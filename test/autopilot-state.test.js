'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  beginReviewAttempt,
  failReviewAttempt,
  createJob,
  createJobStore,
  markTerminal,
  recordCiState,
  recordCorrectiveCycle,
  recordDelivery,
  recordFailure,
  recordPullRequest,
  recordMerge,
  recordIssueReconciled,
  recordReview,
  recordVerification,
  hasPassingVerification,
  recordReviewSkip,
  resolveStateDir,
  selectIssueForJobs,
  summarizeRalphAttempt,
} = require('../src/autopilot-state');
const { selectReadyIssue } = require('../src/autopilot-github');

const temporaryDirectories = new Set();

test.afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-state-'));
  temporaryDirectories.add(directory);
  return directory;
}

function newJob(store, number = 7, title = 'Fix totals') {
  return createJob({
    projectName: 'finance-dashboard',
    repo: 'example/finance',
    issue: { number, title },
    branch: `ralph/issue-${number}-fix-totals`,
    worktreePath: `/worktrees/issue-${number}`,
    now: store.now,
  });
}

test('persists the delivered branch and commit and rejects a foreign branch', () => {
  const directory = temporaryDirectory();
  const store = createJobStore(directory);
  const job = newJob(store, 9);
  assert.deepEqual(job.delivery, { branch: null, commit: null, pushed: false });

  recordDelivery(job, { branch: 'ralph/issue-9-fix-totals', commit: 'abc123', pushed: true });
  store.save(job);
  assert.deepEqual(createJobStore(directory).load(9).delivery, { branch: 'ralph/issue-9-fix-totals', commit: 'abc123', pushed: true });

  assert.throws(() => recordDelivery(job, { branch: 'main', commit: 'def456', pushed: true }), /does not match job branch/);
  assert.equal(job.delivery.commit, 'abc123');
});

test('a newly delivered commit invalidates an approval for the prior head', () => {
  const store = createJobStore(temporaryDirectory());
  const job = newJob(store, 10);
  recordDelivery(job, { branch: job.branch, commit: 'abc123', pushed: true });
  recordReview(job, { reviewer: 'claude:sonnet', verdict: 'PASS', commit: 'abc123', policy: 'always', attempt: beginReviewAttempt(job) });
  recordDelivery(job, { branch: job.branch, commit: 'def456', pushed: true });
  store.save(job);
  assert.equal(createJobStore(store.directory).load(10).review, null);
});

test('review skip evidence survives reload and is invalidated by a new delivered SHA', () => {
  const store = createJobStore(temporaryDirectory(), { now: () => '2026-10-11T00:00:00.000Z' });
  const job = newJob(store, 14);
  recordDelivery(job, { commit: 'abc123' });
  recordReviewSkip(job, { commit: 'abc123', reason: '  Documentation-only change covered by documentation checks.  ' }, store.now);
  store.save(job);
  const reloaded = createJobStore(store.directory).load(14);
  assert.deepEqual(reloaded.reviewSkip, {
    policy: 'none', commit: 'abc123', reason: 'Documentation-only change covered by documentation checks.',
    recordedAt: '2026-10-11T00:00:00.000Z',
  });
  recordDelivery(reloaded, { commit: 'def456' });
  store.save(reloaded);
  assert.equal(createJobStore(store.directory).load(14).reviewSkip, null);
});

test('invalid skip reasons and malformed persisted skip evidence fail closed', () => {
  const store = createJobStore(temporaryDirectory());
  const job = newJob(store, 15);
  recordDelivery(job, { commit: 'abc123' });
  for (const reason of [undefined, null, '', ' \n\t ', 42, 'x'.repeat(4001)]) {
    assert.throws(() => recordReviewSkip(job, { commit: 'abc123', reason }), /skip reason/i);
    assert.equal(job.reviewSkip, null);
  }
  assert.throws(() => recordReviewSkip(job, { commit: 'def456', reason: 'Documentation-only change.' }), /exact delivered commit/);
  recordReviewSkip(job, { commit: 'abc123', reason: 'Documentation-only change covered by documentation checks.' });
  for (const corrupt of [
    { ...job.reviewSkip, reason: '  ' },
    { ...job.reviewSkip, reason: 'x'.repeat(4001) },
    { ...job.reviewSkip, policy: 'always' },
    { ...job.reviewSkip, commit: '' },
    { ...job.reviewSkip, recordedAt: '' },
  ]) {
    assert.throws(() => store.save({ ...job, reviewSkip: corrupt }), /invalid review skip state/);
  }
});

