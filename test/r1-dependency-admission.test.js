'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createR1Jobs } = require('../src/r1-jobs');
const { createJob, createJobStore, recordVerification, recordDelivery, recordCiState, beginReviewAttempt, recordReview, recordMerge, recordIssueReconciled, markTerminal } = require('../src/autopilot-state');
const { configuredProjects } = require('../src/project-registry');

const fixture = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-dependency-admission-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'repo');
  fs.mkdirSync(checkout);
  execFileSync('git', ['init', '-q', checkout]);
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, '{}');
  const names = ['ralph', 'other'];
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
  const jobs = createR1Jobs(store, { admitIntervalMs: 0, autopilotDependencies: {
    loadProjectConfig: name => projects[name], discoverReadyIssues: async () => issueList,
  } });
  return { jobs, selected, setIssues: issues => { issueList = issues; }, projects };
};

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
  f.setIssues([{ number: 3, title: 'Blocked downstream', body: '## Blocked by\n- #2: Import purchases' }]);
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
