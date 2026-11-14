'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const state = require('../src/autopilot-state');
const { validateDeploymentCandidate } = require('../src/deploy-preflight');

function fixture(t, content = 'candidate\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout');
  const remote = path.join(root, 'origin.git');
  fs.mkdirSync(checkout);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'ralph-dev');
  git('config', 'user.name', 'Preflight Test');
  git('config', 'user.email', 'preflight@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('init', '--bare', remote);
  // Git itself redirects this configured GitHub URL to a disposable bare repo.
  // No command responses or approval predicates are mocked.
  git('config', `url.${remote}.insteadOf`, 'https://github.com/woodsja/AgentLoop.git');
  git('remote', 'add', 'origin', 'https://github.com/woodsja/AgentLoop.git');
  const commit = text => {
    fs.writeFileSync(path.join(checkout, 'file.txt'), text);
    git('add', '.'); git('commit', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const oldSha = commit('installed\n');
  git('checkout', '-b', 'ralph/issue-28');
  const head = commit(content);
  git('checkout', 'ralph-dev');
  git('merge', '--no-ff', 'ralph/issue-28', '-m', 'approved merge');
  const newSha = git('rev-parse', 'HEAD');
  git('push', 'origin', 'ralph-dev');
  git('reset', '--hard', oldSha);
  const configPath = path.join(root, 'projects.json');
  const project = {
    enabled: true, repo: 'woodsja/AgentLoop', checkout, worktreeRoot: root,
    stateDir: path.join(root, 'state'), baseBranch: 'ralph-dev',
    readyLabel: 'ready-for-agent', humanLabel: 'ready-for-human', worker: 'codex',
    verification: 'npm test && git diff --check', ciWorkflow: 'CI', reviewPolicy: 'always', autoMerge: true,
  };
  const configure = () => fs.writeFileSync(configPath, JSON.stringify({ ralph: project }));
  configure();
  const store = state.createJobStore(project.stateDir);
  const job = state.createJob({ projectName: 'ralph', repo: project.repo, issue: { number: 28, title: 'candidate' },
    branch: 'ralph/issue-28', worktreePath: checkout, now: store.now });
  state.recordVerification(job, project.verification, { passed: true, exitCode: 0, timedOut: false, stdout: 'passed', stderr: '' });
  state.recordDelivery(job, { commit: head });
  state.recordPullRequest(job, { number: 128, url: 'https://github.com/woodsja/AgentLoop/pull/128' });
  state.recordReview(job, { reviewer: 'claude:opus', verdict: 'PASS', commit: head, policy: 'always', findings: [], attempt: state.beginReviewAttempt(job) });
  state.recordCiState(job, { state: 'green', headCommit: head, prNumber: 128, requiredWorkflow: 'CI', runs: [{
    databaseId: 1, workflowName: 'CI', status: 'completed', conclusion: 'success', name: null,
    url: null, startedAt: null, updatedAt: null,
  }] });
  state.recordMerge(job, { prNumber: 128, approvedHead: head, commit: newSha, repo: project.repo, issueClosed: true });
  state.markTerminal(job, 'merged');
  const save = () => store.save(job);
  save();
  return { root, checkout, remote, git, commit, oldSha, newSha, head, job, store, save, project, configure,
    validate: () => validateDeploymentCandidate(28, { configPath }) };
}

// Compare every byte, including config, durable evidence, index, and refs.
function snapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(file)) : [[file, fs.readFileSync(file).toString('base64')]];
  }));
}

test('valid merge returns frozen SHAs without writing any fixture files; already installed is a no-op', async t => {
  const f = fixture(t);
  let before = snapshot(f.root);
  const result = await f.validate();
  assert.deepEqual(result, { oldSha: f.oldSha, newSha: f.newSha, noOp: false });
  assert.ok(Object.isFrozen(result));
  assert.throws(() => { result.newSha = f.oldSha; }, TypeError);
  assert.deepEqual(snapshot(f.root), before);
  f.git('reset', '--hard', f.newSha);
  before = snapshot(f.root);
  assert.deepEqual(await f.validate(), { oldSha: f.newSha, newSha: f.newSha, noOp: true });
  assert.deepEqual(snapshot(f.root), before);
});

test('rejects whitespace in the committed delta even though the checkout is clean', async t => {
  const f = fixture(t, 'bad trailing whitespace  \n');
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.git('diff', '--check'), '');
  f.git('config', 'core.whitespace', '-blank-at-eol,-blank-at-eof,-space-before-tab');
  await assert.rejects(f.validate(), error => /trailing whitespace/.test(error.stdout));
});