test('verification evidence is checkpointed before delivery, bound once, and preserved across delivery restart', () => {
  const store = createJobStore(temporaryDirectory());
  const job = newJob(store, 16);
  const verification = { passed: true, exitCode: 0, timedOut: false, stdout: 'tests passed\n', stderr: 'lint clean\n' };
  recordVerification(job, 'npm test && npm run lint', verification);
  store.save(job);
  const reloaded = createJobStore(store.directory).load(16);
  assert.deepEqual(reloaded.verification, { command: 'npm test && npm run lint', commit: null, ...verification });
  assert.equal(hasPassingVerification(reloaded.verification, 'abc123'), false);
  recordDelivery(reloaded, { commit: 'abc123', pushed: false });
  store.save(reloaded);
  const afterCommit = createJobStore(store.directory).load(16);
  assert.equal(hasPassingVerification(afterCommit.verification, 'abc123'), true);
  recordDelivery(afterCommit, { commit: 'abc123', pushed: true });
  assert.deepEqual(afterCommit.verification, reloaded.verification);
  recordDelivery(afterCommit, { commit: 'def456', pushed: true });
  assert.equal(afterCommit.verification, null, 'another SHA cannot reuse or rebind old evidence');
  recordVerification(afterCommit, 'npm test', { ...verification, stdout: 'corrected tests passed\n' });
  recordDelivery(afterCommit, { commit: 'def456' });
  store.save(afterCommit);
  assert.equal(hasPassingVerification(createJobStore(store.directory).load(16).verification, 'def456'), true);
});

test('verification evidence bounds test output and rejects malformed persisted records', () => {
  const store = createJobStore(temporaryDirectory());
  const job = newJob(store, 17);
  const verification = { passed: true, exitCode: 0, timedOut: false, stdout: 'x'.repeat(10000) + 'test summary', stderr: '' };
  recordVerification(job, 'npm test', verification);
  assert.equal(job.verification.stdout.length, 4000);
  assert.ok(job.verification.stdout.endsWith('test summary'));
  for (const corrupt of [
    { ...job.verification, command: '' },
    { ...job.verification, stdout: undefined },
    { ...job.verification, stderr: 'x'.repeat(4001) },
    { ...job.verification, exitCode: '0' },
    { ...job.verification, passed: 'true' },
  ]) {
    assert.throws(() => store.save({ ...job, verification: corrupt }), /invalid deterministic verification state/);
  }
});

test('persists review policy, structured findings, and attempt metadata with the verdict and exact SHA', () => {
  const store = createJobStore(temporaryDirectory(), { now: () => '2026-10-11T00:00:00.000Z' });
  const job = newJob(store, 11);
  const sha = '0123456789abcdef0123456789abcdef01234567';
  recordDelivery(job, { branch: job.branch, commit: sha, pushed: true });
  const first = beginReviewAttempt(job, () => '2026-10-11T00:00:01.000Z');
  recordReview(job, {
    reviewer: 'claude:opus', verdict: 'NEEDS_CHANGES', commit: sha, policy: 'risk', attempt: first,
    findings: [{ summary: '  Totals ignore refunds ', file: 'src/totals.js', line: 42, severity: 'high' }, { summary: 'Add a regression test' }],
  }, () => '2026-10-11T00:00:02.000Z');
  store.save(job);
  const reloaded = createJobStore(store.directory).load(11);
  assert.equal(reloaded.reviewAttempts, 1);
  assert.deepEqual(reloaded.review, {
    reviewer: 'claude:opus', verdict: 'NEEDS_CHANGES', commit: sha, policy: 'risk',
    findings: [
      { summary: 'Totals ignore refunds', file: 'src/totals.js', line: 42, severity: 'high' },
      { summary: 'Add a regression test', file: null, line: null, severity: null },
    ],
    attempt: { number: 1, startedAt: '2026-10-11T00:00:01.000Z', completedAt: '2026-10-11T00:00:02.000Z' },
  });

  const second = beginReviewAttempt(job, () => '2026-10-11T00:01:00.000Z');
  recordReview(job, { reviewer: 'claude:opus', verdict: 'PASS', commit: sha, policy: 'risk', findings: [], attempt: second }, () => '2026-10-11T00:01:30.000Z');
  store.save(job);
  assert.deepEqual(createJobStore(store.directory).load(11).review, {
    reviewer: 'claude:opus', verdict: 'PASS', commit: sha, policy: 'risk', findings: [],
    attempt: { number: 2, startedAt: '2026-10-11T00:01:00.000Z', completedAt: '2026-10-11T00:01:30.000Z' },
  });
});

