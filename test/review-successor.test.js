'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reviewSuccessor } = require('../src/review-successor');
const commit = 'a'.repeat(40);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-successor-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const sourcePath = path.join(root, 'blocked.json');
  const source = { id: 'original', status: 'blocked', project: 'finance', evidence: {
    commit, ci: { prNumber: 83 }, verification: { commit, command: 'npm test', passed: true, exitCode: 0, timedOut: false, stdout: 'passed', stderr: '' },
    reviewHistory: [{ commit, status: 'invalid_verdict', diagnostics: 'Write/ExitPlanMode' }],
  } };
  fs.writeFileSync(sourcePath, JSON.stringify(source));
  const calls = [];
  const review = Object.assign(async () => { calls.push('invoke'); return { reviewer: 'claude:opus', verdict: 'PASS', commit }; }, { prepare: async context => { calls.push(context); return {}; } });
  const args = { sourcePath, directory: path.join(root, 'successor'), projectName: 'finance', issueNumber: 48, project: { repo: 'woodsja/finance-dashboard', checkout: '/safe/fixture', autoMerge: true } };
  const deps = { review, observeCi: async () => ({ state: 'green', headCommit: commit, prNumber: 83 }) };
  return { args, deps, calls, source, root };
}

test('review-only successor preserves original bytes, bounds paid invocations, and cannot merge', async t => {
  const f = fixture(t), original = fs.readFileSync(f.args.sourcePath);
  const verdict = await reviewSuccessor(f.args, f.deps);
  assert.equal(verdict.verdict, 'PASS');
  assert.deepEqual(fs.readFileSync(f.args.sourcePath), original);
  assert.equal(f.calls[0].project.autoMerge, false);
  assert.equal(f.calls[0].project.reviewModel, 'opus');
  const journalPath = path.join(f.args.directory, 'execution.ndjson');
  const journal = fs.readFileSync(journalPath, 'utf8');
  const entries = journal.trim().split('\n').map(JSON.parse);
  assert.equal(entries[0].maxInvocations, 1);
  assert.equal(entries.at(-1).mergeAuthorized, false);
  await assert.rejects(reviewSuccessor(f.args, f.deps), /EEXIST/);
  assert.equal(f.calls.filter(call => call === 'invoke').length, 1);
  assert.equal(fs.readFileSync(journalPath, 'utf8'), journal);
});

for (const failure of ['provider', 'markup', 'ci mismatch', 'interruption', 'restart']) {
  test(`successor remains blocked without replay after ${failure}`, async t => {
    const f = fixture(t), original = fs.readFileSync(f.args.sourcePath);
    if (failure === 'provider' || failure === 'markup') f.deps.review = Object.assign(async () => { throw new Error(failure); }, { prepare: async () => ({}) });
    if (failure === 'ci mismatch') f.deps.observeCi = async () => ({ state: 'green', headCommit: 'b'.repeat(40), prNumber: 83 });
    if (failure === 'interruption') f.args.signal = AbortSignal.abort();
    if (failure === 'restart') { fs.mkdirSync(f.args.directory); fs.writeFileSync(path.join(f.args.directory, 'execution.ndjson'), '{"event":"review_running"}\n'); }
    await assert.rejects(reviewSuccessor(f.args, f.deps));
    await assert.rejects(reviewSuccessor(f.args, f.deps), /EEXIST/);
    assert.deepEqual(fs.readFileSync(f.args.sourcePath), original);
    assert.equal(f.calls.includes('invoke'), false);
  });
}

test('successor refuses stale verification before creating evidence or invoking Claude', async t => {
  const f = fixture(t);
  f.source.evidence.verification.commit = 'b'.repeat(40);
  fs.writeFileSync(f.args.sourcePath, JSON.stringify(f.source));
  await assert.rejects(reviewSuccessor(f.args, f.deps), /exact-SHA verification/);
  assert.equal(fs.existsSync(f.args.directory), false);
  assert.equal(f.calls.length, 0);
});

test('required CI turning red during review blocks the successor despite a valid PASS', async t => {
  const f = fixture(t);
  let observations = 0;
  f.deps.observeCi = async () => ({ state: ++observations === 1 ? 'green' : 'red', headCommit: commit, prNumber: 83 });
  await assert.rejects(reviewSuccessor(f.args, f.deps), /green required CI/);
  const journal = fs.readFileSync(path.join(f.args.directory, 'execution.ndjson'), 'utf8');
  assert.match(journal, /successor_blocked/);
  assert.doesNotMatch(journal, /review_completed/);
});

for (const scenario of ['valid', 'tool markup', 'non-JSON envelope', 'provider error', 'wrong SHA']) {
  test(`real adapter successor preserves raw owner evidence for ${scenario}`, async t => {
    const f = fixture(t);
    const { EventEmitter } = require('node:events');
    const { captureProcess, currentRecorder } = require('../src/execution-log');
    const { createClaudeReviewAdapter } = require('../src/autopilot-review');
    const verdict = JSON.stringify({ verdict: 'PASS', commit: scenario === 'wrong SHA' ? 'b'.repeat(40) : commit, findings: '' });
    const output = scenario === 'non-JSON envelope' ? 'provider non-json response'
      : JSON.stringify({ is_error: scenario === 'provider error', result: scenario === 'tool markup' ? `<invoke name="Write">${verdict}</invoke><invoke name="ExitPlanMode"/>` : verdict });
    const stderr = 'verbatim provider stderr: π\n';
    const spawn = (...args) => captureProcess(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.stdin.end = () => queueMicrotask(() => { child.stdout.emit('data', Buffer.from(output)); child.stderr.emit('data', Buffer.from(stderr)); child.emit('close', 0); });
      child.kill = () => true;
      return child;
    }, ...args, currentRecorder());
    f.deps.review = createClaudeReviewAdapter({ spawn, execFile(file, args, options, cb) {
      if (file === 'git') return cb(null, '');
      if (args[0] === 'issue') return cb(null, JSON.stringify({ number: 48, title: 'Finance fix', body: 'requirements', url: 'https://github.com/woodsja/finance-dashboard/issues/48' }));
      if (args[1] === 'diff') return cb(null, 'diff --git a/a.js b/a.js\n+safe change');
      return cb(null, JSON.stringify({ number: 83, headRefOid: commit, isCrossRepository: false, url: 'https://github.com/woodsja/finance-dashboard/pull/83' }));
    } });
    const original = fs.readFileSync(f.args.sourcePath);
    if (scenario === 'valid') assert.equal((await reviewSuccessor(f.args, f.deps)).verdict, 'PASS');
    else await assert.rejects(reviewSuccessor(f.args, f.deps), /Claude review failed closed/);
    const entries = fs.readFileSync(path.join(f.args.directory, 'execution.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    for (const [stream, expected] of [['stdout', output], ['stderr', stderr]]) {
      assert.equal(Buffer.concat(entries.filter(e => e.event === 'output' && e.stream === stream).map(e => Buffer.from(e.base64, 'base64'))).toString(), expected);
    }
    const command = entries.find(e => e.event === 'command' && e.command === 'claude');
    assert.equal(command.args.includes('dontAsk'), true);
    assert.equal(command.args.includes('plan'), false);
    assert.deepEqual(fs.readFileSync(f.args.sourcePath), original);
    assert.equal(entries.at(-1).event, scenario === 'valid' ? 'review_completed' : 'successor_blocked');
    await assert.rejects(reviewSuccessor(f.args, f.deps), /EEXIST/);
  });
}
