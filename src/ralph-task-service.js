const { createCliWorker } = require('./cli-worker');
const { createTaskStateWriter } = require('./task-state-store');
const { runTask } = require('./task-loop');

function createRalphTaskService(options = {}) {
  const createCliWorkerImpl = options.createCliWorkerImpl ?? createCliWorker;
  const createTaskStateWriterImpl = options.createTaskStateWriterImpl ?? createTaskStateWriter;
  const runTaskImpl = options.runTaskImpl ?? runTask;
  const runWorker = createCliWorkerImpl({
    config: options.config,
    timeoutMs: options.workerTimeoutMs,
  });

  return {
    run(projectPath, task) {
      const stateWriter = createTaskStateWriterImpl(projectPath);
      return runTaskImpl(projectPath, task, {
        runWorker,
        onStateChange: stateWriter,
        verificationTimeoutMs: options.verificationTimeoutMs,
      });
    },
  };
}

module.exports = { createRalphTaskService };
