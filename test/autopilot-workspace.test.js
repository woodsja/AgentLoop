'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  deriveBranchName,
  deriveWorktreePath,
  prepareIssueWorkspace,
  cleanupIssueWorkspace,
} = require('../src/autopilot-workspace');

const temporaryDirectories = new Set();

test.afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-autopilot-workspace-'));
  temporaryDirectories.add(root);
  const origin = path.join(root, 'origin');
  const checkout = path.join(root, 'checkout');
  const worktreeRoot = path.join(root, 'worktrees');

  git(root, ['init', '--initial-branch=main', origin]);
  git(origin, ['config', 'user.name', 'Workspace Test']);
  git(origin, ['config', 'user.email', 'workspace-test@example.invalid']);
  fs.writeFileSync(path.join(origin, 'README.md'), 'fixture\n');
  git(origin, ['add', 'README.md']);
  git(origin, ['commit', '-m', 'fixture']);
  git(root, ['clone', origin, checkout]);
  return { root, origin, checkout, worktreeRoot, baseBranch: 'main' };
}

test('derives stable, safe branch names and deterministic worktree paths', () => {
  const issue = { number: 42, title: '  Café: Build / Test — Again!!!  ' };
  assert.equal(deriveBranchName(issue), 'ralph/issue-42-cafe-build-test-again');
  assert.equal(deriveBranchName({ number: 7, title: '---' }), 'ralph/issue-7-untitled');
  assert.match(deriveBranchName({ number: 8, title: 'x'.repeat(200) }), /^ralph\/issue-8-x{48}$/);
  assert.equal(deriveWorktreePath({ checkout: '/checkout', worktreeRoot: '/tmp/worktrees', baseBranch: 'main' }, issue), '/tmp/worktrees/issue-42');
});

test('prepares an isolated worktree from the configured origin base ref and cleans it idempotently', async () => {
  const project = makeRepository();
  const issue = { number: 14, title: 'Add isolated worktrees' };
  const workspace = await prepareIssueWorkspace(project, issue);

  assert.deepEqual(workspace, {
    branch: 'ralph/issue-14-add-isolated-worktrees',
    worktreePath: path.join(project.worktreeRoot, 'issue-14'),
    baseRef: 'origin/main',
  });
  assert.equal(fs.readFileSync(path.join(workspace.worktreePath, 'README.md'), 'utf8'), 'fixture\n');
  assert.equal(git(project.checkout, ['branch', '--show-current']).trim(), 'main');

  await cleanupIssueWorkspace(project, workspace);
  await cleanupIssueWorkspace(project, workspace);
  assert.equal(fs.existsSync(workspace.worktreePath), false);
  assert.equal(git(project.checkout, ['worktree', 'list', '--porcelain']).includes(workspace.worktreePath), false);
});

test('refuses existing branches and non-empty deterministic destinations without overwriting them', async () => {
  const project = makeRepository();
  const issue = { number: 9, title: 'Keep existing files' };
  const branch = deriveBranchName(issue);
  git(project.checkout, ['branch', branch, 'origin/main']);
  await assert.rejects(prepareIssueWorkspace(project, issue), /issue branch already exists/);

  const secondIssue = { number: 10, title: 'Existing directory' };
  const destination = deriveWorktreePath(project, secondIssue);
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'keep.txt'), 'keep');
  await assert.rejects(prepareIssueWorkspace(project, secondIssue), /destination is not empty/);
  assert.equal(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8'), 'keep');
});

test('reports git failures by operation without leaking subprocess details', async () => {
  const project = makeRepository();
  await assert.rejects(
    prepareIssueWorkspace({ ...project, baseBranch: 'missing' }, { number: 3, title: 'Missing base' }),
    /Git workspace operation failed: verifying the configured base remote ref/,
  );
});

test('best-effort cleans a destination created by a failed worktree add', async () => {
  const project = makeRepository();
  const issue = { number: 25, title: 'Clean failed creation' };
  const destination = deriveWorktreePath(project, issue);
  let addAttempted = false;

  function failingGit(command, args, options, callback) {
    assert.equal(command, 'git');
    assert.equal(options.shell, false);
    if (args[0] === 'show-ref') {
      const error = new Error('branch absent');
      error.code = 1;
      callback(error, '', '');
      return;
    }
    if (args[0] === 'worktree' && args[1] === 'add') {
      addAttempted = true;
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, 'partial'), 'partial');
      const error = new Error('simulated private subprocess output');
      error.code = 1;
      callback(error, '', 'simulated private subprocess output');
      return;
    }
    callback(null, '', '');
  }

  await assert.rejects(
    prepareIssueWorkspace(project, issue, { execFile: failingGit }),
    /Git workspace operation failed: creating the issue worktree/,
  );
  assert.equal(addAttempted, true);
  assert.equal(fs.existsSync(destination), false);
});

test('cleanup refuses a path outside the configured worktree root', async () => {
  const project = makeRepository();
  const outsidePath = path.join(project.root, 'outside');
  fs.mkdirSync(outsidePath);

  await assert.rejects(
    cleanupIssueWorkspace(project, { worktreePath: outsidePath }),
    /outside the managed issue workspace root/,
  );
  assert.equal(fs.existsSync(outsidePath), true);
});
