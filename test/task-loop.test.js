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

test('first-attempt pass emits working then passed with normalized task', async () => {
  await inProject(async projectPath => {
    const states = [];
    const result = await runTask(projectPath, task({ maxAttempts: 3 }), {
      onStateChange: state => states.push(state),
      runWorker: async () => {
        fs.writeFileSync(path.join(projectPath, 'result.txt'), 'ready');
      },
    });

    assert.deepEqual(states.map(({ status, activeAttempt, attempts }) =>
      [status, activeAttempt, attempts.length]), [
      ['working', 1, 0],
      ['passed', null, 1],
    ]);
    assert.deepEqual(Object.keys(states[0]), ['task', 'status', 'activeAttempt', 'attempts']);
    assert.deepEqual(states[0].task, result.task);
    assert.deepEqual(states[1].attempts, result.attempts);
  });
});

test('failed verification then pass emits completed failed attempt before retry', async () => {
  await inProject(async projectPath => {
    const states = [];
    let calls = 0;
    const result = await runTask(projectPath, task({ maxAttempts: 3 }), {
      onStateChange: state => states.push(state),
      runWorker: async () => {
        if (++calls === 2) fs.writeFileSync(path.join(projectPath, 'result.txt'), 'ready');
      },
    });

    assert.deepEqual(states.map(({ status, activeAttempt, attempts }) =>
      [status, activeAttempt, attempts.map(attempt => attempt.status)]), [
      ['working', 1, []],
      ['working', null, ['failed']],
      ['working', 2, ['failed']],
      ['passed', null, ['failed', 'passed']],
    ]);
    assert.deepEqual(states[1].attempts[0], result.attempts[0]);
  });
});

test('worker error is present in completed-attempt state', async () => {
  await inProject(async projectPath => {
    const states = [];
    await runTask(projectPath, task({ maxAttempts: 2 }), {
      onStateChange: state => states.push(state),
      runWorker: async () => {
        if (states.length === 1) throw new TypeError('worker crashed');
        fs.writeFileSync(path.join(projectPath, 'result.txt'), 'ready');
      },
    });

    assert.deepEqual(states[1].attempts, [{
      number: 1,
      status: 'worker_error',
      error: { name: 'TypeError', message: 'worker crashed' },
    }]);
    assert.equal(states[1].activeAttempt, null);
  });
});

test('exhausted attempts emit one needs_planning terminal state', async () => {
  await inProject(async projectPath => {
    const states = [];
    const result = await runTask(projectPath, task({ maxAttempts: 2 }), {
      onStateChange: state => states.push(state),
      runWorker: async () => {},
    });

    assert.deepEqual(states.map(({ status, activeAttempt, attempts }) =>
      [status, activeAttempt, attempts.length]), [
      ['working', 1, 0],
      ['working', null, 1],
      ['working', 2, 1],
      ['needs_planning', null, 2],
    ]);
    assert.deepEqual(states[3].attempts, result.attempts);
  });
});

test('async state callback finishes before a worker begins', async () => {
  await inProject(async projectPath => {
    let release;
    let entered;
    const callbackEntered = new Promise(resolve => { entered = resolve; });
    const callbackReleased = new Promise(resolve => { release = resolve; });
    let workerCalls = 0;
    const pending = runTask(projectPath, task({ maxAttempts: 1 }), {
      onStateChange: async state => {
        if (state.activeAttempt === 1) {
          entered();
          await callbackReleased;
        }
      },
      runWorker: async () => { workerCalls++; },
    });

    await callbackEntered;
    assert.equal(workerCalls, 0);
    release();
    await pending;
    assert.equal(workerCalls, 1);
  });
});

test('callback mutation cannot change internal task, attempts, or later snapshots', async () => {
  await inProject(async projectPath => {
    const states = [];
    let calls = 0;
    const result = await runTask(projectPath, task({ maxAttempts: 2 }), {
      onStateChange: state => {
        assert.equal(state.task.goal, 'Create result.txt');
        assert.deepEqual(state.task.acceptance, ['result.txt exists']);
        assert.equal(state.attempts.length, [0, 1, 1, 2][states.length]);
        assert.ok(state.attempts.every(attempt => attempt.status !== 'changed'));
        assert.ok(state.attempts.every(attempt => attempt.worker.message === 'original'));
        states.push(state);
        state.task.goal = 'changed';
        state.task.acceptance.push('changed');
        if (state.attempts[0]) {
          state.attempts[0].status = 'changed';
          state.attempts[0].worker.message = 'changed';
          state.attempts[0].verification.stdout = 'changed';
        }
        state.attempts.push({ number: 99, status: 'changed' });
      },
      runWorker: async (_workerPath, workerTask) => {
        assert.equal(workerTask.goal, 'Create result.txt');
        assert.deepEqual(workerTask.acceptance, ['result.txt exists']);
        if (++calls === 2) fs.writeFileSync(path.join(projectPath, 'result.txt'), 'ready');
        return { message: 'original' };
      },
    });

    assert.equal(calls, 2);
    assert.equal(result.task.goal, 'Create result.txt');
    assert.deepEqual(result.task.acceptance, ['result.txt exists']);
    assert.deepEqual(result.attempts.map(attempt => attempt.status), ['failed', 'passed']);
    assert.deepEqual(result.attempts.map(attempt => attempt.worker.message), ['original', 'original']);
    assert.equal(result.attempts[0].verification.stdout, '');
    assert.equal(states[2].attempts[0].worker.message, 'changed');
    assert.equal(states[3].attempts[0].worker.message, 'changed');
    assert.equal(states[3].attempts[1].worker.message, 'original');
    assert.equal(states[2].attempts.length, 2);
    assert.equal(states[3].attempts.length, 3);
  });
});

test('state callback rejection stops execution before another worker attempt', async () => {
  await inProject(async projectPath => {
    let calls = 0;
    const failure = new Error('state write failed');
    await assert.rejects(runTask(projectPath, task({ maxAttempts: 3 }), {
      onStateChange: async state => {
        if (state.status === 'working' && state.activeAttempt === null) throw failure;
      },
      runWorker: async () => { calls++; },
    }), error => error === failure);
    assert.equal(calls, 1);
  });
});

test('invalid state callback is rejected before any worker runs', async () => {
  let calls = 0;
  await assert.rejects(runTask(process.cwd(), task(), {
    onStateChange: 'not a function',
    runWorker: async () => { calls++; },
  }), /options\.onStateChange must be a function/);
  assert.equal(calls, 0);
});
