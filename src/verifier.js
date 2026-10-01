const { spawn } = require('node:child_process');

function runVerification(projectPath, command, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnFailed = false;
    const child = spawn(command, {
      cwd: projectPath,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

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

    child.on('error', () => { spawnFailed = true; });
    child.on('exit', () => { clearTimeout(timer); });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        passed: !spawnFailed && !timedOut && signal === null && exitCode === 0,
        exitCode,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

module.exports = { runVerification };
