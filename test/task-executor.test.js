const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { executeTask } = require('../src/task-executor');

const fileCheck = 'node -e "process.exit(require(\'node:fs\').existsSync(\'result.txt\') ? 0 : 1)"';
const verificationMarker = 'node -e "require(\'node:fs\').writeFileSync(\'verification-ran\', \'yes\')"';

function task(verification = fileCheck) {
  return {
    id: 'task-1',
    goal: 'Create result.txt',
    acceptance: ['result.txt exists'],
    verification,
    worker: 'codex',
  };
}

async function inProject(run) {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-task-executor-'));
  try {
    return await run(projectPath);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
}

test('worker creates a file and verification confirms it', async () => {
  await inProject(async projectPath => {
    const workerResult = { message: 'created' };
    const result = await executeTask(projectPath, task(), {
      runWorker: async workerPath => {
        assert.equal(workerPath, projectPath);
        fs.writeFileSync(path.join(workerPath, 'result.txt'), 'ready');
        return workerResult;
      },
      verificationTimeoutMs: 5000,
    });

    assert.strictEqual(result.worker, workerResult);
    assert.equal(result.status, 'passed');
    assert.equal(result.verification.passed, true);
    assert.equal(result.verification.exitCode, 0);
    assert.deepEqual(Object.keys(result), ['task', 'worker', 'status', 'verification']);
  });
});

test('verification failure overrides a worker success claim', async () => {
  await inProject(async projectPath => {
    const workerResult = { status: 'passed', verification: { passed: true } };
    const result = await executeTask(projectPath, task(), {
      runWorker: async () => workerResult,
    });

    assert.strictEqual(result.worker, workerResult);
    assert.equal(result.status, 'failed');
    assert.equal(result.verification.passed, false);
    assert.equal(result.verification.exitCode, 1);
  });
});

test('verification success overrides a worker failure claim', async () => {
  await inProject(async projectPath => {
    const workerResult = { status: 'failed', verification: { passed: false } };
    const result = await executeTask(projectPath, task(), {
      runWorker: async () => {
        fs.writeFileSync(path.join(projectPath, 'result.txt'), 'ready');
        return workerResult;
      },
    });

    assert.strictEqual(result.worker, workerResult);
    assert.equal(result.status, 'passed');
    assert.equal(result.verification.passed, true);
  });
});

test('verification waits for the worker to finish', async () => {
  await inProject(async projectPath => {
    let finishWorker;
    const workerGate = new Promise(resolve => { finishWorker = resolve; });
    let workerFinished = false;
    const execution = executeTask(projectPath, task(), {
      runWorker: async () => {
        await workerGate;
        fs.writeFileSync(path.join(projectPath, 'result.txt'), 'ready');
        workerFinished = true;
      },
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(workerFinished, false);
    finishWorker();

    const result = await execution;
    assert.equal(workerFinished, true);
    assert.equal(result.status, 'passed');
  });
});

test('worker errors propagate and prevent verification', async () => {
  await inProject(async projectPath => {
    const error = new Error('worker failed');
    await assert.rejects(
      executeTask(projectPath, task(verificationMarker), {
        runWorker: async () => { throw error; },
      }),
      caught => caught === error,
    );
    assert.equal(fs.existsSync(path.join(projectPath, 'verification-ran')), false);
  });
});

test('invalid runWorker is rejected before task normalization or execution', async () => {
  for (const options of [undefined, null, [], {}, { runWorker: null }]) {
    await assert.rejects(
      executeTask(process.cwd(), null, options),
      /options\.runWorker must be a function/,
    );
  }
});

test('normalization defaults are passed to the worker and returned', async () => {
  await inProject(async projectPath => {
    const input = task(process.platform === 'win32' ? 'exit /b 0' : 'exit 0');
    let receivedTask;
    const result = await executeTask(projectPath, input, {
      runWorker: async (_workerPath, normalizedTask) => {
        receivedTask = normalizedTask;
        return undefined;
      },
    });

    assert.deepEqual(receivedTask, { ...input, maxAttempts: 2, reviewPolicy: 'risk' });
    assert.notStrictEqual(receivedTask, input);
    assert.strictEqual(result.task, receivedTask);
    assert.equal(result.worker, undefined);
  });
});
