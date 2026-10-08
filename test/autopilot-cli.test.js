'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArguments, classifyRalphResult, run: runAutopilot } = require('../src/autopilot');
const { createJob, createJobStore, isResumable } = require('../src/autopilot-state');
const { deliverPassedWork } = require('../src/autopilot-delivery');

const project = { enabled: false, repo: 'example/repo', readyLabel: 'ready', worker: 'codex' };
const temporaryDirectories = new Set();

test.afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

function temporaryStore(options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-cli-state-'));
  temporaryDirectories.add(directory);
  return createJobStore(directory, options);
}

// Every CLI test gets its own job store so nothing touches real state.
function run(argv, dependencies) {
  return runAutopilot(argv, { jobStore: temporaryStore(), findOpenIssuePullRequests: async () => [], ...dependencies });
}

test('dry run inspects disabled projects and reports its selected candidate', async () => {
  const lines = [];
  const result = await run(['--project', 'demo', '--dry-run'], {
    loadProjectConfig: name => { assert.equal(name, 'demo'); return project; },
    discoverReadyIssues: async value => { assert.equal(value, project); return [{ number: 8, title: 'Selected' }]; },
    write: line => lines.push(line),
  });
  assert.deepEqual(result, { number: 8, title: 'Selected' });
  assert.equal(lines[0], 'Dry run: project demo; repository example/repo; issue #8: Selected; worker codex; action is dry-run only.');
});

test('dry run succeeds with a clear no-candidate result', async () => {
  const lines = [];
  const result = await run(['--project', 'demo', '--dry-run'], {
    loadProjectConfig: () => project,
    discoverReadyIssues: async () => [],
    write: line => lines.push(line),
  });
  assert.equal(result, null);
  assert.equal(lines[0], 'Dry run: no ready-for-agent issue found for project demo in example/repo.');
});

test('rejects malformed and unknown arguments', () => {
  assert.throws(() => parseArguments(['--dry-run', '--project', 'demo']), /Usage:/);
  assert.throws(() => parseArguments(['--project', '', '--dry-run']), /Usage:/);
  assert.throws(() => parseArguments(['--project', 'demo', '--dry-run', '--extra']), /Usage:/);
});

test('runs an enabled issue through the isolated Ralph path and always cleans the workspace', async () => {
  const lines = [];
  const enabledProject = { ...project, enabled: true, verification: 'check', maxAttempts: 2 };
  const issue = { number: 8, title: 'Selected', body: '## Acceptance criteria\n- Ships safely' };
  const workspace = { worktreePath: '/tmp/issue-8', branch: 'ralph/issue-8-selected', baseRef: 'origin/main' };
  let cleaned = false;
  let delivered = false;
  const result = await run(['--project', 'demo'], {
    loadProjectConfig: () => enabledProject,
    discoverReadyIssues: async () => [issue],
    prepareIssueWorkspace: async (value, candidate) => { assert.equal(value, enabledProject); assert.equal(candidate, issue); return workspace; },
    readRepositoryInstructions: async value => { assert.equal(value, workspace.worktreePath); return [{ path: 'AGENTS.md', content: 'Use .venv.' }]; },
    prepareRepositoryEnvironment: async (value, valueProject, options) => {
      assert.equal(value, workspace.worktreePath);
      assert.equal(valueProject, enabledProject);
      assert.deepEqual(options.instructions, [{ path: 'AGENTS.md', content: 'Use .venv.' }]);
    },
    buildAutopilotTask: (valueProject, candidate, instructions) => {
      assert.equal(valueProject, enabledProject); assert.equal(candidate, issue);
      assert.equal(instructions[0].path, 'AGENTS.md');
      return { id: 'autopilot:example/repo#8', maxAttempts: 2 };
    },
    createRalphTaskService: () => ({ run: async (value, task) => {
      assert.equal(value, workspace.worktreePath); assert.deepEqual(task, { id: 'autopilot:example/repo#8', maxAttempts: 2 });
      return { status: 'needs_planning', attempts: [{ number: 1 }] };
    } }),
    deliverPassedWork: async () => { delivered = true; },
    cleanupIssueWorkspace: async (value, valueWorkspace) => { assert.equal(value, enabledProject); assert.equal(valueWorkspace, workspace); cleaned = true; },
    write: line => lines.push(line),
  });
  assert.equal(cleaned, true);
  assert.equal(delivered, false);
  assert.equal(result.result.status, 'needs_planning');
  assert.deepEqual(result.outcome, { status: 'needs_planning', terminal: true, deliverable: false });
  assert.equal(lines[0], 'Autopilot: project demo; issue #8; status needs_planning; autonomous execution stopped before delivery.');
});

test('Ralph verification status alone decides pass versus needs_planning', () => {
  assert.deepEqual(classifyRalphResult({ status: 'passed' }), { status: 'passed', terminal: false, deliverable: true });
  assert.deepEqual(classifyRalphResult({ status: 'needs_planning' }), { status: 'needs_planning', terminal: true, deliverable: false });
  assert.throws(() => classifyRalphResult({ status: 'failed' }), /unexpected Ralph result status/);
  assert.throws(() => classifyRalphResult(undefined), /unexpected Ralph result status/);
});

test('reports a passed Ralph run as deliverable and still cleans the workspace', async () => {
  const lines = [];
  const enabledProject = { ...project, enabled: true, verification: 'check', maxAttempts: 2 };
  const workspace = { worktreePath: '/tmp/issue-9', branch: 'ralph/issue-9-pass', baseRef: 'origin/main' };
  let cleaned = false;
  const result = await run(['--project', 'demo'], {
    loadProjectConfig: () => enabledProject,
    discoverReadyIssues: async () => [{ number: 9, title: 'Pass', body: '' }],
    prepareIssueWorkspace: async () => workspace,
    readRepositoryInstructions: async () => [],
    prepareRepositoryEnvironment: async () => {},
    createRalphTaskService: () => ({ run: async () => ({ status: 'passed', attempts: [{ number: 1 }] }) }),
    deliverPassedWork: async () => ({ branch: workspace.branch, commit: 'abc123', pr: { number: 90, url: 'https://github.com/example/repo/pull/90' } }),
    cleanupIssueWorkspace: async () => { cleaned = true; },
    write: line => lines.push(line),
  });
  assert.equal(cleaned, true);
  assert.deepEqual(result.outcome, { status: 'passed', terminal: false, deliverable: true });
  assert.equal(lines[0], 'Autopilot: project demo; issue #9; status passed.');
});

test('finishes a passed git-only delivery and persists its branch and commit', async () => {
  const store = temporaryStore();
  const issue = { number: 10, title: 'Push only', body: '' };
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: passingRalph,
    deliverPassedWork: async ({ workspace }, { onProgress }) => {
      await onProgress({ branch: workspace.branch, commit: 'gitonlycommit', pushed: true, pr: null });
      return { branch: workspace.branch, commit: 'gitonlycommit', pushed: true };
    },
  }));
  const saved = createJobStore(store.directory).load(10);
  assert.equal(saved.branch, 'ralph/issue-10-push-only');
  assert.deepEqual(saved.delivery, { branch: 'ralph/issue-10-push-only', commit: 'gitonlycommit', pushed: true });
  assert.equal(saved.pr, null);
  assert.equal(saved.status, 'passed');
});

test('does not prepare or mutate a workspace for dry runs', async () => {
  const touched = [];
  await run(['--project', 'demo', '--dry-run'], {
    loadProjectConfig: () => ({ ...project, enabled: true }),
    discoverReadyIssues: async () => [{ number: 1, title: 'Read only', body: '' }],
    prepareIssueWorkspace: async () => { touched.push('workspace'); },
    readRepositoryInstructions: async () => { touched.push('instructions'); },
    prepareRepositoryEnvironment: async () => { touched.push('environment'); },
    buildAutopilotTask: () => { touched.push('task'); },
    createRalphTaskService: () => { touched.push('ralph'); },
    cleanupIssueWorkspace: async () => { touched.push('cleanup'); },
    write: () => {},
  });
  assert.deepEqual(touched, []);
});

test('skips disabled projects without discovery, cleanup, or workspace preparation', async () => {
  const lines = [];
  const touched = [];
  const result = await run(['--project', 'demo'], {
    loadProjectConfig: () => project,
    discoverReadyIssues: async () => { touched.push('discover'); return [{ number: 1, title: 'Nope', body: '' }]; },
    prepareIssueWorkspace: async () => { touched.push('workspace'); },
    cleanupIssueWorkspace: async () => { touched.push('cleanup'); },
    write: line => lines.push(line),
  });
  assert.equal(result, null);
  assert.deepEqual(touched, []);
  assert.deepEqual(lines, ['Autopilot: project demo is disabled; nothing to do.']);
});

test('main exits zero for a disabled project', async () => {
  const { main } = require('../src/autopilot');
  const exitCode = await main(['--project', 'demo'], {
    jobStore: temporaryStore(),
    loadProjectConfig: () => project,
    discoverReadyIssues: async () => { throw new Error('must not discover'); },
    write: () => {},
  });
  assert.equal(exitCode, 0);
});