test('rejects review records that omit policy or attempt metadata or mismatch findings and verdict', () => {
  const store = createJobStore(temporaryDirectory());
  const job = newJob(store, 12);
  const attempt = beginReviewAttempt(job);
  const base = { reviewer: 'claude:sonnet', commit: 'abc123', policy: 'always', attempt };
  assert.throws(() => recordReview(job, { ...base, verdict: 'PASS', policy: 'none' }), /risk or always policy/);
  assert.throws(() => recordReview(job, { ...base, verdict: 'PASS', attempt: undefined }), /attempt metadata/);
  assert.throws(() => recordReview(job, { ...base, verdict: 'PASS', attempt: { number: 2, startedAt: 'x' } }), /attempt metadata/);
  assert.throws(() => recordReview(job, { ...base, verdict: 'PASS', findings: 'still broken' }), /PASS review must have no findings/);
  assert.throws(() => recordReview(job, { ...base, verdict: 'NEEDS_CHANGES', findings: [] }), /PASS review must have no findings/);
  assert.throws(() => recordReview(job, { ...base, verdict: 'NEEDS_CHANGES', findings: [{ summary: 'x', line: 0 }] }), /positive line/);
  assert.equal(job.review, null);

  // Damaged persisted review records fail closed on load.
  recordReview(job, { ...base, verdict: 'NEEDS_CHANGES', findings: 'Fix it' });
  assert.deepEqual(job.review.findings, [{ summary: 'Fix it', file: null, line: null, severity: null }]);
  for (const corrupt of [
    { ...job.review, policy: 'none' },
    { ...job.review, findings: [] },
    { ...job.review, attempt: { ...job.review.attempt, number: 5 } },
    { ...job.review, findings: [{ summary: '' }] },
  ]) {
    assert.throws(() => store.save({ ...job, review: corrupt }), /invalid independent review state/);
  }
});

test('legacy PASS-only review records written before review metadata remain readable', () => {
  const store = createJobStore(temporaryDirectory());
  const job = newJob(store, 13);
  delete job.reviewAttempts;
  job.review = { reviewer: 'claude:sonnet', verdict: 'PASS', commit: 'abc123' };
  store.save(job);
  assert.deepEqual(createJobStore(store.directory).load(13).review, job.review);
  job.review = { reviewer: 'claude:sonnet', verdict: 'NEEDS_CHANGES', commit: 'abc123' };
  assert.throws(() => store.save(job), /invalid independent review state/);
});

