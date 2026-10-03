'use strict';

const { execFile } = require('node:child_process');

function run(command, args, cwd, executeFile, operation) {
  return new Promise((resolve, reject) => {
    try {
      executeFile(command, args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024, shell: false }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Autopilot delivery failed while ${operation}${stderr ? `: ${String(stderr).trim()}` : ''}`));
          return;
        }
        resolve(String(stdout));
      });
    } catch (error) {
      reject(new Error(`Autopilot delivery failed while ${operation}: ${error.message}`));
    }
  });
}

function parseJson(output, operation) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`Autopilot delivery failed while ${operation}: gh returned malformed JSON: ${error.message}`);
  }
}

function deliveryBase(project) {
  return typeof project.baseBranch === 'string' && project.baseBranch.trim() ? project.baseBranch : 'main';
}

function normalizePullRequest(value, operation) {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.number) || value.number < 1
    || typeof value.url !== 'string' || !value.url) {
    throw new Error(`Autopilot delivery failed while ${operation}: gh returned an unexpected pull request shape`);
  }
  return { number: value.number, url: value.url };
}

async function findOpenPullRequest(project, branch, base, cwd, executeFile) {
  const operation = 'finding an existing pull request';
  const response = parseJson(await run('gh', [
    'pr', 'list',
    '--repo', project.repo,
    '--head', branch,
    '--base', base,
    '--state', 'open',
    '--json', 'number,url,headRefName,baseRefName',
    '--limit', '100',
  ], cwd, executeFile, operation), operation);
  if (!Array.isArray(response)) {
    throw new Error(`Autopilot delivery failed while ${operation}: gh returned an unexpected response shape`);
  }
  // gh filters are not identity checks: only a PR for the exact deterministic
  // issue branch and configured base may be reused.
  const matches = response
    .filter(pr => pr && pr.headRefName === branch && pr.baseRefName === base)
    .map(pr => normalizePullRequest(pr, operation))
    .sort((left, right) => left.number - right.number);
  return matches[0] || null;
}

/**
 * Reuses the open pull request for the issue branch, or creates one against
 * the base branch whose body closes the issue.  Looking up by branch first
 * keeps a resumed delivery from opening a duplicate PR.
 */
async function reconcilePullRequest({ project, issue, branch, cwd }, executeFile) {
  const base = deliveryBase(project);
  const existing = await findOpenPullRequest(project, branch, base, cwd, executeFile);
  if (existing) return existing;
  await run('gh', [
    'pr', 'create',
    '--repo', project.repo,
    '--base', base,
    '--head', branch,
    '--title', issue.title.trim() ? issue.title : `Resolve #${issue.number}`,
    '--body', `Closes #${issue.number}`,
  ], cwd, executeFile, 'creating the pull request');
  // Read the PR back by branch rather than parsing gh's human-oriented output.
  const created = await findOpenPullRequest(project, branch, base, cwd, executeFile);
  if (!created) throw new Error('Autopilot delivery failed: the created pull request could not be found');
  return created;
}

/**
 * Commits any Ralph changes, publishes the deterministic issue branch, and
 * reconciles its pull request.  All Git and gh effects are injected for
 * deterministic tests.
 */
async function deliverPassedWork({ project, issue, workspace, ralphStatus, previousCommit, commitMessage }, {
  execFile: executeFile = execFile,
  onProgress,
} = {}) {
  // Only Ralph's deterministic `passed` verdict may produce a commit or push.
  // Refuse before any Git command so needs_planning (or any other status) can
  // never publish work, even if a caller misroutes it here.
  if (ralphStatus !== 'passed') {
    throw new Error(`Autopilot delivery refused: Ralph status is ${String(ralphStatus)}, not passed`);
  }
  if (!project || typeof project.repo !== 'string' || !project.repo || !issue
    || !Number.isSafeInteger(issue.number) || issue.number < 1 || typeof issue.title !== 'string'
    || !workspace || typeof workspace.worktreePath !== 'string' || !workspace.worktreePath
    || typeof workspace.branch !== 'string' || !workspace.branch) {
    throw new TypeError('Autopilot delivery requires project, issue, and workspace identity');
  }
  if (typeof executeFile !== 'function') throw new TypeError('Autopilot delivery requires an execFile function');
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw new TypeError('Autopilot delivery onProgress must be a function when provided');
  }

  const report = async progress => {
    if (onProgress) await onProgress(progress);
  };

  const cwd = workspace.worktreePath;
  const changed = (await run('git', ['status', '--porcelain'], cwd, executeFile, 'checking worktree changes')).trim();
  if (changed) {
    await run('git', ['add', '-A'], cwd, executeFile, 'staging Ralph changes');
    await run('git', ['commit', '-m', commitMessage || `ralph: resolve #${issue.number}`], cwd, executeFile, 'committing Ralph changes');
  }
  const commit = (await run('git', ['rev-parse', 'HEAD'], cwd, executeFile, 'recording the delivery commit')).trim();
  if (!commit) throw new Error('Autopilot delivery failed: Git returned an empty delivery commit');
  // A corrective delivery must carry a code change.  Re-pushing the commit CI
  // already judged red would only be a blind workflow rerun.
  if (previousCommit !== undefined && commit === previousCommit) {
    const error = new Error(`Autopilot delivery refused: correction produced no change from ${previousCommit}`);
    error.code = 'AUTOPILOT_NO_CHANGES';
    throw error;
  }
  await report({ branch: workspace.branch, commit, pushed: false });
  await run('git', ['push', '--set-upstream', 'origin', workspace.branch], cwd, executeFile, 'pushing the issue branch');
  await report({ branch: workspace.branch, commit, pushed: true });
  const pr = await reconcilePullRequest({ project, issue, branch: workspace.branch, cwd }, executeFile);
  const delivery = { branch: workspace.branch, commit, pushed: true, pr };
  await report(delivery);
  return delivery;
}

module.exports = { deliverPassedWork, reconcilePullRequest };
