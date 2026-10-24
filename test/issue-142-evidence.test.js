'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { gunzipSync } = require('node:zlib');
const { validateEvidence } = require('../src/review-evidence');
const { verifyRecovery } = require('../scripts/verify-issue142-evidence');
const root = path.resolve(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 17 * 1024 * 1024 });
const manifestPath = 'docs/evidence/review/manifest.json';
const manifest = () => JSON.parse(fs.readFileSync(path.join(root, manifestPath)));

test('recovered evidence and historical/current digests are byte exact', () => {
  const result = verifyRecovery(root);
  assert.ok(result.logs >= 17);
  assert.ok(result.sourceFiles >= 3);
});

async function review(mutator = () => {}) {
  const entries = manifest().entries;
  const head = 'f'.repeat(40), base = 'e7caf791e59127639f3f946755b98b33a4cf9046';
  const read = async args => {
    if (args[0] === 'merge-base') {
      if (args[1] === '--is-ancestor') return git(...args);
      return Buffer.from(base + '\n');
    }
    if (args[0] === 'ls-tree') return Buffer.from(entries.map(e => e.archive).concat(manifestPath).join('\0') + '\0');
    if (args[0] === 'show' && args[1].startsWith(head + ':')) {
      const file = args[1].slice(head.length + 1);
      const bytes = fs.readFileSync(path.join(root, file));
      return mutator(file, bytes) || bytes;
    }
    // Real retained ancestor Git objects, not synthetic original log bytes.
    return git(...args);
  };
  // The adapter maps the working files to a proposed head; R1 separately repeats
  // this against committed exact-head Git/GitHub identity during delivery.
  return validateEvidence({ project: { repo: 'woodsja/AgentLoop' }, pullRequest: { number: 1 }, headCommit: head,
    diff: entries.map(e => `diff --git a/${e.archive} b/${e.archive}\nBinary files a/${e.archive} and b/${e.archive} differ\n`).join('') + `diff --git a/${manifestPath} b/${manifestPath}\n`,
    github: async () => JSON.stringify({ number: 1, headRefOid: head, baseRefOid: base }),
    read: async (args, options) => {
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor' && args[3] === head) {
        return git('merge-base', '--is-ancestor', args[2], 'HEAD');
      }
      const result = await read(args, options);
      return options?.binary ? result : result.toString();
    } });
}

test('deployed reviewer verifies all original blobs and roundtrip archives', async () => {
  assert.match(await review(), /Validated lossless evidence manifest/);
});

test('mismatched digest and corrupt archive fail closed before model review', async () => {
  await assert.rejects(review((file, bytes) => {
    if (file !== manifestPath) return;
    const data = JSON.parse(bytes); data.entries[0].sha256 = '0'.repeat(64);
    return Buffer.from(JSON.stringify(data));
  }), { code: 'review_evidence_integrity' });
  await assert.rejects(review((file, bytes) => file.endsWith('.gz') ? Buffer.from('broken gzip') : bytes), { code: 'review_evidence_integrity' });
});

test('original failed job retains both reviewer attempts and closed unmerged PR', () => {
  const unpack = suffix => {
    const entry = manifest().entries.find(e => e.original.endsWith('/' + suffix));
    return JSON.parse(gunzipSync(fs.readFileSync(path.join(root, entry.archive))));
  };
  const job = unpack('original-r1.log');
  assert.equal(job.terminal, true); assert.equal(job.terminalState, 'ready_for_human');
  assert.equal(job.reviewHistory.length, 2);
  assert.equal(job.reviewHistory[0].commit, '9661ba43033e761db512dc011326639372287951');
  assert.equal(job.reviewHistory[0].verdict, 'NEEDS_CHANGES');
  assert.equal(job.reviewHistory[1].commit, '78f2ab235d9f25e9a765bfa1905ef1519e5b17e2');
  assert.notEqual(job.reviewHistory[1].verdict, 'PASS');
  const pr = unpack('pr135.log');
  assert.equal(pr.state, 'CLOSED'); assert.equal(pr.mergedAt, null);
  assert.equal(pr.headRefOid, job.reviewHistory[1].commit);
});

test('closing original 111 cannot unlock ADE or bypass smaller-number dependency migration', () => {
  const { dependencies, eligibleIssues } = require('../src/r1-dependencies');
  const entry = manifest().entries.find(e => e.original.endsWith('/original-r1.log'));
  const original = JSON.parse(gunzipSync(fs.readFileSync(path.join(root, entry.archive))));
  const jobs = [original];
  const issues = [114, 115, 116].map(number => ({ number, state: 'open', body: 'Depends on: #111' }));
  assert.deepEqual(eligibleIssues(issues, jobs, 'ralph', 'woodsja/AgentLoop'), []);
  // A closed GitHub issue is not a merged, independently approved R1 receipt.
  const closed = structuredClone(original); closed.issue.state = 'closed';
  assert.deepEqual(eligibleIssues(issues, [closed], 'ralph', 'woodsja/AgentLoop'), []);
  for (const issue of issues) assert.throws(() => dependencies({ ...issue, body: 'Depends on: #142' }), /smaller/);
  assert.deepEqual(dependencies({ number: 143, body: 'Depends on: #142' }), [142]);
  assert.equal(original.terminalState, 'ready_for_human');
});

test('complete recovery diff fits deployed reviewer cap without hiding code patches', () => {
  const { MAX_DIFF_BYTES } = require('../src/autopilot-review');
  const diff = git('diff', '--no-ext-diff', '0055c5d9ad8fd7f1f136de90f9eb91ed45131143', 'HEAD');
  assert.ok(diff.length <= MAX_DIFF_BYTES, `${diff.length} exceeds ${MAX_DIFF_BYTES}`);
  for (const file of ['src/cli.js', 'src/milestone-summary.js', 'test/milestone-batches.test.js']) {
    assert.ok(diff.includes(Buffer.from(`diff --git a/${file} b/${file}`)), file + ' full patch retained');
  }
});
