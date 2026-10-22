'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { synchronizeIssueBranch } = require('../src/autopilot-integration');
const { prepareIssueWorkspace } = require('../src/autopilot-workspace');
const { createJob, createJobStore, recordDelivery, recordPullRequest } = require('../src/autopilot-state');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t, conflict = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin');
  git(root, 'init', '--bare', '--initial-branch=main', origin);
  const checkout = path.join(root, 'checkout');
  git(root, 'clone', origin, checkout);
  git(checkout, 'config', 'user.name', 'Test'); git(checkout, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ scripts: { test: 'node base.js' } }, null, 2));
  fs.writeFileSync(path.join(checkout, 'base.js'), 'console.log("base")');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-m', 'base'); git(checkout, 'push', 'origin', 'main');
  const project = { repo: 'example/repo', checkout, worktreeRoot: path.join(root, 'worktrees'), baseBranch: 'main', verification: 'npm test' };
  const issue = { number: 105, title: 'Second test', body: 'Preserve both tests.' };
  const workspace = await prepareIssueWorkspace(project, issue);
  fs.writeFileSync(path.join(workspace.worktreePath, 'second.js'), 'console.log("second")');
  if (conflict) fs.writeFileSync(path.join(workspace.worktreePath, 'package.json'), JSON.stringify({ scripts: { test: 'node base.js && node second.js' } }, null, 2));
  git(workspace.worktreePath, 'add', '.'); git(workspace.worktreePath, 'commit', '-m', 'second'); git(workspace.worktreePath, 'push', 'origin', workspace.branch);
  const oldHead = git(workspace.worktreePath, 'rev-parse', 'HEAD');
  const first = await prepareIssueWorkspace(project, { number: 104, title: 'First test' });
  fs.writeFileSync(path.join(first.worktreePath, 'first.js'), 'console.log("first")');
  if (conflict) fs.writeFileSync(path.join(first.worktreePath, 'package.json'), JSON.stringify({ scripts: { test: 'node base.js && node first.js' } }, null, 2));
  git(first.worktreePath, 'add', '.'); git(first.worktreePath, 'commit', '-m', 'first');
  git(first.worktreePath, 'push', 'origin', first.branch);
  git(checkout, 'merge', '--no-ff', '-m', 'Merge first independent issue', first.branch);
  git(checkout, 'push', 'origin', 'main');
  const target = git(checkout, 'rev-parse', 'HEAD');
  const store = createJobStore(path.join(root, 'state'));
  const job = createJob({ projectName: 'demo', repo: project.repo, issue, ...workspace, now: store.now });
  job.status = 'awaiting_ci'; recordDelivery(job, { commit: oldHead }); recordPullRequest(job, { number: 117, url: 'https://example/117' }); store.save(job);
  const options = { observePullRequest: async () => ({ number: 117, state: 'OPEN', isCrossRepository: false, headRefName: workspace.branch, headRefOid: git(origin, 'rev-parse', `refs/heads/${workspace.branch}`), baseRefName: 'main' }) };
  return { project, issue, workspace, job, store, options, oldHead, target, origin };
}
test('clean divergence creates a normal merge, verifies exact head and resumes without another commit', async t => {
  const f = await fixture(t);
  await synchronizeIssueBranch(f, f.options);
  const head = f.job.delivery.commit;
  assert.notEqual(head, f.oldHead);
  assert.equal(git(f.workspace.worktreePath, 'rev-parse', 'HEAD^1'), f.oldHead);
  assert.equal(git(f.workspace.worktreePath, 'rev-parse', 'HEAD^2'), f.target);
  assert.equal(f.job.verification.commit, head);
  assert.equal(f.job.verification.passed, true);
  assert.equal(f.job.integration.targetSha, f.target);
  f.job = f.store.load(105);
  await synchronizeIssueBranch(f, f.options);
  assert.equal(f.job.delivery.commit, head);
  assert.equal(f.job.integrationHistory.length, 1);
});
test('safe package script collision carries stages to bounded resolver and preserves both commands', async t => {
  const f = await fixture(t, true);
  let calls = 0;
  await synchronizeIssueBranch(f, { ...f.options, resolveConflict: async context => {
    calls++;
    assert.match(context.stages, /package.json/);
    assert.equal(context.oldHead, f.oldHead);
    assert.equal(context.targetSha, f.target);
    fs.writeFileSync(path.join(f.workspace.worktreePath, 'package.json'), JSON.stringify({ scripts: { test: 'node base.js && node first.js && node second.js' } }));
    git(f.workspace.worktreePath, 'add', 'package.json');
    return { status: 'passed' };
  } });
  assert.equal(calls, 1);
  const script = JSON.parse(fs.readFileSync(path.join(f.workspace.worktreePath, 'package.json'), 'utf8')).scripts.test;
  assert.equal(script, 'node base.js && node first.js && node second.js');
  assert.equal(f.job.verification.passed, true);
  assert.equal(git(f.workspace.worktreePath, 'ls-files', '-u'), '');
});
test('ambiguous unresolved conflict fails closed and preserves the published head', async t => {
  const f = await fixture(t, true);
  await assert.rejects(synchronizeIssueBranch(f, { ...f.options, resolveConflict: async () => ({ status: 'needs_planning' }) }), /resolution/);
  assert.equal(git(f.origin, 'rev-parse', `refs/heads/${f.workspace.branch}`), f.oldHead);
  assert.equal(f.job.integrationHistory[0].outcome, 'escalated');
});

