const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runVerification } = require('../src/verifier');

const commands = process.platform === 'win32'
  ? {
      success: 'exit /b 0',
      failure: 'exit /b 7',
      cwd: 'cd',
      output: 'echo out & echo err 1>&2',
      timeout: 'ping -n 11 127.0.0.1 > NUL',
    }
  : {
      success: 'exit 0',
      failure: 'exit 7',
      cwd: 'pwd -P',
      output: 'printf out; printf err >&2',
      timeout: 'sleep 10',
    };

test('a successful command passes and reports its exit code and duration', async () => {
  const result = await runVerification(process.cwd(), commands.success, 5000);

  assert.equal(result.passed, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.timedOut, false);
  assert.ok(Number.isInteger(result.durationMs) && result.durationMs >= 0);
});

test('a nonzero exit fails and retains the exit code', async () => {
  const result = await runVerification(process.cwd(), commands.failure, 5000);

  assert.equal(result.passed, false);
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
});

test('the command runs in projectPath', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-verifier-'));

  try {
    const result = await runVerification(projectPath, commands.cwd, 5000);

    assert.equal(result.passed, true);
    assert.equal(result.stdout.trim(), fs.realpathSync(projectPath));
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('stdout and stderr are captured separately', async () => {
  const result = await runVerification(process.cwd(), commands.output, 5000);

  assert.equal(result.passed, true);
  assert.equal(result.stdout.trim(), 'out');
  assert.equal(result.stderr.trim(), 'err');
});

test('a timeout terminates the command and fails verification', async () => {
  const result = await runVerification(process.cwd(), commands.timeout, 100);

  assert.equal(result.passed, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.ok(result.durationMs < 5000);
});