test('cleans a prepared workspace when repository setup fails before Ralph runs', async () => {
  const enabledProject = { ...project, enabled: true, verification: 'check', maxAttempts: 2 };
  const workspace = { worktreePath: '/tmp/issue-12', branch: 'ralph/issue-12-setup', baseRef: 'origin/main' };
  let ralphStarted = false;
  let cleaned = false;

  await assert.rejects(run(['--project', 'demo'], {
    loadProjectConfig: () => enabledProject,
    discoverReadyIssues: async () => [{ number: 12, title: 'Setup fails', body: '' }],
    prepareIssueWorkspace: async () => workspace,
    readRepositoryInstructions: async () => [{ path: 'AGENTS.md', content: 'Use .venv.' }],
    prepareRepositoryEnvironment: async () => { throw new Error('venv failed'); },
    createRalphTaskService: () => ({ run: async () => { ralphStarted = true; } }),
    cleanupIssueWorkspace: async (value, valueWorkspace) => {
      assert.equal(value, enabledProject);
      assert.equal(valueWorkspace, workspace);
      cleaned = true;
    },
    write: () => {},
  }), /venv failed/);

  assert.equal(ralphStarted, false);
  assert.equal(cleaned, true);
});

const passingRalph = () => ({ run: async () => ({ status: 'passed', attempts: [{ number: 1 }] }) });

test('persists a delivered PR awaiting CI and does not start duplicate worker work', async () => {
  const store = temporaryStore();
  const issue = { number: 21, title: 'Persist me', body: '' };
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: passingRalph,
    deliverPassedWork: async ({ workspace }) => {
      // Delivery must be resumable if the process stops during a Git or GitHub
      // command; `passed` is recorded only after all of those effects finish.
      const duringDelivery = createJobStore(store.directory).load(21);
      assert.equal(duringDelivery.status, 'delivering');
      assert.equal(duringDelivery.terminal, false);
      assert.equal(duringDelivery.ralph.status, 'passed');
      return { branch: workspace.branch, commit: 'abc123', pr: { number: 99, url: 'https://github.com/example/repo/pull/99' } };
    },
  }));

  const saved = createJobStore(store.directory).load(21);
  assert.equal(saved.status, 'awaiting_ci');
  assert.equal(saved.branch, 'ralph/issue-21-persist-me');
  assert.equal(saved.worktreePath, '/tmp/worktrees/issue-21');
  assert.equal(saved.workspaceState, 'removed');
  assert.deepEqual(saved.ralph, { status: 'passed', attempts: 1, taskId: 'autopilot:example/repo#21' });
  assert.deepEqual(saved.delivery, { branch: 'ralph/issue-21-persist-me', commit: 'abc123', pushed: true });
  assert.deepEqual(saved.pr, { number: 99, url: 'https://github.com/example/repo/pull/99' });
  assert.equal(saved.terminal, false);
  assert.equal(saved.terminalState, null);

  let prepared = false;
  let ralphStarted = false;
  const result = await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    prepareIssueWorkspace: async () => { prepared = true; },
    createRalphTaskService: () => ({ run: async () => { ralphStarted = true; } }),
    observePullRequestCi: async () => ({ state: 'pending', details: 'queued', prNumber: 99, headCommit: 'abc123', runs: [] }),
  }));
  assert.equal(result.outcome.status, 'pending');
  assert.equal(prepared, false);
  assert.equal(ralphStarted, false);
  assert.equal(result.workspace, null);
  assert.equal(store.list().length, 1);
  const pending = createJobStore(store.directory).load(21);
  assert.equal(pending.status, 'awaiting_ci');
  assert.equal(isResumable(pending), true);
});

test('a green persisted PR CI observation becomes ready for human merge without a workspace', async () => {
  const store = temporaryStore();
  const issue = { number: 23, title: 'Ready after CI', body: '' };
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: passingRalph,
  }));

  let prepared = false;
  let ralphStarted = false;
  const result = await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    prepareIssueWorkspace: async () => { prepared = true; },
    createRalphTaskService: () => ({ run: async () => { ralphStarted = true; } }),
    observePullRequestCi: async (value, identity) => {
      assert.equal(value.repo, 'example/repo');
      assert.deepEqual(identity, { number: 99, commit: 'abc123' });
      return {
        state: 'green', details: 'CI (#501): completed/success', prNumber: 99, headCommit: 'abc123',
        runs: [{ databaseId: 501, status: 'completed', conclusion: 'success', name: 'test', workflowName: 'CI', url: 'https://example/run/501', startedAt: null, updatedAt: null }],
      };
    },
  }));

  assert.equal(result.outcome.status, 'green');
  assert.equal(prepared, false);
  assert.equal(ralphStarted, false);
  const saved = createJobStore(store.directory).load(23);
  assert.equal(saved.status, 'ready_for_human_merge');
  assert.equal(saved.terminalState, 'ready_for_human_merge');
  assert.deepEqual(saved.ci.runs.map(run => run.databaseId), [501]);
});

test('an always-review project persists a matching independent PASS before becoming merge-ready', async () => {
  const store = temporaryStore();
  const issue = { number: 230, title: 'Review this change', body: 'The issue context the reviewer needs.' };
  const reviewedProject = { ...project, enabled: true, verification: 'check', maxAttempts: 2, reviewPolicy: 'always' };
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    loadProjectConfig: () => reviewedProject,
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: passingRalph,
  }));

  let prepared = false;
  const result = await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    loadProjectConfig: () => reviewedProject,
    discoverReadyIssues: async () => [issue],
    prepareIssueWorkspace: async () => { prepared = true; },
    observePullRequestCi: async () => ({
      state: 'green', details: 'CI (#501): completed/success', prNumber: 99, headCommit: 'abc123', runs: [],
    }),
    reviewPullRequest: async context => {
      assert.equal(context.project, reviewedProject);
      assert.deepEqual(context.issue, issue);
      assert.deepEqual(context.pullRequest, { number: 99, url: 'https://github.com/example/repo/pull/99', headCommit: 'abc123' });
      assert.equal(context.headCommit, 'abc123');
      assert.deepEqual(context.verification, {
        state: 'green', details: 'CI (#501): completed/success', prNumber: 99, headCommit: 'abc123', runs: [],
      });
      // The terminal transition must follow a durable review checkpoint.
      const duringReview = createJobStore(store.directory).load(230);
      assert.equal(duringReview.terminal, false);
      assert.equal(duringReview.review, null);
      return { reviewer: 'independent-reviewer', verdict: 'PASS', commit: 'abc123' };
    },
  }));

  assert.equal(prepared, false);
  assert.equal(result.outcome.status, 'green');
  const saved = createJobStore(store.directory).load(230);
  assert.deepEqual(saved.review, { reviewer: 'independent-reviewer', verdict: 'PASS', commit: 'abc123' });
  assert.equal(saved.status, 'ready_for_human_merge');
  assert.equal(saved.terminalState, 'ready_for_human_merge');
});

test('the legacy independentReviewer injection remains a supported review interface', async () => {
  const store = temporaryStore();
  const issue = { number: 233, title: 'Preserve reviewer interface', body: '' };
  const reviewedProject = { ...project, enabled: true, verification: 'check', maxAttempts: 2, reviewPolicy: 'always' };
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    loadProjectConfig: () => reviewedProject, discoverReadyIssues: async () => [issue], createRalphTaskService: passingRalph,
  }));
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    loadProjectConfig: () => reviewedProject, discoverReadyIssues: async () => [issue],
    observePullRequestCi: async () => ({ state: 'green', details: 'green', prNumber: 99, headCommit: 'abc123', runs: [] }),
    independentReviewer: async () => ({ reviewer: 'legacy-reviewer', verdict: 'PASS', commit: 'abc123' }),
  }));
  assert.deepEqual(createJobStore(store.directory).load(233).review, { reviewer: 'legacy-reviewer', verdict: 'PASS', commit: 'abc123' });
});

