'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { configuredProjects } = require('../src/project-registry');
const { createR1ChildHandoff } = require('../src/r1-child-handoff');
const { createR1ChildStore } = require('../src/r1-child-store');

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
  const durable = createR1ChildStore({ stateRoot: root, writeTask: (child, stage) => {
    const folder = path.join(root, 'tasks', stage);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${child.id}.json`), JSON.stringify(child), { flag: 'wx' });
    tasks.push({ ...child, stage });
  } });
  const store = {
    paths: { config: configPath },
    config: { allowedProjects: configuredProjects({ demo: { root: checkout, worktreeRoot } }, configPath) },
    readTask: (id, stage) => { if (id !== parent.id || stage !== 'running') throw new Error('not found'); return structuredClone(parent); },
    ...{ enqueueR1ChildLoopOnce: durable.ensureLoop, listR1ChildLoops: durable.listChildren },
    writeTask: (task, stage) => { if (stage === 'running') Object.assign(parent, structuredClone(task)); },
  };
  const create = () => createR1ChildHandoff({ store, loadProject: () => project });
  return { root, checkout, issuePath, project, parent, tasks, store, create };
}

test('one authorized parent creates one durable child and repeated calls reuse it', t => {
  const f = fixture(t), handoff = f.create();
  const first = handoff.ensure(f.parent.id);
  assert.equal(first.created, true);
  assert.deepEqual(handoff.ensure(f.parent.id), { id: first.id, created: false });
  assert.equal(f.tasks.length, 1);
  assert.deepEqual(f.tasks[0].r1Child, { parentJobId: f.parent.id, attempt: 1, issue: 65 });
  assert.equal(f.parent.childLoopId, first.id, 'the parent checkpoints the unique child reference');
});

test('child survives failed parent checkpoint and a reconstructed handoff', t => {
  const f = fixture(t);
  f.store.writeTask = () => { throw new Error('simulated interrupted parent checkpoint'); };
  assert.throws(() => f.create().ensure(f.parent.id), /interrupted parent checkpoint/);
  assert.equal(f.tasks.length, 1);
  f.store.writeTask = (task) => Object.assign(f.parent, structuredClone(task));
  assert.deepEqual(f.create().ensure(f.parent.id), { id: f.tasks[0].id, created: false });
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
  const child = f.store.listR1ChildLoops(f.parent.id)[0];
  const file = path.join(f.root, 'tasks', 'pending', `${child.id}.json`);
  const altered = { ...JSON.parse(fs.readFileSync(file, 'utf8')), projectPath: '/tmp/wrong' };
  fs.writeFileSync(file, JSON.stringify(altered));
  assert.throws(() => f.create().ensure(f.parent.id), /does not match its durable reservation/);
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
  assert.throws(() => f.create().ensure(f.parent.id), /future attempt/);
  assert.equal(f.tasks.length, 0);
});

test('an active prior-attempt child blocks a new attempt on the same worktree', t => {
  const f = fixture(t);
  f.create().ensure(f.parent.id);
  f.parent.r1.runs = 2;
  assert.throws(() => f.create().ensure(f.parent.id), /earlier R1 implementation child is still active/);
  assert.equal(f.tasks.length, 1);
});

test('a parent cancelled during authorization does not enqueue a child', t => {
  const f = fixture(t);
  const original = f.store.readTask;
  let reads = 0;
  f.store.readTask = (...args) => {
    reads++;
    if (reads === 2) f.parent.status = 'cancelled';
    return original(...args);
  };
  assert.throws(() => f.create().ensure(f.parent.id), /not eligible/);
  assert.equal(f.tasks.length, 0);
});
