const test = require('node:test');
const assert = require('node:assert/strict');

const { validateTaskContract, normalizeTaskContract } = require('../src/task-contract');

function minimalTask() {
  return {
    id: 'task-1',
    goal: 'Implement the feature',
    acceptance: ['The feature works'],
    verification: 'npm test',
    worker: 'codex',
  };
}

test('valid minimal task passes validation', () => {
  assert.equal(validateTaskContract(minimalTask()), true);
});

test('normalization adds defaults', () => {
  assert.deepEqual(normalizeTaskContract(minimalTask()), {
    ...minimalTask(),
    maxAttempts: 2,
    reviewPolicy: 'risk',
  });
});

test('all optional fields and alternate allowed values are preserved', () => {
  const task = {
    ...minimalTask(),
    worker: 'claude',
    maxAttempts: 10,
    reviewPolicy: 'always',
    model: 'custom-model',
  };

  assert.equal(validateTaskContract(task), true);
  assert.deepEqual(normalizeTaskContract(task), task);
  assert.equal(validateTaskContract({ ...task, maxAttempts: 1, reviewPolicy: 'none' }), true);
});

test('each required field is rejected when missing or invalid', () => {
  const invalidValues = {
    id: ['', '   ', 3],
    goal: ['', '   ', null],
    acceptance: [[], ['valid', ''], 'criterion'],
    verification: ['', '   ', false],
    worker: ['', null],
  };

  for (const [field, values] of Object.entries(invalidValues)) {
    const missing = minimalTask();
    delete missing[field];
    assert.throws(() => validateTaskContract(missing), TypeError, `${field} missing`);

    for (const value of values) {
      assert.throws(() => validateTaskContract({ ...minimalTask(), [field]: value }), TypeError,
        `${field}: ${JSON.stringify(value)}`);
    }
  }
});

test('invalid worker is rejected', () => {
  assert.throws(() => validateTaskContract({ ...minimalTask(), worker: 'other' }), TypeError);
});

test('maxAttempts rejects out-of-bounds and non-integer values', () => {
  for (const value of [0, 11, 1.5, '2', null, NaN]) {
    assert.throws(() => validateTaskContract({ ...minimalTask(), maxAttempts: value }), TypeError);
  }
});

test('invalid reviewPolicy is rejected', () => {
  for (const value of ['sometimes', '', null]) {
    assert.throws(() => validateTaskContract({ ...minimalTask(), reviewPolicy: value }), TypeError);
  }
});

test('model must be a non-empty string when provided', () => {
  for (const value of ['', '   ', 4, null]) {
    assert.throws(() => validateTaskContract({ ...minimalTask(), model: value }), TypeError);
  }
});

test('unknown top-level fields are rejected', () => {
  const task = { ...minimalTask(), extra: true };
  assert.throws(() => validateTaskContract(task), /Unknown task contract field: extra/);
  assert.throws(() => normalizeTaskContract(task), /Unknown task contract field: extra/);
});

test('normalization returns a new object and does not mutate input', () => {
  const task = minimalTask();
  Object.freeze(task.acceptance);
  Object.freeze(task);

  const normalized = normalizeTaskContract(task);
  assert.notStrictEqual(normalized, task);
  assert.notStrictEqual(normalized.acceptance, task.acceptance);
  assert.deepEqual(task, minimalTask());
  normalized.acceptance.push('Another criterion');
  assert.deepEqual(task.acceptance, ['The feature works']);
});

test('non-object input is rejected', () => {
  for (const value of [null, [], 'task']) {
    assert.throws(() => validateTaskContract(value), TypeError);
  }
});
