const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', 'autopilot-projects.json');
const STRING_FIELDS = [
  'repo',
  'checkout',
  'worktreeRoot',
  'baseBranch',
  'readyLabel',
  'humanLabel',
  'verification',
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateProject(projectName, project) {
  if (!isPlainObject(project)) {
    throw new TypeError(`Project configuration for ${projectName} must be an object`);
  }

  if (Object.hasOwn(project, 'milestoneAuthorization') && typeof project.milestoneAuthorization !== 'boolean') throw new TypeError('milestoneAuthorization must be a boolean');

  for (const field of ['enabled', 'autoMerge']) {
    if (typeof project[field] !== 'boolean') {
      throw new TypeError(`${field} for project ${projectName} must be a boolean`);
    }
  }

  if (Object.hasOwn(project, 'prepareVenv') && typeof project.prepareVenv !== 'boolean') {
    throw new TypeError(`prepareVenv for project ${projectName} must be a boolean`);
  }

  if (Object.hasOwn(project, 'runtime') && !['node', 'python'].includes(project.runtime)) throw new TypeError('runtime must be node or python');

  if (Object.hasOwn(project, 'pythonEnvironment')) require('./legacy-python-preflight').validatePythonPolicy(project.pythonEnvironment);

  // An omitted policy behaves as `none`, which requires a persisted skip
  // explanation before the PR can be presented for merge. Until deterministic
  // risk classification exists, both `risk` and `always` require review.
  if (Object.hasOwn(project, 'reviewPolicy') && !['none', 'risk', 'always'].includes(project.reviewPolicy)) {
    throw new TypeError(`reviewPolicy for project ${projectName} must be none, risk, or always`);
  }

  if (Object.hasOwn(project, 'dependencyFormat') && project.dependencyFormat !== 'household-blocked-by') {
    throw new TypeError(`dependencyFormat for project ${projectName} must be household-blocked-by`);
  }

  if (project.dependencyFormat === 'household-blocked-by'
    && (project.reviewPolicy !== 'always' || project.autoMerge !== true)) {
    throw new TypeError(`dependencyFormat for project ${projectName} requires reviewPolicy always and autoMerge true`);
  }

  if (Object.hasOwn(project, 'reviewModel') && !['sonnet', 'opus'].includes(project.reviewModel)) {
    throw new TypeError(`reviewModel for project ${projectName} must be sonnet or opus`);
  }

  if (Object.hasOwn(project, 'reviewSkipReason')
    && (!isNonEmptyString(project.reviewSkipReason) || project.reviewSkipReason.trim().length > 4000)) {
    throw new TypeError(`reviewSkipReason for project ${projectName} must be a non-empty explanation of at most 4000 characters`);
  }

  // The GitHub Actions workflow name whose success on the exact delivered
  // commit is the only acceptable green CI result. Without it CI stays pending.
  if (Object.hasOwn(project, 'ciWorkflow') && !isNonEmptyString(project.ciWorkflow)) {
    throw new TypeError(`ciWorkflow for project ${projectName} must be a non-empty string`);
  }

  if (Object.hasOwn(project, 'stateDir') && !isNonEmptyString(project.stateDir)) {
    throw new TypeError(`stateDir for project ${projectName} must be a non-empty string`);
  }

  for (const field of STRING_FIELDS) {
    if (!isNonEmptyString(project[field])) {
      throw new TypeError(`${field} for project ${projectName} must be a non-empty string`);
    }
  }

  // Codex is the safe autonomous default.  Claude is intentionally opt-in so
  // an omitted worker cannot silently select a different CLI.
  if (Object.hasOwn(project, 'worker') && project.worker !== 'codex' && project.worker !== 'claude') {
    throw new TypeError(`worker for project ${projectName} must be codex or claude`);
  }

  if (Object.hasOwn(project, 'recoveryPaths')) {
    if (project.implementationStrategy !== 'worker-critic-loop'
      || !Array.isArray(project.recoveryPaths) || project.recoveryPaths.length < 1
      || project.recoveryPaths.length > 24 || project.recoveryPaths.some(value => typeof value !== 'string'
        || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:py|js|jsx|ts|tsx)$/i.test(value))
      || new Set(project.recoveryPaths).size !== project.recoveryPaths.length) {
      throw new TypeError('recoveryPaths requires a mixed-engine project and an explicit set of 1-24 safe source paths.');
    }
  }

  if (Object.hasOwn(project, 'implementationStrategy')
    && !['one-shot', 'worker-critic-loop'].includes(project.implementationStrategy)) {
    throw new TypeError(`implementationStrategy for project ${projectName} must be one-shot or worker-critic-loop`);
  }
  if (project.implementationStrategy === 'worker-critic-loop'
    && (project.worker !== 'codex' || !['always', 'risk'].includes(project.reviewPolicy))) {
    throw new TypeError('Mixed-engine R1 implementation requires Codex worker and independent review.');
  }

  if (Object.hasOwn(project, 'maxAttempts') &&
      (!Number.isInteger(project.maxAttempts) || project.maxAttempts < 1 || project.maxAttempts > 10)) {
    throw new TypeError(`maxAttempts for project ${projectName} must be an integer from 1 through 10`);
  }
}

function loadProjectConfig(projectName, options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('Autopilot project configuration options must be an object');
  }

  const configPath = Object.hasOwn(options, 'configPath') ? options.configPath : DEFAULT_CONFIG_PATH;

  if (!isNonEmptyString(configPath)) {
    throw new TypeError('options.configPath must be a non-empty string when provided');
  }

  let contents;

  try {
    contents = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read autopilot project configuration at ${configPath}: ${error.message}`);
  }

  let projects;
  try {
    projects = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON in autopilot project configuration at ${configPath}: ${error.message}`);
  }

  if (!isPlainObject(projects)) {
    throw new TypeError('Autopilot project configuration must be an object mapping project names to projects');
  }

  if (!Object.hasOwn(projects, projectName)) {
    throw new Error(`Unknown autopilot project: ${projectName}`);
  }

  const project = projects[projectName];
  validateProject(projectName, project);
  return {
    ...project,
    worker: project.worker ?? 'codex',
    // Keep the normal autonomous run bounded, while allowing an explicit
    // project policy to choose a different retry limit.
    maxAttempts: project.maxAttempts ?? 2,
    ...(project.implementationStrategy ? { implementationStrategy: project.implementationStrategy } : {}),
  };
}

module.exports = { loadProjectConfig };