for (const boundary of ['merge commit', 'verifier completion', 'push intent', 'push completion', 'final checkpoint']) {
  test(`reload recovers ${boundary} without another merge, completed verifier or push`, async t => {
    const f = await fixture(t);
    const durable = f.store;
    let crashed = false, verifications = 0, pushes = 0;
    const native = require('node:child_process').execFile;
    const options = { ...f.options,
      execFile: (file, args, opts, callback) => {
        assert.equal(args.includes('--force'), false);
        assert.equal(args[0] === 'rebase', false);
        if (args[0] === 'push') pushes++;
        return native(file, args, opts, callback);
      },
      runVerification: async (...args) => { verifications++; return require('../src/verifier').runVerification(...args); },
    };
    f.store = { ...durable, save: job => {
      durable.save(job);
      const active = job.integrationActive;
      const hit = boundary === 'merge commit' ? active?.phase === 'commit' && active.logs.some(log => log.command?.[1] === 'commit')
        : boundary === 'verifier completion' ? Boolean(active?.verifier)
        : boundary === 'push intent' ? active?.push?.status === 'intent'
        : boundary === 'push completion' ? active?.push?.status === 'pushed'
        : job.integrationHistory?.length === 1;
      if (!crashed && hit) { crashed = true; throw new Error('simulated supervisor loss'); }
    } };
    await assert.rejects(synchronizeIssueBranch(f, options), /simulated supervisor loss/);
    assert.equal(crashed, true);
    f.store = createJobStore(durable.directory); f.job = f.store.load(105);
    await synchronizeIssueBranch(f, options);
    assert.equal(f.job.integrationHistory.length, 1);
    assert.equal(f.job.integrationHistory[0].outcome, 'integrated');
    assert.equal(verifications, 1);
    assert.equal(pushes, 1);
    assert.equal(git(f.workspace.worktreePath, 'rev-parse', 'HEAD^1'), f.oldHead);
  });
}