test('review history retains verdicts across delivered SHAs and sanitized failures across reload', () => {
  const store = createJobStore(temporaryDirectory());
  const job = newJob(store, 18);
  recordDelivery(job, { commit: 'abc123' });
  recordCiState(job, { state: 'green', requiredWorkflow: 'CI', headCommit: 'abc123', runs: [], observedAt: '2026-10-12T00:00:00.000Z' });
  const first = beginReviewAttempt(job, store.now, { reviewer: 'claude:opus', model: 'opus', policy: 'always', commit: 'abc123' });
  recordReview(job, { reviewer: 'claude:opus', verdict: 'NEEDS_CHANGES', commit: 'abc123', policy: 'always', findings: 'Validate totals.', attempt: first }, store.now);
  store.save(job);
  const checkpoint = structuredClone(job.reviewHistory[0]);
  recordDelivery(job, { commit: 'def456' });
  assert.equal(job.review, null);
  assert.equal(job.ci, null, 'a prior head CI result is not current evidence for a correction');
  assert.deepEqual(job.reviewHistory[0], checkpoint);
  const second = beginReviewAttempt(job, store.now, { reviewer: 'claude:opus', model: 'opus', policy: 'always', commit: 'def456' });
  const failed = failReviewAttempt(job, second.number, new Error('malformed verdict JSON token=secret-value'), store.now);
  assert.equal(failed.status, 'invalid_verdict');
  assert.doesNotMatch(failed.diagnostics, /secret-value/);
  assert.throws(() => recordReview(job, { reviewer: 'claude:opus', verdict: 'PASS', commit: 'def456', policy: 'always', attempt: second }), /running attempt/);
  assert.equal(job.review, null);
  store.save(job);
  assert.deepEqual(createJobStore(store.directory).load(18).reviewHistory, job.reviewHistory);
  assert.equal(job.reviewHistory.length, 2);
  assert.throws(() => beginReviewAttempt(job, store.now, { reviewer: 'claude:opus', model: 'opus', policy: 'always', commit: 'def456' }), /history capacity/);
  assert.equal(job.reviewAttempts, 2);
});

test('corrupt review attempt history fails closed while older jobs without history still load', () => {
  const store = createJobStore(temporaryDirectory());
  const job = newJob(store, 19);
  const attempt = beginReviewAttempt(job, store.now, { reviewer: 'claude:sonnet', model: 'sonnet', policy: 'risk', commit: 'abc123' });
  failReviewAttempt(job, attempt.number, new Error('authentication failed: private-token'), store.now);
  for (const corrupt of [
    { ...job.reviewHistory[0], number: 3 },
    { ...job.reviewHistory[0], reviewer: '' },
    { ...job.reviewHistory[0], model: '' },
    { ...job.reviewHistory[0], policy: 'none' },
    { ...job.reviewHistory[0], commit: '' },
    { ...job.reviewHistory[0], status: 'APPROVE' },
    { ...job.reviewHistory[0], verdict: 'PASS' },
    { ...job.reviewHistory[0], completedAt: null },
    { ...job.reviewHistory[0], diagnostics: 'x'.repeat(4001) },
  ]) assert.throws(() => store.save({ ...job, reviewHistory: [corrupt] }), /invalid review attempt history/);
  assert.throws(() => store.save({ ...job, reviewHistory: [job.reviewHistory[0], job.reviewHistory[0]] }), /invalid review attempt history/);
  delete job.reviewHistory;
  store.save(job);
  assert.equal(createJobStore(store.directory).load(19).reviewHistory, undefined);
});

test('persists every job field and reloads it through a fresh store', () => {
  const directory = temporaryDirectory();
  const store = createJobStore(directory, { now: () => '2026-10-03T00:00:00.000Z' });
  const job = newJob(store);
  job.runs = 1;
  job.status = 'passed';
  job.baseRef = 'origin/main';
  job.ralph = { status: 'passed', attempts: 2, taskId: 'autopilot:example/finance#7' };
  recordPullRequest(job, { number: 31, url: 'https://github.com/example/finance/pull/31' });
  recordCiState(job, 'red', 'pytest failed');
  recordCorrectiveCycle(job);
  recordFailure(job, 'ci', new Error('pytest failed'), store.now);
  store.save(job);

  const reloaded = createJobStore(directory).load(7);
  assert.deepEqual(reloaded, job);
  assert.equal(reloaded.issue.title, 'Fix totals');
  assert.equal(reloaded.branch, 'ralph/issue-7-fix-totals');
  assert.equal(reloaded.worktreePath, '/worktrees/issue-7');
  assert.deepEqual(reloaded.pr, { number: 31, url: 'https://github.com/example/finance/pull/31' });
  assert.deepEqual(reloaded.ci, { state: 'red', details: 'pytest failed' });
  assert.equal(reloaded.correctiveCycles, 1);
  assert.deepEqual(reloaded.failures, [{ at: '2026-10-03T00:00:00.000Z', run: 1, phase: 'ci', message: 'pytest failed' }]);
  assert.equal(reloaded.terminal, false);
  assert.deepEqual(createJobStore(directory).list().map(value => value.issue.number), [7]);
});

