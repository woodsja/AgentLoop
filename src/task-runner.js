const { normalizeTaskContract } = require('./task-contract');
const { runVerification } = require('./verifier');

async function verifyTask(projectPath, inputTask, timeoutMs, record) {
  const task = normalizeTaskContract(inputTask);
  const verification = await runVerification(projectPath, task.verification, timeoutMs, record);

  return {
    task,
    status: verification.passed ? 'passed' : 'failed',
    verification,
  };
}

module.exports = { verifyTask };
