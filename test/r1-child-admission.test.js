'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeR1Child } = require('../src/r1-child-admission');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJob, createJobStore } = require('../src/autopilot-state');

const parentId = 't-12345678';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'child-admission-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = { id: 't-child', type: 'loop', project: 'demo', projectPath: '/mock/issue-5',
    workerEngine: 'codex', criticEngine: 'claude', engine: 'codex', source: 'r1',
    r1Child: { parentJobId: parentId, attempt: 1, issue: 5 } };
  const parent = { id: parentId, workflow: 'r1', issue: 5, project: 'demo', status: 'running',
    r1: { issue: { number: 5, title: 'Feature' }, project: 'demo', status: 'running', runs: 1,
      terminal: false, workspaceState: 'prepared', worktreePath: '/mock/issue-5' } };
  parent.autopilotStateDir = root;
  const store = { readTask: () => {
    if (parent.autopilotStateDir) createJobStore(root).save({ ...createJob({ projectName: 'demo', repo: 'example/repo', issue: { number: 5, title: 'Feature' }, branch: 'ralph/issue-5', worktreePath: '/mock/issue-5', now: () => new Date().toISOString() }), ...parent.r1, r1ParentJobId: parent.id });
    return parent;
  }, listR1ChildLoops: () => [{ id: child.id, attempt: 1, stage: 'pending', task: child }],
    config: { allowedProjects: { demo: true } }, paths: { config: '/owner/config' } };
  const options = { store, resolveScope: () => ({ cwd: '/mock/issue-5', isolatedWorktree: true }),
    loadProject: () => ({ enabled: true, worker: 'codex', reviewPolicy: 'always', checkout: __dirname, worktreeRoot: '/mock' }),
    resolveRoot: () => ({ cwd: __dirname }), derivePath: () => '/mock/issue-5' };
  return { options, parent, child };
}
test('only current reserved child of active R1 parent is admitted', t => {
  const f = fixture(t);
  assert.doesNotThrow(() => authorizeR1Child(f.child, f.options));
  f.parent.r1.runs = 2;
  assert.throws(() => authorizeR1Child(f.child, f.options), /attempt|active/);
});
test('cancelled, completed or moved parent never authorizes child execution', t => {
  const f = fixture(t);
  for (const status of ['cancelled', 'passed', 'failed']) {
    f.parent.status = status;
    assert.throws(() => authorizeR1Child(f.child, f.options), /active|eligible/);
  }
  f.parent.status = 'running';
  f.parent.r1.terminal = true;
  assert.throws(() => authorizeR1Child(f.child, f.options), /active|eligible/);
});
test('forged child, unauthorized scope and changed worktree all fail closed', t => {
  const f = fixture(t);
  f.options.store.listR1ChildLoops = () => [];
  assert.throws(() => authorizeR1Child(f.child, f.options), /reservation/);
  f.options.store.listR1ChildLoops = () => [{ id: f.child.id, attempt: 1, stage: 'pending', task: f.child }];
  f.options.resolveScope = () => ({ cwd: '/different', isolatedWorktree: true });
  assert.throws(() => authorizeR1Child(f.child, f.options), /worktree|scope/);
  f.options.resolveScope = () => ({ cwd: '/mock/issue-5', isolatedWorktree: true });
  f.child.projectPath = '/different';
  assert.throws(() => authorizeR1Child(f.child, f.options), /worktree|scope/);
});

test('child on older attempt is rejected even if reservation still exists', t => {
  const f = fixture(t);
  f.child.r1Child.attempt = 1;
  f.parent.r1.runs = 2;
  assert.throws(() => authorizeR1Child(f.child, f.options), /attempt|active/);
});

test('child is denied after its reservation has moved out of pending', t => {
  const f = fixture(t);
  f.options.store.listR1ChildLoops = () => [{ id: f.child.id, attempt: 1, stage: 'done', task: f.child }];
  assert.throws(() => authorizeR1Child(f.child, f.options), /pending loop/);
});

test('historical running parent cannot authorize a child', t => {
  const f = fixture(t);
  delete f.parent.autopilotStateDir;
  assert.throws(() => authorizeR1Child(f.child, f.options), /historical|canonical|read-only/);
});
