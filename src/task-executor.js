const { normalizeTaskContract } = require('./task-contract');
const { verifyTask } = require('./task-runner');

async function executeTask(projectPath, inputTask, options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      typeof options.runWorker !== 'function') {
    throw new TypeError('options.runWorker must be a function');
  }

  const task = normalizeTaskContract(inputTask);
  const worker = await options.runWorker(projectPath, task);
  const proposal = require('./architecture-decisions').readProposal(projectPath, task.architectureDecisions, options.recordExecution);
  if (proposal) return { task, worker, status: 'paused_owner_decision', proposal };
  const result = await verifyTask(projectPath, task, options.verificationTimeoutMs, options.recordExecution);

  return {
    task,
    worker,
    status: result.status,
    verification: result.verification,
  };
}

module.exports = { executeTask };
