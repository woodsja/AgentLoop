'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deliverPassedWork } = require('../src/autopilot-delivery');

const project = { repo: 'example/finance', baseBranch: 'main' };
const issue = { number: 42, title: 'Repair monthly totals' };
const workspace = { worktreePath: '/worktrees/issue-42', branch: 'ralph/issue-42-repair-monthly-totals' };
const pr = { number: 77, url: 'https://github.com/example/finance/pull/77' };
const openPr = JSON.stringify([{ ...pr, headRefName: workspace.branch, baseRefName: 'main' }]);

const listArgs = [
  'pr', 'list', '--repo', project.repo, '--head', workspace.branch, '--base', 'main', '--state', 'open',
  '--json', 'number,url,headRefName,baseRefName', '--limit', '100',
];
const createArgs = [
  'pr', 'create', '--repo', project.repo, '--base', 'main', '--head', workspace.branch,
  '--title', issue.title, '--body', 'Closes #42',
];

function stub(commands, responses) {
  return (file, args, options, callback) => {
    commands.push([file, args]);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 60 * 1000);
    assert.equal(options.killSignal, 'SIGTERM');
    assert.equal(options.maxBuffer, 1024 * 1024);
    assert.equal(options.env.GH_PROMPT_DISABLED, '1');
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    const response = responses.shift() || {};
    callback(response.error || null, response.stdout || '', response.stderr || '');
  };
}

test('delivers a passed issue by committing, pushing, and opening a PR that closes it', async () => {
  const commands = [];
  const result = await deliverPassedWork({ project, issue, workspace, ralphStatus: 'passed' }, { execFile: stub(commands, [
    { stdout: ' M totals.js\n' }, {}, {}, { stdout: 'deadbeef\n' }, {},
    { stdout: '[]' }, { stdout: `${pr.url}\n` }, { stdout: openPr },
  ]) });
  assert.deepEqual(result, { branch: workspace.branch, commit: 'deadbeef', pushed: true, pr });
  assert.deepEqual(commands, [
    ['git', ['status', '--porcelain']], ['git', ['add', '-A']], ['git', ['commit', '-m', 'ralph: resolve #42']],
    ['git', ['rev-parse', 'HEAD']], ['git', ['push', '--set-upstream', 'origin', workspace.branch]],
    ['gh', listArgs], ['gh', createArgs], ['gh', listArgs],
  ]);
});

test('targets main when the project does not name a base branch', async () => {
  const commands = [];
  await deliverPassedWork({ project: { repo: project.repo }, issue, workspace, ralphStatus: 'passed' }, {
    execFile: stub(commands, [{ stdout: '' }, { stdout: 'deadbeef\n' }, {}, { stdout: '[]' }, {}, { stdout: openPr }]),
  });
  const create = commands.find(([file, args]) => file === 'gh' && args[1] === 'create');
  assert.deepEqual(create[1], createArgs);
});

test('pushes a clean passed worktree without creating an empty commit', async () => {
  const commands = [];
  const result = await deliverPassedWork({ project, issue, workspace, ralphStatus: 'passed' }, { execFile: stub(commands, [
    { stdout: '' }, { stdout: 'deadbeef\n' }, {}, { stdout: openPr },
  ]) });
  assert.equal(commands.some(([, args]) => args[0] === 'commit'), false);
  assert.deepEqual(result, { branch: workspace.branch, commit: 'deadbeef', pushed: true, pr });
});

test('reuses an existing open PR for the deterministic branch instead of creating a duplicate', async () => {
  const commands = [];
  const result = await deliverPassedWork({ project, issue, workspace, ralphStatus: 'passed' }, { execFile: stub(commands, [
    { stdout: '' }, { stdout: 'deadbeef\n' }, {},
    { stdout: JSON.stringify([
      { number: 5, url: 'https://github.com/example/finance/pull/5', headRefName: 'other/branch', baseRefName: 'main' },
      { ...pr, headRefName: workspace.branch, baseRefName: 'main' },
    ]) },
  ]) });
  assert.deepEqual(result.pr, pr);
  assert.equal(commands.some(([file, args]) => file === 'gh' && args[1] === 'create'), false);
});

test('creates a PR when only PRs for other branches match the head filter', async () => {
  const commands = [];
  const result = await deliverPassedWork({ project, issue, workspace, ralphStatus: 'passed' }, { execFile: stub(commands, [
    { stdout: '' }, { stdout: 'deadbeef\n' }, {},
    { stdout: JSON.stringify([{ number: 5, url: 'https://github.com/example/finance/pull/5', headRefName: 'other', baseRefName: 'main' }]) },
    {}, { stdout: openPr },
  ]) });
  assert.deepEqual(result.pr, pr);
  assert.deepEqual(commands.filter(([file]) => file === 'gh').map(([, args]) => args[1]), ['list', 'create', 'list']);
});

