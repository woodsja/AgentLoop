const test = require('node:test');
const assert = require('node:assert/strict');
const { startDaemon, stopDaemon, runScenario, cleanWorkspace, request } = require('./runner');

let daemon;

test.before(async () => {
  cleanWorkspace();
  daemon = await startDaemon();
});

test.after(async () => {
  try {
    stopDaemon(daemon);
  } finally {
    cleanWorkspace();
  }
});

// Single-task plan: worker writes add.js, critic returns PASS on cycle 1.
test('scenario: clean-pass completes and checkpoints', async () => {
  const { actual, expect } = await runScenario('clean-pass', daemon);
  assert.equal(actual.status, expect.status);
  assert.equal(actual.checkpoints, expect.checkpoints);
  assert.equal(actual.tasksDone, expect.tasksDone);
  assert.deepEqual(actual.verdicts, expect.verdicts);
  assert.equal(actual.daemonAlive, true);
  assert.deepEqual(actual.invocations.map(row => [row.engine, row.role]), [['codex', 'worker'], ['codex', 'critic']]);
  for (const snippet of expect.gitMessages || []) {
    assert.ok(actual.gitLog.includes(snippet), `git log missing ${snippet}`);
  }
});

test('mixed engines receive their own models despite a configured legacy top-level model', async () => {
  const { actual } = await runScenario('clean-pass', daemon, { workerEngine: 'codex', criticEngine: 'claude' });
  assert.equal(actual.status, 'passed');
  assert.equal(actual.checkpoints, 1);
  assert.deepEqual(actual.invocations.map(row => [row.engine, row.role, row.model]), [
    ['codex', 'worker', 'gpt-5.6-terra'], ['claude', 'critic', 'opus'],
  ]);
  const [worker, critic] = actual.invocations;
  assert.ok(worker.argv.includes('workspace-write'));
  assert.ok(critic.argv.includes('Read,Glob,Grep'));
  assert.ok(critic.argv.includes('dontAsk'));
  assert.equal(new Set(actual.invocations.map(row => row.pid)).size, 2);
  assert.equal(actual.persisted.workerEngine, 'codex');
  assert.equal(actual.persisted.criticEngine, 'claude');
  const snapshot = await request('GET', '/api/state', undefined, daemon.port);
  const recent = snapshot.body.tasks.recent.find(row => row.id === actual.id);
  assert.equal(recent.workerEngine, 'codex');
  assert.equal(recent.criticEngine, 'claude');
});

test('legacy engine-only Claude loops use Claude for both roles', async () => {
  const { actual } = await runScenario('clean-pass', daemon, { engine: 'claude' });
  assert.equal(actual.status, 'passed');
  assert.deepEqual(actual.invocations.map(row => [row.engine, row.role]), [['claude', 'worker'], ['claude', 'critic']]);
  assert.equal(actual.persisted.workerEngine, 'claude');
  assert.equal(actual.persisted.criticEngine, 'claude');
});

test('Claude FAIL sends concrete corrections to a fresh Codex worker', async () => {
  const { actual } = await runScenario('task-retry', daemon, { workerEngine: 'codex', criticEngine: 'claude' });
  assert.equal(actual.status, 'passed');
  assert.deepEqual(actual.verdicts, ['FAIL', 'PASS']);
  assert.deepEqual(actual.invocations.map(row => [row.engine, row.role]), [
    ['codex', 'worker'], ['claude', 'critic'], ['codex', 'worker'], ['claude', 'critic'],
  ]);
  assert.match(actual.invocations[2].prompt, /syntax error in add.js/);
  assert.equal(new Set(actual.invocations.map(row => row.pid)).size, 4);
  assert.equal(actual.checkpoints, 1);
});