test('a matching reviewer NEEDS_CHANGES is deferred, corrected once, then independently re-reviewed', async () => {
  const store = temporaryStore();
  const issue = { number: 234, title: 'Review repair', body: 'Original issue context' };
  const reviewedProject = { ...project, enabled: true, verification: 'check', maxAttempts: 2, reviewPolicy: 'always' };
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    loadProjectConfig: () => reviewedProject, discoverReadyIssues: async () => [issue], createRalphTaskService: passingRalph,
  }));
  let workerStarted = false;
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    loadProjectConfig: () => reviewedProject, discoverReadyIssues: async () => [issue],
    observePullRequestCi: async () => ({ state: 'green', details: 'ok', prNumber: 99, headCommit: 'abc123', runs: [] }),
    reviewPullRequest: async () => ({ reviewer: 'claude:sonnet', verdict: 'NEEDS_CHANGES', commit: 'abc123', findings: 'lib.js:7: validate input' }),
    prepareIssueWorkspace: async () => { workerStarted = true; },
  }));
  let saved = createJobStore(store.directory).load(234);
  assert.equal(workerStarted, false);
  assert.equal(saved.status, 'review_correction_eligible');
  assert.equal(saved.reviewCorrectiveCycles, 1);
  assert.equal(saved.correctiveCycles, 0);
  assert.equal(saved.reviewCorrection.findings, 'lib.js:7: validate input');

  let task;
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    loadProjectConfig: () => reviewedProject, discoverReadyIssues: async () => [issue],
    createRalphTaskService: () => ({ run: async (cwd, value) => { task = value; return { status: 'passed', attempts: [{ number: 1 }] }; } }),
    deliverPassedWork: async ({ workspace }) => ({ branch: workspace.branch, commit: 'def456', pr: { number: 99, url: 'https://github.com/example/repo/pull/99' } }),
  }));
  assert.equal(task.id, 'autopilot:example/repo#234:review-correction-1');
  assert.match(task.goal, /Original issue context/);
  assert.match(task.goal, /validate input/);
  assert.doesNotMatch(task.goal, /Fix the failing CI/);
  saved = createJobStore(store.directory).load(234);
  assert.equal(saved.delivery.commit, 'def456');
  assert.equal(saved.review, null);

  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    loadProjectConfig: () => reviewedProject, discoverReadyIssues: async () => [issue],
    observePullRequestCi: async (value, identity) => { assert.equal(identity.commit, 'def456'); return { state: 'green', details: 'ok', prNumber: 99, headCommit: 'def456', runs: [] }; },
    reviewPullRequest: async () => ({ reviewer: 'claude:sonnet', verdict: 'PASS', commit: 'def456' }),
  }));
  saved = createJobStore(store.directory).load(234);
  assert.equal(saved.status, 'ready_for_human_merge');
  assert.deepEqual(saved.review, { reviewer: 'claude:sonnet', verdict: 'PASS', commit: 'def456' });
});

test('a second matching reviewer NEEDS_CHANGES after the reviewer budget is spent is handed to a human', async () => {
  const store = temporaryStore();
  const issue = { number: 235, title: 'Review exhausted', body: '' };
  const job = createJob({ projectName: 'demo', repo: 'example/repo', issue, branch: 'ralph/issue-235-review-exhausted', worktreePath: null, now: store.now });
  job.delivery = { branch: job.branch, commit: 'def456', pushed: true };
  job.pr = { number: 99, url: 'https://github.com/example/repo/pull/99' };
  job.status = 'awaiting_ci';
  job.reviewCorrectiveCycles = 1;
  job.reviewCorrection = { cycle: 1, status: 'delivered', reviewCommit: 'abc123', reviewer: 'claude:sonnet', findings: 'first finding', commit: 'def456' };
  store.save(job);
  let workerStarted = false;
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    loadProjectConfig: () => ({ ...project, enabled: true, verification: 'check', reviewPolicy: 'always' }),
    discoverReadyIssues: async () => [issue],
    observePullRequestCi: async () => ({ state: 'green', details: 'ok', prNumber: 99, headCommit: 'def456', runs: [] }),
    reviewPullRequest: async () => ({ reviewer: 'claude:sonnet', verdict: 'NEEDS_CHANGES', commit: 'def456', findings: 'second finding' }),
    prepareIssueWorkspace: async () => { workerStarted = true; },
  }));
  const saved = createJobStore(store.directory).load(235);
  assert.equal(workerStarted, false);
  assert.equal(saved.status, 'ready_for_human');
  assert.match(saved.failures.at(-1).message, /second finding/);
});

test('a second reviewer block and an interrupted reviewer worker are exhausted without duplicate work', async () => {
  const reviewedProject = { ...project, enabled: true, verification: 'check', maxAttempts: 2, reviewPolicy: 'always' };
  const issue = { number: 235, title: 'Bound review repair', body: '' };

  // This is the durable checkpoint left after the one permitted reviewer
  // correction has been delivered.  A new block is still reviewed against
  // the corrected SHA, but cannot start a second worker.
  const exhaustedStore = temporaryStore();
  const exhausted = createJob({
    projectName: 'demo', repo: 'example/repo', issue, branch: 'ralph/issue-235-bound-review-repair', worktreePath: null, now: exhaustedStore.now,
  });
  exhausted.delivery = { branch: exhausted.branch, commit: 'def456', pushed: true };
  exhausted.pr = { number: 99, url: 'https://github.com/example/repo/pull/99' };
  exhausted.status = 'awaiting_ci';
  exhausted.reviewCorrectiveCycles = 1;
  exhausted.reviewCorrection = { cycle: 1, status: 'delivered', reviewCommit: 'abc123', reviewer: 'claude:sonnet', findings: 'lib.js:7: validate input', commit: 'def456' };
  exhaustedStore.save(exhausted);
  let workerStarted = false;
  await runAutopilot(['--project', 'demo'], enabledDependencies(exhaustedStore, {
    loadProjectConfig: () => reviewedProject, discoverReadyIssues: async () => [issue],
    observePullRequestCi: async () => ({ state: 'green', details: 'ok', prNumber: 99, headCommit: 'def456', runs: [] }),
    reviewPullRequest: async () => ({ reviewer: 'claude:sonnet', verdict: 'NEEDS_CHANGES', commit: 'def456', findings: 'lib.js:9: reject malformed totals' }),
    createRalphTaskService: () => ({ run: async () => { workerStarted = true; } }),
  }));
  const blocked = createJobStore(exhaustedStore.directory).load(235);
  assert.equal(workerStarted, false);
  assert.equal(blocked.status, 'ready_for_human');
  assert.equal(blocked.reviewCorrectiveCycles, 1);
  assert.equal(blocked.correctiveCycles, 0);
  assert.match(blocked.failures.at(-1).message, /reject malformed totals/);

  // A crash after the reviewer worker began is also spent: a later one-shot
  // pass records the interruption and never replays the worker or PR work.
  const interruptedStore = temporaryStore();
  const interrupted = createJob({
    projectName: 'demo', repo: 'example/repo', issue: { ...issue, number: 236 }, branch: 'ralph/issue-236-bound-review-repair', worktreePath: null, now: interruptedStore.now,
  });
  interrupted.status = 'running';
  interrupted.ralph = { status: 'running', attempts: 0, taskId: 'autopilot:example/repo#236:review-correction-1' };
  interrupted.reviewCorrectiveCycles = 1;
  interrupted.reviewCorrection = { cycle: 1, status: 'running', reviewCommit: 'abc123', reviewer: 'claude:sonnet', findings: 'lib.js:7: validate input', commit: null };
  interruptedStore.save(interrupted);
  await runAutopilot(['--project', 'demo'], enabledDependencies(interruptedStore, {
    loadProjectConfig: () => reviewedProject, discoverReadyIssues: async () => [{ ...issue, number: 236 }],
    createRalphTaskService: () => ({ run: async () => { throw new Error('must not replay reviewer correction'); } }),
  }));
  const recovered = createJobStore(interruptedStore.directory).load(236);
  assert.equal(recovered.status, 'ready_for_human');
  assert.equal(recovered.reviewCorrection.status, 'failed');
  assert.match(recovered.failures.at(-1).message, /interrupted after Ralph started/);
});

test('an always-review project fails closed for absent, invalid, mismatched, or finding-bearing PASS review results', async () => {
  const inheritedFindingPass = Object.assign(Object.create({ findings: 'inherited unresolved defect' }), { reviewer: 'injected-reviewer', verdict: 'PASS', commit: 'abc123' });
  for (const review of [undefined, { reviewer: 'reviewer', verdict: 'PASS', commit: 'other-sha' }, { reviewer: 'reviewer', verdict: 'APPROVE', commit: 'abc123' }, { reviewer: 'injected-reviewer', verdict: 'PASS', commit: 'abc123', findings: 'src/app.js:1: unresolved defect' }, inheritedFindingPass]) {
    const store = temporaryStore();
    const issue = { number: 231, title: 'Fail closed review', body: '' };
    const reviewedProject = { ...project, enabled: true, verification: 'check', maxAttempts: 2, reviewPolicy: 'always' };
    await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
      loadProjectConfig: () => reviewedProject,
      discoverReadyIssues: async () => [issue],
      createRalphTaskService: passingRalph,
    }));
    await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
      loadProjectConfig: () => reviewedProject,
      discoverReadyIssues: async () => [issue],
      observePullRequestCi: async () => ({ state: 'green', details: 'green', prNumber: 99, headCommit: 'abc123', runs: [] }),
      reviewPullRequest: async () => review,
    }));
    const saved = createJobStore(store.directory).load(231);
    assert.equal(saved.status, 'ready_for_human');
    assert.equal(saved.terminal, true);
    assert.equal(saved.terminalState, 'ready_for_human');
    assert.equal(saved.review, null);
  }
});

