'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDevelopmentJobs } = require('../src/development-jobs');
const { run: runAutopilot } = require('../src/autopilot');
const { createJob, createJobStore, recordVerification, recordDelivery, recordCiState, beginReviewAttempt, recordReview, recordMerge, recordIssueReconciled, markTerminal } = require('../src/autopilot-state');
const { configuredProjects } = require('../src/project-registry');

const fixture = (t, names = ['ralph', 'other']) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-dependency-admission-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'repo');
  fs.mkdirSync(checkout);
  // Admission queues work against a registered directory; Git preparation is
  // exercised by workspace tests and happens later in the runner lifecycle.
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, '{}');
  const projects = Object.fromEntries(names.map(name => [name, {
    enabled: true, autoMerge: true, repo: 'woodsja/AgentLoop', checkout, stateDir: path.join(root, 'state', name),
    worktreeRoot: path.join(root, 'worktrees'), baseBranch: 'main',
    worker: 'codex', reviewPolicy: 'always', readyLabel: 'ready-for-agent',
  }]));
  const selected = [];
  let issueList = [];
  const store = {
    paths: { config: configPath },
    config: { allowedProjects: configuredProjects(Object.fromEntries(names.map(name => [name,
      { root: checkout, worktreeRoot: path.join(root, 'worktrees') }])), configPath) },
    listTasks: () => [],
    enqueueTask: task => { selected.push(task); return { ...task, id: 't-12345678' }; },
    appendLogLine: () => {}, writeTask: () => {},
  };
  const scanner = () => createDevelopmentJobs(store, { admitIntervalMs: 0, autopilotDependencies: {
    loadProjectConfig: name => projects[name], discoverReadyIssues: async project => typeof issueList === 'function' ? issueList(project) : issueList,
  } });
  return { jobs: scanner(), scanner, selected, setIssues: issues => { issueList = issues; }, projects };
};

function approvedMerge(project, number = 1) {
  const job = createJob({ projectName: 'ralph', repo: project.repo,
    issue: { number, title: 'Prerequisite' }, branch: `ralph/issue-${number}-prerequisite`,
    worktreePath: null, now: () => new Date().toISOString() });
  const sha = 'a'.repeat(40);
  recordVerification(job, 'npm test', { passed: true, exitCode: 0, timedOut: false, stdout: 'raw verification evidence', stderr: '' });
  recordDelivery(job, { commit: sha });
  recordCiState(job, { state: 'green', headCommit: sha });
  const attempt = beginReviewAttempt(job, undefined, { reviewer: 'claude:opus', model: 'opus', policy: 'always', commit: sha });
  recordReview(job, { reviewer: 'claude:opus', verdict: 'PASS', commit: sha, policy: 'always', findings: [], attempt });
  recordMerge(job, { prNumber: 5, approvedHead: sha, commit: 'b'.repeat(40), repo: project.repo });
  recordIssueReconciled(job);
  job.status = 'merged';
  markTerminal(job, 'merged');
  return job;
}

function dependencyEvents(project, number) {
  return fs.readFileSync(path.join(project.stateDir, `issue-${number}.execution.ndjson`), 'utf8')
    .trim().split('\n').map(JSON.parse).filter(event => event.event === 'dependency_admission_blocked');
}

test('real R1 admission skips a blocked first issue and admits the independent next issue', async t => {
  const f = fixture(t);
  f.projects.other.enabled = false;
  f.setIssues([{ number: 2, title: 'Blocked', body: 'Depends on: #1' },
    { number: 3, title: 'Free', body: 'No prerequisites for this sufficiently specified issue' }]);
  await f.jobs.admit();
  assert.equal(f.selected.length, 1);
  assert.equal(f.selected[0].issue, 3);
  assert.equal(f.selected[0].project, 'ralph');
});

