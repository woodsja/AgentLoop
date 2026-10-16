'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAutopilotTask } = require('../src/autopilot-task');
const { syntheticPlan } = require('../src/r1-loop-implementation');
const { parsePlanTasks } = require('../src/prompts');

const issue = {
  number: 75,
  title: 'Pilot: report unnamed shared-option help slots as actionable errors',
  body: `## Goal\nImprove CLI help formatting.\n## Requirements
- Report unnamed {} placeholders as TypeError.
- Preserve existing named placeholders and valid help output.
- Add a test that fails before the fix and passes afterward.
- Keep changes to the approved Python source and test files only.
- Run local .venv readiness, pytest, Ruff and Git checks.
- Preserve GitHub CI, exact-head independent final Opus review and leave PR for human merge.
## Acceptance criteria
- [ ] Test demonstrates the original unnamed-slot failure and correction.
- [ ] SharedOption reports a clear TypeError with the missing slot.
- [ ] Existing named-slot and valid help behavior remain unchanged.
- [ ] Only the two approved Python files change.
- [ ] Local verification and PR CI pass; Opus reviews the exact PR commit.
## Pilot constraints
Do not auto-merge; do not change private financial data.`,
};

test('original Finance #75 requirements produce one local implementation task while parent owns delivery', () => {
  const project = { repo: 'fixture/finance', verification: 'python -m pytest', worker: 'codex' };
  const task = buildAutopilotTask(project, issue, []);
  const plan = syntheticPlan(task);
  const childTasks = parsePlanTasks(plan['PLAN.md']);
  assert.equal(childTasks.length, 1);
  assert.match(childTasks[0], /source-scope requirement/);
  assert.doesNotMatch(childTasks[0], /PR|CI|merge|final review/);
  assert.match(plan['PLAN.md'], /SharedOption reports a clear TypeError/);
  assert.match(plan['PLAN.md'], /PR CI pass; Opus reviews the exact PR commit/);
  assert.match(plan['GUIDELINES.md'], /parent alone owns Git commits/);
  assert.match(plan['GUIDELINES.md'], /PASS requires ALL implementation criteria/);
  assert.match(plan['GUIDELINES.md'], /Do not create or update a PR/);
});
