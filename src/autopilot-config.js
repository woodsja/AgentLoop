const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', 'autopilot-projects.json');
const crypto = require('node:crypto');
let runtimeIdentity;
function projectConfigPath(explicit) {
  return explicit ?? process.env.AGENTLOOP_PROJECTS_PATH ?? DEFAULT_CONFIG_PATH;
}
// An explicitly selected runtime file is owner configuration. Pin its canonical
// identity for this process and refuse drift on every later project load.
let lastRuntimeDiagnostic;
function runtimeDiagnostic(event) {
  const key = JSON.stringify({ ...event, error: event.error?.split('\n')[0] });
  if (lastRuntimeDiagnostic === key) return;
  const state = process.env.AGENTLOOP_STATE_DIR || path.resolve(__dirname, '..', 'state');
  fs.mkdirSync(state, { recursive: true });
  const fd = fs.openSync(path.join(state, 'project-config.ndjson'), 'a', 0o600);
  try { fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const dir = fs.openSync(state, 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  lastRuntimeDiagnostic = key;
}
function runtimeProjectConfigIdentity() {
  if (process.env.AGENTLOOP_PROJECTS_PATH === undefined && !runtimeIdentity) return null;
  try {
    const file = process.env.AGENTLOOP_PROJECTS_PATH;
    const { canonicalAbsolute, regular } = require('./deploy-files');
    canonicalAbsolute(file); regular(file);
    const identity = { path: file, hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
    if (runtimeIdentity && (identity.path !== runtimeIdentity.path || identity.hash !== runtimeIdentity.hash)) {
      throw new Error('Runtime project configuration changed; owner restart required');
    }
    runtimeIdentity ||= Object.freeze(identity);
    if (lastRuntimeDiagnostic) runtimeDiagnostic({ code: 'PROJECT_CONFIG_RESTORED', identity });
    return runtimeIdentity;
  } catch (error) {
    try { runtimeDiagnostic({ code: 'PROJECT_CONFIG_DEGRADED', expected: runtimeIdentity, error: error.stack }); }
    catch (diagnosticError) { console.error('Project configuration diagnostic persistence failed:', diagnosticError.stack, error.stack); }
    throw error;
  }
}
function runtimeProjectConfigAttestation() {
  const identity = runtimeProjectConfigIdentity();
  return identity ? { pathHash: crypto.createHash('sha256').update(identity.path).digest('hex'), hash: identity.hash } : null;
}
// Keep the owner dashboard available, but never attest stale policy as healthy.
function runtimeProjectConfigState() {
  try { return runtimeProjectConfigAttestation(); }
  catch (error) { return { degraded: true, hash: null, pathHash: null, error: error.message,
    expected: runtimeIdentity ? { pathHash: crypto.createHash('sha256').update(runtimeIdentity.path).digest('hex'), hash: runtimeIdentity.hash } : null }; }
}
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

  if (Object.hasOwn(project, 'architectureDecisions') && typeof project.architectureDecisions !== 'boolean') throw new TypeError('architectureDecisions must be a boolean');
  if (Object.hasOwn(project, 'decisionOwner') && (typeof project.decisionOwner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(project.decisionOwner))) throw new TypeError('decisionOwner must be a GitHub login');
  if (project.architectureDecisions === true && ['needs-owner-decision', ''].includes(project.readyLabel)) throw new TypeError('Decision issues require a separate ready label');

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

  if (Object.hasOwn(project, 'maxReviewRounds')
    && (!Number.isInteger(project.maxReviewRounds) || project.maxReviewRounds < 1 || project.maxReviewRounds > 5)) {
    throw new TypeError(`maxReviewRounds for project ${projectName} must be an integer from 1 through 5`);
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

  const configPath = Object.hasOwn(options, 'configPath') ? options.configPath : projectConfigPath();
  const identity = !Object.hasOwn(options, 'configPath') ? runtimeProjectConfigIdentity() : null;

  if (!isNonEmptyString(configPath)) {
    throw new TypeError('options.configPath must be a non-empty string when provided');
  }

  let contents;

  try {
    contents = fs.readFileSync(configPath, 'utf8');
    if (identity && crypto.createHash('sha256').update(contents).digest('hex') !== identity.hash) {
      throw new Error('Runtime project configuration changed during read');
    }
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
    maxReviewRounds: project.maxReviewRounds ?? 2,
    ...(project.implementationStrategy ? { implementationStrategy: project.implementationStrategy } : {}),
  };
}

module.exports = { loadProjectConfig, projectConfigPath, runtimeProjectConfigIdentity, runtimeProjectConfigAttestation, runtimeProjectConfigState };
