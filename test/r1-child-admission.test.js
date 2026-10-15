'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeR1Child } = require('../src/r1-child-admission');

const parentId = 't-12345678';
function fixture() {
  const child = { id: 't-child', type: 'loop', project: 'demo', projectPath: '/mock/issue-5',
    workerEngine: 'codex', criticEngine: 'claude', engine: 'codex', source: 'r1',
    r1Child: { parentJobId: parentId, attempt: 1, issue: 5 } };
  const parent = { id: parentId, workflow: 'r1', issue: 5, project: 'demo', status: 'running',
    r1: { issue: { number: 5 }, project: 'demo', status: 'running', runs: 1,
      terminal: false, workspaceState: 'prepared', worktreePath: '/mock/issue-5' } };
  const store = { readTask: () => parent, listR1ChildLoops: () => [{ id: child.id, attempt: 1, stage: 'pending', task: child }],
    config: { allowedProjects: { demo: true } }, paths: { config: '/owner/config' } };
  const options = { store, resolveScope: () => ({ cwd: '/mock/issue-5', isolatedWorktree: true }),
    loadProject: () => ({ enabled: true, worker: 'codex', reviewPolicy: 'always', checkout: '/checkout', worktreeRoot: '/mock' }),
    resolveRoot: () => ({ cwd: '/checkout' }), derivePath: () => '/mock/issue-5' };
  return { options, parent, child };
}
test('only current reserved child of active R1 parent is admitted', () => {
  const f = fixture();
  assert.doesNotThrow(() => authorizeR1Child(f.child, f.options));
  f.parent.r1.runs = 2;
  assert.throws(() => authorizeR1Child(f.child, f.options), /attempt|active/);
});
test('cancelled, completed or moved parent never authorizes child execution', () => {
  const f = fixture();
  for (const status of ['cancelled', 'passed', 'failed']) {
    f.parent.status = status;
    assert.throws(() => authorizeR1Child(f.child, f.options), /active|eligible/);
  }
  f.parent.status = 'running';
  f.parent.r1.terminal = true;
  assert.throws(() => authorizeR1Child(f.child, f.options), /active|eligible/);
});
test('forged child, unauthorized scope and changed worktree all fail closed', () => {
  const f = fixture();
  f.options.store.listR1ChildLoops = () => [];
  assert.throws(() => authorizeR1Child(f.child, f.options), /reservation/);
  f.options.store.listR1ChildLoops = () => [{ id: f.child.id, attempt: 1, stage: 'pending', task: f.child }];
  f.options.resolveScope = () => ({ cwd: '/different', isolatedWorktree: true });
  assert.throws(() => authorizeR1Child(f.child, f.options), /worktree|scope/);
  f.options.resolveScope = () => ({ cwd: '/mock/issue-5', isolatedWorktree: true });
  f.child.projectPath = '/different';
  assert.throws(() => authorizeR1Child(f.child, f.options), /worktree|scope/);
});

test('child on older attempt is rejected even if reservation still exists', () => {
  const f = fixture();
  f.child.r1Child.attempt = 1;
  f.parent.r1.runs = 2;
  assert.throws(() => authorizeR1Child(f.child, f.options), /attempt|active/);
});

test('child is denied after its reservation has moved out of pending', () => {
  const f = fixture();
  f.options.store.listR1ChildLoops = () => [{ id: f.child.id, attempt: 1, stage: 'done', task: f.child }];
  assert.throws(() => authorizeR1Child(f.child, f.options), /pending loop/);
});
