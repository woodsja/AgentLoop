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
      const available = f.store.acquireTarget(f.project.repo, 'main'); available.release();
      ciHeads.push(pr.commit);
      return { state: 'green', headCommit: pr.commit, prNumber: pr.number };
    },
    independentReview: async input => {
      const available = f.store.acquireTarget(f.project.repo, 'main'); available.release();
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

test('resolver-attributed edits outside its worktree refuse publication', async t => {
  const f = await fixture(t, true);
  await assert.rejects(synchronizeIssueBranch(f, { ...f.options, resolveConflict: async () => ({
    status: 'passed', taskResult: { attempts: [{ worker: { stdout: JSON.stringify({
      type: 'item.completed', item: { type: 'file_change', changes: [
        { path: path.join(f.project.checkout, 'unrelated'), kind: 'update' },
      ] },
    }) } }] },
  }) }), /outside.*worktree/);
});

test('protected resolver configuration edits refuse publication', async t => {
  const f = await fixture(t, true);
  await assert.rejects(synchronizeIssueBranch(f, { ...f.options, resolveConflict: async () => {
    fs.writeFileSync(path.join(f.workspace.worktreePath, 'AGENTS.md'), 'unsafe policy change');
    return { status: 'passed' };
  } }), /protected/);
});

test('another authorized worktree can change while conflict resolution is running', async t => {
  const f = await fixture(t, true);
  const other = await prepareIssueWorkspace(f.project, { number: 106, title: 'Concurrent work' });
  let resume;
  const waiting = new Promise(resolve => { resume = resolve; });
  const integration = synchronizeIssueBranch(f, { ...f.options, resolveConflict: async ({ cwd }) => {
    resume();
    await edited;
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: {
      test: 'node base.js && node first.js && node second.js',
    } }));
    git(cwd, 'add', 'package.json');
    return { status: 'passed' };
  } });
  let finishEdit;
  const edited = new Promise(resolve => { finishEdit = resolve; });
  await waiting;
  fs.writeFileSync(path.join(other.worktreePath, 'concurrent.js'), 'authorized concurrent edit');
  git(other.worktreePath, 'add', '.'); git(other.worktreePath, 'commit', '-m', 'Concurrent worker');
  fs.writeFileSync(path.join(other.worktreePath, 'untracked'), 'still working');
  finishEdit();
  await integration;
  assert.equal(f.store.load(105).integrationHistory[0].outcome, 'integrated');
  assert.equal(fs.readFileSync(path.join(other.worktreePath, 'untracked'), 'utf8'), 'still working');
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

for (const timeoutMs of [undefined, 15 * 60 * 1000]) {
  test(`one-shot integration inherits verification timeout ${timeoutMs}`, async t => {
    const f = await fixture(t);
    const { run } = require('../src/autopilot');
    let verified = false;
    await run(['--project', 'demo'], {
      jobStore: f.store, loadProjectConfig: () => ({ ...f.project, enabled: true }),
      discoverReadyIssues: async () => [f.issue], write: () => {},
      readRepositoryInstructions: async () => [], prepareRepositoryEnvironment: async () => ({}),
      observePullRequest: f.options.observePullRequest,
      ralphOptions: { verificationTimeoutMs: timeoutMs },
      runVerification: async (cwd, command, timeout) => {
        verified = true;
        assert.equal(cwd, f.workspace.worktreePath);
        assert.equal(command, 'npm test');
        assert.equal(timeout, timeoutMs);
        return { passed: true, exitCode: 0, timedOut: false, stdout: '', stderr: '' };
      },
    });
    assert.equal(verified, true);
  });
}

test('target contention defers durably without consuming any job attempts', async t => {
  const f = await fixture(t);
  const { run } = require('../src/autopilot');
  const before = f.store.load(105);
  const lock = f.store.acquireTarget(f.project.repo, 'main');
  try {
    const result = await run(['--project', 'demo'], {
      jobStore: createJobStore(f.store.directory),
      loadProjectConfig: () => ({ ...f.project, enabled: true }),
      discoverReadyIssues: async () => [f.issue], write: () => {},
      synchronizeIssueBranch: async () => { throw new Error('must defer before integration'); },
    });
    assert.equal(result.outcome.status, 'deferred');
    assert.deepEqual(f.store.load(105), before);
  } finally { lock.release(); }
});

