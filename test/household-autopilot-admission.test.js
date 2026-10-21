'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/autopilot');
const household = { enabled: true, repo: 'Woodsja/household-purchases', readyLabel: 'ready-for-agent', worker: 'codex', reviewPolicy: 'always', autoMerge: true };
const unrelated = { ...household, repo: 'example/other' };
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
