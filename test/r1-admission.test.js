const test = require('node:test');
const assert = require('node:assert/strict');
const { admitOne, selectIssues } = require('../src/r1-admission');

const project = { id: 'ralph', repository: 'woodsja/AgentLoop', worktree: '/authorized/ralph' };
function fakeStore() {
  const jobs = new Map(); const claims = new Set();
  const key = (repo, number) => `${repo}#${number}`;
  return {
    readR1Job: (repo, number) => jobs.get(key(repo, number)) || null,
    readR1Claim: (repo, number) => claims.has(key(repo, number)) ? {} : null,
    claimR1Issue: (repo, number) => { const value = key(repo, number); if (claims.has(value)) return false; claims.add(value); return true; },
    writeR1Job: job => jobs.set(key(job.project, job.issueNumber), job),
    listR1Jobs: () => [...jobs.values()],
  };
}
const issue = (number, extra = {}) => ({ number, title: `Issue ${number}`, state: 'OPEN', labels: ['ready-for-agent'], body: '', ...extra });

test('dry run deterministically reports eligible and skipped issues', async () => {
  const store = fakeStore();
  const issues = [issue(8), issue(2, { body: 'Implemented in commit abcdef1' }), issue(5, { body: 'Blocked by #8' }), issue(4, { labels: ['deferred'] }), issue(3, { labels: [] })];
  const result = await admitOne({ project, issues, dryRun: true, storeImpl: store });
  assert.equal(result.selected.issue.number, 8);
  assert.deepEqual(result.report.map(x => [x.issue.number, x.reason]), [[8, 'eligible'], [2, 'already implemented/delivered'], [5, 'blocked by #8'], [4, 'deferred'], [3, 'unlabeled']]);
});

test('admission claims once and submits exactly one R1 job with review always', async () => {
  const store = fakeStore(); let calls = 0;
  const submitR1Job = async request => { calls++; assert.equal(request.reviewPolicy, 'always'); assert.equal(request.autoMerge, false); return { id: request.id }; };
  const first = await admitOne({ project, issues: [issue(9), issue(3)], submitR1Job, storeImpl: store });
  const second = await admitOne({ project, issues: [issue(9), issue(3)], submitR1Job, storeImpl: store });
  assert.equal(first.admitted.issueNumber, 3);
  assert.equal(second.admitted, null);
  assert.equal(calls, 1);
});

test('simultaneous admission attempts cannot submit the same issue twice', async () => {
  const store = fakeStore(); let calls = 0;
  const submitR1Job = async () => { calls++; return { id: 'durable-job' }; };
  const [one, two] = await Promise.all([
    admitOne({ project, issues: [issue(3)], submitR1Job, storeImpl: store }),
    admitOne({ project, issues: [issue(3)], submitR1Job, storeImpl: store }),
  ]);
  assert.equal(calls, 1);
  assert.equal([one.admitted, two.admitted].filter(Boolean).length, 1);
});

test('fails closed for malformed dependencies and unauthorized projects', () => {
  const store = fakeStore();
  assert.equal(selectIssues([issue(4, { body: 'Blocked by something' })], project, store).report[0].reason, 'ambiguous Blocked by dependency');
  assert.throws(() => selectIssues([], { ...project, repository: 'other/repo' }, store), /unauthorized/);
});
