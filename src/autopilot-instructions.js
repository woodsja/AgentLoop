'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readRepositoryInstructions(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new TypeError('Repository instruction discovery requires a project path');
  }

  const root = path.resolve(projectPath);
  const instructions = [];
  const ignored = new Set(['.git', '.venv', 'node_modules']);
  function visit(directory) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Repository instruction discovery failed: unable to inspect repository instructions: ${error.message}`);
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && !ignored.has(entry.name)) visit(entryPath);
      if (entry.isFile() && entry.name === 'AGENTS.md') {
        try {
          instructions.push({ path: path.relative(root, entryPath), content: fs.readFileSync(entryPath, 'utf8') });
        } catch (error) {
          throw new Error(`Repository instruction discovery failed: unable to read ${path.relative(root, entryPath)}: ${error.message}`);
        }
      }
    }
  }
  visit(root);
  return instructions.sort((left, right) => left.path.localeCompare(right.path));
}

function formatRepositoryInstructions(instructions) {
  if (!Array.isArray(instructions) || instructions.length === 0) return 'No repository AGENTS.md instructions were found.';
  return instructions.map(instruction => `--- ${instruction.path} ---\n${instruction.content.trim()}`).join('\n\n');
}

module.exports = { readRepositoryInstructions, formatRepositoryInstructions };
