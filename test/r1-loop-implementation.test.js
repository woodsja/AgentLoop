'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createR1LoopImplementation } = require('../src/r1-loop-implementation');
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-loop-strategy-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(cwd, 'README'), 'original'); git('add', '.'); git('commit', '-qm', 'initial');
  const task = { id: 'task-1', goal: 'Write a testable feature', acceptance: ['Implement behavior', 'Test it'],
    verification: 'true', worker: 'codex', maxAttempts: 2 };
  const child = { stage: 'done', task: { status: 'passed', cycles: [{ verdict: 'PASS' }], blocked: [] } };
  return { cwd, git, task, child };
}
test('opt-in implementation uses durable child PASS then deterministic verifier, leaves no synthetic instructions', async t => {
  const f = fixture(t);
  let calls = 0;
  const implementation = createR1LoopImplementation({ ensureChild: () => ({ id: 't-123' }),
    childState: () => f.child, pollMs: 1,
    verify: async (cwd, task) => {
      calls++;
      for (const name of ['PLAN.md', 'GUIDELINES.md', 'STATE.md']) assert.equal(fs.existsSync(path.join(cwd, name)), false);
      assert.equal(task.id, f.task.id);
      return { status: 'passed', verification: { passed: true, exitCode: 0, timedOut: false, stdout: 'ok', stderr: '' } };
    } });
  const result = await implementation.run(f.cwd, f.task);
  assert.equal(result.status, 'passed'); assert.equal(result.childLoopId, 't-123'); assert.equal(calls, 1);
  assert.equal(f.git('status', '--porcelain'), '');
});
test('a rejected or partial child never invokes deterministic verification', async t => {
  const f = fixture(t); f.child.task.status = 'partial';
  let verified = false;
  const impl = createR1LoopImplementation({ ensureChild: () => ({ id: 't-123' }), childState: () => f.child,
    verify: async () => { verified = true; } });
  await assert.rejects(impl.run(f.cwd, f.task), /did not pass/);
  assert.equal(verified, false);
  assert.equal(f.git('status', '--porcelain'), '');
});
test('worker cannot smuggle generated instructions into a commit', async t => {
  const f = fixture(t);
  const impl = createR1LoopImplementation({ ensureChild: () => {
    f.git('add', 'PLAN.md'); f.git('commit', '-m', 'malicious instruction addition');
    return { id: 't-123' };
  }, childState: () => f.child });
  await assert.rejects(impl.run(f.cwd, f.task), /temporary instruction file PLAN.md (entered Git history|was added to the Git index)/);
});
test('existing repository PLAN is never replaced', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.cwd, 'PLAN.md'), 'owner plan');
  const impl = createR1LoopImplementation({ ensureChild: () => { throw new Error('should not run'); }, childState: () => f.child });
  await assert.rejects(impl.run(f.cwd, f.task), /collides/);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'PLAN.md'), 'utf8'), 'owner plan');
});
