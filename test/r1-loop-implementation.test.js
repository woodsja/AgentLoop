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
  const child = { stage: 'done', task: { status: 'passed', criticEngine: 'claude', cycles: [{ status: 'passed', phase: 'critic', verdict: 'PASS' }], blocked: [] } };
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
  await assert.rejects(impl.run(f.cwd, f.task), /lacks a final Claude critic PASS/);
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
  await assert.rejects(impl.run(f.cwd, f.task), /collide/);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'PLAN.md'), 'utf8'), 'owner plan');
});


test('an earlier PASS followed by FAIL never satisfies final critic gate', async t => {
  const f = fixture(t);
  f.child.task.cycles.push({ status: 'failed', phase: 'critic', verdict: 'FAIL' });
  const impl = createR1LoopImplementation({ ensureChild: () => ({ id: 't-123' }), childState: () => f.child });
  await assert.rejects(impl.run(f.cwd, f.task), /lacks a final Claude critic PASS/);
});

test('timeout cancels child, waits for terminal state, and then removes temporary files', async t => {
  const f = fixture(t);
  f.child.stage = 'pending';
  let cancels = 0;
  const impl = createR1LoopImplementation({ ensureChild: () => ({ id: 't-123' }),
    childState: () => f.child, cancelChild: async () => { cancels++; f.child.stage = 'done'; f.child.task.status = 'cancelled'; },
    pollMs: 1, maxWaitMs: 5, cancelWaitMs: 20 });
  await assert.rejects(impl.run(f.cwd, f.task), /timed out/);
  assert.equal(cancels, 1);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('a resumed invocation reattaches to matching synthetic files', async t => {
  const f = fixture(t);
  const { syntheticPlan } = require('../src/r1-loop-implementation');
  for (const [name, body] of Object.entries(syntheticPlan(f.task))) fs.writeFileSync(path.join(f.cwd, name), body);
  fs.appendFileSync(path.join(f.cwd, 'STATE.md'), '\n- Worker progress recorded\n');
  const impl = createR1LoopImplementation({ ensureChild: () => ({ id: 't-123' }), childState: () => f.child,
    verify: async () => ({ status: 'passed', verification: { passed: true, exitCode: 0, timedOut: false, stdout: '', stderr: '' } }) });
  assert.equal((await impl.run(f.cwd, f.task)).status, 'passed');
  assert.equal(f.git('status', '--porcelain'), '');
});