test('a risk-review project fails closed for missing or invalid review results', async () => {
  for (const review of [undefined, { reviewer: 'reviewer', verdict: 'PASS', commit: 'other-sha' }, { reviewer: 'reviewer', verdict: 'APPROVE', commit: 'abc123' }]) {
    const store = temporaryStore();
    const issue = { number: 232, title: 'Fail closed risk review', body: '' };
    const reviewedProject = { ...project, enabled: true, verification: 'check', maxAttempts: 2, reviewPolicy: 'risk' };
    await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
      loadProjectConfig: () => reviewedProject,
      discoverReadyIssues: async () => [issue],
      createRalphTaskService: passingRalph,
    }));
    await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
      loadProjectConfig: () => reviewedProject,
      discoverReadyIssues: async () => [issue],
      observePullRequestCi: async () => ({ state: 'green', details: 'green', prNumber: 99, headCommit: 'abc123', runs: [] }),
      reviewPullRequest: async () => review,
    }));
    const saved = createJobStore(store.directory).load(232);
    assert.notEqual(saved.status, 'ready_for_human_merge');
    assert.equal(saved.status, 'ready_for_human');
    assert.equal(saved.terminal, true);
    assert.equal(saved.terminalState, 'ready_for_human');
    assert.equal(saved.review, null);
  }
});

test('a red persisted PR CI observation is recorded without starting corrective work', async () => {
  const store = temporaryStore();
  const issue = { number: 24, title: 'Red CI', body: '' };
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: passingRalph,
  }));

  let prepared = false;
  const result = await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    prepareIssueWorkspace: async () => { prepared = true; },
    observePullRequestCi: async () => ({
      state: 'red', details: 'CI (#601): completed/failure', prNumber: 99, headCommit: 'abc123',
      runs: [{ databaseId: 601, status: 'completed', conclusion: 'failure', name: 'test', workflowName: 'CI', url: 'https://example/run/601', startedAt: null, updatedAt: null }],
    }),
  }));

  assert.equal(result.outcome.status, 'red');
  assert.equal(prepared, false);
  const saved = createJobStore(store.directory).load(24);
  assert.equal(saved.status, 'correction_eligible');
  assert.equal(saved.correctiveCycles, 1);
  assert.equal(saved.terminal, false);
  assert.deepEqual(saved.ci, {
    state: 'red', details: 'CI (#601): completed/failure', prNumber: 99, headCommit: 'abc123',
    runs: [{ databaseId: 601, status: 'completed', conclusion: 'failure', name: 'test', workflowName: 'CI', url: 'https://example/run/601', startedAt: null, updatedAt: null }],
    diagnostics: 'diagnostics for abc123',
  });
  assert.deepEqual(saved.correction, {
    cycle: 1, status: 'eligible', redCommit: 'abc123', diagnostics: 'diagnostics for abc123', commit: null,
  });
});

test('red CI diagnostics are gathered and persisted before any correction', async () => {
  const store = temporaryStore();
  const issue = { number: 27, title: 'Diagnose CI', body: '' };
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: passingRalph,
  }));

  const observation = { state: 'red', details: 'CI (#701): completed/failure', prNumber: 99, headCommit: 'abc123', runs: [] };
  await assert.rejects(runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    observePullRequestCi: async () => observation,
    collectCiFailureDiagnostics: async () => { throw new Error('logs unavailable'); },
  })), /logs unavailable/);
  const retry = createJobStore(store.directory).load(27);
  assert.equal(retry.status, 'awaiting_ci');
  assert.equal(retry.correctiveCycles, 0);
  assert.equal(retry.correction, null);

  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    observePullRequestCi: async () => observation,
    collectCiFailureDiagnostics: async (value, observed) => {
      assert.equal(value.repo, 'example/repo');
      assert.equal(observed, observation);
      return 'pytest: test_ledger FAILED';
    },
  }));
  const saved = createJobStore(store.directory).load(27);
  assert.equal(saved.ci.diagnostics, 'pytest: test_ledger FAILED');
  assert.equal(saved.correction.diagnostics, 'pytest: test_ledger FAILED');
  assert.equal(saved.correction.redCommit, 'abc123');
});

test('red CI diagnostics come from the GitHub adapter and survive reload without launching a worker', async () => {
  const store = temporaryStore();
  const issue = { number: 28, title: 'Adapter diagnostics', body: '' };
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: passingRalph,
  }));

  const ghCalls = [];
  const runs = [
    { databaseId: 801, status: 'completed', conclusion: 'failure', name: 'test', workflowName: 'CI', url: 'https://example/run/801', startedAt: null, updatedAt: null },
    { databaseId: 802, status: 'completed', conclusion: 'success', name: 'lint', workflowName: 'Lint', url: null, startedAt: null, updatedAt: null },
  ];
  const jobs = { jobs: [{ name: 'unit', conclusion: 'failure', steps: [{ name: 'npm test', conclusion: 'failure' }] }] };
  let ralphLaunches = 0;
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    observePullRequestCi: undefined,
    collectCiFailureDiagnostics: undefined,
    createRalphTaskService: () => ({ run: async () => { ralphLaunches += 1; } }),
    execFile: (file, args, options, callback) => {
      ghCalls.push(args);
      assert.equal(file, 'gh');
      if (args[0] === 'run' && args[1] === 'list') return callback(null, JSON.stringify(runs), '');
      if (args.includes('--log-failed')) return callback(null, 'unit\tnpm test\tnot ok 3 - ledger totals\n', '');
      if (args.includes('jobs')) return callback(null, JSON.stringify(jobs), '');
      return callback(new Error(`unexpected gh call: ${args.join(' ')}`), '', '');
    },
  }));

  assert.equal(ralphLaunches, 0);
  assert.equal(ghCalls.some(args => args.includes('rerun')), false);
  const saved = createJobStore(store.directory).load(28);
  assert.equal(saved.status, 'correction_eligible');
  assert.equal(saved.ci.state, 'red');
  assert.deepEqual(saved.ci.runs.map(run => [run.databaseId, run.conclusion]), [[801, 'failure'], [802, 'success']]);
  assert.match(saved.ci.diagnostics, /== CI \(#801\): failure https:\/\/example\/run\/801/);
  assert.match(saved.ci.diagnostics, /- job unit: failure; failed steps: npm test \(failure\)/);
  assert.match(saved.ci.diagnostics, /not ok 3 - ledger totals/);
  assert.equal(saved.correction.diagnostics, saved.ci.diagnostics);
  assert.equal(saved.correction.status, 'eligible');
});

async function reachCorrection(store, issue) {
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: passingRalph,
  }));
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    observePullRequestCi: async () => ({ state: 'red', details: 'CI failed', prNumber: 99, headCommit: 'abc123', runs: [] }),
    collectCiFailureDiagnostics: async () => 'npm test: ledger.test.js failed',
  }));
}

test('a passed correction uses issue context plus CI diagnostics and is pushed to the same branch', async () => {
  const store = temporaryStore();
  const issue = { number: 28, title: 'Correct me', body: '## Acceptance criteria\n- Ledger balances' };
  await reachCorrection(store, issue);

  const prepared = [];
  const delivered = [];
  let task;
  const result = await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    prepareIssueWorkspace: async (value, candidate, options) => {
      prepared.push(options);
      return { worktreePath: '/tmp/worktrees/issue-28', branch: options.branch, baseRef: 'origin/main' };
    },
    readRepositoryInstructions: async () => [{ path: 'AGENTS.md', content: 'Run npm test.' }],
    createRalphTaskService: () => ({ run: async (cwd, value) => {
      task = value;
      return { status: 'passed', attempts: [{ number: 1 }] };
    } }),
    deliverPassedWork: async input => {
      delivered.push(input);
      return { branch: input.workspace.branch, commit: 'def456', pr: { number: 99, url: 'https://github.com/example/repo/pull/99' } };
    },
  }));

  assert.deepEqual(prepared, [{ branch: 'ralph/issue-28-correct-me', headCommit: 'abc123' }]);
  assert.equal(task.id, 'autopilot:example/repo#28:ci-correction-1');
  assert.equal(task.verification, 'check');
  assert.match(task.goal, /npm test: ledger\.test\.js failed/);
  assert.match(task.goal, /Ledger balances/);
  assert.match(task.goal, /Run npm test\./);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].previousCommit, 'abc123');
  assert.equal(delivered[0].ralphStatus, 'passed');
  assert.equal(delivered[0].workspace.branch, 'ralph/issue-28-correct-me');
  assert.equal(result.outcome.status, 'passed');

  const saved = createJobStore(store.directory).load(28);
  assert.equal(saved.status, 'awaiting_ci');
  assert.equal(saved.terminal, false);
  assert.deepEqual(saved.delivery, { branch: 'ralph/issue-28-correct-me', commit: 'def456', pushed: true });
  assert.equal(saved.ci.state, 'pending');
  assert.equal(saved.ci.headCommit, 'def456');
  assert.equal(saved.correction.status, 'delivered');
  assert.equal(saved.correction.commit, 'def456');
  assert.equal(saved.correctiveCycles, 1);

  // The next pass only observes CI for the corrective commit.
  let ralphStarted = false;
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: () => ({ run: async () => { ralphStarted = true; } }),
    observePullRequestCi: async (value, identity) => {
      assert.deepEqual(identity, { number: 99, commit: 'def456' });
      return { state: 'green', details: 'ok', prNumber: 99, headCommit: 'def456', runs: [] };
    },
  }));
  assert.equal(ralphStarted, false);
  assert.equal(createJobStore(store.directory).load(28).status, 'ready_for_human_merge');
});

