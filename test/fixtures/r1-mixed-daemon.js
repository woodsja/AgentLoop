'use strict';
// Full R1 execution through real daemon, Git and mocked external GitHub.
// Engine entrypoints are configured through the isolated owner config.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const f = JSON.parse(fs.readFileSync(process.env.R1_MIXED_FIXTURE, 'utf8'));
const p = f.project;
const observePullRequest = require('./r1-git-remote')(p, f.root);
const record = (name, data) => fs.appendFileSync(path.join(f.root, name), JSON.stringify(data) + '\n');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const issue = { number: 5, title: 'Add answer', body: '## Acceptance criteria\n- Create answer with the text 42.\n- Verify correctness with the specified test.' };
require('../../src/daemon').start({ r1: { ciPollMs: 30, autopilotDependencies: {
  loadProjectConfig: () => p,
  discoverReadyIssues: async () => [issue],
  findOpenIssuePullRequests: async () => [],
  observePullRequest,
  prepareIssueWorkspace: async (project, candidate, options) => {
    const where = path.join(project.worktreeRoot, `issue-${candidate.number}`);
    if (!fs.existsSync(where)) git(project.checkout, 'worktree', 'add', '-b', options.branch, where, 'HEAD');
    return { branch: options.branch, worktreePath: where, baseRef: 'main' };
  },
  cleanupIssueWorkspace: async () => {},
  readRepositoryInstructions: async () => [],
  prepareRepositoryEnvironment: async () => {},
  deliverPassedWork: async ({workspace}, {onProgress}) => {
    for (const name of ['PLAN.md', 'GUIDELINES.md', 'STATE.md']) {
      if (fs.existsSync(path.join(workspace.worktreePath, name))) throw Error('Synthetic instruction leaked into delivery');
    }
    git(workspace.worktreePath, 'add', '--all');
    git(workspace.worktreePath, 'commit', '-m', 'Implement answer');
    git(workspace.worktreePath, 'push', 'origin', workspace.branch);
    const commit = git(workspace.worktreePath, 'rev-parse', 'HEAD');
    const value = { branch: workspace.branch, commit, pushed: true,
      pr: { number: 5, url: 'https://example.invalid/r1/5' } };
    record('delivery', value);
    await onProgress(value);
    return value;
  },
  observePullRequestCi: async (_project, pr) => {
    record('ci', pr);
    return {state:'green',headCommit:pr.commit,prNumber:5,details:'mock CI green'};
  },
  reviewPullRequest: Object.assign(async context => {
    record('final-review', { headCommit:context.headCommit, verified:context.verification });
    return { reviewer:'claude:opus',verdict:'PASS',commit:context.headCommit,policy:'always',findings:[] };
  }, {reviewer:'claude:opus',model:'opus'}),
} } });