test('contention after Claude PASS preserves approval and resumes without another review', async t => {
  const f = await fixture(t);
  await synchronizeIssueBranch(f, f.options);
  const { run } = require('../src/autopilot');
  let competingLock, reviews = 0, merges = 0;
  const dependencies = {
    jobStore: f.store,
    loadProjectConfig: () => ({ ...f.project, enabled: true, reviewPolicy: 'always', autoMerge: true }),
    discoverReadyIssues: async () => [f.issue], write: () => {},
    observePullRequest: f.options.observePullRequest,
    observePullRequestCi: async (_project, pr) => ({ state: 'green', headCommit: pr.commit, prNumber: pr.number }),
    independentReview: async ({ headCommit }) => {
      reviews++;
      competingLock = createJobStore(f.store.directory).acquireTarget(f.project.repo, 'main');
      return { reviewer: 'claude:sonnet', verdict: 'PASS', findings: [], commit: headCommit };
    },
    mergePullRequest: async () => {
      merges++;
      assert.throws(() => f.store.acquireTarget(f.project.repo, 'main'), { code: 'AUTOPILOT_TARGET_BUSY' });
      return { mergeCommit: 'merged-fixture-sha' };
    },
    reconcileIssueClosure: async () => ({}),
  };
  try {
    const result = await run(['--project', 'demo'], dependencies);
    assert.equal(result.outcome.status, 'deferred');
    const deferred = f.store.load(105);
    assert.equal(deferred.status, 'awaiting_ci');
    assert.equal(deferred.review.verdict, 'PASS');
    assert.equal(deferred.reviewAttempts, 1);
    assert.deepEqual(deferred.failures, []);
    assert.equal(merges, 0);
  } finally { competingLock?.release(); }
  await run(['--project', 'demo'], { ...dependencies, jobStore: createJobStore(f.store.directory) });
  assert.equal(f.store.load(105).status, 'merged');
  assert.equal(reviews, 1);
  assert.equal(merges, 1);
});

