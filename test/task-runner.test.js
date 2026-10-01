const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { verifyTask } = require('../src/task-runner');

function task(verification) {
  return {
    id: 'task-1',
    goal: 'Verify the task',
    acceptance: ['Verification succeeds'],
    verification,
    worker: 'codex',
  };
}

const commands = process.platform === 'win32'
  ? {
      success: 'exit /b 0',
      failure: 'exit /b 7',
      output: 'echo out & echo err 1>&2',
      cwd: 'cd',
      timeout: 'ping -n 11 127.0.0.1 > NUL',
    }
  : {
      success: 'exit 0',
      failure: 'exit 7',
      output: 'printf out; printf err >&2',
      cwd: 'pwd -P',
      timeout: 'sleep 10',
    };

test('a passing task returns the normalized task and full verification result', async () => {
  const input = task(commands.success);
  const result = await verifyTask(process.cwd(), input, 5000);

  assert.deepEqual(result.task, { ...input, maxAttempts: 2, reviewPolicy: 'risk' });
  assert.notStrictEqual(result.task, input);
  assert.equal(result.status, 'passed');
  assert.deepEqual(Object.keys(result.verification).sort(),
    ['passed', 'exitCode', 'stdout', 'stderr', 'timedOut', 'durationMs'].sort());
  assert.equal(result.verification.passed, true);
  assert.equal(result.verification.exitCode, 0);
  assert.equal(result.verification.timedOut, false);
  assert.ok(Number.isInteger(result.verification.durationMs));
});

test('a failing verification command returns failed with its exit code', async () => {
  const result = await verifyTask(process.cwd(), task(commands.failure), 5000);

  assert.equal(result.status, 'failed');
  assert.equal(result.verification.passed, false);
  assert.equal(result.verification.exitCode, 7);
});

test('stdout and stderr are preserved in verification', async () => {
  const result = await verifyTask(process.cwd(), task(commands.output), 5000);

  assert.equal(result.status, 'passed');
  assert.equal(result.verification.stdout.trim(), 'out');
  assert.equal(result.verification.stderr.trim(), 'err');
});

test('a timed out command returns failed and records the timeout', async () => {
  const result = await verifyTask(process.cwd(), task(commands.timeout), 100);

  assert.equal(result.status, 'failed');
  assert.equal(result.verification.passed, false);
  assert.equal(result.verification.timedOut, true);
  assert.equal(result.verification.exitCode, null);
  assert.ok(result.verification.durationMs < 5000);
});

test('verification runs in projectPath', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-task-runner-'));

  try {
    const result = await verifyTask(projectPath, task(commands.cwd), 5000);

    assert.equal(result.status, 'passed');
    assert.equal(result.verification.stdout.trim(), fs.realpathSync(projectPath));
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('an invalid task rejects before executing its verification command', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-task-runner-'));
  const marker = path.join(projectPath, 'executed');
  const command = 'node -e "require(\'node:fs\').writeFileSync(\'executed\', \'yes\')"';

  try {
    await assert.rejects(
      verifyTask(projectPath, { ...task(command), worker: 'invalid' }, 5000),
      TypeError,
    );
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});
