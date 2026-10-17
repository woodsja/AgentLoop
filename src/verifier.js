const { spawn } = require('node:child_process');
const { captureProcess } = require('./execution-log');

function runVerification(projectPath, command, timeoutMs, record = () => {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnFailed = false;
    let exception = null;
    const child = captureProcess(spawn, command, [], {
      cwd: projectPath,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    }, record);

    const { StringDecoder } = require('node:string_decoder');
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    child.stdout.on('data', (chunk) => { stdout += outDecoder.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr += errDecoder.write(chunk); });

    let timer;
    if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform === 'win32') {
            child.kill();
          } else if (child.pid) {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch (error) {
          if (error.code !== 'ESRCH') child.kill('SIGKILL');
        }
      }, timeoutMs);
    }

    child.on('error', error => { spawnFailed = true; exception = { name: error.name, message: error.message, code: error.code, stack: error.stack }; });
    child.on('exit', () => { clearTimeout(timer); });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      const result = {
        passed: !spawnFailed && !timedOut && signal === null && exitCode === 0,
        command,
        exception,
        signal,
        exitCode,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      };
      record('verification', { result });
      resolve(result);
    });
  });
}

module.exports = { runVerification };
