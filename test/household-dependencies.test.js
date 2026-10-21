'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prerequisites, eligible } = require('../src/household-dependencies');
const issue = (number, body) =>({number,title:'Issue '+number,body});
const stored = (number = 2) =>{const sha='a'.repeat(40);return {issue:{number},project:'woodsja--household-purchases',repo:'woodsja/household-purchases',terminal:true,terminalState:'merged',delivery:{commit:sha},merge:{commit:'b'.repeat(40),repo:'woodsja/household-purchases',approvedHead:sha,issueClosed:true},ci:{state:'green',headCommit:sha},review:{reviewer:'claude:opus',verdict:'PASS',commit:sha,findings:[]},verification:{command:'npm run check',commit:sha,passed:true,timedOut:false,exitCode:0,stdout:'',stderr:''}}};
const candidates = [issue(3,'## Blocked by\n- #2: Import\n\n## Activation\nPlanning only'),issue(4,'## Blocked by\n- #3: Dedup')];
const pick = (jobs, issues = candidates) =>eligible(issues,jobs,'woodsja--household-purchases','woodsja/household-purchases');
test('reads existing household planning metadata; fails closed on invalid syntax', () =>{
 assert.deepEqual(prerequisites(candidates[0]),[2]);
 assert.deepEqual(prerequisites(issue(2,'## Blocked by\n- #1: Foundation')),[1]);
 for(const body of ['','## Blocked by\n- #2, #3','## Blocked by\n- #3: self','## Blocked by\n- #1\n- #1','## Blocked by\n- other/repo#1']) assert.deepEqual(pick([], [issue(3,body)]),[]);
});
test('blocked issue cannot starve independent issue; merged record releases next', () =>{
 const free=issue(5,'## Blocked by\nNone');
 assert.deepEqual(pick([], [...candidates,free]).map(x=>x.number),[5]);
 assert.deepEqual(pick([stored(2)], [...candidates,free]).map(x=>x.number),[3,5]);
 assert.deepEqual(pick([stored(2),stored(3)], [...candidates,free]).map(x=>x.number),[3,4,5]);
});
test('all review, verification, CI and merge gates fail closed', () =>{
 const good=stored(2);
 for(const delta of [{terminalState:'failed'},{project:'wrong'},{merge:{...good.merge,issueClosed:false}},{review:{...good.review,findings:[{summary:'bug'}]}},{ci:{state:'red',headCommit:good.delivery.commit}},{verification:{...good.verification,commit:'bad'}},{review:null},{review:{...good.review,commit:'wrong'}},{review:{...good.review,verdict:'NEEDS_CHANGES'}},{review:{...good.review,reviewer:'codex'}},{merge:{...good.merge,approvedHead:'wrong'}},{merge:{...good.merge,repo:'elsewhere/repo'}},{ci:{...good.ci,headCommit:'wrong'}},{repo:'elsewhere/repo'}]) assert.deepEqual(pick([{...good,...delta}], [candidates[0]]),[]);
});

test('missing commit and permissive None declaration are never admitted', () =>{
 const bad={...stored(2),delivery:{}};
 assert.deepEqual(pick([bad],[candidates[0]]),[]);
 assert.deepEqual(pick([], [issue(2,'## Blocked by\nNone yet, but #1 first')]),[]);
});
