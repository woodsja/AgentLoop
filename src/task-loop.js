const { normalizeTaskContract } = require('./task-contract');
const { executeTask } = require('./task-executor');

async function runTask(projectPath, inputTask, options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      typeof options.runWorker !== 'function') {
    throw new TypeError('options.runWorker must be a function');
  }

  const task = normalizeTaskContract(inputTask);
  const attempts = [];

  for (let number = 1; number <= task.maxAttempts; number++) {
    try {
      const result = await executeTask(projectPath, task, {
        runWorker: options.runWorker,
        verificationTimeoutMs: options.verificationTimeoutMs,
      });
      attempts.push({
        number,
        status: result.status,
        worker: result.worker,
        verification: result.verification,
      });

      if (result.status === 'passed') {
        return { task, status: 'passed', attempts };
      }
    } catch (error) {
      attempts.push({
        number,
        status: 'worker_error',
        error: { name: error.name, message: error.message },
      });
    }
  }

  return { task, status: 'needs_planning', attempts };
}

module.exports = { runTask };