test('does not reuse a PR for the issue branch when it targets a different base', async () => {
  const commands = [];
  const mainPr = JSON.stringify([{ ...pr, headRefName: workspace.branch, baseRefName: 'main' }]);
  await deliverPassedWork({ project, issue, workspace, ralphStatus: 'passed' }, { execFile: stub(commands, [
    { stdout: '' }, { stdout: 'deadbeef\n' }, {},
    { stdout: JSON.stringify([{ ...pr, headRefName: workspace.branch, baseRefName: 'release' }]) },
    {}, { stdout: mainPr },
  ]) });
  assert.deepEqual(commands.filter(([file]) => file === 'gh').map(([, args]) => args[1]), ['list', 'create', 'list']);
});

test('refuses to commit, push, or open a PR unless Ralph reported passed', async () => {
  for (const ralphStatus of ['needs_planning', 'running', 'failed', null, undefined]) {
    const commands = [];
    await assert.rejects(
      deliverPassedWork({ project, issue, workspace, ralphStatus }, { execFile: stub(commands, []) }),
      /delivery refused/,
    );
    assert.deepEqual(commands, []);
  }
});

test('does not push when committing the passed changes fails', async () => {
  const commands = [];
  await assert.rejects(deliverPassedWork({ project, issue, workspace, ralphStatus: 'passed' }, { execFile: stub(commands, [
    { stdout: ' M totals.js\n' }, {}, { error: new Error('exit 1'), stderr: 'nothing to commit' },
  ]) }), /committing Ralph changes: nothing to commit/);
  assert.equal(commands.some(([, args]) => args[0] === 'push'), false);
  assert.equal(commands.some(([file]) => file === 'gh'), false);
});

test('does not open a PR when the push fails', async () => {
  const commands = [];
  await assert.rejects(deliverPassedWork({ project, issue, workspace, ralphStatus: 'passed' }, { execFile: stub(commands, [
    { stdout: '' }, { stdout: 'deadbeef\n' }, { error: new Error('exit 1'), stderr: 'rejected' },
  ]) }), /pushing the issue branch: rejected/);
  assert.equal(commands.some(([file]) => file === 'gh'), false);
});

test('surfaces a PR creation failure after the push has been checkpointed', async () => {
  const progress = [];
  await assert.rejects(deliverPassedWork({ project, issue, workspace, ralphStatus: 'passed' }, {
    execFile: stub([], [
      { stdout: '' }, { stdout: 'deadbeef\n' }, {}, { stdout: '[]' },
      { error: new Error('exit 1'), stderr: 'GraphQL error' },
    ]),
    onProgress: checkpoint => progress.push(checkpoint),
  }), /creating the pull request: GraphQL error/);
  assert.deepEqual(progress.at(-1), { branch: workspace.branch, commit: 'deadbeef', pushed: true });
});

test('rejects malformed gh pull request output', async () => {
  await assert.rejects(deliverPassedWork({ project, issue, workspace, ralphStatus: 'passed' }, { execFile: stub([], [
    { stdout: '' }, { stdout: 'deadbeef\n' }, {}, { stdout: 'not json' },
  ]) }), /finding an existing pull request: gh returned malformed JSON/);
});

test('a corrective delivery commits a new change to the same branch and refuses an unchanged head', async () => {
  const commands = [];
  const result = await deliverPassedWork({
    project, issue, workspace, ralphStatus: 'passed', previousCommit: 'deadbeef', commitMessage: 'ralph: fix CI for #42',
  }, { execFile: stub(commands, [
    { stdout: ' M totals.js\n' }, {}, {}, { stdout: 'cafef00d\n' }, {}, { stdout: openPr },
  ]) });
  assert.equal(result.commit, 'cafef00d');
  assert.deepEqual(commands.slice(0, 5).map(([, args]) => args), [
    ['status', '--porcelain'], ['add', '-A'], ['commit', '-m', 'ralph: fix CI for #42'],
    ['rev-parse', 'HEAD'], ['push', '--set-upstream', 'origin', workspace.branch],
  ]);

  const unchanged = [];
  await assert.rejects(deliverPassedWork({ project, issue, workspace, ralphStatus: 'passed', previousCommit: 'deadbeef' }, {
    execFile: stub(unchanged, [{ stdout: '' }, { stdout: 'deadbeef\n' }]),
  }), error => error.code === 'AUTOPILOT_NO_CHANGES' && /no change from deadbeef/.test(error.message));
  assert.equal(unchanged.some(([, args]) => args[0] === 'push'), false);
});

test('reports durable delivery checkpoints after the commit, push, and PR', async () => {
  const progress = [];
  await deliverPassedWork({ project, issue, workspace, ralphStatus: 'passed' }, {
    execFile: stub([], [
      { stdout: '' }, { stdout: 'deadbeef\n' }, {}, { stdout: openPr },
    ]),
    onProgress: checkpoint => progress.push(checkpoint),
  });
  assert.deepEqual(progress, [
    { branch: workspace.branch, commit: 'deadbeef', pushed: false },
    { branch: workspace.branch, commit: 'deadbeef', pushed: true },
    { branch: workspace.branch, commit: 'deadbeef', pushed: true, pr },
  ]);
});