// Exercise each one-shot pass through a freshly loaded durable job and real Git.
function retryRunner(f, execute, clock, overrides = {}) {
  Object.assign(f.project, { enabled: true, reviewPolicy: 'always', autoMerge: true, readyLabel: 'ready', worker: 'codex' });
  return () => require('../src/autopilot').run(['--project', 'demo'], {
    jobStore: createJobStore(f.store.directory, { now: () => new Date(clock.time).toISOString() }),
    loadProjectConfig: () => f.project, discoverReadyIssues: async () => [f.issue], write: () => {},
    execFile: execute, observePullRequest: f.options.observePullRequest,
    observePullRequestCi: async (_p, pr) => ({ state: clock.green ? 'green' : 'pending', headCommit: pr.commit, prNumber: pr.number }),
    independentReview: async ({ headCommit }) => ({ reviewer: 'claude:fixture', verdict: 'PASS', findings: [], commit: headCommit }),
    mergePullRequest: async () => ({ mergeCommit: 'merged-fixture-sha' }), reconcileIssueClosure: async () => ({}),
    createRalphTaskService: () => { throw new Error('infrastructure retry started worker'); },
    ...overrides,
  });
}
function transportAdapter(match, failure) {
  const native = require('node:child_process').execFile;
  return (file, args, options, cb) => {
    if (file === 'git' && match(args)) return failure(file, args, options, cb, native);
    return native(file, args, options, cb);
  };
}
for (const operation of ['fetch', 'ls-remote']) {
  test(`one-shot ${operation} transport retry survives reload and respects deadline without spending model budgets`, async t => {
    const f = await fixture(t), clock = { time: Date.now() };
    let calls = 0;
    const tick = retryRunner(f, transportAdapter(args => args[0] === operation, (_file, _args, _opts, cb) => {
      calls++;
      cb(Object.assign(new Error(`Command failed: git ${operation} refs/heads/ralph/issue-401-authentication`), { code: 128 }), '', 'fatal: Could not resolve host: github.com\nraw original failure');
    }), clock);
    const first = await tick();
    assert.equal(first.outcome.status, 'deferred');
    const saved = f.store.load(105);
    assert.equal(saved.terminal, false);
    assert.equal(saved.runs, 0); assert.equal(saved.reviewAttempts, 0);
    await tick(); assert.equal(calls, 1);
    clock.time += 60000;
    const recovered = retryRunner(f, require('node:child_process').execFile, clock);
    await recovered();
    assert.equal(f.store.load(105).integrationHistory[0].outcome, 'integrated');
    assert.deepEqual(f.store.load(105).gitRetries, {});
    const raw = fs.readFileSync(f.store.load(105).executionJournal.file, 'utf8');
    assert.match(raw, /raw original failure/);
  });
}
test('three matching failures exhaust across restarts; auth refuses immediately', async t => {
  for (const auth of [false, true]) {
    const f = await fixture(t), clock = { time: Date.now() };
    let calls = 0;
    const tick = retryRunner(f, transportAdapter(args => args[0] === 'fetch', (_file, _args, _opts, cb) => {
      calls++; cb(Object.assign(new Error('git failed'), { code: 128 }), '', auth ? 'fatal: Authentication failed' : `Connection timed out: failure ${calls}`);
    }), clock);
    if (auth) await assert.rejects(tick(), /Authentication/);
    else {
      await tick(); await tick(); assert.equal(calls, 1);
      clock.time += 60000; await tick(); await tick(); assert.equal(calls, 2);
      clock.time += 60000; await assert.rejects(tick(), /exhausted/);
    }
    const saved = f.store.load(105);
    assert.equal(saved.terminalState, 'ready_for_human');
    assert.equal(calls, auth ? 1 : 3);
    assert.equal(saved.runs, 0); assert.equal(saved.reviewAttempts, 0);
    const raw = fs.readFileSync(saved.executionJournal.file, 'utf8');
    if (!auth) for (let n = 1; n <= 3; n++) assert.match(raw, new RegExp(`failure ${n}`));
  }
});
test('500 pending CI and target polls keep bounded summaries and retain green/base transitions and raw evidence', async t => {
  const f = await fixture(t), clock = { time: Date.now() };
  const tick = retryRunner(f, require('node:child_process').execFile, clock);
  await tick(); await tick();
  const before = fs.statSync(f.store.jobPath(105)).size;
  for (let n = 0; n < 500; n++) { clock.time += 1000; await tick(); }
  const saved = f.store.load(105);
  assert.ok(fs.statSync(f.store.jobPath(105)).size < before + 2000);
  assert.equal(saved.integrationPolling.channels.ci.pollCount, 501);
  assert.equal(saved.integrationPolling.channels.ci.current.state, 'pending');
  assert.equal(saved.integrationPolling.channels.ci.lastCheckedAt, new Date(clock.time).toISOString());
  assert.ok(saved.integrationPolling.channels.target.pollCount >= 500);
  assert.ok(saved.integrationPolling.transitions.length <= 20);
  const raw = fs.readFileSync(saved.executionJournal.file, 'utf8');
  assert.match(raw, /refs\/remotes\/origin\/main/);
  const events = raw.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.event === 'integration-observation' && event.channel === 'ci').length, 501);
  fs.writeFileSync(path.join(f.project.checkout, 'later.js'), 'console.log("later")');
  git(f.project.checkout, 'add', '.'); git(f.project.checkout, 'commit', '-m', 'base advances after long pending CI');
  git(f.project.checkout, 'push', 'origin', 'main');
  clock.time += 1000; await tick();
  const advanced = f.store.load(105);
  assert.equal(advanced.integration.targetSha, git(f.origin, 'rev-parse', 'main'));
  assert.ok(advanced.integrationPolling.transitions.some(e => e.current.targetSha === advanced.integration.targetSha));
  clock.green = true; clock.time += 1000; await tick();
  assert.equal(f.store.load(105).status, 'merged');
  assert.ok(f.store.load(105).integrationPolling.transitions.some(e => e.current.state === 'green'));
  const complete = JSON.parse(fs.readFileSync(f.store.jobPath(105), 'utf8'));
  for (const damage of [
    job => { job.integrationPolling.transitions = Array(21).fill(saved.integrationPolling.transitions[0]); },
    job => { job.integrationPolling.channels.ci.pollCount = -1; },
    job => { job.integrationPolling.channels.ci.current.state = 'invented'; },
    job => { job.integrationPolling.channels.ci.lastCheckedAt = ' '.repeat(1000) + new Date(clock.time).toISOString(); },
  ]) {
    const damaged = structuredClone(complete); damage(damaged);
    fs.writeFileSync(f.store.jobPath(105), JSON.stringify(damaged));
    assert.throws(() => f.store.load(105), /invalid integration polling/);
  }
  for (const damage of [
    job => { job.integrationHistory[0].logs = Array(129).fill(job.integrationHistory[0].logs[0]); },
    job => { job.integrationHistory[0].logs = [null]; },
    job => { job.integrationGateObservations = Array(21).fill({ at: new Date(clock.time).toISOString() }); },
    job => { job.gitRetries = { ['a'.repeat(64)]: { count: 4, operation: 'fetch', diagnostic: 'invalid',
      lastFailureAt: new Date(clock.time).toISOString(), nextEligibleAt: new Date(clock.time).toISOString() } }; },
  ]) {
    const damaged = structuredClone(complete); damage(damaged);
    fs.writeFileSync(f.store.jobPath(105), JSON.stringify(damaged));
    assert.throws(() => f.store.load(105), /invalid (integration|Git retry)/);
  }
  assert.equal(fs.readFileSync(complete.executionJournal.file, 'utf8').startsWith(raw), true);
});

