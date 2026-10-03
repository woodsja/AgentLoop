'use strict';

const { execFile } = require('node:child_process');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function runGh(args, executeFile) {
  return new Promise((resolve, reject) => {
    try {
      executeFile('gh', args, { encoding: 'utf8', maxBuffer: 1024 * 1024, shell: false }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`GitHub issue discovery failed: gh exited unsuccessfully${stderr ? `: ${String(stderr).trim()}` : ''}`));
          return;
        }
        resolve(String(stdout));
      });
    } catch (error) {
      reject(new Error(`GitHub issue discovery failed: unable to execute gh: ${error.message}`));
    }
  });
}

function normalizeIssue(issue) {
  if (!isPlainObject(issue)
    || !Number.isSafeInteger(issue.number)
    || issue.number < 1
    || typeof issue.title !== 'string'
    || issue.state !== 'OPEN') {
    throw new Error('GitHub issue discovery failed: gh returned an unexpected issue shape');
  }

  return { number: issue.number, title: issue.title };
}

/**
 * Lists the configured repository's open issues carrying its ready label.
 * This function is intentionally read-only and invokes gh directly, never via a shell.
 */
async function discoverReadyIssues(project, { execFile: executeFile = execFile } = {}) {
  if (!isPlainObject(project) || typeof project.repo !== 'string' || !project.repo.trim()
    || typeof project.readyLabel !== 'string' || !project.readyLabel.trim()) {
    throw new TypeError('GitHub issue discovery requires a project with repo and readyLabel');
  }

  if (typeof executeFile !== 'function') {
    throw new TypeError('GitHub issue discovery requires an execFile function');
  }

  const args = [
    'issue', 'list',
    '--repo', project.repo,
    '--state', 'open',
    '--label', project.readyLabel,
    '--json', 'number,title,state',
    '--limit', '1000',
  ];
  const output = await runGh(args, executeFile);
  let response;
  try {
    response = JSON.parse(output);
  } catch (error) {
    throw new Error(`GitHub issue discovery failed: gh returned malformed JSON: ${error.message}`);
  }

  if (!Array.isArray(response)) {
    throw new Error('GitHub issue discovery failed: gh returned an unexpected response shape');
  }

  return response.map(normalizeIssue).sort((left, right) => left.number - right.number);
}

function selectReadyIssue(issues) {
  if (!Array.isArray(issues)) {
    throw new TypeError('Ready issues must be an array');
  }
  return issues.length === 0 ? null : [...issues].sort((left, right) => left.number - right.number)[0];
}

module.exports = { discoverReadyIssues, selectReadyIssue };
