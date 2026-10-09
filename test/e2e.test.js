const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { callTool } = require('../src/tools');
const {
  startDaemon, stopDaemon, runScenario, prepareMockScenario, request, waitForJob, cleanWorkspace,
} = require('./runner');

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
  for (const snippet of expect.gitMessages || []) {
    assert.ok(actual.gitLog.includes(snippet), `git log missing ${snippet}`);
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

test('HTTP job survives the submit connection and is retrieved later by ID', async () => {
  // Reuse a named, registered fixture project and the fake CLI. The worker is
  // intentionally delayed, so completion cannot be an artifact of the POST.
  prepareMockScenario('async-job', 'clean-pass');
  const submittedAt = Date.now();
  const submitted = await request('POST', '/api/jobs', {
    project: 'clean-pass',
    title: 'async acceptance job',
    prompt: 'Confirm the daemon runs this queued mock job asynchronously.',
    engine: 'codex',
  }, daemon.port);
  const submitElapsedMs = Date.now() - submittedAt;

  assert.equal(submitted.statusCode, 201);
  assert.match(submitted.body.id, /^t-/);
  assert.ok(submitElapsedMs < 1200, `submission waited ${submitElapsedMs}ms for worker completion`);
  assert.ok(fs.existsSync(daemon.stateDir), 'isolated daemon state survives after submit response closes');

  const id = submitted.body.id;
  const inFlight = await request('GET', `/api/jobs/${id}`, undefined, daemon.port);
  assert.equal(inFlight.statusCode, 200);
  assert.equal(inFlight.body.id, id);
  assert.ok(['pending', 'running'].includes(inFlight.body.status), `expected queued/running, got ${inFlight.body.status}`);
  assert.ok(fs.existsSync(daemon.stateDir), 'same isolated state is available to a later HTTP request');
  assert.doesNotThrow(() => process.kill(daemon.pid, 0), 'daemon child survives between HTTP requests');

  const waited = await waitForJob(id, 15000, daemon.port);
  assert.equal(waited.done, true, `job did not finish: ${JSON.stringify(waited.job)}`);

  const completed = await request('GET', `/api/jobs/${id}`, undefined, daemon.port);
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.body.id, id);
  assert.equal(completed.body.status, 'done');
  assert.equal(completed.body.result.status, 'done');
  assert.equal(completed.body.result.summary, 'async mock job completed independently');
  assert.equal(typeof completed.body.result.finishedAt, 'string');

  // Exercise the public MCP facade against the same daemon, rather than only
  // its raw HTTP representation.
  const mcpResult = await callTool({ name: 'get_job_result', arguments: { id } }, {
    daemonRequest: async (requestPath, body) => {
      const response = await request(body === undefined ? 'GET' : 'POST', requestPath, body, daemon.port);
      return { statusCode: response.statusCode, value: response.body };
    },
  });
  assert.equal(mcpResult.isError, undefined);
  assert.equal(mcpResult.structuredContent.id, id);
  assert.equal(mcpResult.structuredContent.status, 'done');
  assert.equal(mcpResult.structuredContent.result.status, 'done');
});
