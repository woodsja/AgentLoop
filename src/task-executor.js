const { normalizeTaskContract } = require('./task-contract');
const { verifyTask } = require('./task-runner');

async function executeTask(projectPath, inputTask, options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      typeof options.runWorker !== 'function') {
    throw new TypeError('options.runWorker must be a function');
  }

  const task = normalizeTaskContract(inputTask);
  const worker = await options.runWorker(projectPath, task);
  const result = await verifyTask(projectPath, task, options.verificationTimeoutMs);

  return {
    task,
    worker,
    status: result.status,
    verification: result.verification,
  };
}

module.exports = { executeTask };
