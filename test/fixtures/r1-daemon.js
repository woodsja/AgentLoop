// Isolated integration daemon: fake model adapters; real queue, Git and verifier.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fixture = JSON.parse(fs.readFileSync(process.env.R1_FIXTURE, 'utf8'));
const project = fixture.project;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
async function gate(name) {
  while (!fs.existsSync(path.join(fixture.root, name))) await new Promise(resolve => setTimeout(resolve, 20));
}
const reviewPullRequest = Object.assign(async context => {
  fs.appendFileSync(path.join(fixture.root, 'reviews'), JSON.stringify(context) + '\n');
  await gate('review-release');
  if (fs.existsSync(path.join(fixture.root, 'review-error'))) throw new Error(`Fake reviewer failed: github_pat_abcdefghijklmnopqrstuvwxyz0123456789 /tmp/r1-private-output`);
  return { reviewer: 'claude:sonnet', verdict: 'PASS', commit: context.headCommit, policy: 'always', findings: [] };
}, { reviewer: 'claude:sonnet', model: 'sonnet' });
require('../../src/daemon').start({ r1: { ciPollMs: 50, autopilotDependencies: {
  loadProjectConfig: () => project,
  discoverReadyIssues: async () => [1, 2, 3, 4].map(number => ({ number, title: `Issue ${number}`, body: '## Acceptance criteria\n- Write the answer' })),
  findOpenIssuePullRequests: async () => [],
  prepareIssueWorkspace: async (_project, issue, options) => {
    const worktreePath = path.join(project.worktreeRoot, `issue-${issue.number}`);
    if (!fs.existsSync(worktreePath)) git(project.checkout, 'worktree', 'add', '-b', options.branch, worktreePath, 'HEAD');
    return { branch: options.branch, worktreePath, baseRef: 'main' };
  },
  cleanupIssueWorkspace: async () => {},
  readRepositoryInstructions: async () => [],
  prepareRepositoryEnvironment: async () => {},
  ralphOptions: { createCliWorkerImpl: () => async cwd => {
    fs.appendFileSync(path.join(fixture.root, 'workers'), cwd + '\n');
    await gate('worker-release');
    fs.writeFileSync(path.join(cwd, 'answer'), '42');
    return { exitCode: 0, resultText: 'Implemented' };
  } },
  deliverPassedWork: async ({ workspace, issue }, { onProgress }) => {
    git(workspace.worktreePath, 'add', 'answer');
    git(workspace.worktreePath, 'commit', '-m', 'Fixture implementation');
    const delivery = { branch: workspace.branch, commit: git(workspace.worktreePath, 'rev-parse', 'HEAD'), pushed: true,
      pr: { number: issue.number, url: `https://example.invalid/pull/${issue.number}` } };
    await onProgress(delivery);
    return delivery;
  },
  observePullRequestCi: async (_project, pr) => ({ state: 'green', headCommit: pr.commit, prNumber: pr.number }),
  reviewPullRequest,
} } });
