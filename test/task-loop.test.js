const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runTask } = require('../src/task-loop');

const fileCheck = 'node -e "process.exit(require(\'node:fs\').existsSync(\'result.txt\') ? 0 : 1)"';

function task(overrides = {}) {
  return {
    id: 'task-1',
    goal: 'Create result.txt',
    acceptance: ['result.txt exists'],
    verification: fileCheck,
    worker: 'codex',
    ...overrides,
  };
}

async function inProject(run) {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-task-loop-'));
  try {
    return await run(projectPath);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
}

test('passing on the first attempt stops immediately', async () => {
  await inProject(async projectPath => {
    const workerResult = { message: 'created' };
    let calls = 0;
    const result = await runTask(projectPath, task({ maxAttempts: 3 }), {
      runWorker: async (workerPath, workerTask, context) => {
        calls++;
        assert.equal(workerPath, projectPath);
        assert.equal(workerTask.id, 'task-1');
        assert.deepEqual(context, { attempt: 1, previousAttempt: null });
        fs.writeFileSync(path.join(workerPath, 'result.txt'), 'ready');
        return workerResult;
      },
      verificationTimeoutMs: 5000,
    });

    assert.equal(calls, 1);
    assert.equal(result.status, 'passed');
    assert.equal(result.attempts.length, 1);
    assert.deepEqual(Object.keys(result), ['task', 'status', 'attempts']);
    assert.equal(result.attempts[0].number, 1);
    assert.equal(result.attempts[0].status, 'passed');
    assert.strictEqual(result.attempts[0].worker, workerResult);
    assert.equal(result.attempts[0].verification.passed, true);
  });
});

test('first verification fails and second passes', async () => {
  await inProject(async projectPath => {
    let calls = 0;
    const contexts = [];
    const result = await runTask(projectPath, task({ maxAttempts: 3 }), {
      runWorker: async (_workerPath, _workerTask, context) => {
        contexts.push(context);
        calls++;
        if (calls === 2) fs.writeFileSync(path.join(projectPath, 'result.txt'), 'ready');
        return { call: calls, resultText: 'worker output' };
      },
    });

    assert.equal(calls, 2);
    assert.equal(result.status, 'passed');
    assert.deepEqual(result.attempts.map(attempt => [attempt.number, attempt.status]), [
      [1, 'failed'],
      [2, 'passed'],
    ]);
    assert.deepEqual(result.attempts.map(attempt => attempt.worker), [
      { call: 1, resultText: 'worker output' },
      { call: 2, resultText: 'worker output' },
    ]);
    assert.deepEqual(result.attempts.map(attempt => attempt.verification.passed), [false, true]);
    assert.deepEqual(contexts, [
      { attempt: 1, previousAttempt: null },
      {
        attempt: 2,
        previousAttempt: {
          number: 1,
          status: 'failed',
          verification: {
            passed: false,
            exitCode: 1,
            timedOut: false,
            stdout: '',
            stderr: '',
          },
        },
      },
    ]);
    assert.ok(Object.hasOwn(result.attempts[0].verification, 'durationMs'));
  });
});

test('maxAttempts exhaustion returns needs_planning', async () => {
  await inProject(async projectPath => {
    const result = await runTask(projectPath, task({ maxAttempts: 2 }), {
      runWorker: async () => ({ message: 'no file' }),
    });

    assert.equal(result.status, 'needs_planning');
    assert.deepEqual(result.attempts.map(attempt => attempt.status), ['failed', 'failed']);
    assert.ok(result.attempts.every(attempt => attempt.verification.passed === false));
  });
});

test('exactly maxAttempts attempts occur, never more', async () => {
  await inProject(async projectPath => {
    let calls = 0;
    const result = await runTask(projectPath, task({ maxAttempts: 4 }), {
      runWorker: async () => { calls++; },
    });

    assert.equal(calls, 4);
    assert.equal(result.attempts.length, 4);
    assert.deepEqual(result.attempts.map(attempt => attempt.number), [1, 2, 3, 4]);
    assert.equal(result.status, 'needs_planning');
  });
});

test('maxAttempts: 1 performs only one attempt', async () => {
  await inProject(async projectPath => {
    let calls = 0;
    const result = await runTask(projectPath, task({ maxAttempts: 1 }), {
      runWorker: async () => { calls++; },
    });

    assert.equal(calls, 1);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].number, 1);
    assert.equal(result.status, 'needs_planning');
  });
});