test('persists normalized CI observations with workflow run identifiers', () => {
  const directory = temporaryDirectory();
  const store = createJobStore(directory, { now: () => '2026-10-03T00:00:00.000Z' });
  const job = newJob(store);
  const runs = [{ databaseId: 77, status: 'completed', conclusion: 'failure', name: 'test', workflowName: 'CI', url: 'https://example/run/77', startedAt: null, updatedAt: null }];
  recordCiState(job, { state: 'red', details: 'CI (#77): completed/failure', prNumber: 31, headCommit: 'abc123', runs });
  store.save(job);

  const reloaded = createJobStore(directory).load(7);
  assert.deepEqual(reloaded.ci, { state: 'red', details: 'CI (#77): completed/failure', prNumber: 31, headCommit: 'abc123', runs });
  assert.throws(() => recordCiState(job, { state: 'failure', runs: [] }), /pending, green, or red/);
  assert.throws(() => recordCiState(job, { state: 'green', runs: [{ databaseId: 0, status: 'completed' }] }), /normalized workflow runs/);
});

test('persists a bounded, exact-head CI status projection without Action logs', () => {
  const directory = temporaryDirectory();
  const store = createJobStore(directory);
  const job = newJob(store);
  recordCiState(job, {
    state: 'pending', requiredWorkflow: 'CI', prNumber: 31, headCommit: 'abc123',
    observedAt: '2026-10-12T12:00:00.000Z', details: 'untrusted details are not projected',
    runs: [{ databaseId: 77, status: 'in_progress', conclusion: null, workflowName: 'CI',
      url: 'https://github.com/example/repo/actions/runs/77?token=private',
      name: null, startedAt: null, updatedAt: null,
      jobId: 88, jobName: 'test', stepName: 'Test', stepStatus: 'in_progress' }],
  });
  store.save(job);
  assert.deepEqual(createJobStore(directory).load(7).ci.observation, {
    status: 'queued_or_running', requiredWorkflow: 'CI', prNumber: 31, headCommit: 'abc123',
    observedAt: '2026-10-12T12:00:00.000Z', reason: 'Required CI workflow "CI" is in_progress.',
    run: { id: 77, url: 'https://github.com/example/repo/actions/runs/77', status: 'in_progress',
      jobId: 88, jobName: 'test', stepName: 'Test', stepStatus: 'in_progress' },
  });
});

test('matches slash-containing workflow names before sanitizing their status projection', () => {
  const store = createJobStore(temporaryDirectory());
  const job = newJob(store);
  recordCiState(job, {
    state: 'green', requiredWorkflow: 'Build/Test', prNumber: 31, headCommit: 'abc123',
    runs: [{ databaseId: 78, status: 'completed', conclusion: 'success', workflowName: 'Build/Test',
      url: 'https://github.com/example/repo/actions/runs/78', name: null, startedAt: null, updatedAt: null }],
  });
  assert.equal(job.ci.observation.status, 'green');
  assert.equal(job.ci.observation.requiredWorkflow, 'Build/Test');
  assert.equal(job.ci.observation.run.id, 78);
});

test('rejects unbounded or unsafe persisted CI observation fields', () => {
  const store = createJobStore(temporaryDirectory());
  const job = newJob(store);
  recordCiState(job, { state: 'pending', requiredWorkflow: 'CI', runs: [] });
  for (const observation of [
    { ...job.ci.observation, requiredWorkflow: 'x'.repeat(513) },
    { ...job.ci.observation, run: { id: 1, status: 'x'.repeat(513) } },
    { ...job.ci.observation, run: { id: 1, status: 'completed', url: 'https://example.invalid/run?token=private' } },
  ]) assert.throws(() => store.save({ ...job, ci: { ...job.ci, observation } }), /invalid CI state/);
});