test('assigned roles stay fixed while walking multiple plan items', async () => {
  const { actual } = await runScenario('plan-walk', daemon, { workerEngine: 'claude', criticEngine: 'codex' });
  assert.equal(actual.status, 'passed');
  assert.deepEqual(actual.verdicts, ['CONTINUE', 'CONTINUE', 'PASS']);
  assert.equal(actual.checkpoints, 3);
  for (const row of actual.invocations) {
    assert.equal(row.engine, row.role === 'worker' ? 'claude' : 'codex');
    if (row.role === 'critic') {
      assert.ok(row.argv.includes('read-only'));
      assert.ok(row.argv.includes('approval_policy="never"'));
    }
  }
});

test('API rejects invalid engine fields', async () => {
  for (const field of ['engine', 'workerEngine', 'criticEngine']) {
    const response = await request('POST', '/api/loop', {
      project: 'workspace/clean-pass', autoCommit: false, [field]: 'unknown',
    }, daemon.port);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, new RegExp(`Unsupported ${field}`));
  }
});

// Multi-task plan: walks 3 tasks with CONTINUE, CONTINUE, PASS and checkpoints each task.
test('scenario: multi-task plan walk checkpoints each task', async () => {
  const { actual, expect } = await runScenario('plan-walk', daemon);
  assert.equal(actual.status, expect.status);
  assert.equal(actual.checkpoints, expect.checkpoints);
  assert.equal(actual.tasksDone, expect.tasksDone);
  assert.deepEqual(actual.verdicts, expect.verdicts);
  assert.equal(actual.daemonAlive, true);
  for (const snippet of expect.gitMessages || []) {
    assert.ok(actual.gitLog.includes(snippet), `git log missing ${snippet}`);
  }
});

// Task failure recovery: cycle 1 fails, cycle 2 succeeds within retry budget.
test('scenario: task retry within budget succeeds', async () => {
  const { actual, expect } = await runScenario('task-retry', daemon);
  assert.equal(actual.status, expect.status);
  assert.equal(actual.checkpoints, expect.checkpoints);
  assert.equal(actual.tasksDone, expect.tasksDone);
  assert.deepEqual(actual.verdicts, expect.verdicts);
  assert.equal(actual.daemonAlive, true);
  for (const snippet of expect.gitMessages || []) {
    assert.ok(actual.gitLog.includes(snippet), `git log missing ${snippet}`);
  }
});

// Cycle budget limit: consecutive failures exhaust maxCycles and resolve to maxed without PASS.
test('scenario: budget exhaustion marks loop maxed', async () => {
  const { actual, expect } = await runScenario('budget-exhaustion', daemon);
  assert.equal(actual.status, expect.status);
  assert.equal(actual.checkpoints, expect.checkpoints);
  assert.equal(actual.tasksDone, expect.tasksDone);
  assert.deepEqual(actual.verdicts, expect.verdicts);
  assert.equal(actual.daemonAlive, true);
});

// Invalid critic verdict retries on task budget then passes on cycle 2.
test('scenario: invalid critic verdict retries on task budget then passes', async () => {
  const { actual, expect } = await runScenario('invalid-critic', daemon);
  assert.equal(actual.status, expect.status);
  assert.equal(actual.checkpoints, expect.checkpoints);
  assert.equal(actual.tasksDone, expect.tasksDone);
  assert.deepEqual(actual.verdicts, expect.verdicts);
  assert.equal(actual.daemonAlive, true);
  for (const snippet of expect.gitMessages || []) {
    assert.ok(actual.gitLog.includes(snippet), `git log missing ${snippet}`);
  }
});

// No-change worker is graded by critic and passes.
test('scenario: no-change worker is graded by critic and passes', async () => {
  const { actual, expect } = await runScenario('no-change-worker', daemon);
  assert.equal(actual.status, expect.status);
  assert.equal(actual.checkpoints, expect.checkpoints);
  assert.equal(actual.tasksDone, expect.tasksDone);
  assert.deepEqual(actual.verdicts, expect.verdicts);
  assert.equal(actual.daemonAlive, true);
  for (const snippet of expect.gitMessages || []) {
    assert.ok(actual.gitLog.includes(snippet), `git log missing ${snippet}`);
  }
});

