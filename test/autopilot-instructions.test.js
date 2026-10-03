'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readRepositoryInstructions } = require('../src/autopilot-instructions');

test('discovers repository AGENTS instructions without reading git or virtual-environment internals', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-autopilot-instructions-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, '.venv'), { recursive: true });
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Root instructions');
    fs.writeFileSync(path.join(root, 'src', 'AGENTS.md'), 'Source instructions');
    fs.writeFileSync(path.join(root, '.git', 'AGENTS.md'), 'Never read');
    fs.writeFileSync(path.join(root, '.venv', 'AGENTS.md'), 'Never read');
    assert.deepEqual(readRepositoryInstructions(root), [
      { path: 'AGENTS.md', content: 'Root instructions' },
      { path: path.join('src', 'AGENTS.md'), content: 'Source instructions' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
