'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

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
} = {}) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new TypeError('Repository environment preparation requires a project path');
  }
  if (!project || typeof project !== 'object') {
    throw new TypeError('Repository environment preparation requires a project configuration');
  }
  if (!project.prepareVenv && !instructionsRequireVenv(instructions)) return { venvPath: null };
  const venvPath = path.join(path.resolve(projectPath), '.venv');
  if (fs.existsSync(venvPath) && !fs.statSync(venvPath).isDirectory()) {
    throw new Error('Repository environment preparation failed: required .venv exists but is not a directory');
  }
  if (!fs.existsSync(venvPath)) await run('python3', ['-m', 'venv', '.venv'], projectPath, executeFile);
  return { venvPath };
}

module.exports = { instructionsRequireVenv, prepareRepositoryEnvironment };
