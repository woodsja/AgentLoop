'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { configuredProjects } = require('../src/project-registry');
const { createR1ChildHandoff } = require('../src/r1-child-handoff');

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-child-handoff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'repo');
  const worktreeRoot = path.join(root, 'worktrees');
  const issuePath = path.join(worktreeRoot, 'issue-65');
  const configPath = path.join(root, 'owner.json');
  fs.mkdirSync(checkout);
  fs.writeFileSync(configPath, '{}');
  git(checkout, 'init', '-q');
  git(checkout, 'config', 'user.name', 'Fixture');
  git(checkout, 'config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(checkout, 'README.md'), 'sample');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-qm', 'init');
  fs.mkdirSync(worktreeRoot);
  git(checkout, 'worktree', 'add', '-qb', 'issue-65', issuePath);
  fs.writeFileSync(path.join(issuePath, 'PLAN.md'), '- Implement small feature\n');
  const project = { enabled: true, worker: 'codex', reviewPolicy: 'always', checkout, worktreeRoot, baseBranch: 'main' };
  const parent = {
    id: 't-12345678', workflow: 'r1', project: 'demo', issue: 65, status: 'running',
    r1: { project: 'demo', issue: { number: 65, title: 'Feature' }, worktreePath: issuePath,
      workspaceState: 'prepared', status: 'running', runs: 1, terminal: false },
  };
  const tasks = [];
  const store = {
    paths: { config: configPath },
    config: { allowedProjects: configuredProjects({ demo: { root: checkout, worktreeRoot } }, configPath) },
    readTask: (id, stage) => { if (id !== parent.id || stage !== 'running') throw new Error('not found'); return parent; },
    listTasks: stage => tasks.filter(task => task.stage === stage),
    enqueueLoop: partial => { const child = { ...partial, type: 'loop', id: `t-${String(tasks.length + 1).padStart(8, '0')}`, stage: 'pending' }; tasks.push(child); return child; },
    writeTask: (task, stage) => { if (stage === 'running') Object.assign(parent, task); },
  };
  const create = () => createR1ChildHandoff({ store, loadProject: () => project });
  return { root, checkout, issuePath, project, parent, tasks, store, create };
}

test('one authorized parent creates one durable child and repeated calls reuse it', t => {
  const f = fixture(t), handoff = f.create();
  assert.deepEqual(handoff.ensure(f.parent.id), { id: 't-00000001', created: true });
  assert.deepEqual(handoff.ensure(f.parent.id), { id: 't-00000001', created: false });
  assert.equal(f.tasks.length, 1);
  assert.deepEqual(f.tasks[0].r1Child, { parentJobId: f.parent.id, attempt: 1, issue: 65 });
  assert.equal(f.parent.childLoopId, 't-00000001');
});

test('child survives failed parent checkpoint and a reconstructed handoff', t => {
  const f = fixture(t);
  f.store.writeTask = () => { throw new Error('checkpoint interrupted'); };
  assert.throws(() => f.create().ensure(f.parent.id), /checkpoint interrupted/);
  assert.equal(f.tasks.length, 1);
  assert.deepEqual(f.create().ensure(f.parent.id), { id: 't-00000001', created: false });
});

test('rejects missing, completed, mismatched and unauthorized parent without creating a child', t => {
  const f = fixture(t);
  assert.throws(() => f.create().ensure('../etc/passwd'), /Invalid R1 parent/);
  f.parent.status = 'done';
  assert.throws(() => f.create().ensure(f.parent.id), /not eligible/);
  f.parent.status = 'running';
  f.parent.r1.issue.number = 17;
  assert.throws(() => f.create().ensure(f.parent.id), /not active/);
  f.parent.r1.issue.number = 65;
  f.parent.r1.worktreePath = f.root;
  assert.throws(() => f.create().ensure(f.parent.id), /authorized managed issue worktree/);
  assert.equal(f.tasks.length, 0);
});

test('rejects a similarly named worktree from a different Git repository', t => {
  const f = fixture(t);
  git(f.checkout, 'worktree', 'remove', '-f', f.issuePath);
  const alien = path.join(f.root, 'other');
  fs.mkdirSync(alien);
  git(alien, 'init', '-q');
  git(alien, 'config', 'user.name', 'Fixture');
  git(alien, 'config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(alien, 'README'), 'alien');
  git(alien, 'add', '.');
  git(alien, 'commit', '-qm', 'init');
  git(alien, 'worktree', 'add', '-qb', 'issue-65', f.issuePath);
  fs.writeFileSync(path.join(f.issuePath, 'PLAN.md'), '- feature\n');
  assert.throws(() => f.create().ensure(f.parent.id), /does not belong to the registered repository/);
  assert.equal(f.tasks.length, 0);
});

test('rejects duplicate or mismatched durable child association', t => {
  const f = fixture(t);
  f.create().ensure(f.parent.id);
  f.tasks.push({ ...f.tasks[0], id: 't-99999999' });
  assert.throws(() => f.create().ensure(f.parent.id), /Duplicate R1 child/);
  f.tasks.pop();
  f.tasks[0].projectPath = '/tmp/wrong';
  assert.throws(() => f.create().ensure(f.parent.id), /does not match authorized parent/);
});

test('refuses to replace a missing checkpointed child with a fresh loop', t => {
  const f = fixture(t);
  f.parent.childLoopId = 't-deadbeef';
  f.parent.childAttempt = 1;
  assert.throws(() => f.create().ensure(f.parent.id), /does not match durable loop state/);
  assert.equal(f.tasks.length, 0);
});

test('refuses parent child checkpoints from a different attempt', t => {
  const f = fixture(t);
  f.parent.childAttempt = 2;
  assert.throws(() => f.create().ensure(f.parent.id), /another attempt/);
  assert.equal(f.tasks.length, 0);
});
