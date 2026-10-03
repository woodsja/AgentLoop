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

  for (const field of ['enabled', 'autoMerge']) {
    if (typeof project[field] !== 'boolean') {
      throw new TypeError(`${field} for project ${projectName} must be a boolean`);
    }
  }

  for (const field of STRING_FIELDS) {
    if (!isNonEmptyString(project[field])) {
      throw new TypeError(`${field} for project ${projectName} must be a non-empty string`);
    }
  }

  if (project.worker !== 'codex' && project.worker !== 'claude') {
    throw new TypeError(`worker for project ${projectName} must be codex or claude`);
  }

  if (!Number.isInteger(project.maxAttempts) || project.maxAttempts < 1 || project.maxAttempts > 10) {
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
  return { ...project };
}

module.exports = { loadProjectConfig };