test('worker error is recorded and retried', async () => {
  await inProject(async projectPath => {
    let calls = 0;
    const contexts = [];
    const result = await runTask(projectPath, task({ maxAttempts: 2 }), {
      runWorker: async (_workerPath, _workerTask, context) => {
        contexts.push(context);
        calls++;
        if (calls === 1) throw new TypeError('worker crashed');
        fs.writeFileSync(path.join(projectPath, 'result.txt'), 'ready');
        return { message: 'recovered' };
      },
    });

    assert.equal(calls, 2);
    assert.equal(result.status, 'passed');
    assert.deepEqual(result.attempts[0], {
      number: 1,
      status: 'worker_error',
      error: { name: 'TypeError', message: 'worker crashed' },
    });
    assert.equal(result.attempts[1].status, 'passed');
    assert.equal(result.attempts[1].verification.passed, true);
    assert.deepEqual(contexts, [
      { attempt: 1, previousAttempt: null },
      {
        attempt: 2,
        previousAttempt: {
          number: 1,
          status: 'worker_error',
          error: { name: 'TypeError', message: 'worker crashed' },
        },
      },
    ]);
  });
});

test('third attempt receives only the immediately preceding attempt', async () => {
  await inProject(async projectPath => {
    const contexts = [];
    const result = await runTask(projectPath, task({ maxAttempts: 3 }), {
      runWorker: async (_workerPath, _workerTask, context) => {
        contexts.push(context);
        if (context.attempt === 3) fs.writeFileSync(path.join(projectPath, 'result.txt'), 'ready');
        return { attempt: context.attempt, resultText: 'private worker output' };
      },
    });

    assert.equal(result.status, 'passed');
    assert.deepEqual(result.attempts.map(attempt => attempt.status), ['failed', 'failed', 'passed']);
    assert.deepEqual(contexts[2], {
      attempt: 3,
      previousAttempt: {
        number: 2,
        status: 'failed',
        verification: {
          passed: false,
          exitCode: 1,
          timedOut: false,
          stdout: '',
          stderr: '',
        },
      },
    });
    assert.deepEqual(result.attempts.map(attempt => attempt.worker.attempt), [1, 2, 3]);
  });
});

test('repeated worker errors eventually produce needs_planning', async () => {
  await inProject(async projectPath => {
    let calls = 0;
    const result = await runTask(projectPath, task({ maxAttempts: 3 }), {
      runWorker: async () => {
        calls++;
        throw new Error('still broken');
      },
    });

    assert.equal(calls, 3);
    assert.equal(result.status, 'needs_planning');
    assert.deepEqual(result.attempts, [1, 2, 3].map(number => ({
      number,
      status: 'worker_error',
      error: { name: 'Error', message: 'still broken' },
    })));
  });
});

test('defaults cause two attempts when maxAttempts is omitted', async () => {
  await inProject(async projectPath => {
    let calls = 0;
    const input = task();
    const result = await runTask(projectPath, input, {
      runWorker: async () => { calls++; },
    });

    assert.equal(calls, 2);
    assert.equal(result.status, 'needs_planning');
    assert.equal(result.attempts.length, 2);
    assert.deepEqual(result.task, { ...input, maxAttempts: 2, reviewPolicy: 'risk' });
    assert.notStrictEqual(result.task, input);
  });
});

test('normalization occurs before any worker runs', async () => {
  await inProject(async projectPath => {
    const input = task({ maxAttempts: 2 });
    const received = [];
    const result = await runTask(projectPath, input, {
      runWorker: async (_workerPath, workerTask) => {
        received.push(workerTask);
        assert.equal(workerTask.maxAttempts, 2);
        assert.equal(workerTask.reviewPolicy, 'risk');
        if (received.length === 1) {
          input.goal = 'Changed after the first attempt';
          input.acceptance.push('New criterion');
        }
      },
    });

    assert.equal(received.length, 2);
    assert.equal(result.task.goal, 'Create result.txt');
    assert.deepEqual(result.task.acceptance, ['result.txt exists']);
    assert.ok(received.every(workerTask => workerTask.goal === result.task.goal));
    assert.ok(received.every(workerTask => workerTask.acceptance.length === 1));
  });
});

test('runWorker is required before attempts begin', async () => {
  await assert.rejects(runTask(process.cwd(), task(), {}),
    /options\.runWorker must be a function/);
});