for (const kind of ['untracked', 'unstaged', 'staged', 'branch', 'detached', 'origin', 'missing remote ref', 'stale remote tracking ref', 'non-FF']) {
  test(`rejects ${kind}`, async t => {
    const f = fixture(t);
    if (kind === 'untracked') fs.writeFileSync(path.join(f.checkout, 'extra'), 'dirty');
    if (['unstaged', 'staged'].includes(kind)) {
      fs.writeFileSync(path.join(f.checkout, 'file.txt'), 'dirty\n');
      if (kind === 'staged') f.git('add', '.');
    }
    if (kind === 'branch') f.git('checkout', '-b', 'main');
    if (kind === 'detached') f.git('checkout', '--detach');
    if (kind === 'origin') f.git('remote', 'set-url', 'origin', f.remote);
    if (kind === 'missing remote ref') f.git('push', 'origin', ':ralph-dev');
    if (kind === 'stale remote tracking ref') {
      f.git('push', '--force', 'origin', `${f.oldSha}:refs/heads/ralph-dev`);
      f.git('update-ref', 'refs/remotes/origin/ralph-dev', f.newSha);
    }
    if (kind === 'non-FF') f.commit('divergent installed commit\n');
    const before = snapshot(f.root);
    await assert.rejects(f.validate());
    assert.deepEqual(snapshot(f.root), before);
  });
}

const invalidEvidence = {
  unreviewed: j => { j.review = null; },
  stale: j => { j.review.commit = 'a'.repeat(40); },
  foreign: j => { j.merge.repo = 'other/repo'; },
  'foreign job repository': j => { j.repo = 'other/repo'; },
  'wrong project': j => { j.project = 'finance-dashboard'; },
  'not merged': j => { j.terminalState = 'failed'; },
  'wrong approved head': j => { j.merge.approvedHead = 'a'.repeat(40); },
  'worker approval': j => { j.review.reviewer = 'codex'; },
  findings: j => { j.review.verdict = 'NEEDS_CHANGES'; j.review.findings = [{ summary: 'bug', file: null, severity: null, line: null }]; },
  'stale CI': j => { j.ci.headCommit = 'a'.repeat(40); },
  'wrong CI PR': j => { j.ci.prNumber++; },
  'wrong merge PR': j => { j.merge.prNumber++; },
  'missing required CI': j => { j.ci.runs = []; },
  'red required CI': j => { j.ci.runs[0].conclusion = 'failure'; },
  'stale workflow': j => { j.ci.requiredWorkflow = 'Other'; },
  'CI provider failure': j => { j.ci.providerError = true; },
  'newer required CI retry': j => { j.ci.runs.push({ ...j.ci.runs[0], databaseId: 2, status: 'in_progress', conclusion: null }); },
  'red other workflow': j => { j.ci.runs.push({ ...j.ci.runs[0], databaseId: 2, workflowName: 'Other', conclusion: 'failure' }); },
  'failed deterministic tests': j => { j.verification.passed = false; },
  'fake SHA': j => { j.merge.commit = 'a'.repeat(40); },
};
for (const [name, change] of Object.entries(invalidEvidence)) {
  test(`durable evidence fails closed: ${name}`, async t => {
    const f = fixture(t);
    change(f.job); f.save();
    await assert.rejects(f.validate());
  });
}

test('accepts a fast-forward whose target is the exact reviewed head', async t => {
  const f = fixture(t);
  f.git('push', '--force', 'origin', `${f.head}:refs/heads/ralph-dev`);
  f.job.merge.commit = f.head; f.save();
  assert.deepEqual(await f.validate(), { oldSha: f.oldSha, newSha: f.head, noOp: false });
});

test('rejects a real remote commit unrelated to the exact approved head', async t => {
  const f = fixture(t);
  f.git('checkout', '--orphan', 'unrelated');
  const unrelated = f.commit('unrelated\n');
  f.git('push', '--force', 'origin', `${unrelated}:refs/heads/ralph-dev`);
  f.git('checkout', 'ralph-dev');
  f.job.merge.commit = unrelated; f.save();
  await assert.rejects(f.validate(), /exact reviewed head/);
});

test('rejects missing local candidate objects without fetching', async t => {
  const f = fixture(t);
  const remoteGit = (...args) => execFileSync('git', ['--git-dir', f.remote, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const tree = remoteGit('rev-parse', `${f.newSha}^{tree}`);
  const unknown = remoteGit('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit-tree', tree, '-p', f.newSha, '-m', 'remote only');
  remoteGit('update-ref', 'refs/heads/ralph-dev', unknown);
  f.job.merge.commit = unknown; f.save();
  const before = snapshot(f.root);
  await assert.rejects(f.validate());
  assert.deepEqual(snapshot(f.root), before);
});

test('missing or malformed durable evidence fails closed; no state is created', async t => {
  const f = fixture(t);
  const file = path.join(f.store.directory, 'issue-28.json');
  fs.writeFileSync(file, '{');
  await assert.rejects(f.validate(), /malformed/);
  fs.rmSync(f.store.directory, { recursive: true });
  await assert.rejects(f.validate(), /MERGED evidence/);
  assert.equal(fs.existsSync(f.store.directory), false);
});

test('owner configuration must retain Ralph deployment branch and review policy', async t => {
  const f = fixture(t);
  f.project.baseBranch = 'main'; f.configure();
  await assert.rejects(f.validate(), /owner Ralph policy/);
  f.project.baseBranch = 'ralph-dev'; f.project.reviewPolicy = 'none'; f.configure();
  await assert.rejects(f.validate(), /owner Ralph policy/);
});