test('uncertain completed push reconciles read-only and preserves pre-push read retry evidence', async t => {
  const f = await fixture(t), clock = { time: Date.now() };
  let pushes = 0, reads = 0;
  const execute = transportAdapter(args => ['push', 'ls-remote'].includes(args[0]), (file, args, opts, cb, native) => {
    if (args[0] === 'ls-remote' && ++reads === 1) {
      return cb(Object.assign(new Error('read reset'), { code: 128 }), '', 'Connection reset by peer: pre-push read');
    }
    if (args[0] === 'push') {
      pushes++;
      assert.ok(!args.some(arg => /force|^\+/.test(arg)));
      return native(file, args, opts, (error, stdout, stderr) => {
        assert.ifError(error);
        cb(Object.assign(new Error('lost push response'), { code: 'ECONNRESET' }), stdout, stderr + '\nConnection reset by peer: push response');
      });
    }
    return native(file, args, opts, cb);
  });
  const tick = retryRunner(f, execute, clock);
  await tick(); assert.equal(pushes, 0);
  clock.time += 60000; await tick(); assert.equal(pushes, 1);
  const finalHead = git(f.origin, 'rev-parse', f.job.branch);
  clock.time += 60000; await tick();
  assert.equal(pushes, 1);
  const saved = f.store.load(105);
  assert.equal(saved.delivery.commit, finalHead);
  assert.deepEqual(saved.gitRetries, {});
  assert.equal(saved.reviewAttempts, 0);
  assert.match(fs.readFileSync(saved.executionJournal.file, 'utf8'), /integration-push-reconciled/);
});
test('final target ls-remote transport failure defers with retained exact PASS and no extra review', async t => {
  const f = await fixture(t), clock = { time: Date.now(), green: true };
  let reads = 0;
  const tick = retryRunner(f, transportAdapter(args => args[0] === 'ls-remote' && args.at(-1) === 'refs/heads/main', (file, args, opts, cb, native) => {
    if (++reads === 1) return cb(Object.assign(new Error('unavailable'), { code: 128 }), '', 'Could not resolve host: github.com');
    return native(file, args, opts, cb);
  }), clock);
  await tick(); await tick();
  assert.equal(f.store.load(105).terminal, false);
  assert.equal(f.store.load(105).review.verdict, 'PASS');
  assert.equal(f.store.load(105).reviewAttempts, 1);
  await tick(); assert.equal(reads, 1);
  clock.time += 60000; await tick();
  assert.equal(f.store.load(105).status, 'merged');
  assert.equal(f.store.load(105).reviewAttempts, 1);
});

test('a successful fetch clears only its own streak while a pre-push read remains deferred', async t => {
  const f = await fixture(t), clock = { time: Date.now() };
  let fetches = 0;
  const tick = retryRunner(f, transportAdapter(args => ['fetch', 'ls-remote'].includes(args[0]), (file, args, opts, cb, native) => {
    if (args[0] === 'fetch' && ++fetches === 2) return native(file, args, opts, cb);
    return cb(Object.assign(new Error('network failure'), { code: 128 }), '', 'Connection timed out');
  }), clock);
  await tick();
  clock.time += 60000; await tick();
  const pending = f.store.load(105);
  assert.equal(Object.values(pending.gitRetries).length, 1);
  assert.equal(Object.values(pending.gitRetries)[0].operation, 'ls-remote');
  // Fetch is no longer needed during the active push phase. Repeated passes
  // must leave that read's budget untouched and the recent inline logs bounded.
  const size = fs.statSync(f.store.jobPath(105)).size;
  // Four successful reads per deferred pass exceed the 128-record window.
  for (let n = 0; n < 40; n++) await tick();
  const saved = f.store.load(105);
  assert.equal(Object.values(saved.gitRetries)[0].count, 1);
  assert.ok(saved.integrationActive.logs.length <= 128);
  assert.ok(fs.statSync(f.store.jobPath(105)).size < size + 60000);
  assert.equal(saved.reviewAttempts, 0);
});

