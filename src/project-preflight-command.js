const path = require('node:path');
const { spawn: nativeSpawn } = require('node:child_process');
const { captureProcess, currentRecorder } = require('./execution-log');
const { StringDecoder } = require('node:string_decoder');
const { blocked } = require('./project-preflight');
const { startTime, terminatePriorR1Worker } = require('./r1-process-claim');

function preparationCommands(root, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 300000);
  const cancelled = () => { try { return options.isCancelled?.() === true; } catch { return true; } };
  const check = () => {
    if (cancelled()) throw blocked('cancelled', 'Project preparation cancelled before worker admission.');
    if (Date.now() >= deadline) throw blocked('timeout', 'Project preparation exceeded its time limit.');
  };
  const record = options.recordExecution || currentRecorder() || (() => {});
  const command = (file, args, reason, applicationCheck = false) => new Promise((resolve, reject) => {
    try { check(); } catch (error) { reject(error); return; }
    let child, claim, timer, failure, stdout = '', stderr = '';
    const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure ||= error; } };
    record('command', { command: file, args, cwd: root, role: 'environment' });
    try {
      child = captureProcess(options.spawn || nativeSpawn, process.execPath, [path.join(__dirname, 'project-preflight-runner.js'), file, ...args], {
        cwd: root, env: options.env || process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      }, record);
      child.stdout.on('data', bytes => { stdout += outDecoder.write(bytes); });
      child.stderr.on('data', bytes => { stderr += errDecoder.write(bytes); });
      child.on('error', error => { failure ||= error; });
      child.stdin.on('error', error => { failure ||= error; stop(); });
      child.on('close', (exitCode, signal) => {
        clearInterval(timer);
        stdout += outDecoder.end();
        stderr += errDecoder.end();
        // Do not erase a durable claim if descendants cannot be confirmed gone.
        if (claim && !terminatePriorR1Worker({ r1Child: true, workerPid: claim.pid, workerStartTime: claim.startTime })) {
          reject(blocked('prior_process_unresolved', 'Project setup process group could not be terminated; preserve its claim before retry.')); return;
        }
        try {
          options.onProcess?.(null);
          check();
          if (failure || (exitCode !== 0 && (!applicationCheck || signal !== null || exitCode === null || [126, 127].includes(exitCode)))) throw blocked(reason, `Project command failed: ${file} ${args.join(' ')}\n${failure?.stack || ''}\n${stdout}\n${stderr}`, { command: file, args, exitCode, signal, stdout, stderr });
          resolve(applicationCheck ? { passed: exitCode === 0, exitCode, signal, stdout, stderr } : stdout);
        } catch (error) { reject(error); }
      });
      claim = { pid: child.pid, startTime: startTime(child.pid) };
      if (!claim.startTime) throw blocked('prior_process_unresolved', 'Cannot establish Linux process identity for project preparation.');
      options.onProcess?.(claim);
      child.stdin.end('start\n');
      timer = setInterval(() => { if (cancelled() || Date.now() >= deadline) stop(); }, 50);
    } catch (error) {
      if (child?.pid) { failure = error; stop(); }
      else reject(error);
    }
  });
  return { command, check };
}
module.exports = { preparationCommands };