test('a correction that fails local verification is handed to a human with diagnostics', async () => {
  const store = temporaryStore();
  const issue = { number: 29, title: 'Unfixable', body: '' };
  await reachCorrection(store, issue);

  let deliveries = 0;
  const result = await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: () => ({ run: async () => ({
      status: 'needs_planning',
      attempts: [{ number: 1, status: 'failed', verification: { exitCode: 1, stderr: 'still failing' } }],
    }) }),
    deliverPassedWork: async () => { deliveries += 1; },
  }));
  assert.equal(deliveries, 0);
  assert.equal(result.outcome.status, 'ready_for_human');
  const saved = createJobStore(store.directory).load(29);
  assert.equal(saved.status, 'ready_for_human');
  assert.equal(saved.terminal, true);
  assert.equal(saved.terminalState, 'ready_for_human');
  assert.equal(saved.correction.status, 'failed');
  assert.equal(saved.correctiveCycles, 1);
  const failure = saved.failures[saved.failures.length - 1];
  assert.equal(failure.phase, 'correction');
  assert.match(failure.message, /still failing/);
  assert.match(failure.message, /ledger\.test\.js failed/);

  assert.equal(await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: () => ({ run: async () => { throw new Error('must not run'); } }),
  })), null);
});

test('a correction without a code change is never pushed and goes to a human', async () => {
  const store = temporaryStore();
  const issue = { number: 30, title: 'No change', body: '' };
  await reachCorrection(store, issue);

  await assert.rejects(runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: passingRalph,
    deliverPassedWork: async input => deliverPassedWork(input, {
      execFile: (command, args, options, callback) => {
        assert.notDeepEqual(args.slice(0, 1), ['push']);
        callback(null, args[0] === 'rev-parse' ? 'abc123\n' : '', '');
      },
    }),
  })), /no change from abc123/);
  const saved = createJobStore(store.directory).load(30);
  assert.equal(saved.status, 'ready_for_human');
  assert.equal(saved.terminal, true);
  assert.equal(saved.delivery.commit, 'abc123');
  assert.equal(saved.correction.status, 'failed');
});

test('an interrupted correction is not started a second time', async () => {
  const store = temporaryStore();
  const issue = { number: 31, title: 'Interrupted fix', body: '' };
  await reachCorrection(store, issue);
  const job = store.load(31);
  job.status = 'running';
  job.correction.status = 'running';
  job.ralph = { status: 'running', attempts: 0, taskId: 'autopilot:example/repo#31:ci-correction-1' };
  store.save(job);

  let ralphStarted = false;
  const result = await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: () => ({ run: async () => { ralphStarted = true; } }),
  }));
  assert.equal(ralphStarted, false);
  assert.equal(result.outcome.status, 'ready_for_human');
  assert.equal(createJobStore(store.directory).load(31).terminalState, 'ready_for_human');
});

test('a correction pushed before an interrupted delivery resumes from its corrective commit without rerunning Ralph', async () => {
  const store = temporaryStore();
  const issue = { number: 33, title: 'Resume fix', body: '' };
  await reachCorrection(store, issue);

  let ralphRuns = 0;
  await assert.rejects(runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: () => ({ run: async () => { ralphRuns += 1; return { status: 'passed', attempts: [{ number: 1 }] }; } }),
    deliverPassedWork: async ({ workspace }, { onProgress }) => {
      await onProgress({ branch: workspace.branch, commit: 'fe7c0de', pushed: true, pr: null });
      throw new Error('PR lookup interrupted');
    },
  })), /PR lookup interrupted/);
  const failed = createJobStore(store.directory).load(33);
  assert.equal(failed.correction.status, 'passed');
  assert.equal(failed.terminal, false);

  const prepared = [];
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    prepareIssueWorkspace: async (value, candidate, options) => {
      prepared.push(options);
      return { worktreePath: '/tmp/worktrees/issue-33', branch: options.branch, baseRef: 'origin/main' };
    },
    createRalphTaskService: () => ({ run: async () => { ralphRuns += 1; } }),
    deliverPassedWork: async ({ workspace, previousCommit }) => {
      assert.equal(previousCommit, 'abc123');
      return { branch: workspace.branch, commit: 'fe7c0de', pr: { number: 99, url: 'https://github.com/example/repo/pull/99' } };
    },
  }));
  assert.equal(ralphRuns, 1);
  assert.deepEqual(prepared, [{ branch: 'ralph/issue-33-resume-fix', headCommit: 'fe7c0de' }]);
  const saved = createJobStore(store.directory).load(33);
  assert.equal(saved.status, 'awaiting_ci');
  assert.equal(saved.correction.status, 'delivered');
  assert.equal(saved.ci.headCommit, 'fe7c0de');
});

test('a correction committed before an interrupted push resumes from its corrective commit without rerunning Ralph', async () => {
  const store = temporaryStore();
  const issue = { number: 34, title: 'Resume unpushed fix', body: '' };
  await reachCorrection(store, issue);

  let ralphRuns = 0;
  await assert.rejects(runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: () => ({ run: async () => { ralphRuns += 1; return { status: 'passed', attempts: [{ number: 1 }] }; } }),
    deliverPassedWork: async ({ workspace }, { onProgress }) => {
      await onProgress({ branch: workspace.branch, commit: 'c0ffee0', pushed: false });
      throw new Error('push interrupted');
    },
  })), /push interrupted/);
  const failed = createJobStore(store.directory).load(34);
  assert.equal(failed.correction.status, 'passed');
  assert.deepEqual(failed.delivery, { branch: 'ralph/issue-34-resume-unpushed-fix', commit: 'c0ffee0', pushed: false });

  const prepared = [];
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    prepareIssueWorkspace: async (value, candidate, options) => {
      prepared.push(options);
      return { worktreePath: '/tmp/worktrees/issue-34', branch: options.branch, baseRef: 'origin/main' };
    },
    createRalphTaskService: () => ({ run: async () => { ralphRuns += 1; } }),
    deliverPassedWork: async ({ workspace, previousCommit }) => {
      assert.equal(previousCommit, 'abc123');
      return { branch: workspace.branch, commit: 'c0ffee0', pr: { number: 99, url: 'https://github.com/example/repo/pull/99' } };
    },
  }));
  assert.equal(ralphRuns, 1);
  assert.deepEqual(prepared, [{ branch: 'ralph/issue-34-resume-unpushed-fix', headCommit: 'c0ffee0' }]);
  const saved = createJobStore(store.directory).load(34);
  assert.equal(saved.status, 'awaiting_ci');
  assert.equal(saved.correction.status, 'delivered');
  assert.equal(saved.ci.headCommit, 'c0ffee0');
});

test('red CI permits one later correction and then becomes terminal if CI remains red', async () => {
  const store = temporaryStore();
  const issue = { number: 26, title: 'Correct CI', body: '' };
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: passingRalph,
  }));

  let workers = 0;
  const red = async () => ({ state: 'red', details: 'CI failed', prNumber: 99, headCommit: 'abc123', runs: [] });
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: () => ({ run: async () => { workers += 1; return { status: 'passed', attempts: [{ number: 1 }] }; } }),
    observePullRequestCi: red,
  }));
  assert.equal(workers, 0);
  assert.equal(createJobStore(store.directory).load(26).status, 'correction_eligible');

  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: () => ({ run: async () => { workers += 1; return { status: 'passed', attempts: [{ number: 1 }] }; } }),
    deliverPassedWork: async ({ workspace }) => ({ branch: workspace.branch, commit: 'def456', pr: { number: 99, url: 'https://github.com/example/repo/pull/99' } }),
  }));
  assert.equal(workers, 1);

  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    observePullRequestCi: async () => ({ state: 'red', details: 'CI still failed', prNumber: 99, headCommit: 'def456', runs: [] }),
  }));
  const exhausted = createJobStore(store.directory).load(26);
  assert.equal(exhausted.status, 'ready_for_human');
  assert.equal(exhausted.terminal, true);
  assert.equal(exhausted.terminalState, 'ready_for_human');
  assert.equal(exhausted.correctiveCycles, 1);
  assert.equal(exhausted.ci.diagnostics, 'diagnostics for def456');
  assert.match(exhausted.failures[exhausted.failures.length - 1].message, /diagnostics for def456/);

  assert.equal(await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: () => ({ run: async () => { workers += 1; } }),
  })), null);
  assert.equal(workers, 1);
});