test('one-shot runner invalidates PASS when target advances, then requires new CI and Claude review', async t => {
  const f = await fixture(t);
  const { run } = require('../src/autopilot');
  Object.assign(f.project, { enabled: true, reviewPolicy: 'always', autoMerge: true, readyLabel: 'ready', worker: 'codex' });
  const reviews = [], ciHeads = [];
  let merges = 0;
  const tick = () => run(['--project', 'demo'], {
    jobStore: createJobStore(f.store.directory), loadProjectConfig: () => f.project,
    discoverReadyIssues: async () => [f.issue], write: () => {},
    readRepositoryInstructions: async () => [], prepareRepositoryEnvironment: async () => ({}),
    observePullRequest: f.options.observePullRequest,
    observePullRequestCi: async (_project, pr) => {
      ciHeads.push(pr.commit);
      return { state: 'green', headCommit: pr.commit, prNumber: pr.number };
    },
    independentReview: async input => {
      reviews.push(input.headCommit);
      if (reviews.length === 1) {
        fs.writeFileSync(path.join(f.project.checkout, 'third.js'), 'console.log("third")');
        git(f.project.checkout, 'add', '.'); git(f.project.checkout, 'commit', '-m', 'target advances after PASS');
        git(f.project.checkout, 'push', 'origin', 'main');
      }
      return { reviewer: 'claude:sonnet', verdict: 'PASS', findings: [], commit: input.headCommit };
    },
    mergePullRequest: async (_project, pr) => {
      merges++;
      const saved = f.store.load(105);
      assert.equal(saved.integration.targetSha, git(f.origin, 'rev-parse', 'main'));
      assert.equal(pr.headCommit, saved.verification.commit);
      assert.throws(() => f.store.acquireTarget(f.project.repo, 'main'), /owned/);
      return { mergeCommit: 'merged-fixture-sha' };
    },
    reconcileIssueClosure: async () => ({}),
    createRalphTaskService: () => { throw new Error('unexpected worker'); },
  });
  await tick(); // sync before any CI or review
  assert.equal(ciHeads.length, 0);
  await tick(); // PASS becomes historical; re-integrate the advanced target
  assert.equal(merges, 0);
  const middle = f.store.load(105);
  assert.equal(middle.reviewHistory.length, 1);
  assert.equal(middle.review, null);
  await tick();
  const final = f.store.load(105);
  assert.equal(final.status, 'merged');
  assert.equal(merges, 1);
  assert.equal(reviews.length, 2);
  assert.notEqual(reviews[0], reviews[1]);
  assert.deepEqual(ciHeads, reviews);
  assert.equal(final.reviewHistory.length, 2);
});

test('target lock serializes independent issues and is released for later passes', async t => {
  const f = await fixture(t);
  const secondStore = createJobStore(f.store.directory);
  const lock = f.store.acquireTarget(f.project.repo, 'main');
  assert.throws(() => secondStore.acquireTarget(f.project.repo, 'main'), /owned/);
  const other = secondStore.acquireTarget(f.project.repo, 'release'); other.release();
  lock.release();
  secondStore.acquireTarget(f.project.repo, 'main').release();
});

test('red integrated verifier gets one repair and fresh exact-commit verification', async t => {
  const f = await fixture(t);
  let verifications = 0, repairs = 0;
  const options = { ...f.options,
    runVerification: async () => ({ passed: ++verifications > 1, exitCode: verifications > 1 ? 0 : 1,
      timedOut: false, stdout: 'complete verifier stdout', stderr: 'complete verifier stderr' }),
    resolveConflict: async context => {
      assert.equal(context.kind, 'repair'); repairs++;
      fs.writeFileSync(path.join(context.cwd, 'repair.js'), 'fixed');
      return { status: 'passed' };
    },
  };
  assert.equal((await synchronizeIssueBranch(f, options)).pending, true);
  assert.equal(git(f.origin, 'rev-parse', `refs/heads/${f.job.branch}`), f.oldHead);
  f.job = f.store.load(105);
  await synchronizeIssueBranch(f, options);
  assert.equal(repairs, 1); assert.equal(verifications, 2);
  assert.equal(f.job.verification.commit, f.job.delivery.commit);
  assert.equal(f.job.integrationHistory[0].failedVerification.result.stderr, 'complete verifier stderr');
});

test('interrupted conflict agent is never invoked twice after reload', async t => {
  const f = await fixture(t, true);
  let calls = 0;
  const options = { ...f.options, resolveConflict: async () => { calls++; throw new Error('agent process lost'); } };
  await assert.rejects(synchronizeIssueBranch(f, options), /agent process lost/);
  f.job = f.store.load(105);
  await assert.rejects(synchronizeIssueBranch(f, options), /interrupted or budget exhausted/);
  assert.equal(calls, 1);
  assert.equal(f.job.integrationHistory[0].workers.length, 1);
});

