const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function runVerification(projectPath, command, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnFailed = false;
    // File-backed capture avoids losing child output when a shell launches a
    // further process (notably nested Node invocations in constrained
    // runtimes). Some sandboxed workers deliberately cannot write the OS
    // temporary directory, though. In that case pipe capture is safe and
    // still returns verifier evidence instead of refusing to run tests.
    let capture = null;
    let captureDirectory = null;
    let captureStdoutFd = null;
    try {
      captureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-verification-'));
      const stdoutPath = path.join(captureDirectory, 'stdout');
      const stderrPath = path.join(captureDirectory, 'stderr');
      captureStdoutFd = fs.openSync(stdoutPath, 'w');
      capture = {
        directory: captureDirectory,
        stdoutPath,
        stderrPath,
        stdoutFd: captureStdoutFd,
        stderrFd: fs.openSync(stderrPath, 'w'),
      };
    } catch {
      if (captureStdoutFd !== null) fs.closeSync(captureStdoutFd);
      if (captureDirectory) fs.rmSync(captureDirectory, { recursive: true, force: true });
      capture = { directory: null, stdoutPath: null, stderrPath: null, stdoutFd: null, stderrFd: null };
    }
    let child;
    try {
      child = spawn(command, {
        cwd: projectPath,
        shell: true,
        detached: process.platform !== 'win32',
        stdio: capture.directory ? ['ignore', capture.stdoutFd, capture.stderrFd] : ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (capture.directory) {
        fs.closeSync(capture.stdoutFd);
        fs.closeSync(capture.stderrFd);
        fs.rmSync(capture.directory, { recursive: true, force: true });
      }
      throw error;
    }
    if (!capture.directory) {
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
    }

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
      if (capture.directory) {
        fs.closeSync(capture.stdoutFd);
        fs.closeSync(capture.stderrFd);
        try {
          stdout = fs.readFileSync(capture.stdoutPath, 'utf8');
          stderr = fs.readFileSync(capture.stderrPath, 'utf8');
        } finally {
          fs.rmSync(capture.directory, { recursive: true, force: true });
        }
      }
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