test('loss between the first Git result and its checkpoint cannot reset retry reservation', async t => {
  const f = await fixture(t), clock = { time: Date.now() };
  const store = createJobStore(f.store.directory, { now: () => new Date(clock.time).toISOString() });
  const append = store.appendIntegrationEvent;
  let lost = false, calls = 0;
  store.appendIntegrationEvent = (job, record) => {
    append(job, record);
    if (!lost && record.event === 'integration-git' && record.command[1] === 'fetch') {
      lost = true; throw new Error('supervisor lost after initial Git response');
    }
  };
  const adapter = transportAdapter(args => args[0] === 'fetch', (_file, _args, _opts, cb) => {
    calls++; cb(Object.assign(new Error('transport unavailable'), { code: 128 }), '', 'Connection timed out');
  });
  await assert.rejects(retryRunner(f, adapter, clock, { jobStore: store })(), /supervisor lost/);
  const pending = f.store.load(105);
  assert.equal(Object.values(pending.gitRetries)[0].count, 1);
  await retryRunner(f, adapter, clock)(); assert.equal(calls, 1);
  clock.time += 60000;
  await retryRunner(f, require('node:child_process').execFile, clock)();
  assert.equal(f.store.load(105).integrationHistory[0].outcome, 'integrated');
  assert.deepEqual(f.store.load(105).gitRetries, {});
});

for (const operation of ['worktree', 'rev-parse']) {
  test(`temporary ${operation} read process failure resumes at the real persisted run seam`, async t => {
    const f = await fixture(t), clock = { time: Date.now() };
    let calls = 0;
    const tick = retryRunner(f, transportAdapter(args => args[0] === operation, (_file, _args, _opts, cb) => {
      calls++; cb(Object.assign(new Error('spawn git EAGAIN'), { code: 'EAGAIN' }), '', '');
    }), clock);
    await tick(); await tick(); assert.equal(calls, 1);
    assert.equal(f.store.load(105).terminal, false);
    clock.time += 60000;
    await retryRunner(f, require('node:child_process').execFile, clock)();
    assert.equal(f.store.load(105).integrationHistory[0].outcome, 'integrated');
    assert.equal(f.store.load(105).runs, 0);
    assert.equal(f.store.load(105).reviewAttempts, 0);
  });
}

test('reattaching a removed delivery worktree retries its own fetch with persisted infrastructure budget', async t => {
  const f = await fixture(t), clock = { time: Date.now() };
  git(f.project.checkout, 'worktree', 'remove', f.workspace.worktreePath);
  let calls = 0;
  const tick = retryRunner(f, transportAdapter(args => args[0] === 'fetch' && args.at(-1) === 'main', (_file, _args, _opts, cb) => {
    calls++; cb(Object.assign(new Error('remote unavailable'), { code: 128 }), '', 'Connection timed out: workspace reattachment');
  }), clock);
  await tick(); await tick(); assert.equal(calls, 1);
  assert.equal(f.store.load(105).integrationActive.interruptions || 0, 0);
  clock.time += 60000;
  await retryRunner(f, require('node:child_process').execFile, clock)();
  assert.equal(f.store.load(105).integrationHistory[0].outcome, 'integrated');
  assert.equal(f.store.load(105).runs, 0);
  assert.deepEqual(f.store.load(105).gitRetries, {});
});

test('an unexplained push response is reconciled read-only and never authorizes a blind retry', async t => {
  for (const completed of [false, true]) {
    const f = await fixture(t), clock = { time: Date.now() };
    let pushes = 0;
    const tick = retryRunner(f, transportAdapter(args => args[0] === 'push', (file, args, opts, cb, native) => {
      pushes++;
      const lost = () => cb(Object.assign(new Error('response unavailable'), { code: 128 }), '', '');
      if (completed) return native(file, args, opts, error => { assert.ifError(error); lost(); });
      lost();
    }), clock);
    if (completed) {
      await tick();
      assert.equal(f.store.load(105).integrationHistory[0].outcome, 'integrated');
      assert.equal(f.store.load(105).delivery.commit, git(f.origin, 'rev-parse', f.job.branch));
    } else {
      await assert.rejects(tick(), /response unavailable/);
      assert.equal(f.store.load(105).terminalState, 'ready_for_human');
    }
    assert.equal(pushes, 1);
  }
});

