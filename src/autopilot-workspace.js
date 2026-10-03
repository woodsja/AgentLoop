'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MAX_SLUG_LENGTH = 48;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateIssue(issue) {
  if (!isPlainObject(issue) || !Number.isSafeInteger(issue.number) || issue.number < 1
    || typeof issue.title !== 'string') {
    throw new TypeError('Workspace operations require an issue with a positive integer number and string title');
  }
}

function validateProject(project) {
  if (!isPlainObject(project) || typeof project.checkout !== 'string' || !project.checkout.trim()
    || typeof project.worktreeRoot !== 'string' || !project.worktreeRoot.trim()
    || typeof project.baseBranch !== 'string' || !project.baseBranch.trim()) {
    throw new TypeError('Workspace operations require a project with checkout, worktreeRoot, and baseBranch');
  }
}

function issueSlug(title) {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');

  return slug || 'untitled';
}

function deriveBranchName(issue) {
  validateIssue(issue);
  return `ralph/issue-${issue.number}-${issueSlug(issue.title)}`;
}

function deriveWorktreePath(project, issue) {
  validateProject(project);
  validateIssue(issue);
  return path.resolve(project.worktreeRoot, `issue-${issue.number}`);
}

function gitFailure(operation) {
  return new Error(`Git workspace operation failed: ${operation}`);
}

function runGit(args, cwd, executeFile = execFile, operation) {
  return new Promise((resolve, reject) => {
    try {
      executeFile('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        shell: false,
      }, (error, stdout) => {
        if (error) {
          reject(gitFailure(operation));
          return;
        }
        resolve(String(stdout));
      });
    } catch (error) {
      reject(gitFailure(operation));
    }
  });
}

function runGitAllowMissingBranch(args, cwd, executeFile) {
  return new Promise((resolve, reject) => {
    try {
      executeFile('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        shell: false,
      }, (error) => {
        if (!error) {
          resolve(true);
        } else if (error.code === 1) {
          resolve(false);
        } else {
          reject(gitFailure('checking whether the issue branch already exists'));
        }
      });
    } catch (error) {
      reject(gitFailure('checking whether the issue branch already exists'));
    }
  });
}

function assertDestinationIsEmptyOrMissing(worktreePath) {
  if (!fs.existsSync(worktreePath)) return;

  let entries;
  try {
    entries = fs.readdirSync(worktreePath);
  } catch (error) {
    throw new Error('Workspace preparation refused: destination cannot be inspected safely');
  }

  if (entries.length > 0) {
    throw new Error('Workspace preparation refused: destination is not empty');
  }
}

function assertManagedWorktreePath(project, worktreePath) {
  const root = path.resolve(project.worktreeRoot);
  const resolvedPath = path.resolve(worktreePath);
  const relativePath = path.relative(root, resolvedPath);

  if (path.dirname(relativePath) !== '.' || !/^issue-[1-9][0-9]*$/.test(relativePath)) {
    throw new Error('Workspace cleanup refused: worktree path is outside the managed issue workspace root');
  }
  return resolvedPath;
}

/**
 * Creates an issue-specific worktree from origin/<baseBranch>.
 * No fetch is performed: callers must arrange for the checkout's remote ref to exist.
 */
async function prepareIssueWorkspace(project, issue, { execFile: executeFile = execFile } = {}) {
  validateProject(project);
  validateIssue(issue);
  if (typeof executeFile !== 'function') throw new TypeError('Workspace preparation requires an execFile function');

  const branch = deriveBranchName(issue);
  const worktreePath = deriveWorktreePath(project, issue);
  const baseRef = `origin/${project.baseBranch}`;

  try {
    fs.mkdirSync(project.worktreeRoot, { recursive: true });
  } catch (error) {
    throw new Error('Workspace preparation failed: unable to create the worktree root');
  }

  assertDestinationIsEmptyOrMissing(worktreePath);

  const branchExists = await runGitAllowMissingBranch(
    ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    project.checkout,
    executeFile,
  );
  if (branchExists) {
    throw new Error('Workspace preparation refused: issue branch already exists');
  }

  await runGit(
    ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`],
    project.checkout,
    executeFile,
    'verifying the configured base remote ref',
  );

  try {
    await runGit(
      ['worktree', 'add', '-b', branch, worktreePath, baseRef],
      project.checkout,
      executeFile,
      'creating the issue worktree',
    );
  } catch (error) {
    await cleanupIssueWorkspace(project, { worktreePath }, { execFile: executeFile, suppressErrors: true });
    throw error;
  }

  return { branch, worktreePath, baseRef };
}

/** Removes a registered worktree and any directory left behind by an interrupted operation. */
async function cleanupIssueWorkspace(project, workspaceOrIssue, options = {}) {
  validateProject(project);
  const { execFile: executeFile = execFile, suppressErrors = false } = options;
  if (typeof executeFile !== 'function') throw new TypeError('Workspace cleanup requires an execFile function');

  const requestedPath = isPlainObject(workspaceOrIssue) && typeof workspaceOrIssue.worktreePath === 'string'
    ? path.resolve(workspaceOrIssue.worktreePath)
    : deriveWorktreePath(project, workspaceOrIssue);
  const worktreePath = assertManagedWorktreePath(project, requestedPath);
  let failure = null;

  if (fs.existsSync(worktreePath)) {
    try {
      await runGit(['worktree', 'remove', '--force', worktreePath], project.checkout, executeFile, 'removing the issue worktree');
    } catch (error) {
      failure = error;
    }
  }

  try {
    await runGit(['worktree', 'prune'], project.checkout, executeFile, 'pruning worktree metadata');
  } catch (error) {
    failure = failure || error;
  }

  try {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  } catch (error) {
    failure = failure || new Error('Workspace cleanup failed: unable to remove the leftover worktree directory');
  }

  if (failure && !suppressErrors) throw failure;
}

module.exports = {
  deriveBranchName,
  deriveWorktreePath,
  prepareIssueWorkspace,
  cleanupIssueWorkspace,
};
