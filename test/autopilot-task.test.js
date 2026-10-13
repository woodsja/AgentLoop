'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { acceptanceFromIssue, buildAutopilotTask, buildCorrectiveTask } = require('../src/autopilot-task');

test('builds a corrective task from the original issue, instructions, and CI diagnostics only', () => {
  const project = { repo: 'example/finance', worker: 'codex', verification: 'deterministic check' };
  const issue = { number: 42, title: 'Improve totals', body: '## Acceptance Criteria\n- Show totals' };
  const instructions = [{ path: 'AGENTS.md', content: 'Use .venv.' }];
  const task = buildCorrectiveTask(project, issue, instructions, {
    cycle: 1, status: 'eligible', redCommit: 'abc123', diagnostics: 'not ok 1 - totals', commit: null,
  });
  assert.equal(task.id, 'autopilot:example/finance#42:ci-correction-1');
  assert.equal(task.verification, 'deterministic check');
  assert.equal(task.maxAttempts, 2);
  assert.match(task.goal, /commit abc123/);
  assert.match(task.goal, /not ok 1 - totals/);
  assert.match(task.goal, /Show totals/);
  assert.match(task.goal, /Use .venv/);
  assert.equal(task.acceptance[0], 'Show totals');
  assert.throws(() => buildCorrectiveTask(project, issue, instructions, { redCommit: 'abc123', diagnostics: ' ' }), /CI diagnostics/);
  assert.throws(() => buildCorrectiveTask(project, issue, instructions, {
    cycle: 2, redCommit: 'abc123', diagnostics: 'not ok',
  }), /one allowed cycle/);
});

test('builds a reviewer corrective task with findings and original issue context', () => {
  const project = { repo: 'example/finance', verification: 'deterministic check' };
  const issue = { number: 42, title: 'Improve totals', body: 'Original context\n\n## Acceptance Criteria\n- Show totals' };
  const task = buildCorrectiveTask(project, issue, [], {
    kind: 'review', cycle: 1, status: 'eligible', reviewCommit: 'abc123',
    reviewer: 'claude:sonnet', findings: 'totals.js:12: handle empty input', commit: null,
  });
  assert.equal(task.id, 'autopilot:example/finance#42:review-correction-1');
  assert.match(task.goal, /Address independent code review findings/);
  assert.match(task.goal, /claude:sonnet/);
  assert.match(task.goal, /handle empty input/);
  assert.match(task.goal, /Original context/);
  assert.doesNotMatch(task.goal, /Fix the failing CI/);
});

test('builds the fourth reviewer corrective task without losing the original issue context', () => {
  const project = { repo: 'example/finance', verification: 'deterministic check', maxReviewRounds: 5 };
  const issue = { number: 42, title: 'Improve totals', body: 'Original context\n\n## Acceptance Criteria\n- Show totals' };
  const task = buildCorrectiveTask(project, issue, [], {
    kind: 'review', cycle: 4, status: 'eligible', reviewCommit: 'def456',
    reviewer: 'claude:opus', findings: 'totals.js:20: preserve zero balances', commit: null,
  });
  assert.equal(task.id, 'autopilot:example/finance#42:review-correction-4');
  assert.match(task.goal, /commit def456/);
  assert.match(task.goal, /preserve zero balances/);
  assert.match(task.goal, /Original context/);
});

test('builds a bounded Codex Ralph task from issue data and repository instructions', () => {
  const issue = { number: 42, title: 'Improve totals', body: 'Context for the issue.\n\n## Acceptance Criteria\n- Show totals\n- Cover empty data\n\n## Notes\nLater text' };
  const task = buildAutopilotTask({ repo: 'example/finance', worker: 'codex', verification: 'deterministic check' }, issue, [{ path: 'AGENTS.md', content: 'Use .venv.' }]);
  assert.equal(task.id, 'autopilot:example/finance#42');
  assert.equal(task.worker, 'codex');
  assert.equal(task.maxAttempts, 2);
  assert.equal(task.verification, 'deterministic check');
  assert.match(task.goal, /Improve totals/);
  assert.match(task.goal, /Context for the issue/);
  assert.match(task.goal, /Use .venv/);
  assert.deepEqual(task.acceptance, ['Show totals', 'Cover empty data', 'Follow the repository instructions included in the task goal.']);
  assert.deepEqual(acceptanceFromIssue({ number: 1, title: 'Fallback', body: '' }), ['Complete issue #1: Fallback']);
});

test('uses two attempts by default and honors an explicit project retry limit', () => {
  const defaultTask = buildAutopilotTask(
    { repo: 'example/finance', worker: 'codex', verification: 'check' },
    { number: 2, title: 'Default retries', body: '' },
    [],
  );
  const task = buildAutopilotTask(
    { repo: 'example/finance', worker: 'codex', verification: 'check', maxAttempts: 3 },
    { number: 3, title: 'Bounded retries', body: '' },
    [],
  );
  assert.equal(defaultTask.maxAttempts, 2);
  assert.equal(buildAutopilotTask({ repo: 'example/finance', verification: 'check' }, { number: 4, title: 'Default worker', body: '' }, []).worker, 'codex');
  assert.equal(task.maxAttempts, 3);
});

test('extracts checklist criteria from a conventional heading with a colon', () => {
  const criteria = acceptanceFromIssue({
    number: 9,
    title: 'Colon heading',
    body: '## Acceptance Criteria:\n- [ ] First condition\n1. Second condition\n\n## Notes\nIgnore this',
  });
  assert.deepEqual(criteria, ['First condition', 'Second condition']);
});

test('extracts explicit acceptance criteria without requiring a Markdown heading marker', () => {
  const criteria = acceptanceFromIssue({
    number: 10,
    title: 'Plain acceptance heading',
    body: 'Acceptance criteria:\n- Persists the transaction\n- Shows its balance',
  });
  assert.deepEqual(criteria, ['Persists the transaction', 'Shows its balance']);
});
