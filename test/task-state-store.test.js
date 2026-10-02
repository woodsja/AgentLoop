const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const store = require('../src/store');
const { createTaskStateWriter } = require('../src/task-state-store');

function runFile(id) {
  return path.join(store.paths.taskRuns, `${crypto.createHash('sha256').update(id).digest('hex')}.json`);
}

test('writer persists the exact record with an absolute project path and injected timestamp', async () => {
  const snapshot = {
    task: { id: 'task-1', goal: 'Build', privateDetail: { value: 'keep this' } },
    status: 'working',
    activeAttempt: 2,
    attempts: [{ number: 1, worker: { output: 'full output' } }],
  };
  const original = structuredClone(snapshot);
  let persisted;
  const writer = createTaskStateWriter('relative/project', {
    storeImpl: { writeTaskRunState: record => { persisted = record; } },
    now: () => '2026-10-02T12:34:56.000Z',
  });

  await writer(snapshot);

  assert.deepEqual(persisted, {
    schemaVersion: 1,
    id: 'task-1',
    projectPath: path.resolve('relative/project'),
    task: original.task,
    status: 'working',
    activeAttempt: 2,
    attempts: original.attempts,
    updatedAt: '2026-10-02T12:34:56.000Z',
  });
  assert.deepEqual(Object.keys(persisted), [
    'schemaVersion', 'id', 'projectPath', 'task', 'status',
    'activeAttempt', 'attempts', 'updatedAt',
  ]);
  assert.deepEqual(snapshot, original);
});

test('writer awaits an asynchronous store', async () => {
  let finishWrite;
  let completed = false;
  const writer = createTaskStateWriter('/project', {
    storeImpl: {
      writeTaskRunState: () => new Promise(resolve => { finishWrite = resolve; }),
    },
  });

  const write = writer({ task: { id: 'task-2' }, status: 'working', activeAttempt: 1, attempts: [] })
    .then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  finishWrite();
  await write;
  assert.equal(completed, true);
});

test('writer propagates store errors', async () => {
  const failure = new Error('disk full');
  const snapshot = { task: { id: 'task-3' }, status: 'working', activeAttempt: null, attempts: [] };
  const syncWriter = createTaskStateWriter('/project', {
    storeImpl: { writeTaskRunState: () => { throw failure; } },
  });
  const asyncWriter = createTaskStateWriter('/project', {
    storeImpl: { writeTaskRunState: async () => { throw failure; } },
  });

  await assert.rejects(syncWriter(snapshot), error => error === failure);
  await assert.rejects(asyncWriter(snapshot), error => error === failure);
});

test('writer rejects invalid project paths', () => {
  for (const value of [undefined, null, '', '   ', 42, {}]) {
    assert.throws(() => createTaskStateWriter(value), TypeError);
  }
});

test('real store round-trips the latest state', () => {
  const id = `task-state-${crypto.randomUUID()}`;
  const filePath = runFile(id);
  try {
    const initial = { id, status: 'working', attempts: [] };
    const latest = { id, status: 'passed', attempts: [{ number: 1, output: 'full output' }] };
    store.writeTaskRunState(initial);
    assert.deepEqual(store.readTaskRunState(id), initial);
    store.writeTaskRunState(latest);
    assert.deepEqual(store.readTaskRunState(id), latest);
    assert.equal(fs.readdirSync(store.paths.taskRuns).filter(name => name === path.basename(filePath)).length, 1);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('task ids with slash and backslash stay inside task-runs', () => {
  const unique = `task-state-${crypto.randomUUID()}`;
  const id = `../${unique}/escaped\\name`;
  const filePath = runFile(id);
  const outsideDir = path.join(store.paths.state, unique);
  try {
    store.writeTaskRunState({ id, status: 'working' });
    assert.deepEqual(store.readTaskRunState(id), { id, status: 'working' });
    assert.equal(fs.existsSync(filePath), true);
    assert.equal(fs.existsSync(outsideDir), false);
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('missing task-run state returns null', () => {
  assert.equal(store.readTaskRunState(`missing-${crypto.randomUUID()}`), null);
});

test('malformed task-run JSON is reported', () => {
  const id = `malformed-${crypto.randomUUID()}`;
  const filePath = runFile(id);
  try {
    fs.mkdirSync(store.paths.taskRuns, { recursive: true });
    fs.writeFileSync(filePath, '{ malformed json', 'utf8');
    assert.throws(() => store.readTaskRunState(id), SyntaxError);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