test('the correction budget gate keys on the persisted correctiveCycles counter', async () => {
  const store = temporaryStore();
  const issue = { number: 35, title: 'Budget gate', body: '' };
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: passingRalph,
  }));
  const fresh = createJobStore(store.directory).load(35);
  assert.equal(fresh.status, 'awaiting_ci');
  assert.equal(fresh.correctiveCycles, 0);

  // Simulate a job whose single correction budget was already spent by an
  // earlier cycle, independently of how the corrective worker delivered it.
  fresh.correctiveCycles = 1;
  store.save(fresh);
  assert.equal(createJobStore(store.directory).load(35).correctiveCycles, 1);

  let workers = 0;
  const result = await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: () => ({ run: async () => { workers += 1; } }),
    observePullRequestCi: async () => ({ state: 'red', details: 'CI failed again', prNumber: 99, headCommit: 'abc123', runs: [] }),
  }));
  assert.equal(workers, 0);
  assert.equal(result.outcome.status, 'red');
  const saved = createJobStore(store.directory).load(35);
  assert.equal(saved.status, 'ready_for_human');
  assert.equal(saved.terminal, true);
  assert.equal(saved.terminalState, 'ready_for_human');
  assert.equal(saved.correctiveCycles, 1);
  assert.equal(saved.correction, null);
  assert.equal(saved.ci.state, 'red');
  assert.equal(saved.ci.diagnostics, 'diagnostics for abc123');
  const failure = saved.failures[saved.failures.length - 1];
  assert.equal(failure.phase, 'ci');
  assert.match(failure.message, /no further automatic correction/);
  assert.match(failure.message, /diagnostics for abc123/);
});

test('CI observation failures keep the job awaiting CI and never restart Ralph', async () => {
  const store = temporaryStore();
  const issue = { number: 25, title: 'Observe again', body: '' };
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: passingRalph,
  }));

  for (const observe of [
    async () => { throw new Error('gh offline'); },
    async () => ({ state: 'green', details: null, prNumber: 99, headCommit: 'other', runs: [] }),
  ]) {
    await assert.rejects(runAutopilot(['--project', 'demo'], enabledDependencies(store, {
      discoverReadyIssues: async () => [issue],
      observePullRequestCi: observe,
    })), /gh offline|does not match/);
    const saved = createJobStore(store.directory).load(25);
    assert.equal(saved.status, 'awaiting_ci');
    assert.equal(saved.terminal, false);
    assert.equal(saved.ci, null);
  }

  let ralphStarted = false;
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: () => ({ run: async () => { ralphStarted = true; } }),
    observePullRequestCi: async () => ({ state: 'pending', details: null, prNumber: 99, headCommit: 'abc123', runs: [] }),
  }));
  assert.equal(ralphStarted, false);
  assert.equal(createJobStore(store.directory).load(25).ci.state, 'pending');
});

test('reloads a failed job on the next run and resumes it with the persisted branch', async () => {
  const store = temporaryStore();
  const issue = { number: 22, title: 'Flaky setup', body: '' };
  await assert.rejects(runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    prepareRepositoryEnvironment: async () => { throw new Error('venv failed'); },
    createRalphTaskService: passingRalph,
  })), /venv failed/);

  const failed = createJobStore(store.directory).load(22);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.terminal, false);
  assert.equal(failed.workspaceState, 'removed');
  assert.deepEqual(failed.failures.map(failure => [failure.run, failure.phase]), [[1, 'preparing']]);
  assert.match(failed.failures[0].message, /venv failed/);

  const branches = [];
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [{ ...issue, title: 'Renamed later' }],
    prepareIssueWorkspace: async (value, candidate, options) => {
      branches.push(options.branch);
      return { worktreePath: '/tmp/worktrees/issue-22', branch: options.branch, baseRef: 'origin/main' };
    },
    createRalphTaskService: passingRalph,
  }));
  assert.deepEqual(branches, ['ralph/issue-22-flaky-setup']);
  const resumed = createJobStore(store.directory).load(22);
  assert.equal(resumed.status, 'awaiting_ci');
  assert.equal(resumed.runs, 2);
  assert.equal(resumed.issue.title, 'Renamed later');
  assert.equal(resumed.failures.length, 1);
  assert.equal(store.list().length, 1);
});

function enabledDependencies(store, overrides = {}) {
  return {
    jobStore: store,
    loadProjectConfig: () => ({ ...project, enabled: true, verification: 'check', maxAttempts: 2, worktreeRoot: '/tmp/worktrees' }),
    prepareIssueWorkspace: async (value, issue, options) => ({
      worktreePath: `/tmp/worktrees/issue-${issue.number}`,
      branch: options.branch,
      baseRef: 'origin/main',
    }),
    readRepositoryInstructions: async () => [],
    prepareRepositoryEnvironment: async () => {},
    cleanupIssueWorkspace: async () => {},
    deliverPassedWork: async ({ workspace }) => ({ branch: workspace.branch, commit: 'abc123', pr: { number: 99, url: 'https://github.com/example/repo/pull/99' } }),
    collectCiFailureDiagnostics: async (value, observation) => `diagnostics for ${observation.headCommit}`,
    findOpenIssuePullRequests: async () => [],
    write: () => {},
    ...overrides,
  };
}

test('hands issue 68 with an existing open PR to a human before creating a workspace or worker', async () => {
  const store = temporaryStore();
  const issue = { number: 68, title: 'Reconcile an existing PR', body: '' };
  let prepared = false;
  let workerStarted = false;
  const result = await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    findOpenIssuePullRequests: async (value, candidate) => {
      assert.equal(candidate.number, 68);
      return [{ number: 70, url: 'https://github.com/example/repo/pull/70' }];
    },
    prepareIssueWorkspace: async () => { prepared = true; },
    createRalphTaskService: () => ({ run: async () => { workerStarted = true; } }),
  }));
  assert.equal(prepared, false);
  assert.equal(workerStarted, false);
  assert.equal(result.outcome.status, 'ready_for_human');
  const job = createJobStore(store.directory).load(68);
  assert.equal(job.branch, 'ralph/issue-68-reconcile-an-existing-pr');
  assert.equal(job.status, 'ready_for_human');
  assert.equal(job.terminal, true);
  assert.equal(job.pr, null);
  assert.match(job.failures.at(-1).message, /PR #70 explicitly closes issue #68/);
});

test('hands ambiguous open PR associations to a human without creating a workspace or worker', async () => {
  const store = temporaryStore();
  const issue = { number: 68, title: 'Ambiguous PR', body: '' };
  let prepared = false;
  const result = await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    findOpenIssuePullRequests: async () => [
      { number: 70, url: 'https://github.com/example/repo/pull/70' },
      { number: 71, url: 'https://github.com/example/repo/pull/71' },
    ],
    prepareIssueWorkspace: async () => { prepared = true; },
  }));
  assert.equal(prepared, false);
  assert.equal(result.outcome.status, 'ready_for_human');
  const job = createJobStore(store.directory).load(68);
  assert.equal(job.terminal, true);
  assert.equal(job.status, 'ready_for_human');
  assert.match(job.failures[0].message, /PRs #70, #71 explicitly close issue #68/);
});

test('persists a needs_planning job and does not start duplicate work on the next run', async () => {
  const store = temporaryStore();
  const issue = { number: 8, title: 'Selected', body: '' };
  let ralphRuns = 0;
  let deliveries = 0;
  const dependencies = enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: () => ({ run: async () => {
      ralphRuns += 1;
      return { status: 'needs_planning', attempts: [{ number: 1, status: 'worker_error', error: { message: 'codex crashed' } }] };
    } }),
    deliverPassedWork: async () => { deliveries += 1; },
  });

  await runAutopilot(['--project', 'demo'], dependencies);
  const job = createJobStore(store.directory).load(8);
  assert.equal(job.project, 'demo');
  assert.deepEqual(job.issue, { number: 8, title: 'Selected' });
  assert.equal(job.branch, 'ralph/issue-8-selected');
  assert.equal(job.worktreePath, '/tmp/worktrees/issue-8');
  assert.equal(job.baseRef, 'origin/main');
  assert.equal(job.workspaceState, 'removed');
  assert.equal(job.status, 'needs_planning');
  assert.deepEqual(job.ralph, { status: 'needs_planning', attempts: 1, taskId: 'autopilot:example/repo#8' });
  assert.equal(job.pr, null);
  assert.equal(job.ci, null);
  assert.equal(job.correctiveCycles, 0);
  assert.equal(job.runs, 1);
  assert.equal(job.terminal, true);
  assert.equal(job.terminalState, 'needs_planning');
  assert.equal(job.failures[0].phase, 'ralph');
  assert.match(job.failures[0].message, /codex crashed/);
  assert.equal(deliveries, 0);

  const lines = [];
  const second = await runAutopilot(['--project', 'demo'], { ...dependencies, write: line => lines.push(line) });
  assert.equal(second, null);
  assert.equal(ralphRuns, 1);
  assert.equal(deliveries, 0);
  assert.match(lines[0], /no ready-for-agent issue/);
});