test('real persisted approved merge unlocks dependent on next admission scan', async t => {
  const fixtureState = fixture(t);
  fixtureState.projects.other.enabled = false;
  fixtureState.setIssues([{ number: 2, title: 'Needs one', body: 'Depends on: #1' }]);
  await fixtureState.jobs.admit();
  assert.equal(fixtureState.selected.length, 0);
  const state = createJobStore(fixtureState.projects.ralph.stateDir);
  const issueOne = { number: 1, title: 'Prerequisite' };
  const job = createJob({ projectName: 'ralph', repo: 'woodsja/AgentLoop', issue: issueOne, branch: 'ralph/issue-1-prerequisite', worktreePath: null, now: () => new Date().toISOString() });
  const sha = 'a'.repeat(40);
  recordVerification(job, 'npm test', { passed: true, exitCode: 0, timedOut: false, stdout: '', stderr: '' });
  recordDelivery(job, { commit: sha });
  recordCiState(job, { state: 'green', headCommit: sha });
  const attempt = beginReviewAttempt(job, undefined, { reviewer: 'claude:opus', model: 'opus', policy: 'always', commit: sha });
  recordReview(job, { reviewer: 'claude:opus', verdict: 'PASS', commit: sha, policy: 'always', findings: [], attempt });
  recordMerge(job, { prNumber: 5, approvedHead: sha, commit: 'b'.repeat(40), repo: 'woodsja/AgentLoop' });
  recordIssueReconciled(job);
  job.status = 'merged';
  markTerminal(job, 'merged');
  state.save(job);
  assert.equal(state.load(1).terminalState, 'merged');
  await fixtureState.jobs.admit();
  assert.equal(fixtureState.selected.length, 1);
  assert.equal(fixtureState.selected[0].issue, 2);
});

test('non-Ralph autonomous projects retain prior admission behavior', async t => {
  const fixtureState = fixture(t);
  fixtureState.projects.ralph.enabled = false;
  fixtureState.setIssues([{ number: 2, title: 'Unrelated', body: 'Depends on: #1' }]);
  await fixtureState.jobs.admit();
  assert.equal(fixtureState.selected.length, 1);
  assert.equal(fixtureState.selected[0].project, 'other');
  assert.equal(fixtureState.selected[0].issue, 2);
});

test('R1 daemon must not consume ready labels belonging to the separately scheduled Household autopilot', async t => {
  const f = fixture(t);
  f.projects.other.repo = 'woodsja/household-purchases';
  f.projects.other.dependencyFormat = 'household-blocked-by';
  f.projects.ralph.enabled = false;
  f.setIssues([{ number: 2, title: 'Ready household import', body: '## Blocked by\nNone' }]);
  await f.jobs.admit();
  assert.deepEqual(f.selected, [], 'R1 never admits issues explicitly assigned to the Household scheduler');
  // This exemption must not shut down admission for the original R1 project.
  f.projects.ralph.enabled = true;
  f.setIssues([{ number: 8, title: 'Independent R1 work', body: 'Independent issue without prerequisites' }]);
  await f.jobs.admit();
  assert.equal(f.selected.length, 1);
  assert.equal(f.selected[0].project, 'ralph');
  assert.equal(f.selected[0].issue, 8);
});

test('separate Household autopilot retains admission to issues after R1 yields', async t => {
  const f = fixture(t);
  f.projects.other.repo = 'woodsja/household-purchases';
  f.projects.other.dependencyFormat = 'household-blocked-by';
  f.projects.ralph.enabled = false;
  const state = createJobStore(f.projects.other.stateDir);
  const job = createJob({ projectName: 'other', repo: f.projects.other.repo,
    issue: { number: 1, title: 'Foundation' }, branch: 'ralph/issue-1-foundation',
    worktreePath: null, now: () => new Date().toISOString() });
  const sha = 'a'.repeat(40);
  recordVerification(job, 'npm test', { passed: true, exitCode: 0, timedOut: false, stdout: '', stderr: '' });
  recordDelivery(job, { commit: sha });
  recordCiState(job, { state: 'green', headCommit: sha });
  const attempt = beginReviewAttempt(job, undefined, { reviewer: 'claude:opus', model: 'opus', policy: 'always', commit: sha });
  recordReview(job, { reviewer: 'claude:opus', verdict: 'PASS', commit: sha, policy: 'always', findings: [], attempt });
  recordMerge(job, { prNumber: 16, approvedHead: sha, commit: 'b'.repeat(40), repo: f.projects.other.repo });
  recordIssueReconciled(job);
  job.status = 'merged';
  markTerminal(job, 'merged');
  state.save(job);
  const candidates = [{ number: 2, title: 'Import purchase data', body: '## Blocked by\n- #1: Foundation' }];
  const selected = await runAutopilot(['--project', 'other', '--dry-run'], {
    loadProjectConfig: () => f.projects.other,
    discoverReadyIssues: async () => candidates,
    jobStore: state,
    write: () => {},
  });
  assert.equal(selected.number, 2);
  f.setIssues(candidates);
  await f.jobs.admit();
  assert.deepEqual(f.selected, [], 'only standalone autopilot may admit this project');
});

