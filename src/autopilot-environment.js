'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { preparePython } = require('./python-preflight');
const { blocked, readContract } = require('./project-preflight');

function instructionsRequireVenv(instructions) {
  if (!Array.isArray(instructions)) return false;
  return instructions.some(instruction => {
    if (!instruction || typeof instruction.content !== 'string') return false;
    // AGENTS.md commonly says both that commands must use .venv and that it
    // must be recreated if absent.  Treat either spelling as a requirement.
    return /(?:^|\W)\.venv(?:\W|$)|virtual\s+environment/i.test(instruction.content);
  });
}

async function prepareRepositoryEnvironment(projectPath, project, {
  instructions = [],
  isCancelled,
  onProcess,
  timeoutMs,
  recordExecution,
  spawn,
} = {}) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new TypeError('Repository environment preparation requires a project path');
  }
  if (!project || typeof project !== 'object') {
    throw new TypeError('Repository environment preparation requires a project configuration');
  }
  if (project.runtime || fs.existsSync(path.join(projectPath, '.ralph/project.json'))) {
    const root = path.resolve(projectPath);
    const contract = readContract(root, project.runtime);
    const prepare = contract.runtime === 'python' ? preparePython : require('./project-preflight').prepareNode;
    return prepare(root, project, { isCancelled, onProcess, timeoutMs, recordExecution, spawn });
  }
  // Keep legacy, currently active owner policies available until controlled migration.
  if (project.pythonEnvironment) return require('./legacy-python-preflight').preparePython(path.resolve(projectPath), project.pythonEnvironment, { isCancelled, onProcess });
  if (project.prepareVenv || instructionsRequireVenv(instructions)) {
    throw blocked('contract_missing', 'Python setup requires .ralph/project.json, pyproject.toml and a committed uv.lock. Run project add to migrate the staged legacy registration; bare prepareVenv and instruction-only setup are retired.');
  }
  return { venvPath: null };
}

module.exports = { instructionsRequireVenv, prepareRepositoryEnvironment };