test('unexpected PR head refuses before any merge or agent invocation', async t => {
  const f = await fixture(t);
  await assert.rejects(synchronizeIssueBranch(f, { ...f.options, observePullRequest: async () => ({
    ...(await f.options.observePullRequest()), headRefOid: 'a'.repeat(40),
  }) }), /unexpected PR head/);
  assert.equal(git(f.workspace.worktreePath, 'rev-parse', 'HEAD'), f.oldHead);
});

test('agent edits to another worktree or protected configuration refuse publication', async t => {
  for (const protectedEdit of [false, true]) {
    const f = await fixture(t, true);
    if (!protectedEdit) fs.writeFileSync(path.join(f.project.checkout, 'unrelated'), 'original owner content');
    await assert.rejects(synchronizeIssueBranch(f, { ...f.options, resolveConflict: async () => {
      if (protectedEdit) {
        fs.writeFileSync(path.join(f.workspace.worktreePath, 'AGENTS.md'), 'unsafe policy change');
      } else fs.writeFileSync(path.join(f.project.checkout, 'unrelated'), 'unrelated worktree edit');
      return { status: 'passed' };
    } }), protectedEdit ? /protected/ : /another worktree/);
    assert.equal(git(f.origin, 'rev-parse', `refs/heads/${f.job.branch}`), f.oldHead);
  }
});

test('total synchronization budget refuses another target advance without discarding passing work', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) {
    await synchronizeIssueBranch(f, f.options);
    fs.writeFileSync(path.join(f.project.checkout, `advance-${i}`), 'target');
    git(f.project.checkout, 'add', '.'); git(f.project.checkout, 'commit', '-m', `advance ${i}`);
    git(f.project.checkout, 'push', 'origin', 'main');
  }
  const published = f.job.delivery.commit;
  await assert.rejects(synchronizeIssueBranch(f, f.options), /total synchronization limit/);
  assert.equal(git(f.origin, 'rev-parse', `refs/heads/${f.job.branch}`), published);
  assert.equal(f.job.integrationHistory.length, 3);
});

test('fork identity and corrupt durable transitions fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(synchronizeIssueBranch(f, { ...f.options, observePullRequest: async () => ({
    ...(await f.options.observePullRequest()), isCrossRepository: true,
  }) }), /PR identity mismatch/);
  assert.throws(() => f.store.save({ ...f.job, integrationActive: { phase: 'push', finalHead: f.oldHead } }), /invalid integration state/);
  assert.equal(git(f.origin, 'rev-parse', `refs/heads/${f.job.branch}`), f.oldHead);
});

test('one-shot runner blocks green CI without explicit exact-SHA evidence', async t => {
  const f = await fixture(t);
  await synchronizeIssueBranch(f, f.options);
  let reviews = 0;
  const result = await require('../src/autopilot').run(['--project', 'demo'], {
    jobStore: f.store,
    loadProjectConfig: () => ({ ...f.project, enabled: true, reviewPolicy: 'always', autoMerge: true }),
    discoverReadyIssues: async () => [f.issue], write: () => {},
    observePullRequest: f.options.observePullRequest,
    observePullRequestCi: async () => ({ state: 'green' }),
    independentReview: async () => { reviews++; },
  });
  assert.equal(reviews, 0);
  assert.equal(result.job.terminalState, 'ready_for_human');
});

test('one-shot conflict resolution uses the authorized integration worker instead of replaying implementation', async t => {
  const f = await fixture(t, true);
  let workers = 0;
  const result = await require('../src/autopilot').run(['--project', 'demo'], {
    jobStore: f.store,
    loadProjectConfig: () => ({ ...f.project, enabled: true, reviewPolicy: 'always' }),
    discoverReadyIssues: async () => [f.issue], write: () => {},
    observePullRequest: f.options.observePullRequest,
    readRepositoryInstructions: async () => [], prepareRepositoryEnvironment: async () => ({}),
    createRalphTaskService: () => { throw new Error('must not replay the implementation child'); },
    createIntegrationTaskService: () => ({ run: async (cwd, task) => {
      workers++;
      assert.equal(task.maxAttempts, 1);
      assert.match(task.goal, /Preserve both tests/);
      assert.match(task.goal, new RegExp(f.target));
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node base.js && node first.js && node second.js' } }));
      git(cwd, 'add', 'package.json');
      return { status: 'needs_planning', attempts: [{ status: 'failed', worker: { exitCode: 0 },
        verification: { passed: false, stderr: 'Environment not prepared yet' } }] };
    } }),
  });
  assert.equal(workers, 1);
  assert.equal(result.job.integrationHistory[0].outcome, 'integrated');
  assert.equal(result.job.integrationHistory[0].workers[0].result.taskResult.attempts[0].verification.stderr,
    'Environment not prepared yet');
});

