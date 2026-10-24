// Continuous-runner integration daemon: real queue, Git, verifier and run();
// fake GitHub and model adapters that record every external action.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fixture = JSON.parse(fs.readFileSync(process.env.R1_FIXTURE, 'utf8'));
const project = fixture.project;
require('./r1-git-remote')(project, fixture.root);
const file = name => path.join(fixture.root, name);
const record = (name, value) => fs.appendFileSync(file(name), JSON.stringify(value) + '\n');
// Let the integration test make the durable transcript unavailable without
// changing any of the queue, verification, CI, review, or merge adapters.
const store = require('../../src/store');
const appendLogLine = store.appendLogLine;
store.appendLogLine = (id, line) => {
  if (fs.existsSync(file('throw-log-append'))) {
    record('append-attempts', { id, line });
    throw new Error('fixture log append failure');
  }
  return appendLogLine(id, line);
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const issueOf = branch => Number(/^ralph\/issue-(\d+)-/.exec(branch)[1]);
const branchOf = number => git(project.checkout, 'for-each-ref', '--format=%(refname:short)', `refs/heads/ralph/issue-${number}-*`);
const ciCalls = new Map();

require('../../src/daemon').start({ r1: {
  ciPollMs: 100, ciTimeoutMs: fixture.ciTimeoutMs, admitIntervalMs: 100,
  execFile: (command, args, options, callback) => {
    record('commands', [command, ...args]);
    callback(null, args.includes('--json') ? '{"state":"OPEN"}' : '', '');
  },
  autopilotDependencies: {
    loadProjectConfig: () => project,
    discoverReadyIssues: async () => JSON.parse(fs.readFileSync(file('issues.json'), 'utf8')),
    findOpenIssuePullRequests: async () => [],
    prepareIssueWorkspace: async (_project, issue, options) => {
      const worktreePath = path.join(project.worktreeRoot, `issue-${issue.number}`);
      if (!fs.existsSync(worktreePath)) {
        const exists = git(project.checkout, 'for-each-ref', '--format=x', `refs/heads/${options.branch}`) === 'x';
        if (exists) git(project.checkout, 'worktree', 'add', worktreePath, options.branch);
        else git(project.checkout, 'worktree', 'add', '-b', options.branch, worktreePath, 'HEAD');
      }
      return { branch: options.branch, worktreePath, baseRef: 'main' };
    },
    cleanupIssueWorkspace: async (_project, workspace) => {
      if (fs.existsSync(workspace.worktreePath)) git(project.checkout, 'worktree', 'remove', '--force', workspace.worktreePath);
    },
    readRepositoryInstructions: async () => [],
    prepareRepositoryEnvironment: async () => {},
    ralphOptions: { createCliWorkerImpl: () => async cwd => {
      record('workers', path.basename(cwd));
      if (issueOf(git(cwd, 'branch', '--show-current')) === 7) {
        while (!fs.existsSync(file('worker-release-7'))) await new Promise(resolve => setTimeout(resolve, 10));
      }
      fs.writeFileSync(path.join(cwd, 'answer'), issueOf(git(cwd, 'branch', '--show-current')) === fixture.verificationFailure ? 'not 42' : '42');
      fs.writeFileSync(path.join(cwd, 'revision'), String(process.hrtime.bigint()));
      // Marker text stays out of compact navigation labels; full owner records
      // must preserve it like any other captured worker result.
      return { exitCode: 0, resultText: fixture.adversarial || 'Implemented' };
    } },
    deliverPassedWork: async ({ workspace, issue }, { onProgress }) => {
      git(workspace.worktreePath, 'add', 'answer', 'revision');
      git(workspace.worktreePath, 'commit', '-m', `Fixture change for #${issue.number}`);
      git(workspace.worktreePath, 'push', 'origin', workspace.branch);
      const delivery = { branch: workspace.branch, commit: git(workspace.worktreePath, 'rev-parse', 'HEAD'), pushed: true,
        pr: { number: issue.number, url: `https://example.invalid/pull/${issue.number}` } };
      await onProgress(delivery);
      return delivery;
    },
    observePullRequestCi: async (_project, pr) => {
      record('ci', { number: pr.number, at: Date.now() });
      if (pr.number === fixture.gatedCi && fs.existsSync(file('ci-error'))) throw new Error(fixture.adversarial);
      const calls = (ciCalls.get(pr.commit) || 0) + 1;
      ciCalls.set(pr.commit, calls);
      const green = pr.number === fixture.neverGreen ? false
        : pr.number === fixture.gatedCi ? fs.existsSync(file('ci-release')) : calls > 1;
      return { state: green ? 'green' : 'pending', details: green ? 'CI (#1): completed/success' : 'pending', headCommit: pr.commit, prNumber: pr.number, runs: [{ databaseId: 1, status: green ? 'completed' : 'in_progress', conclusion: green ? 'success' : null, workflowName: project.ciWorkflow, name: null, url: null, startedAt: null, updatedAt: null }] };
    },
    reviewPullRequest: Object.assign(async context => {
      record('reviews', { number: context.pullRequest.number, commit: context.headCommit });
      return context.pullRequest.number === fixture.rejected
        ? { reviewer: 'claude:sonnet', verdict: 'NEEDS_CHANGES', commit: context.headCommit, findings: [{ summary: 'Still wrong', file: 'answer', line: 1, severity: 'high' }] }
        : { reviewer: 'claude:sonnet', verdict: 'PASS', commit: context.headCommit, findings: [] };
    }, { reviewer: 'claude:sonnet', model: 'sonnet' }),
    observePullRequest: async (_project, number) => {
      const branch = branchOf(number);
      const merged = fs.existsSync(file(`merged-${number}`)) ? fs.readFileSync(file(`merged-${number}`), 'utf8') : null;
      return { number, url: `https://example.invalid/pull/${number}`, state: merged ? 'MERGED' : 'OPEN', isCrossRepository: false, headRefName: branch,
        headRefOid: git(project.checkout, 'rev-parse', `refs/heads/${branch}`), baseRefName: project.baseBranch, mergeCommit: merged };
    },
    mergePullRequest: async (_project, { number, headCommit }) => {
      record('merges', { number, headCommit, issue: issueOf(branchOf(number)) });
      fs.writeFileSync(file(`merged-${number}`), `merge-${headCommit}`);
      return { mergeCommit: `merge-${headCommit}` };
    },
    reconcileIssueClosure: async (_project, number) => { record('closures', number); return { number, state: 'closed' }; },
  },
} });
