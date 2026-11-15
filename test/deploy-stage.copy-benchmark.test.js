'use strict';

// Explicit local-history copy benchmark, not evidence of the real suite passing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fixture } = require('./helpers/deploy-stage-fixture');

test('copies full real reachable history with fixture npm gate and reports headroom', { timeout: 120000 }, async t => {
  const f = fixture(t);
  const source = path.resolve(__dirname, '..');
  const history = path.join(f.root, 'history.git');
  const git = args => execFileSync('/usr/bin/git', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git(['clone', '--bare', '--local', '--no-hardlinks', source, history]);
  fs.cpSync(path.join(history, 'objects'), path.join(f.checkout, '.git/objects'), { recursive: true, force: false });
  const head = git(['--git-dir=' + history, 'rev-parse', 'HEAD']);
  const tree = f.git('rev-parse', f.newSha + '^{tree}');
  const installedTree = f.git('rev-parse', f.oldSha + '^{tree}');
  const commit = (tree, parent, date) => execFileSync('/usr/bin/git', ['-C', f.checkout, 'commit-tree', tree, '-p', parent, '-m', 'benchmark fixture'], {
    env: {...process.env, GIT_AUTHOR_DATE:date, GIT_COMMITTER_DATE:date}, stdio:['ignore','pipe','pipe'] }).toString().trim();
  f.oldSha = commit(installedTree, head, '2029-01-01T00:00:00Z');
  f.git('reset', '--hard', f.oldSha);
  const candidate = commit(tree, f.oldSha, '2029-01-02T00:00:00Z');
  f.git('push', '--force', f.remote, candidate + ':refs/heads/ralph-dev');
  f.job.delivery.commit = f.job.verification.commit = f.job.review.commit = f.job.ci.headCommit = candidate;
  f.job.merge.approvedHead = f.job.merge.commit = candidate;
  f.save();
  const receipt = await f.prepare();
  assert.equal(receipt.state, 'PREPARED');
  const records = fs.readFileSync(receipt.transcript, 'utf8').trim().split('\n').map(JSON.parse);
  const summary = records.find(record => record.historyCopy).historyCopy;
  assert.ok(summary.objects > 2000);
  assert.ok(summary.elapsedMs < 60000, 'real local copy must leave substantial deadline headroom');
  assert.ok(summary.byteHeadroom > summary.bytes * 4);
  assert.ok(summary.objectHeadroom > summary.objects * 10);
  assert.equal(summary.retainedBudgetBytes, 2 * 1024 * 1024 * 1024);
  assert.ok(summary.retainedBytesAtCopy > summary.bytes, 'raw batch and verified objects consume retained storage');
  assert.equal(summary.retainedHeadroomBytesAtCopy,
    summary.retainedBudgetBytes - summary.retainedBytesAtCopy);
  const finalStorage = records.find(record => record.retainedStorage)?.retainedStorage;
  assert.ok(finalStorage && finalStorage.usedBytes >= summary.retainedBytesAtCopy);
  assert.ok(finalStorage.remainingBytes < summary.retainedHeadroomBytesAtCopy);
  assert.equal(finalStorage.budgetBytes, summary.retainedBudgetBytes);
  assert.equal(git(['-C', receipt.repo, 'rev-parse', head]), head);
  t.diagnostic(JSON.stringify({ benchmarkOnly: true, fullRalphSuiteRun: false, ...summary,
    gitCommands: records.filter(record => record.command?.[0] === '/usr/bin/git').length }));
});