test('new untracked resolver files with conflict markers cannot enter the merge commit', async t => {
  const f = await fixture(t, true);
  await assert.rejects(synchronizeIssueBranch(f, { ...f.options, resolveConflict: async ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node base.js && node first.js && node second.js' } }));
    git(cwd, 'add', 'package.json');
    fs.writeFileSync(path.join(cwd, 'new.js'), '<<<<<<< ours\nunresolved\n=======\nother\n>>>>>>> theirs\n');
    return { status: 'passed' };
  } }), /conflict markers in new.js/);
  assert.equal(git(f.origin, 'rev-parse', `refs/heads/${f.job.branch}`), f.oldHead);
});

test('reload after repair commit preserves the failed verifier and never repeats the repair worker', async t => {
  const f = await fixture(t);
  const durable = f.store;
  let crashed = false, workers = 0, verifications = 0;
  f.store = { ...durable, save: job => {
    durable.save(job);
    if (!crashed && job.integrationActive?.phase === 'repair_commit'
      && job.integrationActive.logs.filter(log => log.command?.[1] === 'commit').length === 2) {
      crashed = true;
      throw new Error('lost supervisor after repair commit');
    }
  } };
  const options = { ...f.options,
    runVerification: async () => ({ passed: ++verifications > 1, exitCode: verifications > 1 ? 0 : 1,
      timedOut: false, stdout: 'raw test output', stderr: 'original integration failure' }),
    resolveConflict: async ({ cwd }) => {
      workers++;
      fs.writeFileSync(path.join(cwd, 'repair.js'), 'fixed');
      return { status: 'passed' };
    },
  };
  await assert.rejects(synchronizeIssueBranch(f, options), /lost supervisor/);
  f.store = createJobStore(durable.directory); f.job = f.store.load(105);
  assert.equal((await synchronizeIssueBranch(f, options)).pending, true);
  await synchronizeIssueBranch(f, options);
  assert.equal(workers, 1);
  assert.equal(verifications, 2);
  assert.equal(f.job.integrationHistory[0].failedVerification.result.stderr, 'original integration failure');
  assert.equal(f.job.verification.commit, f.job.delivery.commit);
});

test('prepared project verification command is used and recorded for the exact integrated commit', async t => {
  const f = await fixture(t);
  let command;
  await synchronizeIssueBranch(f, { ...f.options,
    prepareEnvironment: async () => ({ verification: 'node base.js' }),
    runVerification: async (...args) => {
      command = args[1];
      return require('../src/verifier').runVerification(...args);
    },
  });
  assert.equal(command, 'node base.js');
  assert.equal(f.job.verification.command, command);
  assert.equal(f.job.verification.commit, f.job.delivery.commit);
});

test('a failed resolver process cannot become successful through a task-service PASS', async t => {
  const f = await fixture(t, true);
  await assert.rejects(require('../src/autopilot').run(['--project', 'demo'], {
    jobStore: f.store,
    loadProjectConfig: () => ({ ...f.project, enabled: true, reviewPolicy: 'always' }),
    discoverReadyIssues: async () => [f.issue], write: () => {},
    observePullRequest: f.options.observePullRequest,
    readRepositoryInstructions: async () => [],
    createIntegrationTaskService: () => ({ run: async () => ({ status: 'passed',
      attempts: [{ status: 'passed', worker: { exitCode: 1 } }] }) }),
  }), /resolution did not pass/);
  const saved = f.store.load(105);
  assert.equal(saved.workspaceState, 'integration_retained');
  assert.equal(saved.integrationHistory[0].outcome, 'escalated');
  assert.equal(git(f.origin, 'rev-parse', `refs/heads/${f.job.branch}`), f.oldHead);
});
