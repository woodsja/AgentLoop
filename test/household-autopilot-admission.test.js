'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/autopilot');
const household = { enabled: true, repo: 'Woodsja/household-purchases', readyLabel: 'ready-for-agent', worker: 'codex', reviewPolicy: 'always', autoMerge: true, dependencyFormat: 'household-blocked-by' };
const { dependencyFormat, ...otherConfig } = household;
const unrelated = { ...otherConfig, repo: 'example/other' };
const issue = { number: 2, title: 'M1: import', body: '## What to build\nImport synthetic data\n\n## Blocked by\n- #1: M0: foundation\n\n## Activation\nPlanning backlog only' };
function deps(project, output) {
  return { loadProjectConfig: () => project, discoverReadyIssues: async () => [issue],
    jobStore: { list: () => [] }, write: line => output.push(line) };
}
test('real autopilot dry run blocks Household Purchases without merged #1', async () => {
  const output = [];
  const result = await run(['--project', 'woodsja--household-purchases', '--dry-run'], deps(household, output));
  assert.equal(result, null);
  assert.ok(output.some(line => /blocked by unresolved #1/.test(line)));
});
test('other repositories retain their previous issue selection', async () => {
  const output = [];
  const result = await run(['--project', 'other', '--dry-run'], deps(unrelated, output));
  assert.equal(result.number, 2);
});

test('real autopilot dry run accepts issue #2 after durable approved merge #1', async () => {
  const output = [];
  const sha = 'a'.repeat(40);
  const approved = { issue: {number:1}, project: 'woodsja--household-purchases', repo: household.repo, terminal:true, terminalState:'merged', delivery:{commit:sha}, merge:{commit:'b'.repeat(40),repo:household.repo,approvedHead:sha,issueClosed:true}, ci:{state:'green',headCommit:sha}, review:{reviewer:'claude:opus',verdict:'PASS',commit:sha,findings:[]}, verification:{command:'npm run check',commit:sha,passed:true,exitCode:0,timedOut:false,stdout:'',stderr:''} };
  const injected = deps(household, output);
  injected.jobStore.list = () => [approved];
  const result = await run(['--project', 'woodsja--household-purchases', '--dry-run'], injected);
  assert.equal(result.number, 2);
});

test('dependency rules are selected by owner policy rather than a repository name', async () => {
  const output = [];
  const unconfiguredHousehold = { ...household };
  delete unconfiguredHousehold.dependencyFormat;
  const result = await run(['--project', 'woodsja--household-purchases', '--dry-run'], deps(unconfiguredHousehold, output));
  assert.equal(result.number, 2);
});
