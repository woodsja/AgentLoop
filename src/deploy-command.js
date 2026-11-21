'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { sync, insist, regular } = require('./deploy-files');
// Shipping command path, shared by worker and guardian-death integration tests.
function createCommand({ location, env, record, budget = () => {}, output = () => true,
  started = () => {}, completed = () => {} }) {
  return (file, args, timeout = '5s', { persistent = false } = {}) => new Promise((resolve,reject) => {
    budget(); started(); const start = Date.now();
    if (persistent) {
      const retained = fs.readdirSync(location).filter(name => /^guardian-.*\.(stdout|stderr)$/.test(name));
      let retainedBytes = 0;
      for (const name of retained) { const f = path.join(location,name); regular(f); retainedBytes += fs.statSync(f).size; }
      insist(retained.length < 128 && retainedBytes < 32 * 1024 * 1024, 'guardian retained audit budget exhausted; preserve logs for owner inspection');
    }
    const files = persistent ? ['stdout','stderr'].map(s => path.join(location, `guardian-${crypto.randomUUID()}.${s}`)) : [];
    const fds = files.map(f => fs.openSync(f, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600));
    if (persistent) sync(location);
    record({ command: [file,...args], timeout, persistent, stdout: files[0], stderr: files[1] });
    const child = spawn('/usr/bin/timeout', ['--signal=TERM','--kill-after=2s', timeout,file,...args], {
      env: { ...env, ...((file === '/usr/bin/systemctl' || file === process.execPath) ? { XDG_RUNTIME_DIR: `/run/user/${process.getuid()}` } : {}) },
      detached: true, stdio: ['ignore', ...(persistent ? fds : ['pipe','pipe']), 3] });
    // Children have independent file descriptions; parent closure cannot cause EPIPE.
    for (const fd of fds) fs.closeSync(fd);
    const chunks = []; let exceeded = false, failure;
    if (!persistent) for (const stream of ['stdout','stderr']) child[stream].on('data', bytes => {
      record({ stream, encoding: 'base64', bytes: bytes.toString('base64') });
      if (stream === 'stdout') chunks.push(bytes);
      if (!output(bytes.length)) { exceeded = true; try { process.kill(-child.pid,'SIGKILL'); } catch {} }
    });
    child.on('error', error => { failure = error; });
    child.on('close', (code,signal) => {
      completed(file, Date.now()-start);
      record({ exitCode:code, signal, error: failure?.stack });
      if (!failure && code === 0 && !exceeded) resolve(Buffer.concat(chunks));
      else reject(failure || new Error(`command failed: ${file} (${code}, ${signal})`));
    });
  });
}
module.exports = { createCommand };