test('resumes a failed delivery without rerunning Ralph and reuses its branch and PR', async () => {
  const store = temporaryStore();
  const issue = { number: 31, title: 'Delivery retry', body: '' };
  let ralphRuns = 0;
  let deliveryRuns = 0;
  const dependencies = enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: () => ({ run: async () => {
      ralphRuns += 1;
      return { status: 'passed', attempts: [{ number: 1 }] };
    } }),
    deliverPassedWork: async ({ workspace }) => {
      deliveryRuns += 1;
      if (deliveryRuns === 1) throw new Error('push interrupted');
      assert.equal(workspace.branch, 'ralph/issue-31-delivery-retry');
      return { branch: workspace.branch, commit: 'retrycommit', pr: { number: 111, url: 'https://github.com/example/repo/pull/111' } };
    },
  });

  await assert.rejects(runAutopilot(['--project', 'demo'], dependencies), /push interrupted/);
  let failed = createJobStore(store.directory).load(31);
  assert.equal(failed.ralph.status, 'passed');
  assert.equal(failed.terminal, false);
  assert.equal(failed.status, 'failed');

  await runAutopilot(['--project', 'demo'], dependencies);
  const completed = createJobStore(store.directory).load(31);
  assert.equal(ralphRuns, 1);
  assert.equal(deliveryRuns, 2);
  assert.deepEqual(completed.delivery, { branch: 'ralph/issue-31-delivery-retry', commit: 'retrycommit', pushed: true });
  assert.deepEqual(completed.pr, { number: 111, url: 'https://github.com/example/repo/pull/111' });
  assert.equal(completed.status, 'awaiting_ci');
  assert.equal(completed.terminalState, null);
});

test('persists a successful push before a later delivery failure for a safe reconcile on resume', async () => {
  const store = temporaryStore();
  const issue = { number: 32, title: 'Durable push', body: '' };
  await assert.rejects(runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: passingRalph,
    deliverPassedWork: async ({ workspace }, { onProgress }) => {
      await onProgress({ branch: workspace.branch, commit: 'pushedcommit', pushed: true, pr: null });
      throw new Error('GitHub PR lookup interrupted');
    },
  })), /GitHub PR lookup interrupted/);

  const failed = createJobStore(store.directory).load(32);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.delivery, { branch: 'ralph/issue-32-durable-push', commit: 'pushedcommit', pushed: true });
  assert.equal(failed.pr, null);
  assert.equal(failed.ralph.status, 'passed');
});

// Routes delivery through the real Git/gh adapter with a recording execFile so
// the tests observe exactly which commands a Ralph verdict produces.  `remote`
// models GitHub's open pull requests so resumed runs can observe earlier ones.
function recordingGitDelivery(commands, remote = { pulls: [] }, { failCreate = false } = {}) {
  return (request, options) => deliverPassedWork(request, {
    ...options,
    execFile: (file, args, execOptions, callback) => {
      commands.push([file, ...args]);
      if (file === 'gh' && args[1] === 'list') {
        const head = args[args.indexOf('--head') + 1];
        const base = args[args.indexOf('--base') + 1];
        callback(null, JSON.stringify(remote.pulls.filter(pull => pull.headRefName === head && pull.baseRefName === base)), '');
        return;
      }
      if (file === 'gh' && args[1] === 'create') {
        if (failCreate) {
          callback(new Error('exit 1'), '', 'gh: network unreachable');
          return;
        }
        const number = 500 + remote.pulls.length;
        const url = `https://github.com/example/repo/pull/${number}`;
        remote.pulls.push({
          number,
          url,
          headRefName: args[args.indexOf('--head') + 1],
          baseRefName: args[args.indexOf('--base') + 1],
        });
        callback(null, `${url}\n`, '');
        return;
      }
      const stdout = args[0] === 'status' ? ' M src/totals.js\n' : args[0] === 'rev-parse' ? 'c0ffee1\n' : '';
      callback(null, stdout, '');
    },
  });
}

test('a passed Ralph verdict pushes the deterministic branch, opens a PR to main, and persists both', async () => {
  const store = temporaryStore();
  const commands = [];
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    loadProjectConfig: () => ({ ...project, enabled: true, verification: 'check', maxAttempts: 2, baseBranch: 'main' }),
    discoverReadyIssues: async () => [{ number: 41, title: 'Fix: Monthly Totals!', body: '' }],
    createRalphTaskService: passingRalph,
    deliverPassedWork: recordingGitDelivery(commands),
  }));

  const branch = 'ralph/issue-41-fix-monthly-totals';
  const list = ['gh', 'pr', 'list', '--repo', 'example/repo', '--head', branch, '--base', 'main', '--state', 'open',
    '--json', 'number,url,headRefName,baseRefName', '--limit', '100'];
  assert.deepEqual(commands, [
    ['git', 'status', '--porcelain'],
    ['git', 'add', '-A'],
    ['git', 'commit', '-m', 'ralph: resolve #41'],
    ['git', 'rev-parse', 'HEAD'],
    ['git', 'push', '--set-upstream', 'origin', branch],
    list,
    ['gh', 'pr', 'create', '--repo', 'example/repo', '--base', 'main', '--head', branch,
      '--title', 'Fix: Monthly Totals!', '--body', 'Closes #41'],
    list,
  ]);
  const saved = createJobStore(store.directory).load(41);
  assert.equal(saved.branch, branch);
  assert.deepEqual(saved.delivery, { branch, commit: 'c0ffee1', pushed: true });
  assert.deepEqual(saved.pr, { number: 500, url: 'https://github.com/example/repo/pull/500' });
  assert.equal(saved.status, 'awaiting_ci');
  assert.equal(saved.terminalState, null);
});

test('a resumed delivery reuses the open PR for its deterministic branch instead of opening a duplicate', async () => {
  const store = temporaryStore();
  const remote = { pulls: [] };
  const issue = { number: 44, title: 'Resume PR', body: '' };
  const branch = 'ralph/issue-44-resume-pr';
  let ralphRuns = 0;
  const base = {
    discoverReadyIssues: async () => [issue],
    createRalphTaskService: () => ({ run: async () => {
      ralphRuns += 1;
      return { status: 'passed', attempts: [{ number: 1 }] };
    } }),
  };

  // The first run opens the PR but dies before the job records it.
  const firstCommands = [];
  const firstDelivery = recordingGitDelivery(firstCommands, remote);
  await assert.rejects(runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    ...base,
    deliverPassedWork: async (request, options) => {
      await firstDelivery(request, { ...options, onProgress: async progress => {
        if (progress.pr) throw new Error('crashed after PR creation');
        await options.onProgress(progress);
      } });
    },
  })), /crashed after PR creation/);
  assert.equal(remote.pulls.length, 1);
  let job = createJobStore(store.directory).load(44);
  assert.equal(job.pr, null);
  assert.equal(job.delivery.pushed, true);

  const commands = [];
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    ...base,
    deliverPassedWork: recordingGitDelivery(commands, remote),
  }));
  assert.equal(ralphRuns, 1);
  assert.equal(commands.some(([file, , action]) => file === 'gh' && action === 'create'), false);
  assert.equal(remote.pulls.length, 1);
  job = createJobStore(store.directory).load(44);
  assert.equal(job.branch, branch);
  assert.deepEqual(job.pr, { number: 500, url: 'https://github.com/example/repo/pull/500' });
  assert.equal(job.status, 'awaiting_ci');
  assert.equal(job.terminalState, null);
});

test('a failed PR creation keeps the pushed job resumable without recording a PR', async () => {
  const store = temporaryStore();
  const commands = [];
  await assert.rejects(runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [{ number: 45, title: 'Offline', body: '' }],
    createRalphTaskService: passingRalph,
    deliverPassedWork: recordingGitDelivery(commands, { pulls: [] }, { failCreate: true }),
  })), /creating the pull request: gh: network unreachable/);
  const saved = createJobStore(store.directory).load(45);
  assert.equal(saved.delivery.pushed, true);
  assert.equal(saved.pr, null);
  assert.equal(saved.status, 'failed');
  assert.equal(saved.terminal, false);
  assert.equal(saved.ralph.status, 'passed');
});

test('needs_planning never commits, pushes, or opens a PR and leaves delivery unrecorded', async () => {
  const store = temporaryStore();
  const commands = [];
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [{ number: 42, title: 'Unclear', body: '' }],
    createRalphTaskService: () => ({ run: async () => ({ status: 'needs_planning', attempts: [{ number: 1 }] }) }),
    deliverPassedWork: recordingGitDelivery(commands),
  }));

  assert.deepEqual(commands, []);
  const saved = createJobStore(store.directory).load(42);
  assert.equal(saved.status, 'needs_planning');
  assert.deepEqual(saved.delivery, { branch: null, commit: null, pushed: false });
  assert.equal(saved.pr, null);
});

