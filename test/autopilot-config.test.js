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
  ciWorkflow: 'Checks',
  reviewPolicy: 'always',
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

test('preserves an explicit review skip explanation and rejects invalid reason values', () => {
  const config = { ...validProject(), reviewPolicy: 'none', reviewSkipReason: 'Documentation-only change covered by documentation checks.' };
  assert.deepEqual(loadProjectConfig('demo', { configPath: writeConfig({ demo: config }) }), config);
  for (const reviewSkipReason of [null, '', ' \n\t ', 42, 'x'.repeat(4001)]) {
    assert.throws(() => loadProjectConfig('demo', {
      configPath: writeConfig({ demo: { ...config, reviewSkipReason } }),
    }), /reviewSkipReason/);
  }
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
    reviewModel: 'haiku',
    maxAttempts: 1.5,
    prepareVenv: 'yes',
    ciWorkflow: ' ',
  };

  for (const [field, value] of Object.entries(invalidFields)) {
    const configPath = writeConfig({ demo: { ...validProject(), [field]: value } });
    assert.throws(() => loadProjectConfig('demo', { configPath }), new RegExp(field));
  }
});


test('mixed-engine implementation is explicit and validates its owner policy', () => {
  const project = validProject();
  const good = { ...project, implementationStrategy: 'worker-critic-loop' };
  assert.equal(loadProjectConfig('demo', { configPath: writeConfig({ demo: good }) }).implementationStrategy, 'worker-critic-loop');
  for (const bad of ['invalid', true, 2]) {
    assert.throws(() => loadProjectConfig('demo', { configPath: writeConfig({ demo: { ...project, implementationStrategy: bad } }) }), /implementationStrategy/);
  }
  assert.throws(() => loadProjectConfig('demo', { configPath: writeConfig({ demo: { ...good, worker: 'claude' } }) }), /Codex worker/);
  assert.throws(() => loadProjectConfig('demo', { configPath: writeConfig({ demo: { ...good, reviewPolicy: 'none' } }) }), /independent review/);
});

test('owner runtime supports the shared Node and Python contract only', () => {
  for (const runtime of ['node', 'python']) assert.doesNotThrow(() => loadProjectConfig('demo', { configPath: writeConfig({ demo: { ...validProject(), runtime } }) }));
  assert.throws(() => loadProjectConfig('demo', { configPath: writeConfig({ demo: { ...validProject(), runtime: 'ruby' } }) }), /runtime must be node or python/);
});


test('legacy Finance Python policy stays loadable until the staged migration (#87)', () => {
  const policy = { interpreter: '/usr/bin/python3', timeoutMs: 30000, indexUrl: 'https://pypi.org/simple', commands: [],
    dependencies: ['pytest', 'ruff'].map(name => ({ name, version: '1.0', wheel: `${name}-1.0-py3-none-any.whl`, sha256: 'a'.repeat(64) })) };
  const configPath = writeConfig({ finance: { ...validProject(), pythonEnvironment: policy } });
  const project = loadProjectConfig('finance', { configPath });
  assert.deepEqual(project.pythonEnvironment, policy);
  const invalid = { ...policy, indexUrl: 'http://untrusted.invalid/simple' };
  assert.throws(() => loadProjectConfig('finance', { configPath: writeConfig({ finance: { ...validProject(), pythonEnvironment: invalid } }) }));
});
