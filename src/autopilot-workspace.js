'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('./execution-log');
const { unattendedOptions } = require('./autopilot-subprocess');

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
      executeFile('git', args, unattendedOptions({
        cwd,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        shell: false,
      }), (error, stdout) => {
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
      executeFile('git', args, unattendedOptions({
        cwd,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        shell: false,
      }), (error) => {
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

function parseWorktreeList(output) {
  const worktrees = [];
  let current = null;
  for (const line of String(output).split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: path.resolve(line.slice('worktree '.length)), branch: null };
    } else if (current && line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

async function registeredWorktreeAt(project, worktreePath, executeFile) {
  const output = await runGit(
    ['worktree', 'list', '--porcelain'],
    project.checkout,
    executeFile,
    'listing registered worktrees',
  );
  const worktrees = parseWorktreeList(output);
  // Git always lists the main working tree first; it is never removable here.
  if (worktrees.length > 0 && worktrees[0].path === worktreePath) {
    throw new Error('Workspace cleanup refused: worktree path is the main project checkout');
  }
  return worktrees.find(entry => entry.path === worktreePath) || null;
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

function realpathOrResolved(target) {
  try {
    return fs.realpathSync(target);
  } catch (error) {
    return path.resolve(target);
  }
}

function isSameOrInside(parent, child) {
  const relativePath = path.relative(parent, child);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function assertManagedWorktreePath(project, worktreePath) {
  const root = path.resolve(project.worktreeRoot);
  const resolvedPath = path.resolve(worktreePath);
  const relativePath = path.relative(root, resolvedPath);

  if (path.dirname(relativePath) !== '.' || !/^issue-[1-9][0-9]*$/.test(relativePath)) {
    throw new Error('Workspace cleanup refused: worktree path is outside the managed issue workspace root');
  }
  // The project's main checkout is never an issue workspace, however the
  // worktree root happens to be configured (or symlinked) relative to it.
  const checkouts = [path.resolve(project.checkout), realpathOrResolved(project.checkout)];
  for (const candidate of [resolvedPath, realpathOrResolved(resolvedPath)]) {
    if (checkouts.some(checkout => isSameOrInside(candidate, checkout))) {
      throw new Error('Workspace cleanup refused: worktree path is the main project checkout');
    }
  }
  return resolvedPath;
}

function branchForManagedPath(worktreePath, branch) {
  if (typeof branch !== 'string') return null;
  const issueNumber = path.basename(worktreePath).match(/^issue-([1-9][0-9]*)$/)?.[1];
  return issueNumber && new RegExp(`^ralph/issue-${issueNumber}-[a-z0-9-]+$`).test(branch)
    ? branch
    : null;
}

/**
 * Creates an issue-specific worktree from the current origin/<baseBranch>.
 */
async function prepareIssueWorkspace(project, issue, {
  execFile: executeFile = execFile,
  branch: persistedBranch,
  headCommit,
} = {}) {
  validateProject(project);
  validateIssue(issue);
  if (typeof executeFile !== 'function') throw new TypeError('Workspace preparation requires an execFile function');
  if (headCommit !== undefined && (typeof headCommit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(headCommit))) {
    throw new TypeError('Workspace preparation requires a commit id when a head commit is given');
  }

  const worktreePath = deriveWorktreePath(project, issue);
  // A resumed job keeps the branch recorded when it was created, even if the
  // issue title (and therefore the derived slug) has since changed.
  if (persistedBranch !== undefined && branchForManagedPath(worktreePath, persistedBranch) === null) {
    throw new TypeError('Workspace preparation requires a managed branch name for this issue');
  }
  const branch = persistedBranch ?? deriveBranchName(issue);
  const baseRef = `origin/${project.baseBranch}`;

  try {
    fs.mkdirSync(project.worktreeRoot, { recursive: true });
  } catch (error) {
    throw new Error('Workspace preparation failed: unable to create the worktree root');
  }

  assertDestinationIsEmptyOrMissing(worktreePath);

  // Never base autonomous work on whatever ref happened to be fetched previously.
  await runGit(
    ['fetch', '--no-tags', 'origin', project.baseBranch],
    project.checkout,
    executeFile,
    'fetching the configured base remote ref',
  );

  const branchExists = await runGitAllowMissingBranch(
    ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    project.checkout,
    executeFile,
  );
  await runGit(
    ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`],
    project.checkout,
    executeFile,
    'verifying the configured base remote ref',
  );

  // A corrective cycle continues the delivered branch at exactly the commit
  // CI judged; it must never silently restart from the base branch.
  let startPoint = baseRef;
  if (headCommit !== undefined) {
    const resolved = (await runGit(
      ['rev-parse', '--verify', '--quiet', `${branchExists ? `refs/heads/${branch}` : headCommit}^{commit}`],
      project.checkout,
      executeFile,
      'verifying the delivered head commit',
    )).trim();
    if (!resolved || !resolved.startsWith(headCommit.toLowerCase())) {
      throw new Error('Workspace preparation refused: the issue branch does not point at the delivered head commit');
    }
    startPoint = headCommit;
  }

  try {
    await runGit(
      branchExists ? ['worktree', 'add', worktreePath, branch] : ['worktree', 'add', '-b', branch, worktreePath, startPoint],
      project.checkout,
      executeFile,
      'creating the issue worktree',
    );
  } catch (error) {
    // `git worktree add` can create either the branch or destination before
    // reporting an error.  Hand both to cleanup so an interrupted
    // preparation never blocks a later, fresh attempt for this issue.  A
    // delivered branch is published work and is never deleted here.
    await cleanupIssueWorkspace(project, { worktreePath, branch }, {
      execFile: executeFile,
      suppressErrors: true,
      preserveBranch: headCommit !== undefined,
    });
    throw error;
  }

  return { branch, worktreePath, baseRef };
}

/** Removes a registered worktree and any directory left behind by an interrupted operation. */
async function cleanupIssueWorkspace(project, workspaceOrIssue, options = {}) {
  validateProject(project);
  const { execFile: executeFile = execFile, suppressErrors = false, preserveBranch = false } = options;
  if (typeof executeFile !== 'function') throw new TypeError('Workspace cleanup requires an execFile function');

  const requestedPath = isPlainObject(workspaceOrIssue) && typeof workspaceOrIssue.worktreePath === 'string'
    ? path.resolve(workspaceOrIssue.worktreePath)
    : deriveWorktreePath(project, workspaceOrIssue);
  const worktreePath = assertManagedWorktreePath(project, requestedPath);
  const requestedBranch = isPlainObject(workspaceOrIssue) && typeof workspaceOrIssue.branch === 'string'
    ? workspaceOrIssue.branch
    : (!isPlainObject(workspaceOrIssue) ? deriveBranchName(workspaceOrIssue) : null);
  const branch = branchForManagedPath(worktreePath, requestedBranch);
  let failure = null;
  let registered = null;
  let listedWorktrees = false;
  let removedRegisteredWorktree = false;

  try {
    registered = await registeredWorktreeAt(project, worktreePath, executeFile);
    listedWorktrees = true;
  } catch (error) {
    failure = error;
  }
  const belongsToIssue = listedWorktrees && (!registered || (branch && registered.branch === branch));

  // A deterministic issue-N directory alone is not enough evidence that it
  // belongs to this job: an operator may have made an unrelated worktree in
  // the same root.  A registered worktree must also have this issue's
  // recorded ralph branch before it can be removed.  An unregistered path is
  // the residue left by a failed `git worktree add`, and is safe to clear.
  if (!listedWorktrees) {
    // Without Git's registry we cannot tell a failed preparation directory
    // from an operator-created worktree, so leave the filesystem untouched.
  } else if (!belongsToIssue) {
    failure = failure || new Error('Workspace cleanup refused: registered worktree does not belong to this issue branch');
  } else if (fs.existsSync(worktreePath)) {
    try {
      await runGit(['worktree', 'remove', '--force', worktreePath], project.checkout, executeFile, 'removing the issue worktree');
      removedRegisteredWorktree = true;
    } catch (error) {
      failure = error;
    }
  }

  try {
    await runGit(['worktree', 'prune'], project.checkout, executeFile, 'pruning worktree metadata');
  } catch (error) {
    failure = failure || error;
  }

  // An unregistered directory is a partial `worktree add` residue and can be
  // removed directly. If Git declined to remove a registered checkout, retain
  // it: deleting it recursively would destroy work while retaining ambiguous
  // Git metadata.
  if (belongsToIssue && (!registered || removedRegisteredWorktree)) {
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    } catch (error) {
      failure = failure || new Error('Workspace cleanup failed: unable to remove the leftover worktree directory');
    }
  }

  // Branches are preparation resources too.  Leaving one behind turns the
  // next run for the same ready issue into a permanent "branch exists"
  // failure.  Only branches recorded by preparation (or derived directly
  // from an issue) are eligible for removal.
  if (belongsToIssue && branch && !preserveBranch && !fs.existsSync(worktreePath)) {
    try {
      const exists = await runGitAllowMissingBranch(
        ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
        project.checkout,
        executeFile,
      );
      if (exists) {
        await runGit(['branch', '--delete', '--force', '--', branch], project.checkout, executeFile, 'removing the issue branch');
      }
    } catch (error) {
      failure = failure || error;
    }
  }

  if (failure && !suppressErrors) throw failure;
}

module.exports = {
  deriveBranchName,
  deriveWorktreePath,
  prepareIssueWorkspace,
  cleanupIssueWorkspace,
};