test('an unexpected Ralph status never commits or pushes', async () => {
  const store = temporaryStore();
  const commands = [];
  await assert.rejects(runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [{ number: 43, title: 'Odd', body: '' }],
    createRalphTaskService: () => ({ run: async () => ({ status: 'failed', attempts: [] }) }),
    deliverPassedWork: recordingGitDelivery(commands),
  })), /unexpected Ralph result status/);

  assert.deepEqual(commands, []);
  const saved = createJobStore(store.directory).load(43);
  assert.equal(saved.delivery.pushed, false);
  assert.equal(saved.delivery.commit, null);
});

test('reloads an interrupted job, reconciles its leftover workspace, and resumes it before new issues', async () => {
  const store = temporaryStore();
  store.save({
    ...createJob({
      projectName: 'demo',
      repo: 'example/repo',
      issue: { number: 5, title: 'Old title' },
      branch: 'ralph/issue-5-old-title',
      worktreePath: '/tmp/worktrees/issue-5',
      now: store.now,
    }),
    status: 'running',
    runs: 1,
    workspaceState: 'prepared',
    ralph: { status: 'running', attempts: 0, taskId: 'autopilot:example/repo#5' },
  });

  const events = [];
  const lines = [];
  await runAutopilot(['--project', 'demo', '--dry-run'], enabledDependencies(store, {
    discoverReadyIssues: async () => [{ number: 3, title: 'New', body: '' }, { number: 5, title: 'New title', body: '' }],
    write: line => lines.push(line),
  }));
  assert.match(lines[0], /issue #5: New title;.*resumes existing job \(status running\)/);

  const result = await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [{ number: 3, title: 'New', body: '' }, { number: 5, title: 'New title', body: '' }],
    cleanupIssueWorkspace: async (value, workspace) => { events.push(['cleanup', workspace.worktreePath, workspace.branch]); },
    prepareIssueWorkspace: async (value, issue, options) => {
      events.push(['prepare', issue.number, options.branch]);
      return { worktreePath: `/tmp/worktrees/issue-${issue.number}`, branch: options.branch, baseRef: 'origin/main' };
    },
    createRalphTaskService: () => ({ run: async () => ({ status: 'passed', attempts: [{ number: 1 }] }) }),
  }));

  assert.equal(result.issue.number, 5);
  assert.deepEqual(events, [
    ['cleanup', '/tmp/worktrees/issue-5', 'ralph/issue-5-old-title'],
    ['prepare', 5, 'ralph/issue-5-old-title'],
    ['cleanup', '/tmp/worktrees/issue-5', 'ralph/issue-5-old-title'],
  ]);
  const job = createJobStore(store.directory).load(5);
  assert.equal(job.runs, 2);
  assert.equal(job.status, 'awaiting_ci');
  assert.equal(job.terminal, false);
  assert.equal(job.terminalState, null);
  assert.equal(job.issue.title, 'New title');
  assert.equal(job.branch, 'ralph/issue-5-old-title');
  assert.equal(job.failures[0].phase, 'running');
  assert.match(job.failures[0].message, /interrupted/);
  assert.equal(createJobStore(store.directory).load(3), null);
  assert.deepEqual(fs.readdirSync(store.directory), ['issue-5.json']);
});

test('records failures and stops retrying a job after the run bound', async () => {
  const store = temporaryStore();
  const dependencies = enabledDependencies(store, {
    maxJobRuns: 2,
    discoverReadyIssues: async () => [{ number: 6, title: 'Broken fetch', body: '' }],
    prepareIssueWorkspace: async () => { throw new Error('Git workspace operation failed: fetching'); },
    createRalphTaskService: () => { throw new Error('Ralph must not start'); },
  });

  await assert.rejects(runAutopilot(['--project', 'demo'], dependencies), /fetching/);
  let job = createJobStore(store.directory).load(6);
  assert.equal(job.status, 'failed');
  assert.equal(job.terminal, false);
  assert.deepEqual(job.failures.map(failure => [failure.run, failure.phase]), [[1, 'preparing']]);

  await assert.rejects(runAutopilot(['--project', 'demo'], dependencies), /fetching/);
  job = createJobStore(store.directory).load(6);
  assert.equal(job.runs, 2);
  assert.equal(job.terminal, true);
  assert.equal(job.terminalState, 'failed');

  assert.equal(await runAutopilot(['--project', 'demo'], dependencies), null);
});

test('refuses to work an issue whose job is owned by another live process', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-cli-state-'));
  temporaryDirectories.add(directory);
  createJobStore(directory, { pid: 4242, isProcessAlive: () => true }).acquire(9);
  let ralphStarted = false;
  await assert.rejects(runAutopilot(['--project', 'demo'], enabledDependencies(
    createJobStore(directory, { isProcessAlive: () => true }),
    {
      discoverReadyIssues: async () => [{ number: 9, title: 'Busy', body: '' }],
      createRalphTaskService: () => ({ run: async () => { ralphStarted = true; } }),
    },
  )), /already owned by running process 4242/);
  assert.equal(ralphStarted, false);
});

function saveJob(store, number, fields) {
  return store.save({
    ...createJob({
      projectName: 'demo',
      repo: 'example/repo',
      issue: { number, title: `Issue ${number}` },
      branch: `ralph/issue-${number}-issue-${number}`,
      worktreePath: `/tmp/worktrees/issue-${number}`,
      now: store.now,
    }),
    runs: 1,
    ...fields,
  });
}

test('cleans only the recorded workspace of terminal jobs and leaves live or unfinished work alone', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-cli-state-'));
  temporaryDirectories.add(directory);
  const store = createJobStore(directory, { isProcessAlive: pid => pid === 4242 });
  saveJob(store, 40, { status: 'needs_planning', terminal: true, terminalState: 'needs_planning', workspaceState: 'prepared' });
  saveJob(store, 41, { status: 'running', workspaceState: 'prepared' });
  saveJob(store, 42, { status: 'failed', terminal: true, terminalState: 'failed', workspaceState: 'prepared' });
  saveJob(store, 43, { status: 'ready_for_human_merge', terminal: true, terminalState: 'ready_for_human_merge', workspaceState: 'removed' });
  saveJob(store, 44, {
    status: 'ready_for_human_merge',
    terminal: true,
    terminalState: 'ready_for_human_merge',
    workspaceState: 'prepared',
    delivery: { branch: 'ralph/issue-44-issue-44', commit: 'abc123', pushed: true },
  });
  // A live Ralph process still owns issue 42; its workspace must be left in place.
  const liveLock = createJobStore(directory, { pid: 4242, isProcessAlive: () => true }).acquire(42);

  const cleaned = [];
  const lines = [];
  const result = await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [],
    cleanupIssueWorkspace: async (value, workspace, options) => {
      cleaned.push([workspace.worktreePath, workspace.branch, options.preserveBranch]);
    },
    write: line => lines.push(line),
  }));

  assert.equal(result, null);
  assert.deepEqual(cleaned, [
    ['/tmp/worktrees/issue-40', 'ralph/issue-40-issue-40', false],
    ['/tmp/worktrees/issue-44', 'ralph/issue-44-issue-44', true],
  ]);
  const reloaded = createJobStore(directory);
  assert.equal(reloaded.load(40).workspaceState, 'removed');
  assert.equal(reloaded.load(41).workspaceState, 'prepared');
  assert.equal(reloaded.load(42).workspaceState, 'prepared');
  assert.equal(reloaded.load(44).workspaceState, 'removed');
  assert.ok(lines.some(line => /skipped workspace cleanup for issue #42: .*already owned by running process 4242/.test(line)));
  liveLock.release();
});

test('records a refused terminal cleanup without aborting the run', async () => {
  const store = temporaryStore();
  saveJob(store, 45, { status: 'needs_planning', terminal: true, terminalState: 'needs_planning', workspaceState: 'prepared' });
  const lines = [];
  await runAutopilot(['--project', 'demo'], enabledDependencies(store, {
    discoverReadyIssues: async () => [],
    cleanupIssueWorkspace: async () => { throw new Error('Workspace cleanup refused: worktree path is the main project checkout'); },
    write: line => lines.push(line),
  }));
  const job = createJobStore(store.directory).load(45);
  assert.equal(job.workspaceState, 'prepared');
  assert.equal(job.failures.at(-1).phase, 'cleanup');
  assert.match(job.failures.at(-1).message, /main project checkout/);
  assert.ok(lines.some(line => /unable to clean workspace for issue #45/.test(line)));
});

test('dry runs never clean terminal workspaces', async () => {
  const store = temporaryStore();
  saveJob(store, 46, { status: 'needs_planning', terminal: true, terminalState: 'needs_planning', workspaceState: 'prepared' });
  let cleaned = false;
  await runAutopilot(['--project', 'demo', '--dry-run'], enabledDependencies(store, {
    discoverReadyIssues: async () => [],
    cleanupIssueWorkspace: async () => { cleaned = true; },
  }));
  assert.equal(cleaned, false);
  assert.equal(createJobStore(store.directory).load(46).workspaceState, 'prepared');
});
