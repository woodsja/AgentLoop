const { createCliWorker } = require('./cli-worker');
const { createTaskStateWriter } = require('./task-state-store');
const { runTask } = require('./task-loop');

function createRalphTaskService(options = {}) {
  const createCliWorkerImpl = options.createCliWorkerImpl ?? createCliWorker;
  const createTaskStateWriterImpl = options.createTaskStateWriterImpl ?? createTaskStateWriter;
  const runTaskImpl = options.runTaskImpl ?? runTask;
  const cancellation = new AbortController();
  const runWorker = createCliWorkerImpl({
    config: options.config,
    signal: cancellation.signal,
    ...(options.recordExecution ? { recordExecution: options.recordExecution } : {}),
    timeoutMs: options.workerTimeoutMs,
    ...(options.registryPath ? { registryPath: options.registryPath } : {}),
    ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
  });

  return {
    cancel(reason) { cancellation.abort(new Error(reason)); return { requested: true, reason: 'Cancellation token set; active CLI worker receives SIGTERM. Awaiting its actual result; an active verifier retains its normal timeout.' }; },
    run(projectPath, task) {
      const stateWriter = createTaskStateWriterImpl(projectPath);
      return runTaskImpl(projectPath, task, {
        beforeAttempt: async () => {
          if (cancellation.signal.aborted) throw cancellation.signal.reason;
          await options.beforeAttempt?.();
        },
        runWorker: options.onPhaseChange || options.beforeAttempt ? async (...args) => {
          await options.onPhaseChange?.('implementation');
          if (cancellation.signal.aborted) throw cancellation.signal.reason;
          await options.beforeAttempt?.();
          options.onWorkerStart?.();
          const result = await runWorker(...args);
          await options.onPhaseChange?.('verification');
          return result;
        } : runWorker,
        onStateChange: options.recordExecution ? async state => {
          options.recordExecution?.('attempt', { state });
          await stateWriter(state);
        } : stateWriter,
        ...(options.recordExecution ? { recordExecution: options.recordExecution } : {}),
        verificationTimeoutMs: options.verificationTimeoutMs,
      });
    },
  };
}

module.exports = { createRalphTaskService };
