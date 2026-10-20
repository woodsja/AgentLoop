'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { instructionsRequireVenv, prepareRepositoryEnvironment } = require('../src/autopilot-environment');

for (const existing of [false, true]) test(`retired bare venv setup cannot produce readiness (existing=${existing})`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-venv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (existing) fs.mkdirSync(path.join(root, '.venv'));
  for (const project of [{ prepareVenv: true }, { pythonEnvironment: {} }]) {
    await assert.rejects(prepareRepositoryEnvironment(root, project), error => error.outcome?.reason === 'contract_missing');
  }
  const instructions = [{ path: 'AGENTS.md', content: "Use this repository's .venv for checks." }];
  assert.equal(instructionsRequireVenv(instructions), true);
  await assert.rejects(prepareRepositoryEnvironment(root, {}, { instructions }), /committed uv.lock/);
  assert.equal(fs.existsSync(path.join(root, '.venv')), existing);
});

test('uncontracted non-Python projects retain ordinary execution', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(await prepareRepositoryEnvironment(root, {}), { venvPath: null });
});
