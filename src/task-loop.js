const { normalizeTaskContract } = require('./task-contract');
const { executeTask } = require('./task-executor');

function snapshotAttempt(attempt) {
  if (attempt.status === 'worker_error') {
    return {
      number: attempt.number,
      status: attempt.status,
      error: { name: attempt.error.name, message: attempt.error.message },
    };
  }

  const { passed, exitCode, timedOut, stdout, stderr } = attempt.verification;
  return {
    number: attempt.number,
    status: attempt.status,
    verification: { passed, exitCode, timedOut, stdout, stderr },
  };
}

async function runTask(projectPath, inputTask, options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      typeof options.runWorker !== 'function') {
    throw new TypeError('options.runWorker must be a function');
  }
  if (options.onStateChange !== undefined && typeof options.onStateChange !== 'function') {
    throw new TypeError('options.onStateChange must be a function');
  }

  const task = normalizeTaskContract(inputTask);
  const attempts = [];
  async function emitState(status, activeAttempt) {
    if (options.onStateChange) {
      await options.onStateChange(structuredClone({ task, status, activeAttempt, attempts }));
    }
  }

  for (let number = 1; number <= task.maxAttempts; number++) {
    await emitState('working', number);
    const previousAttempt = attempts.length === 0 ? null : snapshotAttempt(attempts[attempts.length - 1]);
    const context = { attempt: number, previousAttempt };
    let result;
    try {
      result = await executeTask(projectPath, task, {
        runWorker: (workerPath, workerTask) => options.runWorker(workerPath, workerTask, context),
        verificationTimeoutMs: options.verificationTimeoutMs,
      });
      attempts.push({
        number,
        status: result.status,
        worker: result.worker,
        verification: result.verification,
      });
    } catch (error) {
      attempts.push({
        number,
        status: 'worker_error',
        error: { name: error.name, message: error.message },
      });
    }

    if (result && result.status === 'passed') {
      await emitState('passed', null);
      return { task, status: 'passed', attempts };
    }
    if (number < task.maxAttempts) await emitState('working', null);
  }

  await emitState('needs_planning', null);
  return { task, status: 'needs_planning', attempts };
}

module.exports = { runTask };
