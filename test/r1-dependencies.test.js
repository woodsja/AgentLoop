'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dependencies, eligibleIssues } = require('../src/r1-dependencies');
const issue = (number, body = '') => ({ number, title: String(number), body });
function merged(number = 1) {
  const sha = 'a'.repeat(40);
  return { issue: { number }, project: 'ralph', repo: 'woodsja/AgentLoop', terminal: true, terminalState: 'merged',
    delivery: { commit: sha }, merge: { commit: 'b'.repeat(40), repo: 'woodsja/AgentLoop', issueClosed: true, approvedHead: sha },
    ci: { state: 'green', headCommit: sha }, review: { reviewer: 'claude:opus', verdict: 'PASS', commit: sha, findings: [] },
    verification: { command: 'npm test', commit: sha, passed: true, exitCode: 0, timedOut: false, stdout: '', stderr: '' } };
}
const pick = (issues, jobs = [], log = []) => eligibleIssues(issues, jobs, 'ralph', 'woodsja/AgentLoop', (_issueNumber, value) => log.push(value));
test('dependency-free issues retain previous admission behavior; unrelated prose is ignored', () => {
  assert.deepEqual(pick([issue(2, 'Blocked by #1'), issue(3)]).map(x => x.number), [2,3]);
});
test('blocked earliest issue does not starve free issue; merged evidence unblocks next scan', () => {
  const list = [issue(2, 'Depends on: #1'), issue(3)];
  assert.deepEqual(pick(list).map(x => x.number), [3]);
  assert.deepEqual(pick(list, [merged()]).map(x => x.number), [2,3]);
});
test('closed, failed, stale, foreign or unreviewed jobs never satisfy prerequisites', () => {
  const target = [issue(3, 'Depends on: #1, #2')];
  const x = merged();
  const y = merged(2);
  for (const bad of [null, {...x, terminalState:'failed'}, {...x, project:'elsewhere'}, {...x, repo:'elsewhere'},
    {...x, review:null}, {...x, review:{...x.review,commit:'wrong'}}, {...x, review:{...x.review,findings:[{summary:'bad'}]}},
    {...x, verification:{...x.verification,commit:'wrong'}}, {...x, merge:{...x.merge,issueClosed:false}}, {...x,ci:{state:'red',headCommit:x.delivery.commit}}]) {
    assert.equal(pick(target, [bad, y].filter(Boolean)).length,0);
  }
  assert.deepEqual(pick(target,[x,y]).map(z=>z.number),[3]);
});
test('malformed, duplicate, self, forward and oversized dependency metadata fails closed with diagnostic', () => {
 const cases = ['Depends on:','Depends on: #1 and #2','Depends on: #1, #1','Depends on: #8','Depends on: #9',
  'Depends on: #0','Depends on: #1\nDepends on: #2','Depends on: #1, #2, #3, #4, #5, #6, #7, #8, #9', 'Depends on: other/repo#1', 'Depends on #1', '**Depends on:** #1', '- Depends on: #1', 'Depends-on: #1', '## Depends on: #1', '1. Depends on: #1', '+ Depends on: #1', '__Depends on:__ #1', '`Depends on: #1`', 'Depends: #1', 'Depends upon: #1', 'Dependencies: #1', 'Dependency: #1', 'Depend on: #1', 'Dependson: #1', '2 Depends on: #1'];
 for(const marker of cases){const log=[];assert.deepEqual(pick([issue(8,marker)], [merged()],log),[],marker);assert.ok(log[0]?.includes('blocked'),marker)}
 assert.deepEqual(dependencies(issue(8,'Depends on: #1, #2')), [1,2]);
});

test('valid merge is not shadowed by failed retry, foreign job or malformed record', () => {
  const valid = merged();
  const foreign = { ...valid, project: 'finance-dashboard' };
  const failed = { ...valid, terminalState: 'failed' };
  assert.deepEqual(pick([issue(2, 'Depends on: #1')], [valid, foreign, failed, { repo: 'malformed' }]).map(x => x.number), [2]);
});
test('every required approval fact fails closed', () => {
  const good = merged();
  const mutations = [
    { terminal: false }, { delivery: null }, { review: { ...good.review, reviewer: 'codex' } },
    { review: { ...good.review, verdict: 'NEEDS_CHANGES' } },
    { review: { ...good.review, findings: null } },
    { ci: { ...good.ci, headCommit: 'bad' } },
    { merge: { ...good.merge, approvedHead: 'bad' } },
    { merge: { ...good.merge, repo: 'wrong/repo' } },
    { merge: { ...good.merge, commit: null } },
  ];
  for (const changed of mutations) {
    assert.deepEqual(pick([issue(2, 'Depends on: #1')], [{ ...good, ...changed }]), []);
  }
});

test('more than eight valid smaller-numbered prerequisites is rejected', () => {
  const diagnostic = [];
  assert.deepEqual(pick([issue(20, 'Depends on: #1, #2, #3, #4, #5, #6, #7, #8, #9')], [], diagnostic), []);
  assert.ok(diagnostic[0]?.includes('metadata blocked'));
});

test('wrong issue number and failed verification never count as approved evidence', () => {
  const approvedOne = merged();
  for (const job of [merged(2), { ...approvedOne, verification: { ...approvedOne.verification, passed: false } },
    { ...approvedOne, verification: { ...approvedOne.verification, exitCode: 1 } },
    { ...approvedOne, verification: { ...approvedOne.verification, timedOut: true } }]) {
    assert.equal(pick([issue(3, 'Depends on: #1')], [job]).length, 0);
  }
});

test('a missing or malformed issue body fails closed', () => {
  for (const body of [undefined, null, 12, {}]) {
    const diagnostics = [];
    assert.deepEqual(pick([{ number: 2, body }], [], diagnostics), []);
    assert.match(diagnostics[0], /metadata blocked/);
  }
});
