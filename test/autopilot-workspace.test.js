'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  deriveBranchName,
  deriveWorktreePath,
  prepareIssueWorkspace,
  cleanupIssueWorkspace,
} = require('../src/autopilot-workspace');
const { readRepositoryInstructions } = require('../src/autopilot-instructions');
const { prepareRepositoryEnvironment } = require('../src/autopilot-environment');
const { createJob, createJobStore } = require('../src/autopilot-state');
const { cleanupTerminalWorkspaces } = require('../src/autopilot');

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

test('reuses a persisted branch for a resumed issue even after its title changes', async () => {
  const project = makeRepository();
  const issue = { number: 15, title: 'Renamed issue title' };
  const workspace = await prepareIssueWorkspace(project, issue, { branch: 'ralph/issue-15-original-title' });
  assert.equal(workspace.branch, 'ralph/issue-15-original-title');
  assert.equal(git(project.checkout, ['branch', '--list', workspace.branch]).trim().replace(/^[+*]\s*/, ''), workspace.branch);
  await cleanupIssueWorkspace(project, workspace);
  assert.equal(git(project.checkout, ['branch', '--list', workspace.branch]).trim(), '');

  await assert.rejects(prepareIssueWorkspace(project, issue, { branch: 'main' }), /managed branch name/);
  await assert.rejects(prepareIssueWorkspace(project, issue, { branch: 'ralph/issue-16-other' }), /managed branch name/);
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
  assert.equal(git(project.checkout, ['branch', '--list', workspace.branch]).trim(), '');
});

test('removes a finished issue worktree and its repo-local virtual environment', async () => {
  const project = makeRepository();
  const workspace = await prepareIssueWorkspace(project, { number: 41, title: 'Finished cleanup' });
  const venvPath = path.join(workspace.worktreePath, '.venv');
  fs.mkdirSync(venvPath);
  fs.writeFileSync(path.join(venvPath, 'marker'), 'created by issue work');

  await cleanupIssueWorkspace(project, workspace);

  assert.equal(fs.existsSync(workspace.worktreePath), false);
  assert.equal(fs.existsSync(venvPath), false);
  assert.equal(git(project.checkout, ['worktree', 'list', '--porcelain']).includes(workspace.worktreePath), false);
});

test('prunes stale metadata after an issue worktree disappears unexpectedly', async () => {
  const project = makeRepository();
  const workspace = await prepareIssueWorkspace(project, { number: 42, title: 'Prune stale metadata' });
  fs.rmSync(workspace.worktreePath, { recursive: true, force: true });
  assert.equal(git(project.checkout, ['worktree', 'list', '--porcelain']).includes(workspace.worktreePath), true);

  await cleanupIssueWorkspace(project, workspace);

  assert.equal(git(project.checkout, ['worktree', 'list', '--porcelain']).includes(workspace.worktreePath), false);
  assert.equal(git(project.checkout, ['branch', '--list', workspace.branch]).trim(), '');
});

test('instruction-only legacy Python setup fails with migration guidance and remains cleanable', async () => {
  const project = makeRepository();
  fs.writeFileSync(path.join(project.origin, 'AGENTS.md'), 'Run checks through the repository .venv.\n');
  git(project.origin, ['add', 'AGENTS.md']);
  git(project.origin, ['commit', '-m', 'add workspace instructions']);
  const workspace = await prepareIssueWorkspace(project, { number: 15, title: 'Prepare environment' });
  const instructions = readRepositoryInstructions(workspace.worktreePath);
  await assert.rejects(prepareRepositoryEnvironment(workspace.worktreePath, {}, { instructions }), /committed uv.lock/);
  assert.equal(fs.existsSync(path.join(workspace.worktreePath, '.venv')), false);
  await cleanupIssueWorkspace(project, workspace);
  assert.equal(fs.existsSync(workspace.worktreePath), false);
});

test('fetches origin before creating a worktree, so the base is not a stale local remote ref', async () => {
  const project = makeRepository();
  fs.writeFileSync(path.join(project.origin, 'current.txt'), 'current\n');
  git(project.origin, ['add', 'current.txt']);
  git(project.origin, ['commit', '-m', 'advance origin']);

  const workspace = await prepareIssueWorkspace(project, { number: 33, title: 'Current base' });
  assert.equal(fs.readFileSync(path.join(workspace.worktreePath, 'current.txt'), 'utf8'), 'current\n');
  await cleanupIssueWorkspace(project, workspace);
});