test('real admission rejects persisted insufficient evidence and still selects independent work', async t => {
  const cases = {
    'GitHub closed without merge': job => { job.merge = null; },
    'failed job': job => { job.terminalState = 'failed'; job.status = 'failed'; },
    'nonterminal job': job => { job.terminal = false; job.terminalState = null; },
    'wrong project in same store': job => { job.project = 'finance-dashboard'; },
    'wrong repository in same store': job => { job.repo = 'other/AgentLoop'; },
    'unreviewed job': job => { job.review = null; },
    'worker approval': job => { job.review.reviewer = 'codex'; },
    'review findings': job => {
      job.review.verdict = 'NEEDS_CHANGES';
      job.review.findings = [{ summary: 'Unresolved defect', file: null, severity: null, line: null }];
    },
    'stale review': job => { job.review.commit = 'c'.repeat(40); },
    'legacy approval without findings evidence': job => { delete job.review.policy; delete job.review.findings; delete job.review.attempt; },
    'stale verification': job => { job.verification.commit = 'c'.repeat(40); },
    'failed verification': job => { job.verification.passed = false; job.verification.exitCode = 1; },
    'timed out verification': job => { job.verification.timedOut = true; },
    'red CI': job => { job.ci.state = 'red'; },
    'stale CI': job => { job.ci.headCommit = 'c'.repeat(40); },
    'wrong approved merge head': job => { job.merge.approvedHead = 'c'.repeat(40); },
    'wrong merge repository': job => { job.merge.repo = 'other/AgentLoop'; },
    'unreconciled issue': job => { job.merge.issueClosed = false; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async t => {
    const f = fixture(t);
    f.projects.other.enabled = false;
    const job = approvedMerge(f.projects.ralph);
    change(job);
    const state = createJobStore(f.projects.ralph.stateDir);
    state.save(job);
    assert.ok(state.load(1), 'exercise real validated durable state');
    f.setIssues([{ number: 3, title: 'Blocked', body: 'Depends on: #1' },
      { number: 4, title: 'Independent', body: 'Ordinary independent issue' }]);
    await f.jobs.admit();
    assert.deepEqual(f.selected.map(task => task.issue), [4]);
    assert.match(dependencyEvents(f.projects.ralph, 3)[0].message, /#1/);
  });
});

test('all prerequisites require evidence from this project store and exact issue', async t => {
  const f = fixture(t);
  f.projects.other.enabled = false;
  const state = createJobStore(f.projects.ralph.stateDir);
  state.save(approvedMerge(f.projects.ralph, 1));
  state.save(approvedMerge(f.projects.ralph, 4)); // another issue cannot satisfy #2
  createJobStore(f.projects.other.stateDir).save(approvedMerge(f.projects.ralph, 2));
  f.setIssues([{ number: 3, title: 'Needs both', body: 'Depends on: #1, #2' }]);
  await f.jobs.admit();
  assert.deepEqual(f.selected, []);
  assert.match(dependencyEvents(f.projects.ralph, 3)[0].message, /prerequisites: #2$/);
  state.save(approvedMerge(f.projects.ralph, 2));
  await f.jobs.admit();
  assert.deepEqual(f.selected.map(task => task.issue), [3]);
  assert.equal(state.load(1).verification.stdout, 'raw verification evidence');
});

test('real admission accepts eight approved prerequisites on a dedicated CRLF metadata line', async t => {
  const f = fixture(t);
  f.projects.other.enabled = false;
  const state = createJobStore(f.projects.ralph.stateDir);
  for (let number = 1; number <= 8; number++) state.save(approvedMerge(f.projects.ralph, number));
  f.setIssues([{ number: 9, title: 'All prerequisites merged',
    body: 'Specification\r\nDepends on: #1, #2, #3, #4, #5, #6, #7, #8\r\nReady to implement.' }]);
  await f.jobs.admit();
  assert.deepEqual(f.selected.map(task => task.issue), [9]);
});

test('real admission fails closed on malformed markers, self references and cycle edges', async t => {
  const f = fixture(t);
  f.projects.other.enabled = false;
  createJobStore(f.projects.ralph.stateDir).save(approvedMerge(f.projects.ralph));
  const bodies = ['Depends on #1', '**Depends on:** #1', 'Depends on: #1, #1',
    'Depends on: other/repo#1', 'Depends on: #1\nDepends on: #2',
    'Depends on: #1, #2, #3, #4, #5, #6, #7, #8, #9',
    'Depends on: #9007199254740993'];
  const malformed = bodies.map((body, i) => ({ number: 10 + i, title: 'Malformed', body }));
  const cyclic = [{ number: 2, title: 'Self', body: 'Depends on: #2' },
    { number: 3, title: 'Forward cycle edge', body: 'Depends on: #4' },
    { number: 4, title: 'Backward cycle edge', body: 'Depends on: #3' }];
  f.setIssues([...cyclic, ...malformed, { number: 30, title: 'Free', body: 'Independent prose mentions Depends on: #1 inline.' }]);
  await f.jobs.admit();
  assert.deepEqual(f.selected.map(task => task.issue), [30]);
  for (const issue of [...cyclic, ...malformed]) {
    const event = dependencyEvents(f.projects.ralph, issue.number)[0];
    assert.equal(event.project, 'ralph');
    assert.equal(event.repo, f.projects.ralph.repo);
    assert.deepEqual(event.issue, issue);
    assert.ok(event.timestamp);
    assert.match(event.message, issue.number === 4 ? /awaits/ : /metadata blocked/);
    assert.equal(fs.existsSync(path.join(f.projects.ralph.stateDir, `issue-${issue.number}.json`)), false, 'no synthetic job');
  }
});

test('raw diagnostics survive restart, preserve body edits and reappear after clearing a block', async t => {
  const f = fixture(t);
  f.projects.other.enabled = false;
  const issue = { number: 2, title: 'Malformed', body: 'Depends on #1\r\n' + 'owner token=example \u0000 '.repeat(500) };
  f.setIssues([issue]);
  await f.jobs.admit();
  await f.jobs.admit();
  assert.equal(dependencyEvents(f.projects.ralph, 2).length, 1, 'unchanged scans deduplicate');
  assert.deepEqual(dependencyEvents(f.projects.ralph, 2)[0].issue, issue, 'complete raw content retained');
  issue.body += 'edited';
  await f.jobs.admit();
  assert.equal(dependencyEvents(f.projects.ralph, 2).length, 2, 'same message with new body remains evidence');
  await f.scanner().admit();
  assert.equal(dependencyEvents(f.projects.ralph, 2).length, 3, 'fresh scanner retains previous diagnostics');
  f.setIssues([]);
  await f.jobs.admit();
  f.setIssues([issue]);
  await f.jobs.admit();
  assert.equal(dependencyEvents(f.projects.ralph, 2).length, 4, 'cleared cache permits renewed block');
  assert.deepEqual(f.selected, []);
});

for (const failure of ['open', 'flush']) {
  for (const destination of ['same project', 'later project']) {
    test(`diagnostic ${failure} failure preserves ${destination} admission and retries after repair`, async t => {
      // z-other must sort after ralph, or it would hide a prematurely aborted scan.
      const f = fixture(t, ['ralph', 'z-other']);
      const state = createJobStore(f.projects.ralph.stateDir);
      const unsafe = approvedMerge(f.projects.ralph);
      unsafe.review.commit = 'c'.repeat(40);
      state.save(unsafe);
      const blocked = { number: 2, title: 'Unsafe prerequisite', body: 'Depends on: #1\n' + 'Raw owner evidence '.repeat(800) };
      const malformed = { number: 4, title: 'Malformed', body: 'Depends on #1' };
      const free = { number: 3, title: 'Independent', body: 'Ordinary ready issue' };
      f.setIssues(project => project === f.projects.ralph
        ? [blocked, malformed, ...(destination === 'same project' ? [free] : [])]
        : [free]);
      const journal = path.join(f.projects.ralph.stateDir, 'issue-2.execution.ndjson');
      let repair;
      if (failure === 'open') {
        fs.mkdirSync(journal); // deterministic even as root; only this issue is broken
        repair = () => fs.rmdirSync(journal);
      } else {
        // Fail the actual durability barrier only for this issue's file descriptor.
        fs.writeFileSync(journal, '');
        const target = fs.statSync(journal);
        const fsync = fs.fsyncSync;
        const mock = t.mock.method(fs, 'fsyncSync', fd => {
          const stat = fs.fstatSync(fd);
          if (stat.dev === target.dev && stat.ino === target.ino) {
            throw Object.assign(new Error('fixture issue-2 fsync failure'), { code: 'EIO' });
          }
          return fsync(fd);
        });
        repair = () => mock.mock.restore();
        t.after(() => {
          mock.mock.restore();
          require('../src/execution-journal').flush(journal);
        });
      }
      const errors = [];
      const error = console.error;
      t.mock.method(console, 'error', (...args) => { errors.push(args); error(...args); });
      const expected = destination === 'same project' ? 'ralph' : 'z-other';
      await f.jobs.admit();
      assert.deepEqual(f.selected.map(task => [task.project, task.issue]), [[expected, 3]]);
      assert.equal(dependencyEvents(f.projects.ralph, 4).length, 1, 'healthy blocked journal still persists');
      assert.ok(errors.some(args => args.some(value => value instanceof Error
        && (failure === 'open' ? value.code === 'EISDIR' : value.code === 'EIO'))), 'owner receives original write/flush error');
      assert.ok(errors.some(args => args.includes(JSON.stringify({ project: 'ralph', repo: f.projects.ralph.repo,
        issue: blocked, message: 'R1 issue #2 awaits independently approved merged prerequisites: #1' }))), 'owner retains complete failed diagnostic evidence');
      const firstErrors = errors.length;
      await f.jobs.admit();
      assert.ok(errors.length > firstErrors, 'persistent failure is retried, never deduplicated');
      const retained = failure === 'flush' ? fs.readFileSync(journal, 'utf8') : '';
      repair();
      await f.jobs.admit();
      const repaired = fs.readFileSync(journal, 'utf8');
      assert.ok(repaired.startsWith(retained), 'previously written evidence survives repair');
      assert.deepEqual(dependencyEvents(f.projects.ralph, 2).at(-1).issue, blocked);
      const count = dependencyEvents(f.projects.ralph, 2).length;
      await f.jobs.admit();
      assert.equal(dependencyEvents(f.projects.ralph, 2).length, count, 'successful flush enables dedup');
      assert.ok(f.selected.every(task => task.project === expected && task.issue === 3), 'unsafe prerequisite never admitted');
      for (const number of [2, 4]) {
        assert.equal(fs.existsSync(path.join(f.projects.ralph.stateDir, `issue-${number}.json`)), false, 'no synthetic blocked job');
      }
      // Repairing diagnostics does not authorize work; only genuine merge evidence does.
      state.save(approvedMerge(f.projects.ralph));
      await f.jobs.admit();
      assert.deepEqual(f.selected.at(-1).project, 'ralph');
      assert.deepEqual(f.selected.at(-1).issue, 2);
    });
  }
}