test('persists red CI diagnostics and the single corrective cycle before correction', () => {
  const directory = temporaryDirectory();
  const store = createJobStore(directory, { now: () => '2026-10-03T00:00:00.000Z' });
  const job = newJob(store);
  recordCiState(job, { state: 'red', details: 'CI (#77): completed/failure', headCommit: 'abc123', diagnostics: 'pytest failed' });
  recordCorrectiveCycle(job, { redCommit: 'abc123', diagnostics: 'pytest failed' });
  store.save(job);

  const reloaded = createJobStore(directory).load(7);
  assert.equal(reloaded.ci.diagnostics, 'pytest failed');
  assert.deepEqual(reloaded.correction, { cycle: 1, status: 'eligible', redCommit: 'abc123', diagnostics: 'pytest failed', commit: null });
  assert.equal(reloaded.correctiveCycles, 1);
  assert.throws(() => recordCorrectiveCycle(job, { redCommit: 'abc123' }), /only one CI corrective cycle/);
  assert.throws(() => recordCiState(job, { state: 'red', diagnostics: 7 }), /diagnostics must be a string/);

  const long = 'x'.repeat(50000);
  recordCiState(job, { state: 'red', diagnostics: long });
  assert.ok(job.ci.diagnostics.length <= 16000);
  job.correction.status = 'bogus';
  assert.throws(() => store.save(job), /invalid corrective cycle state/);
});

test('writes atomically and leaves no temporary files behind', () => {
  const directory = temporaryDirectory();
  const store = createJobStore(directory);
  const job = newJob(store);
  store.save(job);
  job.status = 'running';
  store.save(job);
  assert.deepEqual(fs.readdirSync(directory), ['issue-7.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'issue-7.json'), 'utf8')).status, 'running');
});

test('missing state is empty but malformed state is never silently ignored', () => {
  const directory = temporaryDirectory();
  assert.deepEqual(createJobStore(path.join(directory, 'missing')).list(), []);
  assert.equal(createJobStore(directory).load(3), null);
  fs.writeFileSync(path.join(directory, 'issue-3.json'), '{"schemaVersion": 1, ');
  // A leftover temporary file from an interrupted write is not a job.
  fs.writeFileSync(path.join(directory, '.issue-4.json.1.tmp'), 'partial');
  assert.throws(() => createJobStore(directory).load(3), /malformed/);
  assert.throws(() => createJobStore(directory).list(), /malformed/);
});

test('rejects an incomplete recovery record instead of treating it as a fresh job', () => {
  const directory = temporaryDirectory();
  const job = newJob(createJobStore(directory));
  delete job.branch;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'issue-7.json'), JSON.stringify(job));
  assert.throws(() => createJobStore(directory).load(7), /missing branch/);
});

test('rejects recovery records that omit a required field or corrupt diagnostics', () => {
  const directory = temporaryDirectory();
  const store = createJobStore(directory);
  const job = newJob(store);
  delete job.baseRef;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'issue-7.json'), JSON.stringify(job));
  assert.throws(() => store.load(7), /invalid base ref/);

  job.baseRef = null;
  job.failures = [{ at: '2026-10-03T00:00:00.000Z', run: 0, phase: 'ralph' }];
  fs.writeFileSync(path.join(directory, 'issue-7.json'), JSON.stringify(job));
  assert.throws(() => store.load(7), /invalid failure diagnostics/);
});

test('terminal state and bounded failure diagnostics survive reload', () => {
  const directory = temporaryDirectory();
  const store = createJobStore(directory);
  const job = newJob(store);
  for (let index = 0; index < 25; index++) recordFailure(job, 'preparing', `failure ${index}`);
  recordFailure(job, 'ralph', 'x'.repeat(10000));
  markTerminal(job, 'needs_planning');
  store.save(job);
  const reloaded = store.load(7);
  assert.equal(reloaded.terminal, true);
  assert.equal(reloaded.terminalState, 'needs_planning');
  assert.equal(reloaded.failures.length, 20);
  assert.ok(reloaded.failures.at(-1).message.length <= 4000);
});

test('per-issue lock blocks a live owner and reclaims a lock from a dead or rebooted owner', () => {
  const directory = temporaryDirectory();
  const live = createJobStore(directory, { pid: 100, bootId: 'boot-a', isProcessAlive: () => true });
  const lock = live.acquire(7);
  assert.throws(() => live.acquire(7), /already owned by running process 100/);
  lock.release();
  live.acquire(7);

  const afterCrash = createJobStore(directory, { pid: 200, bootId: 'boot-a', isProcessAlive: () => false });
  afterCrash.acquire(7).release();

  createJobStore(directory, { pid: 300, bootId: 'boot-a', isProcessAlive: () => true }).acquire(8);
  const afterReboot = createJobStore(directory, { pid: 300, bootId: 'boot-b', isProcessAlive: () => true });
  afterReboot.acquire(8).release();
});

