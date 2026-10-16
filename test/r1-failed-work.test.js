'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { captureFailedWork } = require('../src/r1-failed-work');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-failed-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), workspace = path.join(root, 'worktrees', 'issue-75');
  fs.mkdirSync(repo, { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.test');
  fs.mkdirSync(path.join(repo, 'src')); fs.mkdirSync(path.join(repo, 'tests'));
  fs.writeFileSync(path.join(repo, 'src', 'feature.py'), 'def feature():\n    return 1\n');
  fs.writeFileSync(path.join(repo, 'tests', 'test_feature.py'), 'def test_feature():\n    assert True\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.venv/\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Base');
  git(repo, 'worktree', 'add', '-qb', 'ralph/issue-75-feature', workspace);
  const baseline = git(workspace, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(workspace, 'src', 'feature.py'), 'def feature():\n    return 42\n');
  fs.writeFileSync(path.join(workspace, 'tests', 'test_feature.py'), 'def test_feature():\n    assert 42 == 42\n');
  fs.writeFileSync(path.join(workspace, 'PLAN.md'), '- implementation only\n');
  fs.writeFileSync(path.join(workspace, 'STATE.md'), '# worker scratchpad\n');
  fs.writeFileSync(path.join(workspace, 'GUIDELINES.md'), '# private guidance\n');
  const project = { repo: 'example/repo', checkout: repo, worktreeRoot: path.dirname(workspace),
    implementationStrategy: 'worker-critic-loop', recoveryPaths: ['src/feature.py', 'tests/test_feature.py'] };
  const job = { project: 'demo', repo: 'example/repo', issue: { number: 75 }, runs: 1,
    worktreePath: workspace, ralph: { baselineSha: baseline }, delivery: null };
  const owner = { parentJobId: 't-12345678', childLoopId: 't-1234567890abcdef12345678', attempt: 1,
    childTerminal: true, childStatus: 'incomplete' };
  const stateRoot = path.join(root, 'state');
  return { root, repo, workspace, project, job, owner, stateRoot, git, baseline };
}

function capture(f, additions = {}) {
  return captureFailedWork({ project: f.project, job: f.job, owner: f.owner,
    workspace: { worktreePath: f.workspace, branch: 'ralph/issue-75-feature' },
    stateRoot: f.stateRoot, ...additions });
}

test('failed implementation survives workspace cleanup as owner-bound, digest-verified patch', t => {
  const f = setup(t);
  const receipt = capture(f);
  assert.equal(receipt.parentJobId, f.owner.parentJobId);
  assert.equal(receipt.childLoopId, f.owner.childLoopId);
  assert.equal(receipt.baselineSha, f.baseline);
  assert.deepEqual(receipt.paths, ['src/feature.py', 'tests/test_feature.py']);
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  const artifact = path.join(f.stateRoot, receipt.patchRelativePath);
  const patch = fs.readFileSync(artifact);
  assert.equal(crypto.createHash('sha256').update(patch).digest('hex'), receipt.sha256);
  assert.match(String(patch), /return 42/);
  assert.doesNotMatch(String(patch), /PLAN.md|STATE.md|GUIDELINES.md|private guidance/);
  assert.equal(fs.statSync(artifact).mode & 0o777, 0o600);
  const repeat = capture(f);
  assert.deepEqual(repeat, receipt);
  f.git(f.repo, 'worktree', 'remove', '--force', f.workspace);
  assert.equal(fs.existsSync(f.workspace), false);
  assert.equal(fs.existsSync(artifact), true);
  assert.match(fs.readFileSync(artifact, 'utf8'), /return 42/);
});

test('missing source allowlist blocks recovery instead of silently archiving files', t => {
  const f = setup(t); delete f.project.recoveryPaths;
  assert.throws(() => capture(f), /allowlist|recoveryPaths/);
  assert.equal(fs.existsSync(f.stateRoot), false);
  assert.equal(fs.existsSync(f.workspace), true);
});

test('unexpected source file and secret text refuse capture and leave worktree untouched', t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.workspace, '.env'), 'REAL_TOKEN=some-secret\n');
  assert.throws(() => capture(f), /untracked|unexpected/);
  fs.rmSync(path.join(f.workspace, '.env'));
  fs.writeFileSync(path.join(f.workspace, 'src', 'feature.py'), 'api_key = "sk-demo-secret"\n');
  assert.throws(() => capture(f), /secret|credential|sensitive/i);
  assert.equal(fs.existsSync(f.workspace), true);
});

test('ownership, active process, changed baseline, and symlink fail closed', t => {
  const f = setup(t);
  assert.throws(() => capture(f, { owner: { ...f.owner, childTerminal: false } }), /terminal/);
  assert.throws(() => capture(f, { owner: { ...f.owner, attempt: 2 } }), /attempt/);
  assert.throws(() => capture(f, { owner: { ...f.owner, parentJobId: 'not-a-parent' } }), /parent/);
  assert.throws(() => capture(f, { job: { ...f.job, ralph: { baselineSha: '0'.repeat(40) } } }), /baseline/);
  fs.rmSync(path.join(f.workspace, 'src', 'feature.py'));
  fs.symlinkSync('/etc/hosts', path.join(f.workspace, 'src', 'feature.py'));
  assert.throws(() => capture(f), /symlink|regular|unsupported tracked-file changes/);
});

