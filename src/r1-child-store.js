'use strict';

// Read-only inspection of pre-Ticket05 child reservations and queue records.
// No execution or reservation writer remains.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const R1_ID = /^t-[a-f0-9]{8}$/;
const STAGES = ['pending', 'running', 'done'];

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableFields(loop) {
  return {
    project: loop.project, projectPath: loop.projectPath, source: loop.source,
    engine: loop.engine, workerEngine: loop.workerEngine, criticEngine: loop.criticEngine,
    autoCommit: loop.autoCommit, maxCycles: loop.maxCycles, taskRetries: loop.taskRetries,
    r1Child: loop.r1Child,
  };
}

function createR1ChildStore({ stateRoot }) {
  if (typeof stateRoot !== 'string' || !stateRoot.trim()) {
    throw new TypeError('Historical child inspection requires a state directory.');
  }
  const root = path.resolve(stateRoot);
  const indexRoot = path.join(root, 'r1-child-index');

  function reservationPath(parentJobId, attempt) {
    if (!R1_ID.test(parentJobId) || !Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error('Invalid R1 parent or implementation attempt.');
    }
    return path.join(indexRoot, parentJobId, `attempt-${attempt}.json`);
  }

  function findTask(id) {
    const found = [];
    for (const stage of STAGES) {
      try {
        const contents = fs.readFileSync(path.join(root, 'tasks', stage, `${id}.json`), 'utf8');
        found.push({ stage, task: JSON.parse(contents) });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (found.length > 1) throw new Error('R1 child exists in multiple queue stages; refusing to continue.');
    return found[0] || { stage: null, task: null };
  }

  function readReservation(filePath, expectedParent = null) {
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (record?.schemaVersion !== 1 || !R1_ID.test(record.parentJobId)
      || !Number.isSafeInteger(record.attempt) || record.attempt < 1
      || typeof record.id !== 'string' || !/^t-[a-f0-9]{24}$/.test(record.id)
      || !/^[a-f0-9]{64}$/.test(record.fingerprint)
      || (expectedParent && record.parentJobId !== expectedParent)
      || filePath !== reservationPath(record.parentJobId, record.attempt)
      || record.id !== `t-${hash(`${record.parentJobId}:${record.attempt}`).slice(0, 24)}`) {
      throw new Error('Malformed R1 child reservation; refusing to continue.');
    }
    return record;
  }

  function readChild(record) {
    const { stage, task } = findTask(record.id);
    if (task && (task.id !== record.id || task.type !== 'loop'
      || task.r1Child?.parentJobId !== record.parentJobId
      || task.r1Child?.attempt !== record.attempt
      || hash(JSON.stringify(stableFields(task))) !== record.fingerprint)) {
      throw new Error('R1 child task does not match its durable reservation.');
    }
    return { id: record.id, attempt: record.attempt, stage, task };
  }

  function listChildren(parentJobId) {
    reservationPath(parentJobId, 1);
    let files;
    try { files = fs.readdirSync(path.join(indexRoot, parentJobId)); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return files.filter(name => /^attempt-[1-9][0-9]*\.json$/.test(name))
      .map(name => readChild(readReservation(path.join(indexRoot, parentJobId, name), parentJobId)))
      .sort((left, right) => left.attempt - right.attempt);
  }

  return { listChildren };
}

module.exports = { createR1ChildStore };
