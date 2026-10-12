'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { approved, acquireLock, deploy } = require('../src/ralph-deploy');

const old = 'a'.repeat(40), target = 'b'.repeat(40);
const temporaryRoots = [];
test.after(() => { for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true }); });
function job(commit = target) {
  return { project: 'ralph', repo: 'woodsja/AgentLoop', terminalState: 'merged', delivery: { commit },
    merge: { commit, approvedHead: commit, repo: 'woodsja/AgentLoop', issueClosed: true, mergedAt: '2026-01-02T00:00:00.000Z' },
    review: { verdict: 'PASS', commit, findings: [] }, verification: { commit, passed: true, exitCode: 0, timedOut: false, command: 'npm test', stdout: '', stderr: '' } };
}
function fixture({ head = old, npmFails = false } = {}) {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.ralph-deploy-test-')); temporaryRoots.push(root);
  const checkout = path.join(root, 'checkout'), stateDir = path.join(root, 'state'); fs.mkdirSync(path.join(checkout, 'state'), { recursive: true });
  let current = head, pid = 10, restarted = 0;
  fs.writeFileSync(path.join(checkout, 'state', 'daemon.json'), JSON.stringify({ pid, port: 1234 }));
  const exec = (_file, args) => {
    const command = args.slice(2).join(' ');
    if (command === 'status --porcelain') return '';
    if (command === 'branch --show-current') return 'ralph-dev';
    if (command === 'rev-parse HEAD') return current;
    if (command.startsWith('merge-base --is-ancestor')) return '';
    if (command.startsWith('merge --ff-only')) { current = args.at(-1); return ''; }
    if (command.startsWith('reset --hard')) { current = args.at(-1); return ''; }
    return '';
  };
  const spawn = (command, args) => {
    if (command === 'npm' && npmFails) return { status: 1, stderr: 'test failed' };
    if (command === 'systemctl') { restarted += 1; pid += 1; fs.writeFileSync(path.join(checkout, 'state', 'daemon.json'), JSON.stringify({ pid, port: 1234 })); }
    return { status: 0, stderr: '' };
  };
  return { checkout, stateDir, exec, spawn, get: () => ({ current, restarted }) };
}
function options(f) { return { stateDir: f.stateDir, tempDir: f.checkout, execFileSync: f.exec, spawnSync: f.spawn, healthTimeoutMs: 20, requestHealth: async () => true }; }

test('accepts only a completed exact-SHA reviewed Ralph merge', () => {
  assert.equal(approved(job(), { repo: 'woodsja/AgentLoop' }), true);
  for (const mutate of [j => { j.terminalState = 'running'; }, j => { j.review.findings = [{}]; }, j => { j.delivery.commit = old; }, j => { j.repo = 'other/repo'; }]) {
    const candidate = job(); mutate(candidate); assert.equal(approved(candidate, { repo: 'woodsja/AgentLoop' }), false);
  }
});

test('stale deployment lock is reclaimed but a live owner is refused', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.ralph-lock-test-')); temporaryRoots.push(dir);
  fs.writeFileSync(path.join(dir, 'deployment.lock'), JSON.stringify({ pid: 99999999 }));
  const release = acquireLock(dir); release();
  fs.writeFileSync(path.join(dir, 'deployment.lock'), JSON.stringify({ pid: process.pid }));
  assert.throws(() => acquireLock(dir), /another deployment/);
});

test('interrupted post-fast-forward deployment resumes restart and health using saved rollback SHA', async () => {
  const f = fixture({ head: target }); fs.mkdirSync(f.stateDir, { recursive: true });
  fs.writeFileSync(path.join(f.stateDir, 'deployment-state.json'), JSON.stringify({ version: 1, knownGood: old, deployments: { [target]: { status: 'deploying', commit: target, previousCommit: old, updatedAt: 'x', error: null, health: null } } }));
  const result = await deploy({ checkout: f.checkout, baseBranch: 'ralph-dev' }, job(), options(f));
  assert.equal(result.status, 'deployed'); assert.equal(result.previous, old); assert.equal(f.get().restarted, 1);
});

test('pre-deploy test failure preserves a retryable FAILED_DEPLOYMENT record and known-good SHA', async () => {
  const f = fixture({ npmFails: true });
  await assert.rejects(() => deploy({ checkout: f.checkout, baseBranch: 'ralph-dev' }, job(), options(f)), /test failed/);
  const state = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'deployment-state.json')));
  assert.equal(state.knownGood, old); assert.equal(state.deployments[target].status, 'failed'); assert.equal(state.deployments[target].outcome, 'FAILED_DEPLOYMENT'); assert.equal(state.deployments[target].previousCommit, old);
});

test('failed health rolls back and verifies the restored daemon', async () => {
  const f = fixture();
  await assert.rejects(() => deploy({ checkout: f.checkout, baseBranch: 'ralph-dev' }, job(), { ...options(f), requestHealth: async () => f.get().restarted !== 1 }), /health check timed out/);
  const state = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'deployment-state.json')));
  assert.equal(state.deployments[target].status, 'rolled_back'); assert.equal(f.get().current, old); assert.equal(f.get().restarted, 2);
});

test('Ralph-only deployer leaves Finance unaffected', () => {
  assert.equal(require('../src/ralph-deploy').PROJECT, 'ralph');
});
