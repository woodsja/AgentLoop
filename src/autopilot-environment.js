'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('./execution-log');
const { preparePython, blocked } = require('./python-preflight');

function run(command, args, cwd, executeFile) {
  return new Promise((resolve, reject) => {
    executeFile(command, args, { cwd, shell: false, encoding: 'utf8', maxBuffer: 1024 * 1024 }, error => {
      if (error) reject(new Error('Repository environment preparation failed: unable to create the required .venv'));
      else resolve();
    });
  });
}

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
  execFile: executeFile = execFile,
  instructions = [],
  isCancelled,
  onProcess,
  requirePythonReadiness = false,
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
  if (project.runtime || fs.existsSync(path.join(projectPath, '.ralph/project.json'))) return require('./project-preflight').prepareNode(path.resolve(projectPath), project, { isCancelled, onProcess, timeoutMs, recordExecution, spawn });
  if (project.pythonEnvironment) return preparePython(path.resolve(projectPath), project.pythonEnvironment, { execFile: executeFile, isCancelled, onProcess });
  if (!project.prepareVenv && !instructionsRequireVenv(instructions)) return { venvPath: null };
  if (requirePythonReadiness) {
    // Existing owner prepareVenv projects may reuse prepared environments, but
    // dependency installation needs a new explicit owner source/hash policy.
    const localPython = path.join(path.resolve(projectPath), '.venv/bin/python');
    let interpreter;
    try { interpreter = fs.existsSync(localPython) ? fs.realpathSync(localPython) : '/usr/bin/python3'; }
    catch { throw blocked('unsafe_path'); }
    const commands = [...String(project.verification || '').matchAll(/\.venv\/bin\/([A-Za-z0-9_-]+)/g)]
      .map(match => match[1]).filter(name => name !== 'python' && name !== 'python3');
    return preparePython(path.resolve(projectPath), {
      interpreter, timeoutMs: 30000, commands: [...new Set(commands)],
      dependencies: ['pytest', 'ruff'].map(name => ({ name, version: null })),
    }, { execFile: executeFile, isCancelled, onProcess, checkOnly: true });
  }
  const venvPath = path.join(path.resolve(projectPath), '.venv');
  if (fs.existsSync(venvPath) && !fs.statSync(venvPath).isDirectory()) {
    throw new Error('Repository environment preparation failed: required .venv exists but is not a directory');
  }
  if (!fs.existsSync(venvPath)) await run('python3', ['-m', 'venv', '.venv'], projectPath, executeFile);
  return { venvPath };
}

module.exports = { instructionsRequireVenv, prepareRepositoryEnvironment };
