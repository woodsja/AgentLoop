'use strict';

// Immutable reservation identities live outside the moving task-stage folders.
// The reservation is the uniqueness authority: a queue scan never grants the
// right to create an additional worker for the same parent and attempt.
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

function createR1ChildStore({ stateRoot, writeTask }) {
  if (typeof stateRoot !== 'string' || !stateRoot.trim() || typeof writeTask !== 'function') {
    throw new TypeError('R1 child store requires a state directory and a durable task writer.');
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

  // Persist directory entries before publishing an irreversible child identity.
  // A leaf-directory fsync does not make its own parent directory entry durable.
  function ensureDurableIndexDirectory(parentJobId) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const parentDir = path.join(indexRoot, parentJobId);
    for (const dir of [indexRoot, parentDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const parent = path.dirname(dir);
      const fd = fs.openSync(parent, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  }

  // The hard link is an exclusive, atomic publication of a fully written file.
  // If we crash after publication but before writing the pending task, future
  // callers fail closed on the reservation rather than creating another child.
  function publishReservation(filePath, record) {
    ensureDurableIndexDirectory(path.basename(path.dirname(filePath)));
    const tempPath = path.join(path.dirname(filePath), `.${crypto.randomBytes(12).toString('hex')}.tmp`);
    let linked = false;
    try {
      const fd = fs.openSync(tempPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      try {
        fs.linkSync(tempPath, filePath);
        linked = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      if (linked) {
        const fd = fs.openSync(path.dirname(filePath), 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
    } finally { fs.rmSync(tempPath, { force: true }); }
    return linked;
  }

  function ensureLoop(parentJobId, attempt, loop) {
    const filePath = reservationPath(parentJobId, attempt);
    if (!loop || loop.r1Child?.parentJobId !== parentJobId || loop.r1Child.attempt !== attempt
      || loop.source !== 'r1' || loop.workerEngine !== 'codex' || loop.criticEngine !== 'claude') {
      throw new Error('Invalid R1 child loop contract.');
    }
    const id = `t-${hash(`${parentJobId}:${attempt}`).slice(0, 24)}`;
    const fingerprint = hash(JSON.stringify(stableFields(loop)));
    const record = { schemaVersion: 1, parentJobId, attempt, id, fingerprint };
    const created = publishReservation(filePath, record);
    const saved = readReservation(filePath, parentJobId);
    if (saved.id !== id || saved.fingerprint !== fingerprint) {
      throw new Error('R1 child reservation does not match requested implementation.');
    }
    if (created) {
      const child = {
        ...loop, id, type: 'loop', cycles: [], priority: 5,
        createdAt: new Date().toISOString(),
      };
      writeTask(child, 'pending');
      return { id, created: true };
    }
    const child = readChild(saved);
    if (!child.task) {
      throw new Error('R1 child reservation exists without queue materialization; refusing duplicate creation.');
    }
    return { id, created: false };
  }

  return { ensureLoop, listChildren };
}

module.exports = { createR1ChildStore };
