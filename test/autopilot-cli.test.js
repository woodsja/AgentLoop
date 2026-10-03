'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArguments, run } = require('../src/autopilot');

const project = { enabled: false, repo: 'example/repo', readyLabel: 'ready', worker: 'codex' };

test('dry run inspects disabled projects and reports its selected candidate', async () => {
  const lines = [];
  const result = await run(['--project', 'demo', '--dry-run'], {
    loadProjectConfig: name => { assert.equal(name, 'demo'); return project; },
    discoverReadyIssues: async value => { assert.equal(value, project); return [{ number: 8, title: 'Selected' }]; },
    write: line => lines.push(line),
  });
  assert.deepEqual(result, { number: 8, title: 'Selected' });
  assert.equal(lines[0], 'Dry run: project demo; repository example/repo; issue #8: Selected; worker codex; action is dry-run only.');
});

test('dry run succeeds with a clear no-candidate result', async () => {
  const lines = [];
  const result = await run(['--project', 'demo', '--dry-run'], {
    loadProjectConfig: () => project,
    discoverReadyIssues: async () => [],
    write: line => lines.push(line),
  });
  assert.equal(result, null);
  assert.equal(lines[0], 'Dry run: no ready-for-agent issue found for project demo in example/repo.');
});

test('rejects malformed and unknown arguments', () => {
  assert.throws(() => parseArguments(['--dry-run', '--project', 'demo']), /Usage:/);
  assert.throws(() => parseArguments(['--project', '', '--dry-run']), /Usage:/);
  assert.throws(() => parseArguments(['--project', 'demo', '--dry-run', '--extra']), /Usage:/);
});
