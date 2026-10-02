const path = require('node:path');
const store = require('./store');

function createTaskStateWriter(projectPath, options = {}) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new TypeError('projectPath must be a non-empty string');
  }

  const resolvedProjectPath = path.resolve(projectPath);
  const storeImpl = options.storeImpl ?? store;
  const now = options.now ?? (() => new Date().toISOString());

  return async function writeTaskState(snapshot) {
    const record = {
      schemaVersion: 1,
      id: snapshot.task.id,
      projectPath: resolvedProjectPath,
      task: snapshot.task,
      status: snapshot.status,
      activeAttempt: snapshot.activeAttempt,
      attempts: snapshot.attempts,
      updatedAt: now(),
    };

    await Promise.resolve(storeImpl.writeTaskRunState(record));
  };
}

module.exports = { createTaskStateWriter };
