const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadProjectConfig } = require('../src/autopilot-config');

const expectedFinanceDashboard = {
  enabled: true,
  repo: 'woodsja/finance-dashboard',
  checkout: '/home/woodsja/finance-dashboard',
  worktreeRoot: '/home/woodsja/worktrees/finance-dashboard',
  baseBranch: 'main',
  readyLabel: 'ready-for-agent',
  humanLabel: 'ready-for-human',
  worker: 'codex',
  maxAttempts: 2,
  prepareVenv: true,
  verification: '.venv/bin/finance-dashboard check && .venv/bin/python -m pytest && .venv/bin/ruff check && git diff --check',
  autoMerge: false,
};

const temporaryDirectories = new Set();

test.after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function writeConfig(config) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-autopilot-config-'));
  temporaryDirectories.add(directory);
  const configPath = path.join(directory, 'projects.json');
  fs.writeFileSync(configPath, typeof config === 'string' ? config : JSON.stringify(config));
  return configPath;
}

function validProject() {
  return { ...expectedFinanceDashboard };
}

test('loads the shipped finance-dashboard configuration as a new object', () => {
  const project = loadProjectConfig('finance-dashboard');

  assert.deepEqual(project, expectedFinanceDashboard);
  assert.notStrictEqual(project, loadProjectConfig('finance-dashboard'));
});

test('configPath overrides the repository-root configuration path', () => {
  const configPath = writeConfig({ demo: { ...validProject(), repo: 'example/demo' } });

  assert.deepEqual(loadProjectConfig('demo', { configPath }), {
    ...validProject(),
    repo: 'example/demo',
  });
});

test('defaults the normal worker to Codex when no explicit worker is configured', () => {
  const config = validProject();
  delete config.worker;
  const configPath = writeConfig({ demo: config });
  assert.equal(loadProjectConfig('demo', { configPath }).worker, 'codex');
});

test('defaults attempts to two but preserves an explicit project retry limit', () => {
  const defaulted = validProject();
  delete defaulted.maxAttempts;
  const configPath = writeConfig({ defaulted, explicit: { ...validProject(), maxAttempts: 3 } });

  assert.equal(loadProjectConfig('defaulted', { configPath }).maxAttempts, 2);
  assert.equal(loadProjectConfig('explicit', { configPath }).maxAttempts, 3);
});

test('unknown projects fail with a clear error', () => {
  assert.throws(() => loadProjectConfig('missing-project'), /Unknown autopilot project: missing-project/);
});

test('malformed JSON and missing configuration files fail closed', () => {
  const malformedPath = writeConfig('{ not json');
  const missingPath = path.join(os.tmpdir(), 'ralph-autopilot-does-not-exist.json');

  assert.throws(() => loadProjectConfig('demo', { configPath: malformedPath }), /Invalid JSON/);
  assert.throws(() => loadProjectConfig('demo', { configPath: missingPath }), /Unable to read autopilot project configuration/);
});

test('invalid top-level configuration shapes are rejected', () => {
  for (const config of [[], null, 'projects']) {
    const configPath = writeConfig(JSON.stringify(config));
    assert.throws(() => loadProjectConfig('demo', { configPath }), /must be an object mapping/);
  }
});

test('representative invalid project field values are rejected', () => {
  const invalidFields = {
    enabled: 'false',
    autoMerge: null,
    repo: '  ',
    worker: 'other',
    maxAttempts: 1.5,
    prepareVenv: 'yes',
  };

  for (const [field, value] of Object.entries(invalidFields)) {
    const configPath = writeConfig({ demo: { ...validProject(), [field]: value } });
    assert.throws(() => loadProjectConfig('demo', { configPath }), new RegExp(field));
  }
});
