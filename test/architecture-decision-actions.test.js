'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const actions = require('../src/architecture-decision-actions');
const decisions = require('../src/architecture-decisions');
const { createJob, createJobStore } = require('../src/autopilot-state');
const { grantCommand } = require('../src/milestone-grants');
const { ticketCommand, ticketDigest } = require('../src/milestone-tickets');
const proposal = { key: 'storage', problem: 'Choose storage', options: [{ name: 'SQL', tradeoffs: 'Transactions; migration cost' }, { name: 'Journal', tradeoffs: 'Simple; compaction cost' }], recommendation: 'SQL', consequences: 'Maintain migrations', conflicts: 'Preserve ADR 0001', grantImplications: 'None', newEvidence: '', settledDecision: false, expensiveToReverse: true, surprisingWithoutContext: true, genuineTradeoff: true };
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-actions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = { enabled: true, autoMerge: true, architectureDecisions: true, milestoneAuthorization: true, repo: 'owner/demo', checkout: root, worktreeRoot: path.join(root, 'worktrees'), stateDir: path.join(root, 'jobs'), baseBranch: 'main', readyLabel: 'ready', humanLabel: 'human', worker: 'codex', reviewPolicy: 'always', verification: 'npm test' };
  const options = { stateDir: root, configPath: path.join(root, 'config.json'), projectsPath: path.join(root, 'projects.json'), inputPath: path.join(root, 'input.json'), specPath: path.join(root, 'spec.md'), approve: async () => true, record() {} };
  fs.writeFileSync(options.configPath, JSON.stringify({ allowedProjects: { demo: root } }));
  fs.writeFileSync(options.projectsPath, JSON.stringify({ demo: project }));
  fs.writeFileSync(options.specPath, 'Approved architecture and implementation');
  fs.writeFileSync(options.inputPath, JSON.stringify({ project: 'demo', repo: project.repo, spec: { identity: '#1', digest: crypto.createHash('sha256').update(fs.readFileSync(options.specPath)).digest('hex') }, objective: 'Bounded implementation', allowedCategories: ['implementation'], exclusions: ['deployment'], revision: 1, ticketLimit: 3, concurrencyLimit: 2, expiresAt: new Date(Date.now() + 86400000).toISOString() }));
  const grant = await grantCommand('draft', 'g1', options);
  await grantCommand('activate', 'g1', { ...options, digest: grant.digest });
  const issue = { number: 10, title: '[DRAFT] Implement storage', body: 'Implement authorized storage', state: 'open', html_url: 'https://github.com/owner/demo/issues/10', labels: [] };
  const adrIssue = { number: 20, title: '[DRAFT] Record storage ADR', body: 'Record architecture decision', html_url: 'https://github.com/owner/demo/issues/20', state: 'open', labels: [] };
  const store = createJobStore(project.stateDir), requests = [];
  const job = createJob({ projectName: 'demo', repo: project.repo, issue, branch: 'ralph/issue-10', worktreePath: root, now: store.now, maxReviewRounds: 2 });
  const oldAdr = { path: 'docs/decisions/0001.md', content: 'Accepted owner trust boundary' };
  const decisionIssue = { number: 15, html_url: 'https://github.com/owner/demo/issues/15', state: 'open', body: store.load(10)?.architectureDecision?.marker || '', labels: [{ name: 'needs-owner-decision' }] };
  let remoteMerged = true, remoteContent = null, loseResolution = false;
  options.execFile = (file, args, opts, cb) => {
    requests.push(args);
    const url = args[1] === '--method' ? args[3] : args[1];
    if (args.includes('POST')) { const target = url.includes('/20/') ? adrIssue : issue; target.labels = [{ name: 'ready' }]; return cb(null, JSON.stringify(target.labels)); }
    if (args.includes('PATCH')) {
      const target = url.endsWith('/15') ? decisionIssue : adrIssue;
      target.body = args.find(a => a.startsWith('body=')).slice(5);
      if (args.includes('state=closed')) target.state = 'closed';
      if (target === decisionIssue && loseResolution) { loseResolution = false; return cb(new Error('lost response'), '', 'lost resolution response'); }
      return cb(null, JSON.stringify(target));
    }
    if (args[0] === 'issue') return cb(null, '');
    if (url.includes('/contents/')) {
      const content = url.includes('0001.md') ? oldAdr.content : remoteContent ?? store.load(10).architectureDecision?.adr?.content;
      return cb(null, JSON.stringify({ encoding: 'base64', content: Buffer.from(content || '').toString('base64') }));
    }
    if (url.includes('/pulls/')) return cb(null, JSON.stringify({ merged: remoteMerged, head: { sha: 'a'.repeat(40) }, merge_commit_sha: 'b'.repeat(40), base: { repo: { full_name: project.repo }, ref: 'main' } }));
    cb(null, JSON.stringify(url.endsWith('/20') ? adrIssue : url.endsWith('/15') ? decisionIssue : issue));
  };
  const request = { repo: project.repo, issue: 10, grantDigest: grant.digest, revision: 1, spec: { identity: grant.spec.identity, digest: grant.spec.digest }, ticketDigest: ticketDigest(issue), category: 'implementation', scope: 'in-scope', reason: 'Within owner scope' };
  const ticket = async (action, extra = {}) => ticketCommand(action, 'g1', { ...options, request, ...extra });
  const p = await ticket('preview'); await ticket('approve', { digest: p.digest }); await ticket('release');
  job.milestoneAuthorization = await require('../src/milestone-admission').checkMilestoneAdmission('demo', project, 10, { ...options, jobs: [] });
  job.runs = 1; require('../src/autopilot-state').recordFailure(job, 'worker', 'Original diagnostic', store.now);
  job.ralph = { status: 'paused_owner_decision', attempts: 1, taskId: 'original-worker' };
  decisions.pause(job, proposal, [oldAdr], store);
  let saved = store.load(10); saved.architectureDecision.issue = { number: 15, url: 'https://github.com/owner/demo/issues/15' }; saved.architectureDecision.publication = 'complete'; store.save(saved);
  decisionIssue.body = saved.architectureDecision.marker + '\nOriginal decision proposal';
  const input = { option: 'SQL', rationale: 'Owner chooses transactions and accepts migrations', adrPath: 'docs/decisions/0002-storage.md', supersedes: [], conflictResolution: 'Preserve existing host policy; no conflict', adrIssue: 20, requiresMilestoneAmendment: false, conflictsResolved: true };
  const command = async (action, data = input, extra = {}) => {
    fs.writeFileSync(options.inputPath, JSON.stringify(data));
    const inspection = await actions.decisionCommand('inspect', 'demo#10', options);
    return actions.decisionCommand(action, 'demo#10', { ...options, digest: inspection.digest, ...extra });
  };
  const mergeAdr = () => {
    const adr = createJob({ projectName: 'demo', repo: project.repo, issue: adrIssue, branch: 'ralph/issue-20', worktreePath: root, now: store.now });
    Object.assign(adr, { terminal: true, terminalState: 'merged', status: 'merged', delivery: { branch: adr.branch, commit: 'a'.repeat(40), pushed: true },
      merge: { prNumber: 21, repo: project.repo, commit: 'b'.repeat(40), approvedHead: 'a'.repeat(40), issueClosed: true, mergedAt: store.now() },
      review: { reviewer: 'claude:sonnet', verdict: 'PASS', commit: 'a'.repeat(40), findings: [] },
      ci: { state: 'green', headCommit: 'a'.repeat(40), checkedAt: store.now(), details: null }, verification: { command: 'npm test', passed: true, exitCode: 0, timedOut: false, commit: 'a'.repeat(40), stdout: 'all tests passed', stderr: '' } });
    const state = require('../src/autopilot-state');
    const attempt = state.beginReviewAttempt(adr, store.now);
    state.recordReview(adr, { reviewer: 'claude:sonnet', verdict: 'PASS', commit: 'a'.repeat(40), findings: [], policy: 'always', attempt }, store.now);
    store.save(adr);
  };
  const releaseAdr = async () => {
    const adrRequest = { ...request, issue: 20, ticketDigest: ticketDigest(adrIssue) };
    const preview = await ticketCommand('preview', 'g1', { ...options, request: adrRequest });
    await ticketCommand('approve', 'g1', { ...options, request: adrRequest, digest: preview.digest });
    const released = await ticketCommand('release', 'g1', { ...options, request: adrRequest });
    assert.equal(released.released, true, JSON.stringify(released.reasons));
  };
  const changeGrant = patch => { const f = path.join(root, 'milestone-grants.json'), db = JSON.parse(fs.readFileSync(f)); Object.assign(db.grants.g1, patch); fs.writeFileSync(f, JSON.stringify(db)); };
  return { root, options, project, store, issue, adrIssue, decisionIssue, requests, input, command, mergeAdr, releaseAdr, changeGrant, loseResolution: () => { loseResolution = true; }, unmerge: () => { remoteMerged = false; }, alterAdr: () => { remoteContent = 'Proposed only'; } };
}
test('owner accepts once, persists exact evidence and proposes an unreleased ADR without granting execution', async t => {
  const f = await fixture(t), before = f.store.load(10);
  await assert.rejects(f.command('accept', f.input, { approve: async () => false }), /Explicit owner/);
  await assert.rejects(f.command('accept', { ...f.input, actor: 'owner', approved: true }), /Unknown owner decision/);
  await assert.rejects(f.command('accept', f.input, { digest: 'spoofed' }), /exact digest/);
  const first = await f.command('accept'), second = await f.command('accept');
  assert.deepEqual(first, second); assert.equal(first.architectureDecision.ownerDecision.actor, os.userInfo().username);
  assert.equal(first.architectureDecision.ownerDecision.option, 'SQL');
  assert.deepEqual(first.architectureDecision.ownerDecision.milestoneAuthorization, before.milestoneAuthorization);
  assert.match(f.adrIssue.body, /## Alternatives and trade-offs/);
  assert.equal(f.requests.filter(a => a.includes('PATCH')).length, 1);
  assert.deepEqual(f.adrIssue.labels, []); assert.equal(first.terminal, true);
  await assert.rejects(f.command('accept', { ...f.input, option: 'Journal' }), /contradictory/);
});
for (const action of ['reject', 'revise']) test(`owner ${action} remains durably blocked`, async t => {
  const f = await fixture(t); await f.command(action, { rationale: 'Need different alternatives' });
  await assert.rejects(f.command('resume', {}), /Missing owner acceptance/);
  assert.match(f.store.load(10).architectureDecision.blockedReason, /Missing owner acceptance/);
  assert.equal(f.store.load(10).terminal, true);
});
for (const change of ['proposed', 'remote-unmerged', 'content', 'revoked', 'expired', 'changed-grant', 'issue']) test(`resume rejects ${change} with retained original history`, async t => {
  const f = await fixture(t); await f.command('accept');
  if (change !== 'proposed') f.mergeAdr();
  if (change === 'remote-unmerged') f.unmerge();
  if (change === 'content') f.alterAdr();
  if (change === 'revoked') f.changeGrant({ state: 'revoked' });
  if (change === 'expired') f.changeGrant({ expiresAt: '2000-01-01T00:00:00Z' });
  if (change === 'changed-grant') f.changeGrant({ revision: 2 });
  if (change === 'issue') f.issue.body += ' Additional scope';
  await assert.rejects(f.command('resume', {}));
  const job = f.store.load(10);
  assert.equal(job.terminal, true); assert.equal(job.runs, 1);
  assert.equal(job.failures[0].message, 'Original diagnostic'); assert.ok(job.architectureDecision.blockedReason);
});
test('verified merged ADR resumes the same durable job once, retaining worktree, run budget and logs', async t => {
  const f = await fixture(t); await f.command('accept'); f.mergeAdr();
  const before = f.store.load(10);
  const result = await f.command('resume', {});
  assert.equal(result.status, 'decision_resume_pending');
  assert.equal(result.createdAt, before.createdAt); assert.equal(result.runs, before.runs);
  assert.deepEqual(result.ralph, before.ralph); assert.deepEqual(result.failures, before.failures);
  assert.equal(result.worktreePath, before.worktreePath);
  assert.equal(require('../src/autopilot-state').isResumable(result), true);
  await f.command('resume', {});
  assert.equal(f.store.load(10).runs, 1);
});
test('one-shot execution revalidates resume, retains original worktree and spends only the next existing run', async t => {
  const f = await fixture(t); await f.command('accept'); f.mergeAdr(); await f.command('resume', {});
  let workers = 0, preparations = 0;
  const before = f.store.load(10);
  const result = await require('../src/autopilot').run(['--project', 'demo'], {
    loadProjectConfig: () => f.project, jobStore: f.store, milestoneOptions: f.options,
    execFile: f.options.execFile, discoverReadyIssues: async () => [f.issue], write() {},
    prepareIssueWorkspace: async () => { preparations++; throw new Error('Must retain original worktree'); },
    prepareRepositoryEnvironment: async () => ({}), readRepositoryInstructions: async () => [],
    cleanupIssueWorkspace: async () => {},
    createRalphTaskService: () => ({ run: async (cwd, task) => {
      workers++; assert.equal(cwd, before.worktreePath); assert.match(task.goal, /Owner accepted decisions/);
      return { status: 'needs_planning', attempts: [] };
    } }),
  });
  assert.equal(workers, 1); assert.equal(preparations, 0);
  assert.equal(result.job.runs, 2); assert.equal(result.job.createdAt, before.createdAt);
  assert.equal(result.job.architectureDecisionHistory.length, 1);
  assert.equal(result.job.failures[0].message, 'Original diagnostic');
  assert.equal(result.job.architectureDecisionHistory[0].ownerDecision.option, 'SQL');
  assert.ok(require('../src/r1-status').evidence(result.job).architectureDecisionHistory[0].resumedAt);
  await actions.decisionCommand('resume', 'demo#10', f.options);
  assert.equal(f.store.load(10).runs, 2);
});
test('revocation after owner resume request is rechecked before any worker or merge', async t => {
  const f = await fixture(t); await f.command('accept'); f.mergeAdr(); await f.command('resume', {});
  f.changeGrant({ state: 'revoked' });
  const result = await require('../src/autopilot').run(['--project', 'demo'], {
    loadProjectConfig: () => f.project, jobStore: f.store, milestoneOptions: f.options,
    execFile: f.options.execFile, discoverReadyIssues: async () => [f.issue], write() {},
    createRalphTaskService: () => { throw new Error('Must not start a worker'); },
    mergePullRequest: () => { throw new Error('Must not merge'); },
  });
  assert.equal(f.store.load(10).runs, 1);
  assert.notEqual(result?.outcome?.status, 'merged');
});
test('owner queue resume reuses the original parent identity and does not enqueue twice', async t => {
  const f = await fixture(t);
  const job = f.store.load(10); job.r1ParentJobId = 't-1234abcd'; job.architectureDecision.originatingJob = job.r1ParentJobId; f.store.save(job);
  await f.command('accept'); f.mergeAdr();
  let task = { id: job.r1ParentJobId, workflow: 'r1', status: 'paused_owner_decision', project: 'demo', issue: 10, r1: job, phases: [{ phase: 'implementation', at: job.createdAt }], priorErrors: ['original error'] };
  let stage = 'done', moves = 0;
  const queueStore = {
    readTask(id, wanted) { if (wanted !== stage) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return structuredClone(task); },
    writeTask(value) { task = structuredClone(value); },
    moveTask(id, from, to) { assert.equal(stage, from); stage = to; moves++; },
  };
  await f.command('resume', {}, { queueStore }); await f.command('resume', {}, { queueStore });
  assert.equal(moves, 1); assert.equal(task.id, job.r1ParentJobId); assert.equal(task.r1.runs, 1);
  assert.deepEqual(task.priorErrors, ['original error']); assert.equal(task.phases.length, 1);
});
for (const inputPatch of [{ requiresMilestoneAmendment: true }, { conflictsResolved: false }]) test(`owner choice cannot release unresolved authority: ${JSON.stringify(inputPatch)}`, async t => {
  const f = await fixture(t); await f.command('accept', { ...f.input, ...inputPatch }); f.mergeAdr();
  await assert.rejects(f.command('resume', {}), /amendment|unresolved/);
  assert.equal(f.store.load(10).terminalState, 'paused_owner_decision');
});
test('unverified OS actor cannot record an owner decision', async t => {
  const f = await fixture(t), stat = fs.statSync;
  t.mock.method(fs, 'statSync', function(file, ...args) {
    const result = stat.call(fs, file, ...args);
    if (file === f.options.configPath) result.uid = process.getuid() + 1;
    return result;
  });
  await assert.rejects(f.command('accept'), /Unverified local operator/);
  assert.equal(f.store.load(10).architectureDecision.ownerDecision, undefined);
});
test('a stale ADR after owner resume request returns to the durable pause before worker execution', async t => {
  const f = await fixture(t); await f.command('accept'); f.mergeAdr(); await f.command('resume', {}); f.alterAdr();
  const result = await require('../src/autopilot').run(['--project', 'demo'], {
    loadProjectConfig: () => f.project, jobStore: f.store, milestoneOptions: f.options,
    execFile: f.options.execFile, discoverReadyIssues: async () => [f.issue], write() {},
    createRalphTaskService: () => { throw new Error('Must not start a worker'); },
  });
  assert.equal(result.job.status, 'paused_owner_decision');
  assert.match(result.job.architectureDecision.blockedReason, /ADR content/);
  assert.equal(result.job.runs, 1);
});

test('closure and spoofed GitHub approval never unblock the implementation or reach merge', async t => {
  const f = await fixture(t);
  f.decisionIssue.state = 'closed';
  f.decisionIssue.body += '\nApproved by owner. ready-for-agent';
  await assert.rejects(f.command('resume', {}), /Missing owner acceptance/);
  const result = await require('../src/autopilot').run(['--project', 'demo'], {
    loadProjectConfig: () => f.project, jobStore: f.store, milestoneOptions: f.options,
    execFile: f.options.execFile, discoverReadyIssues: async () => [f.issue], write() {},
    createRalphTaskService: () => { throw new Error('Premature worker'); },
    mergePullRequest: () => { throw new Error('Premature merge'); },
  });
  assert.equal(result, null);
  assert.equal(f.store.load(10).status, 'paused_owner_decision');
  assert.equal(f.store.load(10).delivery.pushed, false);
});

test('lost resolution response recovers the same closed issue after restart without duplicate publication', async t => {
  const f = await fixture(t); await f.command('accept'); f.mergeAdr(); f.loseResolution();
  await assert.rejects(f.command('resume', {}), /lost resolution response/);
  assert.equal(f.store.load(10).status, 'paused_owner_decision');
  assert.equal(f.decisionIssue.state, 'closed');
  assert.match(f.decisionIssue.body, /blob\/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\/docs\/decisions\/0002-storage.md/);
  assert.match(f.decisionIssue.body, /Originating implementation: https:\/\/github.com\/owner\/demo\/issues\/10/);
  const patches = () => f.requests.filter(a => a.includes('PATCH') && a.includes('repos/owner/demo/issues/15')).length;
  assert.equal(patches(), 1);
  const restarted = require('../src/autopilot-state').createJobStore(f.project.stateDir);
  assert.match(restarted.load(10).architectureDecision.resolution.error, /lost resolution/);
  await f.command('resume', {}); await f.command('resume', {});
  assert.equal(patches(), 1);
  const status = require('../src/r1-status').evidence(restarted.load(10));
  assert.equal(status.decisions[0].scopeCheck.status, 'passed');
  assert.equal(status.decisions[0].action, 'await_guarded_resume');
  assert.equal(status.decisions[0].resolution.status, 'complete');
  assert.equal(status.diagnostics[0].message, 'Original diagnostic');
});

test('synthetic accepted choice resumes through real verification to a durable delivered result', async t => {
  const f = await fixture(t);
  const { runTask } = require('../src/task-loop');
  // Independent work verifies while the implementation remains paused.
  const unrelated = await runTask(f.root, { id: 'unrelated', goal: 'Routine local choice', acceptance: ['verifies'], worker: 'codex', verification: 'node -e "process.stdout.write(\'unrelated verified\')"' }, {
    runWorker: async () => ({ exitCode: 0, stdout: 'unrelated progressed', stderr: '' }),
  });
  assert.equal(unrelated.status, 'passed');
  assert.equal(f.store.load(10).status, 'paused_owner_decision');
  await f.command('accept'); f.mergeAdr(); await f.command('resume', {});
  const result = await require('../src/autopilot').run(['--project', 'demo'], {
    loadProjectConfig: () => f.project, jobStore: f.store, milestoneOptions: f.options,
    execFile: f.options.execFile, discoverReadyIssues: async () => [f.issue], write() {},
    prepareRepositoryEnvironment: async () => ({}), readRepositoryInstructions: async () => [], cleanupIssueWorkspace: async () => {},
    createRalphTaskService: () => ({ run: async (cwd, task) => {
      assert.match(task.goal, /Owner accepted decisions/);
      return runTask(cwd, { ...task, verification: 'node -e "process.stdout.write(\'resumed verified\')"' }, {
        runWorker: async () => ({ exitCode: 0, stdout: 'complete resumed output', stderr: 'complete resumed diagnostics' }),
      });
    } }),
    deliverPassedWork: async () => ({ commit: 'c'.repeat(40), pushed: true, branch: f.store.load(10).branch }),
  });
  assert.equal(result.job.status, 'passed');
  assert.equal(result.job.verification.passed, true);
  assert.equal(result.job.verification.commit, 'c'.repeat(40));
  assert.match(result.job.verification.command, /resumed verified/);
  const restored = createJobStore(f.project.stateDir).load(10);
  const view = require('../src/r1-status').evidence(restored);
  assert.equal(view.decisions[0].state, 'resumed');
  assert.equal(view.decisions[0].decisionIssue.url, 'https://github.com/owner/demo/issues/15');
  assert.equal(view.decisions[0].originatingIssue.number, 10);
  assert.equal(view.decisions[0].acceptedAdr.commit, 'b'.repeat(40));
  assert.equal(view.architectureDecisionHistory[0].ownerDecision.option, 'SQL');
  assert.equal(view.diagnostics[0].message, 'Original diagnostic');
  restored.status = restored.terminalState = 'merged';
  assert.equal(require('../src/r1-status').evidence(restored).decisions[0].state, 'merged');
});

test('read-only R1 status recovers CLI actions from the durable project job after a stale queue checkpoint', async t => {
  const f = await fixture(t);
  let job = f.store.load(10); job.r1ParentJobId = 't-1234abcd'; job.architectureDecision.originatingJob = job.r1ParentJobId; f.store.save(job);
  const task = { id: job.r1ParentJobId, workflow: 'r1', status: 'paused_owner_decision', project: 'demo', issue: 10, r1: structuredClone(job) };
  const queue = { paths: { config: f.options.configPath }, readTask(id, stage) {
    if (stage !== 'done') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return structuredClone(task);
  } };
  await f.command('accept');
  const { createR1Jobs } = require('../src/r1-jobs');
  const reader = createR1Jobs(queue, { autopilotDependencies: { loadProjectConfig: () => f.project } });
  const calls = f.requests.length;
  const recovered = reader.read(task.id);
  assert.equal(recovered.evidence.decisions[0].ownerDecision.option, 'SQL');
  assert.equal(recovered.evidence.decisions[0].proposedAdr.path, f.input.adrPath);
  assert.equal(recovered.evidence.decisions[0].acceptedAdr, null);
  assert.equal(recovered.executionJournal.raw, '/api/log/t-1234abcd?raw=1');
  assert.equal(recovered.evidence.diagnostics[0].message, 'Original diagnostic');
  assert.deepEqual(reader.read(task.id), recovered);
  assert.equal(f.requests.length, calls, 'status reads have no GitHub side effects');
  assert.equal(task.r1.architectureDecision.ownerDecision, undefined);
});

test('synthetic ADR and resumed implementation pass normal one-shot CI, independent review and guarded merge gates', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "console.log(\'synthetic checks passed\')"' } }));
  await f.command('accept'); await f.releaseAdr();
  const { run } = require('../src/autopilot');
  const reviewed = [], merged = [], observed = [];
  const head = 'a'.repeat(40), target = 'd'.repeat(40);
  const pipeline = issue => ({
    loadProjectConfig: () => f.project, jobStore: createJobStore(f.project.stateDir), milestoneOptions: f.options,
    execFile: f.options.execFile, discoverReadyIssues: async () => [issue], write() {},
    findOpenIssuePullRequests: async () => [],
    prepareIssueWorkspace: async () => ({ worktreePath: f.root, branch: `ralph/issue-${issue.number}` }),
    prepareRepositoryEnvironment: async () => ({}), readRepositoryInstructions: async () => [], cleanupIssueWorkspace: async () => {},
    createRalphTaskService: () => ({ run: async (cwd, task) => require('../src/task-loop').runTask(cwd, task, {
      runWorker: async () => ({ exitCode: 0, stdout: 'synthetic implementation', stderr: 'complete synthetic diagnostic' }),
    }) }),
    deliverPassedWork: async () => ({ branch: `ralph/issue-${issue.number}`, commit: head, pushed: true,
      pr: { number: issue.number + 1, url: `https://github.com/owner/demo/pull/${issue.number + 1}` } }),
    // Synthetic Git transport; the parent gates below are the real one-shot code.
    synchronizeIssueBranch: async ({ job, store }) => {
      const verification = await require('../src/verifier').runVerification(f.root, 'npm test');
      require('../src/autopilot-state').recordVerification(job, 'npm test', verification);
      job.verification.commit = head;
      job.integration = { headSha: head, targetSha: target }; store.save(job);
      return { changed: false };
    },
    observeTargetSha: async () => target,
    observePullRequestCi: async (_project, pr) => {
      observed.push(pr.commit);
      return { state: 'green', headCommit: pr.commit, prNumber: pr.number };
    },
    independentReview: async input => {
      assert.equal(input.verification.commit, head); assert.equal(input.verification.passed, true);
      assert.equal(input.ci.headCommit, head); reviewed.push(input.issue.number);
      return { reviewer: 'claude:synthetic', verdict: 'PASS', commit: head, findings: [] };
    },
    observePullRequest: async () => ({ number: issue.number + 1, state: 'OPEN', isCrossRepository: false,
      headRefName: `ralph/issue-${issue.number}`, headRefOid: head, baseRefName: 'main' }),
    mergePullRequest: async (_project, pr) => {
      assert.equal(pr.headCommit, head); merged.push(issue.number);
      return { mergeCommit: 'b'.repeat(40) };
    },
    reconcileIssueClosure: async () => ({}),
  });
  for (const issue of [f.adrIssue, f.issue]) {
    if (issue.number === 10) await f.command('resume', {});
    const delivery = await run(['--project', 'demo'], pipeline(issue));
    assert.ok(delivery, `No delivery for ${issue.number}`);
    assert.equal(delivery.job.status, 'awaiting_ci', JSON.stringify(delivery.job.failures));
    assert.equal(merged.includes(issue.number), false);
    const completed = await run(['--project', 'demo'], pipeline(issue));
    assert.equal(completed.job.terminalState, 'merged');
    assert.equal(require('../src/r1-dependencies').approved(completed.job, issue.number, 'demo', f.project.repo), true);
  }
  assert.deepEqual(reviewed, [20, 10]); assert.deepEqual(merged, [20, 10]); assert.deepEqual(observed, [head, head]);
  const recovered = require('../src/r1-status').evidence(createJobStore(f.project.stateDir).load(10));
  assert.equal(recovered.decisions[0].state, 'merged');
  assert.equal(recovered.decisions[0].acceptedAdr.commit, 'b'.repeat(40));
  assert.equal(recovered.architectureDecisionHistory[0].resolution.status, 'complete');
});

test('resolution refuses transferred decision identity and preserves the pause', async t => {
  const f = await fixture(t); await f.command('accept'); f.mergeAdr();
  f.decisionIssue.html_url = 'https://github.com/elsewhere/repo/issues/15';
  await assert.rejects(f.command('resume', {}), /identity changed/);
  assert.equal(f.store.load(10).status, 'paused_owner_decision');
  assert.equal(f.decisionIssue.state, 'open');
  assert.equal(f.requests.filter(a => a.includes('PATCH') && a.includes('repos/owner/demo/issues/15')).length, 0);
});
