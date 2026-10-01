const { normalizeTaskContract } = require('./task-contract');
const { runVerification } = require('./verifier');

async function verifyTask(projectPath, inputTask, timeoutMs) {
  const task = normalizeTaskContract(inputTask);
  const verification = await runVerification(projectPath, task.verification, timeoutMs);

  return {
    task,
    status: verification.passed ? 'passed' : 'failed',
    verification,
  };
}

module.exports = { verifyTask };