test('corrupted or incomplete snapshot cannot be silently replaced', t => {
  const f = setup(t);
  const receipt = capture(f);
  fs.appendFileSync(path.join(f.stateRoot, receipt.patchRelativePath), 'corrupt');
  assert.throws(() => capture(f), /corrupt|mismatch|digest/);
});

test('repository-defined Git filters or attributes cannot run during owner snapshot', t => {
  const f = setup(t);
  const injected = path.join(f.root, 'malicious-filter.sh');
  const marker = path.join(f.root, 'executed');
  fs.writeFileSync(injected, `#!/bin/sh\necho invoked > '${marker}'\ncat\n`, { mode: 0o700 });
  f.git(f.repo, 'config', 'filter.sneaky.clean', injected);
  assert.throws(() => capture(f), /configuration|filter/);
  assert.equal(fs.existsSync(marker), false);
  f.git(f.repo, 'config', '--unset', 'filter.sneaky.clean');
  f.git(f.repo, 'config', 'diff.external', injected);
  assert.throws(() => capture(f), /configuration/);
  assert.equal(fs.existsSync(marker), false);
  f.git(f.repo, 'config', '--unset', 'diff.external');
  f.git(f.repo, 'config', 'diff.custom.textconv', injected);
  assert.throws(() => capture(f), /configuration/);
  assert.equal(fs.existsSync(marker), false);
  f.git(f.repo, 'config', '--unset', 'diff.custom.textconv');
  const info = f.git(f.workspace, 'rev-parse', '--git-path', 'info/attributes');
  fs.mkdirSync(path.dirname(info), { recursive: true });
  fs.writeFileSync(info, '*.py filter=sneaky\n');
  assert.throws(() => capture(f), /attributes|configuration/);
  assert.equal(fs.existsSync(marker), false);
});

test('a symlinked state ancestor cannot redirect recovery inside an unsafe directory', t => {
  const f = setup(t);
  const link = path.join(f.root, 'redirect');
  fs.symlinkSync(path.join(f.root, 'worktrees'), link);
  assert.throws(() => capture(f, { stateRoot: path.join(link, 'state') }), /symlink/);
});

test('durable child selection refuses an active sibling, stale attempt, or ambiguous reservation', t => {
  const f = setup(t);
  const { captureFailedR1Job } = require('../src/r1-failed-work');
  f.job.r1ParentJobId = f.owner.parentJobId;
  const done = { id: f.owner.childLoopId, attempt: 1, stage: 'done', task: { status: 'incomplete' } };
  const store = { listR1ChildLoops: () => [done] };
  const params = { project: f.project, job: f.job, workspace: { worktreePath: f.workspace, branch: 'ralph/issue-75-feature' },
    queueStore: store, stateRoot: f.stateRoot };
  const receipt = captureFailedR1Job(params);
  assert.equal(receipt.childLoopId, done.id);
  store.listR1ChildLoops = () => [done, { id: 't-ffffffffffffffffffffffff', attempt: 2, stage: 'running', task: { status: 'running' } }];
  assert.throws(() => captureFailedR1Job(params), /active|ambiguous/);
  store.listR1ChildLoops = () => [{ ...done, attempt: 2 }];
  assert.throws(() => captureFailedR1Job(params), /attempt|exactly one/);
  store.listR1ChildLoops = () => [done, { ...done, id: 't-aaaaaaaaaaaaaaaaaaaaaaaa' }];
  assert.throws(() => captureFailedR1Job(params), /ambiguous|exactly one/);
});

test('another terminal job resolves its own durable parent, not the current R1 task', t => {
  const f = setup(t);
  const { captureFailedR1Job } = require('../src/r1-failed-work');
  f.job.r1ParentJobId = 't-87654321';
  const store = { listR1ChildLoops: id => {
    assert.equal(id, 't-87654321');
    return [{ id: 't-aaaaaaaaaaaaaaaaaaaaaaaa', attempt: 1, stage: 'done', task: { status: 'failed' } }];
  } };
  const receipt = captureFailedR1Job({ project: f.project, job: f.job,
    workspace: { worktreePath: f.workspace, branch: 'ralph/issue-75-feature' }, queueStore: store,
    stateRoot: f.stateRoot });
  assert.equal(receipt.parentJobId, 't-87654321');
});


test('a later R1 parent cannot silently rebind a failed job belonging to an earlier parent', t => {
  const f = setup(t);
  const { bindR1Parent } = require('../src/r1-failed-work');
  f.job.runs = 0;
  assert.equal(bindR1Parent(f.job, f.owner.parentJobId).r1ParentJobId, f.owner.parentJobId);
  assert.throws(() => bindR1Parent(f.job, 't-87654321'), /overwrite durable parent ownership/);
  assert.equal(f.job.r1ParentJobId, f.owner.parentJobId);
});


test('legacy terminal or already attempted jobs cannot acquire a new parent identity', t => {
  const f = setup(t);
  const { bindR1Parent } = require('../src/r1-failed-work');
  assert.throws(() => bindR1Parent({ ...f.job, ralph: {}, terminal: true }, 't-12345678'), /previously running or terminal/);
  assert.throws(() => bindR1Parent({ ...f.job, ralph: {}, runs: 1, terminal: false }, 't-12345678'), /previously running or terminal/);
  assert.equal(bindR1Parent({ ...f.job, ralph: {}, runs: 0, terminal: false }, 't-12345678').r1ParentJobId, 't-12345678');
});