test('reattaches an existing delivery branch and refuses non-empty deterministic destinations', async () => {
  const project = makeRepository();
  const issue = { number: 9, title: 'Keep existing files' };
  const branch = deriveBranchName(issue);
  git(project.checkout, ['branch', branch, 'origin/main']);
  const workspace = await prepareIssueWorkspace(project, issue);
  assert.equal(workspace.branch, branch);
  await cleanupIssueWorkspace(project, workspace, { preserveBranch: true });
  assert.equal(git(project.checkout, ['branch', '--list', branch]).trim().replace(/^[+*]\s*/, ''), branch);

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
    /Git workspace operation failed: fetching the configured base remote ref/,
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
    assert.equal(options.timeout, 60 * 1000);
    assert.equal(options.killSignal, 'SIGTERM');
    assert.equal(options.maxBuffer, 1024 * 1024);
    assert.equal(options.env.GH_PROMPT_DISABLED, '1');
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
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
  assert.equal(git(project.checkout, ['branch', '--list', deriveBranchName(issue)]).trim(), '');
});

test('does not recursively remove a registered worktree when Git removal fails', async () => {
  const project = makeRepository();
  const workspace = await prepareIssueWorkspace(project, { number: 26, title: 'Keep on remove failure' });

  await assert.rejects(
    cleanupIssueWorkspace(project, workspace, {
      execFile(command, args, options, callback) {
        if (args[0] === 'worktree' && args[1] === 'remove') {
          const error = new Error('simulated worktree lock');
          error.code = 1;
          callback(error, '', 'simulated worktree lock');
          return;
        }
        execFile(command, args, options, callback);
      },
    }),
    /removing the issue worktree/,
  );

  assert.equal(fs.existsSync(workspace.worktreePath), true);
  assert.equal(git(project.checkout, ['worktree', 'list', '--porcelain']).includes(workspace.worktreePath), true);
  assert.equal(git(project.checkout, ['branch', '--list', workspace.branch]).trim().replace(/^[+*]\s*/, ''), workspace.branch);

  await cleanupIssueWorkspace(project, workspace);
});