test('malformed delivered or observed commit identities stop immediately without transport retries', async t => {
  for (const delivered of [false, true]) {
    const f = await fixture(t), clock = { time: Date.now() };
    if (delivered) { recordDelivery(f.job, { commit: 'malformed-sha' }); f.store.save(f.job); }
    let reads = 0;
    const tick = retryRunner(f, transportAdapter(args => args[0] === 'rev-parse', (_file, _args, _opts, cb) => {
      reads++; cb(null, 'malformed-sha\n', '');
    }), clock);
    await assert.rejects(tick(), /invalid (delivered|observed) commit SHA/);
    assert.equal(reads, delivered ? 0 : 1);
    assert.equal(f.store.load(105).terminalState, 'ready_for_human');
    assert.equal(f.store.load(105).runs, 0);
  }
});

test('one-shot persisted R1 preflights the incident diff at the real Node buffer boundary without spending another review', async t => {
  const f = await fixture(t);
  await synchronizeIssueBranch(f, f.options);
  const head = f.job.delivery.commit;
  const state = require('../src/autopilot-state');
  const oldAttempt = state.beginReviewAttempt(f.job, f.store.now, { reviewer: 'claude:sonnet', model: 'sonnet', policy: 'always', commit: f.oldHead });
  state.recordReview(f.job, { reviewer: 'claude:sonnet', verdict: 'NEEDS_CHANGES', commit: f.oldHead, policy: 'always', findings: 'Correct the original failure', attempt: oldAttempt }, f.store.now);
  f.store.save(f.job);
  const before = f.store.load(105);
  const native = require('../src/execution-log').execFile;
  const sourceFile = path.join(f.workspace.worktreePath, 'second.js');
  const originalSource = fs.readFileSync(sourceFile);
  fs.writeFileSync(sourceFile, 'x');
  const initialDiff = git(f.workspace.worktreePath, 'diff') + '\n';
  fs.writeFileSync(sourceFile, 'x'.repeat(1 + 258218 - Buffer.byteLength(initialDiff)));
  const incidentDiff = git(f.workspace.worktreePath, 'diff') + '\n';
  fs.writeFileSync(sourceFile, originalSource);
  assert.equal(Buffer.byteLength(incidentDiff), 258218);
  const diffFile = path.join(f.store.directory, 'incident.diff');
  fs.writeFileSync(diffFile, incidentDiff);
  let claudeCalls = 0, diffCalls = 0, sourceError;
  const review = require('../src/autopilot-review').createClaudeReviewAdapter({
    execFile(file, args, options, callback) {
      if (file === 'git') return native(file, args, options, callback);
      if (args[0] === 'issue') return callback(null, JSON.stringify({ ...f.issue, url: 'https://github.com/example/repo/issues/105' }));
      if (args[1] === 'view') return callback(null, JSON.stringify({ number: 117, headRefOid: head, url: 'https://github.com/example/repo/pull/117', isCrossRepository: false }));
      assert.equal(args[1], 'diff'); diffCalls++;
      assert.equal(options.maxBuffer, 245761);
      return native('cat', [diffFile], options, (error, stdout, stderr) => {
        sourceError = error;
        callback(error, stdout, stderr);
      });
    }, spawn() { claudeCalls++; throw new Error('must not start Claude'); },
  });
  const clock = { time: Date.now(), green: true };
  const tick = retryRunner(f, native, clock, { independentReview: review, mergePullRequest: async () => { throw new Error('must not merge'); } });
  const captured = [];
  await require('../src/execution-log').withExecution((event, details) => {
    captured.push({ event, ...details });
    f.store.appendIntegrationEvent(f.job, { event, ...details });
  }, tick);
  const diffCommand = captured.find(entry => entry.event === 'command' && entry.command === 'cat');
  const rawDiff = Buffer.concat(captured.filter(entry => entry.commandId === diffCommand.commandId && entry.event === 'output' && entry.stream === 'stdout').map(entry => Buffer.from(entry.base64, 'base64')));
  assert.equal(rawDiff.toString('utf8'), incidentDiff, 'complete captured diff survives the callback buffer limit in the owner journal');
  assert.equal(sourceError.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  const after = createJobStore(f.store.directory).load(105);
  assert.equal(after.reviewAttempts, before.reviewAttempts);
  assert.deepEqual(after.reviewHistory, before.reviewHistory);
  assert.equal(claudeCalls, 0);
  const failure = after.reviewPreparationHistory.at(-1);
  assert.equal(failure.status, 'blocked');
  assert.equal(failure.diagnostics.code, 'review_input_over_budget');
  assert.equal(failure.diagnostics.sourceCode, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  assert.equal(failure.diagnostics.limitBytes, 245760);
  assert.equal(failure.diagnostics.bufferBytes, 245761);
  assert.ok(failure.diagnostics.observedBytes >= 245761);
  assert.match(fs.readFileSync(failure.rawEvidence.file, 'utf8'), /ERR_CHILD_PROCESS_STDIO_MAXBUFFER/);
  await tick();
  assert.equal(diffCalls, 1);
  assert.equal(claudeCalls, 0);
});

for (const mode of ['transient', 'auth', 'interrupted', 'stale initial head', 'stale rechecked head', 'empty diff']) {
  test(`one-shot review preparation ${mode} is bounded and restart-safe without paid attempts`, async t => {
    const f = await fixture(t);
    await synchronizeIssueBranch(f, f.options);
    const head = f.job.delivery.commit;
    const native = require('node:child_process').execFile;
    let diffs = 0, models = 0, heads = 0;
    const adapter = require('../src/autopilot-review').createClaudeReviewAdapter({ execFile(file, args, opts, cb) {
      if (file === 'git') return native(file, args, opts, cb);
      if (args[0] === 'issue') return cb(null, JSON.stringify({ ...f.issue, url: 'https://github.com/example/repo/issues/105' }));
      if (args[1] === 'view') {
        heads++;
        const stale = mode === 'stale initial head' || mode === 'stale rechecked head' && heads === 2;
        return cb(null, JSON.stringify({ number: 117, headRefOid: stale ? f.oldHead : head, url: 'https://github.com/example/repo/pull/117', isCrossRepository: false }));
      }
      diffs++;
      if (mode === 'empty diff') return cb(null, ' \n');
      if (mode === 'stale rechecked head') return cb(null, 'diff --git a/source.js b/source.js\n+change\n');
      const message = mode === 'auth' ? 'HTTP 401: Bad credentials' : 'HTTP 503: transport interrupted';
      return native('python3', ['-c', `import sys;sys.stderr.write(${JSON.stringify(message)});sys.exit(1)`], opts, cb);
    }, spawn() { models++; throw new Error('must not call Claude'); } });
    const clock = { time: Date.now(), green: true };
    if (mode === 'interrupted') {
      f.job.reviewPreparationHistory = [{ number: 1, commit: head, status: 'running', startedAt: new Date(clock.time).toISOString() }];
      f.store.save(f.job);
    }
    const tick = retryRunner(f, native, clock, { independentReview: adapter });
    await tick();
    let saved = f.store.load(105);
    assert.equal(saved.reviewAttempts, 0);
    assert.equal(models, 0);
    if (mode === 'transient') {
      assert.equal(saved.reviewPreparationHistory[0].status, 'retry_wait');
      assert.equal(saved.reviewPreparationHistory[0].diagnostics.code, 'github_transport');
      await tick(); assert.equal(diffs, 1, 'deadline survives reload');
      clock.time += 30001; await tick();
      clock.time += 30001; await tick();
      saved = f.store.load(105);
      assert.equal(saved.reviewPreparationHistory.length, 3);
      assert.equal(saved.reviewPreparationHistory.at(-1).status, 'blocked');
      assert.equal(diffs, 3);
      assert.equal(saved.terminal, true);
      await tick(); assert.equal(diffs, 3);
    } else {
      assert.equal(saved.terminal, true);
      assert.equal(diffs, ['auth', 'stale rechecked head', 'empty diff'].includes(mode) ? 1 : 0);
      if (mode === 'auth') assert.equal(saved.reviewPreparationHistory[0].diagnostics.code, 'github_auth_denied');
      if (mode.startsWith('stale') || mode === 'empty diff') {
        assert.equal(saved.reviewPreparationHistory[0].diagnostics.code, mode === 'empty diff' ? 'review_diff_absent' : 'review_identity_mismatch');
      }
      const lookups = heads;
      await tick();
      assert.equal(heads, lookups, 'permanent preparation failures never retry');
      assert.equal(f.store.load(105).reviewPreparationHistory.length, 1);
      assert.equal(diffs, ['auth', 'stale rechecked head', 'empty diff'].includes(mode) ? 1 : 0);
    }
  });
}

for (const verdict of ['NEEDS_CHANGES', 'timeout', 'invalid']) {
  test(`one-shot prepared reviewer ${verdict} spends exactly one paid attempt`, async t => {
    const f = await fixture(t);
    await synchronizeIssueBranch(f, f.options);
    const head = f.job.delivery.commit;
    const native = require('node:child_process').execFile;
    let calls = 0;
    const review = require('../src/autopilot-review').createClaudeReviewAdapter({ timeoutMs: 20, execFile(file, args, opts, cb) {
      if (file === 'git') return native(file, args, opts, cb);
      if (args[0] === 'issue') return cb(null, JSON.stringify({ ...f.issue, url: 'https://github.com/example/repo/issues/105' }));
      if (args[1] === 'diff') return native('git', ['-C', f.project.checkout, 'diff', f.target, head], opts, cb);
      cb(null, JSON.stringify({ number: 117, headRefOid: head, url: 'https://github.com/example/repo/pull/117', isCrossRepository: false }));
    }, spawn() {
      calls++;
      const saved = f.store.load(105);
      assert.equal(saved.reviewAttempts, 1);
      assert.equal(saved.reviewPreparationHistory[0].status, 'prepared');
      const { EventEmitter } = require('node:events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.kill = () => { queueMicrotask(() => child.emit('close', 1)); return true; };
      child.stdin.end = () => {
        if (verdict === 'timeout') return;
        queueMicrotask(() => {
          child.stdout.emit('data', verdict === 'invalid' ? 'not a verdict' : JSON.stringify({ is_error: false, result: JSON.stringify({ verdict, commit: head, findings: 'Fix the defect' }) }));
          child.emit('close', 0);
        });
      };
      return child;
    } });
    await retryRunner(f, native, { time: Date.now(), green: true }, { independentReview: review })();
    const saved = f.store.load(105);
    assert.equal(saved.reviewAttempts, 1);
    assert.equal(calls, 1);
    assert.equal(saved.reviewHistory.length, 1);
    assert.equal(saved.reviewHistory[0].status, verdict === 'NEEDS_CHANGES' ? 'completed' : verdict === 'timeout' ? 'timed_out' : 'invalid_verdict');
    if (verdict === 'NEEDS_CHANGES') {
      assert.equal(saved.review.verdict, verdict);
      assert.equal(saved.status, 'review_correction_eligible');
    } else assert.equal(saved.terminal, true);
  });
}


test('exhausted exact-head review budget skips preparation and its context fetches', async t => {
  const f = await fixture(t);
  await synchronizeIssueBranch(f, f.options);
  const state = require('../src/autopilot-state');
  for (let index = 0; index < 2; index++) {
    const attempt = state.beginReviewAttempt(f.job, f.store.now, { reviewer: 'claude:sonnet', model: 'sonnet', policy: 'always', commit: f.job.delivery.commit });
    state.recordReview(f.job, { reviewer: 'claude:sonnet', verdict: 'NEEDS_CHANGES', commit: f.job.delivery.commit, policy: 'always', findings: 'Correct the failure', attempt }, f.store.now);
  }
  f.store.save(f.job);
  const before = f.store.load(105);
  let fetches = 0, models = 0, preparations = 0;
  const review = require('../src/autopilot-review').createClaudeReviewAdapter({
    execFile() { fetches++; throw new Error('must not fetch review context'); },
    spawn() { models++; throw new Error('must not start Claude'); },
  });
  const prepare = review.prepare;
  review.prepare = context => { preparations++; return prepare(context); };
  const tick = retryRunner(f, require('node:child_process').execFile, { time: Date.now(), green: true }, { independentReview: review });
  await tick();
  await tick();
  const saved = f.store.load(105);
  assert.deepEqual([preparations, fetches, models], [0, 0, 0]);
  assert.equal(saved.reviewPreparationHistory?.length ?? 0, 0);
  assert.equal(saved.reviewAttempts, before.reviewAttempts);
  assert.deepEqual(saved.reviewHistory, before.reviewHistory);
  assert.equal(saved.terminalState, 'ready_for_human');
  assert.match(saved.failures.at(-1).message, /review attempt limit/);
});
