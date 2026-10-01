const FIELDS = new Set([
  'id',
  'goal',
  'acceptance',
  'verification',
  'worker',
  'maxAttempts',
  'reviewPolicy',
  'model',
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateTaskContract(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Task contract must be an object');
  }

  for (const field of Reflect.ownKeys(input)) {
    if (!FIELDS.has(field)) {
      throw new TypeError(`Unknown task contract field: ${String(field)}`);
    }
  }

  for (const field of ['id', 'goal', 'verification']) {
    if (!isNonEmptyString(input[field])) {
      throw new TypeError(`${field} must be a non-empty string`);
    }
  }

  if (!Array.isArray(input.acceptance) || input.acceptance.length === 0 ||
      !input.acceptance.every(isNonEmptyString)) {
    throw new TypeError('acceptance must be a non-empty array of non-empty strings');
  }

  if (input.worker !== 'codex' && input.worker !== 'claude') {
    throw new TypeError('worker must be codex or claude');
  }

  if (Object.hasOwn(input, 'maxAttempts') &&
      (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 10)) {
    throw new TypeError('maxAttempts must be an integer from 1 through 10');
  }

  if (Object.hasOwn(input, 'reviewPolicy') &&
      !['none', 'risk', 'always'].includes(input.reviewPolicy)) {
    throw new TypeError('reviewPolicy must be none, risk, or always');
  }

  if (Object.hasOwn(input, 'model') && !isNonEmptyString(input.model)) {
    throw new TypeError('model must be a non-empty string');
  }

  return true;
}

function normalizeTaskContract(input) {
  validateTaskContract(input);

  const normalized = {
    id: input.id,
    goal: input.goal,
    acceptance: [...input.acceptance],
    verification: input.verification,
    worker: input.worker,
    maxAttempts: Object.hasOwn(input, 'maxAttempts') ? input.maxAttempts : 2,
    reviewPolicy: Object.hasOwn(input, 'reviewPolicy') ? input.reviewPolicy : 'risk',
  };

  if (Object.hasOwn(input, 'model')) normalized.model = input.model;

  return normalized;
}

module.exports = { validateTaskContract, normalizeTaskContract };