test('a corrective workspace continues the delivered branch at its red head commit', async () => {
  const project = makeRepository();
  const issue = { number: 11, title: 'Fix CI' };
  const branch = deriveBranchName(issue);
  git(project.checkout, ['branch', branch, 'origin/main']);
  const head = git(project.checkout, ['rev-parse', branch]).trim();

  const workspace = await prepareIssueWorkspace(project, issue, { branch, headCommit: head });
  assert.equal(git(workspace.worktreePath, ['rev-parse', 'HEAD']).trim(), head);
  assert.equal(git(workspace.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), branch);
  await cleanupIssueWorkspace(project, workspace, { preserveBranch: true });

  // A missing local branch is recreated at the delivered commit, not the base.
  git(project.checkout, ['branch', '-D', branch]);
  const recreated = await prepareIssueWorkspace(project, issue, { branch, headCommit: head });
  assert.equal(git(recreated.worktreePath, ['rev-parse', 'HEAD']).trim(), head);
  await cleanupIssueWorkspace(project, recreated, { preserveBranch: true });

  await assert.rejects(
    prepareIssueWorkspace(project, issue, { branch, headCommit: '0'.repeat(40) }),
    /does not point at the delivered head commit/,
  );
  assert.equal(git(project.checkout, ['branch', '--list', branch]).trim().replace(/^[+*]\s*/, ''), branch);
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

test('cleanup never removes a different registered worktree at an issue path', async () => {
  const project = makeRepository();
  const issue = { number: 57, title: 'Autopilot job' };
  const worktreePath = deriveWorktreePath(project, issue);
  git(project.checkout, ['branch', 'operator/keep', 'origin/main']);
  git(project.checkout, ['worktree', 'add', worktreePath, 'operator/keep']);

  await assert.rejects(
    cleanupIssueWorkspace(project, { worktreePath, branch: deriveBranchName(issue) }),
    /does not belong to this issue branch/,
  );
  assert.equal(fs.existsSync(worktreePath), true);
  assert.equal(git(project.checkout, ['worktree', 'list', '--porcelain']).includes(worktreePath), true);
  assert.equal(git(project.checkout, ['branch', '--list', 'operator/keep']).trim().replace(/^[+*]\s*/, ''), 'operator/keep');
});

test('cleanup refuses the main checkout even when it sits at an issue path in the worktree root', async () => {
  const project = makeRepository();
  const checkout = path.join(project.worktreeRoot, 'issue-1');
  fs.mkdirSync(project.worktreeRoot, { recursive: true });
  git(project.root, ['clone', project.origin, checkout]);
  const misconfigured = { ...project, checkout };

  await assert.rejects(
    cleanupIssueWorkspace(misconfigured, { worktreePath: checkout, branch: 'ralph/issue-1-main' }),
    /main project checkout/,
  );
  // A worktree root nested inside the checkout must not expose the checkout either.
  await assert.rejects(
    cleanupIssueWorkspace({ ...project, worktreeRoot: project.root, checkout: path.join(project.root, 'issue-2', 'repo') },
      { worktreePath: path.join(project.root, 'issue-2'), branch: 'ralph/issue-2-main' }),
    /main project checkout/,
  );
  assert.equal(fs.readFileSync(path.join(checkout, 'README.md'), 'utf8'), 'fixture\n');
  assert.equal(git(checkout, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main');
});

test('terminal job cleanup removes only the recorded issue worktree and its .venv, then prunes', async () => {
  const project = makeRepository();
  const store = createJobStore(path.join(project.root, 'state'));
  const finished = await prepareIssueWorkspace(project, { number: 61, title: 'Finished job' });
  const active = await prepareIssueWorkspace(project, { number: 62, title: 'Active job' });
  const finishedVenv = path.join(finished.worktreePath, '.venv');
  fs.mkdirSync(finishedVenv);
  fs.writeFileSync(path.join(finishedVenv, 'marker'), 'finished');
  fs.mkdirSync(path.join(active.worktreePath, '.venv'));

  // An operator worktree outside the managed root, and one whose directory
  // vanished, so prune has stale metadata to clear.
  const unrelated = path.join(project.root, 'operator-worktree');
  git(project.checkout, ['branch', 'operator/keep', 'origin/main']);
  git(project.checkout, ['worktree', 'add', unrelated, 'operator/keep']);
  const stale = path.join(project.root, 'stale-worktree');
  git(project.checkout, ['worktree', 'add', '--detach', stale, 'origin/main']);
  fs.rmSync(stale, { recursive: true, force: true });

  const record = (workspace, issue, fields) => store.save({
    ...createJob({ projectName: 'demo', repo: 'example/repo', issue, branch: workspace.branch, worktreePath: workspace.worktreePath, now: store.now }),
    runs: 1,
    workspaceState: 'prepared',
    ...fields,
  });
  record(finished, { number: 61, title: 'Finished job' }, { status: 'needs_planning', terminal: true, terminalState: 'needs_planning' });
  record(active, { number: 62, title: 'Active job' }, { status: 'running' });

  const cleaned = await cleanupTerminalWorkspaces(project, store, cleanupIssueWorkspace, () => {});

  assert.deepEqual(cleaned, [61]);
  assert.equal(fs.existsSync(finished.worktreePath), false);
  assert.equal(fs.existsSync(finishedVenv), false);
  assert.equal(store.load(61).workspaceState, 'removed');
  assert.equal(git(project.checkout, ['branch', '--list', finished.branch]).trim(), '');

  const listed = git(project.checkout, ['worktree', 'list', '--porcelain']);
  assert.equal(listed.includes(finished.worktreePath), false);
  assert.equal(listed.includes(stale), false);
  assert.equal(listed.includes(active.worktreePath), true);
  assert.equal(listed.includes(unrelated), true);
  assert.equal(fs.existsSync(path.join(active.worktreePath, '.venv')), true);
  assert.equal(store.load(62).workspaceState, 'prepared');
  assert.equal(fs.readFileSync(path.join(unrelated, 'README.md'), 'utf8'), 'fixture\n');
  assert.equal(fs.readFileSync(path.join(project.checkout, 'README.md'), 'utf8'), 'fixture\n');

  await cleanupIssueWorkspace(project, active);
});

test('terminal job cleanup refuses recorded paths naming the main checkout or an unrelated worktree', async () => {
  const project = makeRepository();
  const store = createJobStore(path.join(project.root, 'state'));
  const unrelatedIssue = { number: 63, title: 'Operator owned' };
  const unrelated = deriveWorktreePath(project, unrelatedIssue);
  git(project.checkout, ['branch', 'operator/keep', 'origin/main']);
  git(project.checkout, ['worktree', 'add', unrelated, 'operator/keep']);
  fs.writeFileSync(path.join(unrelated, 'operator-notes.txt'), 'keep me');

  const record = (issue, worktreePath) => store.save({
    ...createJob({ projectName: 'demo', repo: 'example/repo', issue, branch: deriveBranchName(issue), worktreePath, now: store.now }),
    runs: 1,
    status: 'failed',
    terminal: true,
    terminalState: 'failed',
    workspaceState: 'prepared',
  });
  record({ number: 64, title: 'Points at main checkout' }, project.checkout);
  record(unrelatedIssue, unrelated);

  const lines = [];
  const cleaned = await cleanupTerminalWorkspaces(project, store, cleanupIssueWorkspace, line => lines.push(line));

  assert.deepEqual(cleaned, []);
  assert.equal(store.load(64).workspaceState, 'prepared');
  assert.match(store.load(64).failures.at(-1).message, /outside the managed issue workspace root/);
  assert.equal(store.load(63).workspaceState, 'prepared');
  assert.match(store.load(63).failures.at(-1).message, /does not belong to this issue branch/);
  assert.equal(lines.length, 2);

  assert.equal(fs.readFileSync(path.join(project.checkout, 'README.md'), 'utf8'), 'fixture\n');
  assert.equal(git(project.checkout, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main');
  assert.equal(fs.readFileSync(path.join(unrelated, 'operator-notes.txt'), 'utf8'), 'keep me');
  assert.equal(git(project.checkout, ['worktree', 'list', '--porcelain']).includes(unrelated), true);
});
