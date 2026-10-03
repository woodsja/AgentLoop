'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { instructionsRequireVenv, prepareRepositoryEnvironment } = require('../src/autopilot-environment');

test('creates a repo-local venv only when the project requires one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-autopilot-env-'));
  try {
    const calls = [];
    await prepareRepositoryEnvironment(root, { prepareVenv: true }, { execFile: (file, args, options, callback) => {
      calls.push({ file, args, options }); fs.mkdirSync(path.join(root, '.venv')); callback(null);
    } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['-m', 'venv', '.venv']);
    await prepareRepositoryEnvironment(root, { prepareVenv: true }, { execFile: () => assert.fail('existing venv is reused') });
    await prepareRepositoryEnvironment(root, { prepareVenv: false }, { execFile: () => assert.fail('venv is not required') });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('honors a repository instruction requiring a local .venv', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-autopilot-env-instructions-'));
  try {
    const calls = [];
    const instructions = [{ path: 'AGENTS.md', content: 'Run pytest through this repository\'s own .venv.' }];
    assert.equal(instructionsRequireVenv(instructions), true);
    const result = await prepareRepositoryEnvironment(root, { prepareVenv: false }, {
      instructions,
      execFile: (file, args, options, callback) => {
        calls.push({ file, args, options });
        fs.mkdirSync(path.join(root, '.venv'));
        callback(null);
      },
    });
    assert.equal(result.venvPath, path.join(root, '.venv'));
    assert.deepEqual(calls[0].args, ['-m', 'venv', '.venv']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a non-directory path where the required repository .venv belongs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-autopilot-env-invalid-'));
  try {
    fs.writeFileSync(path.join(root, '.venv'), 'not a virtual environment');
    await assert.rejects(
      prepareRepositoryEnvironment(root, { prepareVenv: true }),
      /exists but is not a directory/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
