const test = require('node:test');
const assert = require('node:assert/strict');

const { createRalphTaskService } = require('../src/ralph-task-service');

test('creates one worker with configured options and reuses it across runs', () => {
  const config = { defaultModel: 'test-model' };
  const worker = () => {};
  const writers = [() => {}, () => {}];
  const tasks = [{ id: 'first' }, { id: 'second' }];
  const results = [{ status: 'passed' }, { status: 'needs_planning' }];
  const workerOptions = [];
  const writerPaths = [];
  const calls = [];
  const service = createRalphTaskService({
    config,
    workerTimeoutMs: 1234,
    verificationTimeoutMs: 5678,
    createCliWorkerImpl: options => {
      workerOptions.push(options);
      return worker;
    },
    createTaskStateWriterImpl: projectPath => {
      writerPaths.push(projectPath);
      return writers[writerPaths.length - 1];
    },
    runTaskImpl: (projectPath, task, options) => {
      calls.push({ projectPath, task, options });
      return results[calls.length - 1];
    },
  });

  assert.ok(workerOptions[0].signal instanceof AbortSignal);
  assert.deepEqual(workerOptions, [{ config, signal: workerOptions[0].signal, timeoutMs: 1234 }]);
  assert.strictEqual(service.run('/project/one', tasks[0]), results[0]);
  assert.strictEqual(service.run('/project/two', tasks[1]), results[1]);
  assert.ok(workerOptions[0].signal instanceof AbortSignal);
  assert.deepEqual(workerOptions, [{ config, signal: workerOptions[0].signal, timeoutMs: 1234 }]);
  assert.deepEqual(writerPaths, ['/project/one', '/project/two']);
  assert.deepEqual(calls, [
    {
      projectPath: '/project/one',
      task: tasks[0],
      options: { beforeAttempt: calls[0].options.beforeAttempt, runWorker: worker, onStateChange: writers[0], verificationTimeoutMs: 5678 },
    },
    {
      projectPath: '/project/two',
      task: tasks[1],
      options: { beforeAttempt: calls[1].options.beforeAttempt, runWorker: worker, onStateChange: writers[1], verificationTimeoutMs: 5678 },
    },
  ]);
  assert.notStrictEqual(calls[0].options.onStateChange, calls[1].options.onStateChange);
});

test('returns the exact promise from runTask', async () => {
  const result = { status: 'passed' };
  const pending = Promise.resolve(result);
  const service = createRalphTaskService({
    createCliWorkerImpl: () => () => {},
    createTaskStateWriterImpl: () => () => {},
    runTaskImpl: () => pending,
  });

  assert.strictEqual(service.run('/project', { id: 'task' }), pending);
  assert.strictEqual(await pending, result);
});

test('propagates runTask errors unchanged', async () => {
  for (const source of ['worker', 'verifier', 'persistence']) {
    const failure = new Error(`${source} failed`);
    const service = createRalphTaskService({
      createCliWorkerImpl: () => () => {},
      createTaskStateWriterImpl: () => () => {},
      runTaskImpl: async () => { throw failure; },
    });

    await assert.rejects(service.run('/project', { id: 'task' }), error => error === failure);
  }
});

test('propagates state-writer creation errors unchanged', () => {
  const failure = new Error('cannot create state writer');
  let runTaskCalls = 0;
  const service = createRalphTaskService({
    createCliWorkerImpl: () => () => {},
    createTaskStateWriterImpl: () => { throw failure; },
    runTaskImpl: () => { runTaskCalls++; },
  });

  assert.throws(() => service.run('/project', { id: 'task' }), error => error === failure);
  assert.equal(runTaskCalls, 0);
});

test('cancellation signals the owned worker and denies the next attempt without inventing a terminal result', async () => {
  let signal, attempts;
  const reason = 'owner paused the milestone';
  const service = createRalphTaskService({
    createCliWorkerImpl: options => { signal = options.signal; return async () => ({ exitCode: null, signal: 'SIGTERM' }); },
    createTaskStateWriterImpl: () => async () => {},
    runTaskImpl: async (_, task, options) => { attempts = options.beforeAttempt; await attempts(); return { status: 'actual-worker-result' }; },
  });
  const result = await service.run('/project', {});
  assert.equal(result.status, 'actual-worker-result'); assert.equal(signal.aborted, false);
  assert.equal(service.cancel(reason).requested, true); assert.equal(signal.aborted, true);
  await assert.rejects(attempts(), new RegExp(reason));
});