test('selection resumes unfinished jobs first and never restarts terminal or passed jobs', () => {
  const store = createJobStore(temporaryDirectory());
  const issues = [1, 2, 3, 4].map(number => ({ number, title: `Issue ${number}` }));
  const terminal = markTerminal(newJob(store, 1), 'needs_planning');
  const passed = Object.assign(newJob(store, 2), { status: 'passed' });
  const interrupted = Object.assign(newJob(store, 4), { status: 'running' });

  const resumed = selectIssueForJobs(issues, [terminal, passed, interrupted], selectReadyIssue);
  assert.equal(resumed.issue.number, 4);
  assert.equal(resumed.job, interrupted);

  const fresh = selectIssueForJobs(issues, [terminal, passed], selectReadyIssue);
  assert.equal(fresh.issue.number, 3);
  assert.equal(fresh.job, null);
  assert.equal(selectIssueForJobs(issues.slice(0, 2), [terminal, passed], selectReadyIssue), null);
});

test('state directory defaults per project and honors a configured override', () => {
  assert.equal(resolveStateDir('finance-dashboard', {}, '/state'), path.join('/state', 'finance-dashboard'));
  assert.equal(resolveStateDir('finance-dashboard', { stateDir: '/custom' }, '/state'), path.resolve('/custom'));
  assert.throws(() => resolveStateDir('../escape', {}, '/state'), /simple project name/);
});

test('summarizes the last Ralph attempt for diagnostics', () => {
  assert.equal(summarizeRalphAttempt({ number: 2, status: 'worker_error', error: { message: 'codex crashed' } }),
    'attempt 2: worker_error: codex crashed');
  assert.match(summarizeRalphAttempt({
    number: 1, status: 'failed', verification: { exitCode: 1, timedOut: false, stdout: '', stderr: 'AssertionError' },
  }), /attempt 1: failed; verification exit 1\nAssertionError/);
  assert.equal(summarizeRalphAttempt(undefined), null);
});

test('merge records require full identity, persist, reconcile issue closure, and reject malformed records on load', () => {
  const directory = temporaryDirectory();
  const store = createJobStore(directory);
  const job = newJob(store);
  assert.throws(() => recordIssueReconciled(job), /requires a recorded merge/);
  for (const bad of [{}, { prNumber: 0, approvedHead: 'a', commit: 'm', repo: 'r' }, { prNumber: 1, approvedHead: '', commit: 'm', repo: 'r' },
    { prNumber: 1, approvedHead: 'a', commit: '', repo: 'r' }, { prNumber: 1, approvedHead: 'a', commit: 'm', repo: '' },
    { prNumber: 1, approvedHead: 'a', commit: 'm', repo: 'r', issueClosed: 'yes' }]) {
    assert.throws(() => recordMerge(job, bad), /Merge state requires/);
  }
  recordMerge(job, { prNumber: 9, approvedHead: 'abc123', commit: 'merge123', repo: 'example/repo' }, () => '2026-10-12T00:00:00.000Z');
  store.save(job);
  assert.deepEqual(store.load(7).merge, { prNumber: 9, approvedHead: 'abc123', commit: 'merge123', repo: 'example/repo', mergedAt: '2026-10-12T00:00:00.000Z', issueClosed: false });
  recordIssueReconciled(job);
  store.save(job);
  assert.equal(store.load(7).merge.issueClosed, true);
  for (const merge of [{ ...job.merge, commit: '' }, { ...job.merge, issueClosed: 'no' }, { ...job.merge, prNumber: -1 }, 'merged']) {
    fs.writeFileSync(path.join(directory, 'issue-7.json'), JSON.stringify({ ...job, merge }));
    assert.throws(() => createJobStore(directory).load(7), /invalid merge state/);
  }
});
