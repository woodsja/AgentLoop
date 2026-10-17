const { createCliWorker } = require('./cli-worker');
const { createTaskStateWriter } = require('./task-state-store');
const { runTask } = require('./task-loop');

function createRalphTaskService(options = {}) {
  const createCliWorkerImpl = options.createCliWorkerImpl ?? createCliWorker;
  const createTaskStateWriterImpl = options.createTaskStateWriterImpl ?? createTaskStateWriter;
  const runTaskImpl = options.runTaskImpl ?? runTask;
  const runWorker = createCliWorkerImpl({
    config: options.config,
    ...(options.recordExecution ? { recordExecution: options.recordExecution } : {}),
    timeoutMs: options.workerTimeoutMs,
    ...(options.registryPath ? { registryPath: options.registryPath } : {}),
    ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
  });

  return {
    run(projectPath, task) {
      const stateWriter = createTaskStateWriterImpl(projectPath);
      return runTaskImpl(projectPath, task, {
        runWorker: options.onPhaseChange ? async (...args) => {
          await options.onPhaseChange('implementation');
          const result = await runWorker(...args);
          await options.onPhaseChange('verification');
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
