const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { grantCommand } = require('../src/milestone-grants');
const { ticketCommand, ticketDigest } = require('../src/milestone-tickets');
async function fixture(t, fixedManifest = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json'), projectsPath = path.join(root, 'projects.json');
  const checkout = path.join(root, 'repo'); fs.mkdirSync(checkout);
  fs.writeFileSync(configPath, JSON.stringify({ allowedProjects: { demo: checkout } }));
  fs.writeFileSync(projectsPath, JSON.stringify({ demo: { repo: 'owner/demo', checkout, readyLabel: 'custom-ready' } }));
  const specPath = path.join(root, 'spec.md'); fs.writeFileSync(specPath, 'Approved scope');
  const inputPath = path.join(root, 'input.json');
  fs.writeFileSync(inputPath, JSON.stringify({ project: 'demo', repo: 'owner/demo', spec: { identity: '#103@1', digest: crypto.createHash('sha256').update('Approved scope').digest('hex') }, objective: 'Tests', allowedCategories: ['tests'], exclusions: ['deployment'], revision: 1, ticketLimit: 1, concurrencyLimit: 1, expiresAt: new Date(Date.now() + 86400000).toISOString() }));
  const events = [], writes = [];
  const options = { configPath, projectsPath, stateDir: root, inputPath, specPath, record: (type, details) => events.push({ type, ...details }), approve: async () => true };
  const issue = { number: 106, title: '[DRAFT] Add tests', body: 'Draft tests\n', state: 'open', labels: [], html_url: 'https://github.com/owner/demo/issues/106' };
  if (fixedManifest) {
    const proposal = JSON.parse(fs.readFileSync(inputPath));
    proposal.fixedManifest = { readyLabel: 'custom-ready', tickets: [{ issue: issue.number, title: issue.title, body: issue.body, blockers: [], category: 'tests', reason: 'Only adds tests; no deployment.' }] };
    fs.writeFileSync(inputPath, JSON.stringify(proposal));
  }
  const grant = await grantCommand('draft', 'g1', options);
  await grantCommand('activate', 'g1', { ...options, digest: grant.digest });
  const request = { repo: 'owner/demo', issue: 106, grantDigest: grant.digest, revision: 1, spec: { identity: grant.spec.identity, digest: grant.spec.digest }, ticketDigest: ticketDigest(issue), category: 'tests', scope: 'in-scope', reason: 'Only adds tests; no deployment.' };
  const db = () => JSON.parse(fs.readFileSync(path.join(root, 'milestone-grants.json')));
  options.execFile = (file, args, opts, callback) => {
    if (args.some(a => a.includes('/dependencies/blocked_by'))) return callback(null, '[[]]', '');
    if (args.includes('POST')) {
      assert.equal(Object.keys(db().grants.g1.receipts).length, 1, 'receipt precedes label');
      writes.push(args); if (options.failLabel) return callback(new Error('offline'), '', 'offline');
      issue.labels = [{ name: 'custom-ready' }]; return callback(null, JSON.stringify(issue.labels), '');
    }
    callback(null, JSON.stringify(issue), '');
  };
  const run = async (action, extra = {}) => { fs.writeFileSync(inputPath, JSON.stringify(request)); return ticketCommand(action, 'g1', { ...options, ...extra }); };
  const approve = async () => { const p = await run('preview'); return run('approve', { digest: p.digest }); };
  return { root, options, request, issue, run, approve, writes, events, db };
}

const { createR1Jobs } = require('../src/r1-jobs');
const { configuredProjects } = require('../src/project-registry');
async function r1Fixture(t, fixedManifest = false) {
  const f = await fixture(t, fixedManifest);
  const project = { repo: 'owner/demo', checkout: path.join(f.root, 'repo'), readyLabel: 'custom-ready', humanLabel: 'human', enabled: true,
     baseBranch: 'main', worker: 'codex', reviewPolicy: 'always', autoMerge: true, milestoneAuthorization: true,
    worktreeRoot: path.join(f.root, 'worktrees'), stateDir: path.join(f.root, 'jobs') };
  const config = { allowedProjects: { demo: { root: project.checkout, worktreeRoot: project.worktreeRoot } } };
  fs.writeFileSync(f.options.configPath, JSON.stringify(config));
  // Registration terms bind paths and checkout, which have not changed.
  const tasks = { pending: [], running: [], done: [] }, events = [];
  const store = { paths: { config: f.options.configPath, state: f.root },
    config: { allowedProjects: configuredProjects(config.allowedProjects, f.options.configPath) },
    enqueueTask: task => { const value = { id: 't-0000abcd', ...task }; tasks.pending.push(value); return value; },
    appendLogLine() {}, appendExecution(id, event) { events.push(event); },
    writeTask(task, stage) { tasks[stage] = [...tasks[stage].filter(x => x.id !== task.id), structuredClone(task)]; },
    readTask(id, stage) { const value = tasks[stage].find(x => x.id === id); if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return value; },
    listTasks: stage => tasks[stage], writeResult() {},
    moveTask(id, from, to) { const task = store.readTask(id, from); tasks[from] = tasks[from].filter(x => x.id !== id); tasks[to].push(task); },
  };
  const deps = { loadProjectConfig: () => project, execFile: f.options.execFile, discoverReadyIssues: async () => [f.issue] };
  const jobs = createR1Jobs(store, { projectsPath: f.options.projectsPath, admitIntervalMs: 0,
    autopilotDependencies: deps });
  return { ...f, project, tasks, events, store, jobs, deps };
}
async function settled(f) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = require('../src/autopilot-state').createJobStore(f.project.stateDir).load(106);
    if (job?.terminal || job?.authorizationBlocked) { await new Promise(resolve => setImmediate(resolve)); return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Delivery did not settle at its canonical checkpoint.');
}
test('manual R1 submit and discovery reject ready labels without receipts durably', async t => {
  const f = await r1Fixture(t);
  await assert.rejects(async () => f.jobs.submit({ project: 'demo', issue: 106 }), /milestone.*receipt/i);
  assert.equal(await f.jobs.admit(), null);
  assert.equal(f.tasks.pending.length, 0);
  assert.match(fs.readFileSync(path.join(f.root, 'milestone-admission.ndjson'), 'utf8'), /receipt/i);
});
test('authorized submit progresses; queued recovery rechecks revocation without erasing evidence', async t => {
  const f = await r1Fixture(t); await f.approve(); await f.run('release');
  const task = await f.jobs.submit({ project: 'demo', issue: 106 }); assert.equal(task.issue, 106);
  f.store.moveTask(task.id, 'pending', 'running');
  f.jobs.recover(task);
  const db = f.db(); db.grants.g1.state = 'revoked'; fs.writeFileSync(path.join(f.root, 'milestone-grants.json'), JSON.stringify(db));
  f.store.moveTask(task.id, 'pending', 'running');
  f.jobs.advance(f.store.readTask(task.id, 'running')); await settled(f);
  assert.equal(f.tasks.done.length, 0);
  assert.match(require('../src/autopilot-state').createJobStore(f.project.stateDir).load(106).authorizationBlocked.message, /revoked/i);
  assert.ok(f.events.some(e => e.event === 'recovery' || e.type === 'recovery'));
});

for (const [change, fixedManifest] of ['none', 'revoked', 'expired', 'edited', 'paused'].flatMap(change => [[change, false], [change, true]])) {
  test(`actual R1 resume and guarded merge with ${change} ${fixedManifest ? 'fixed-manifest' : 'legacy'} authorization after green CI and Claude PASS`, async t => {
    const f = await r1Fixture(t, fixedManifest); if (!fixedManifest) await f.approve(); await f.run('release');
    const task = await f.jobs.submit({ project: 'demo', issue: 106 });
    f.store.moveTask(task.id, 'pending', 'running');
    const { createJobStore, createJob } = require('../src/autopilot-state');
    const original = createJobStore(f.project.stateDir);
    const job = createJob({ projectName: 'demo', repo: f.project.repo, issue: f.issue,
      branch: 'ralph/issue-106', worktreePath: path.join(f.project.worktreeRoot, 'issue-106'), now: original.now });
    require('../src/r1-failed-work').bindR1Parent(job, task.id);
    const head = 'a'.repeat(40), target = 'b'.repeat(40);
    Object.assign(job, { status: 'awaiting_ci', runs: 1, workspaceState: 'prepared',
      pr: { number: 200, url: 'https://github.com/owner/demo/pull/200' },
      delivery: { branch: job.branch, commit: head, pushed: true },
      verification: { command: 'npm test', commit: head, passed: true, exitCode: 0, timedOut: false, stdout: 'complete evidence', stderr: '' },
      integration: { headSha: head, targetSha: target } });
    original.save(job);
    let merges = 0, reviews = 0;
    Object.assign(f.deps, {
      synchronizeIssueBranch: async () => ({ changed: false }),
      observePullRequestCi: async () => ({ state: 'green', headCommit: head, prNumber: 200 }),
      reviewPullRequest: async () => {
        reviews++;
        if (change === 'edited') f.issue.body += 'changed';
        if (change === 'paused' || change === 'revoked') {
          const action = change === 'paused' ? 'pause' : 'revoke';
          const preview = await grantCommand(action, 'g1', f.options);
          await grantCommand(action, 'g1', { ...f.options, digest: preview.digest });
        }
        if (change === 'expired') {
          const db = f.db();
          if (change === 'revoked') db.grants.g1.state = 'revoked';
          else db.grants.g1.expiresAt = '2000-01-01T00:00:00.000Z';
          fs.writeFileSync(path.join(f.root, 'milestone-grants.json'), JSON.stringify(db));
        }
        return { reviewer: 'claude:sonnet', verdict: 'PASS', findings: [], commit: head };
      },
      observePullRequest: async () => ({ number: 200, state: 'OPEN', isCrossRepository: false,
        headRefName: job.branch, headRefOid: head, baseRefName: 'main' }),
      observeTargetSha: async () => target,
      mergePullRequest: async () => { merges++; return { mergeCommit: 'c'.repeat(40) }; },
      reconcileIssueClosure: async () => ({}),
      cleanupIssueWorkspace: async () => {},
      createRalphTaskService: () => { throw new Error('must not restart the worker'); },
    });
    f.jobs.advance(f.store.readTask(task.id, 'running')); await settled(f);
    const saved = original.load(106);
    assert.equal(reviews, 1, JSON.stringify({ events: f.events, tasks: f.tasks, saved }));
    assert.equal(saved.review.verdict, 'PASS'); assert.equal(saved.ci.state, 'green');
    assert.equal(saved.verification.stdout, 'complete evidence');
    assert.equal(merges, change === 'none' ? 1 : 0);
    if (change === 'none') assert.equal(f.jobs.read(task.id).status, 'merged');
    else {
      assert.equal(f.tasks.done.length, 0, 'authorization hold retains resumable queue work');
      assert.ok(saved.authorizationBlocked);
      assert.equal(f.tasks.running[0].cleanup, undefined, 'authorization holds retain work and labels');
      assert.ok(saved.failures.some(x => x.phase === 'authorization'));
      let cleanups = 0;
      await require('../src/autopilot').cleanupTerminalWorkspaces(f.project, original, async () => { cleanups++; }, () => {});
      assert.equal(cleanups, 0, 'later maintenance retains authorization-held worktrees');
      if (change === 'paused') {
        const before = [...f.events];
        const preview = await grantCommand('resume', 'g1', f.options);
        await grantCommand('resume', 'g1', { ...f.options, digest: preview.digest });
        const resumed = createR1Jobs(f.store, { projectsPath: f.options.projectsPath, autopilotDependencies: f.deps });
        resumed.recover(f.store.readTask(task.id, 'running'));
        f.store.moveTask(task.id, 'pending', 'running');
        resumed.advance(f.store.readTask(task.id, 'running'));
        const deadline = Date.now() + 5000;
        while (!original.load(106).terminal && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(original.load(106).terminal, true, 'resume must complete within five seconds');
        assert.equal(f.jobs.read(task.id).status, 'merged'); assert.equal(merges, 1); assert.equal(reviews, 1);
        assert.deepEqual(f.events.slice(0, before.length), before, 'restart preserves original transcript records');
      }
    }
  });
}

for (const damage of ['missing-store', 'invalid-json', 'unreadable-store', 'missing-receipt', 'invalid-receipt', 'revoked-receipt', 'missing-approval', 'changed-title', 'wrong-label', 'github-unavailable', 'changed-registration', 'changed-spec', 'paused']) {
  test(`actual R1 submit fails closed with durable diagnostic: ${damage}`, async t => {
    const f = await r1Fixture(t); await f.approve(); await f.run('release');
    const file = path.join(f.root, 'milestone-grants.json'), db = f.db();
    if (damage === 'missing-store') fs.unlinkSync(file);
    if (damage === 'invalid-json') fs.writeFileSync(file, '{');
    if (damage === 'unreadable-store') { fs.unlinkSync(file); fs.mkdirSync(file); }
    if (damage === 'missing-receipt') { db.grants.g1.receipts = {}; fs.writeFileSync(file, JSON.stringify(db)); }
    if (damage === 'invalid-receipt') { db.grants.g1.receipts['owner/demo#106'].issue.body += 'corrupt'; fs.writeFileSync(file, JSON.stringify(db)); }
    if (damage === 'revoked-receipt') { db.grants.g1.receipts['owner/demo#106'].revokedAt = new Date().toISOString(); fs.writeFileSync(file, JSON.stringify(db)); }
    if (damage === 'missing-approval') { db.grants.g1.ticketApprovals = {}; fs.writeFileSync(file, JSON.stringify(db)); }
    if (damage === 'changed-title') f.issue.title += 'changed';
    if (damage === 'wrong-label') f.issue.labels = [{ name: 'other' }];
    if (damage === 'github-unavailable') f.deps.execFile = (file, args, opts, cb) => cb(new Error('offline'), '', 'offline');
    if (damage === 'changed-registration') { const cfg = JSON.parse(fs.readFileSync(f.options.projectsPath)); cfg.alias = cfg.demo; fs.writeFileSync(f.options.projectsPath, JSON.stringify(cfg)); }
    if (damage === 'changed-spec') { db.grants.g1.spec.contentBase64 = Buffer.from('changed').toString('base64'); fs.writeFileSync(file, JSON.stringify(db)); }
    if (damage === 'paused') { db.grants.g1.state = 'paused'; fs.writeFileSync(file, JSON.stringify(db)); }
    await assert.rejects(async () => f.jobs.submit({ project: 'demo', issue: 106 }), /Milestone authorization blocked/);
    assert.equal(f.tasks.pending.length, 0);
    const diagnostic = JSON.parse(fs.readFileSync(path.join(f.root, 'milestone-admission.ndjson'), 'utf8').trim());
    assert.equal(diagnostic.issue, 106); assert.equal(diagnostic.code, 'MILESTONE_AUTHORIZATION_BLOCKED');
    assert.ok(diagnostic.message.length > 50);
  });
}
test('discovery admits a receipted issue through the same R1 submit interface', async t => {
  const f = await r1Fixture(t); await f.approve(); await f.run('release');
  assert.equal((await f.jobs.admit()).issue, 106);
  assert.equal(f.tasks.pending.length, 1);
});
test('receipts do not bypass exact-head independently reviewed merged prerequisite evidence', async t => {
  const f = await r1Fixture(t);
  f.issue.body += '\nDepends on: #105'; f.request.ticketDigest = ticketDigest(f.issue);
  await f.approve(); await f.run('release');
  await assert.rejects(async () => f.jobs.submit({ project: 'demo', issue: 106 }), /independently approved merged prerequisites/);
  const { createJobStore, createJob } = require('../src/autopilot-state');
  const original = createJobStore(f.project.stateDir), head = 'd'.repeat(40);
  const prerequisite = createJob({ projectName: 'demo', repo: f.project.repo, issue: { number: 105, title: 'Prerequisite' }, branch: 'ralph/issue-105', worktreePath: f.root, now: original.now });
  Object.assign(prerequisite, { status: 'merged', reviewAttempts: 1, terminal: true, terminalState: 'merged',
    delivery: { commit: head, pushed: true, branch: prerequisite.branch },
    merge: { prNumber: 199, approvedHead: head, commit: 'merge-sha', repo: f.project.repo, mergedAt: new Date().toISOString(), issueClosed: true },
    verification: { command: 'npm test', commit: head, passed: true, exitCode: 0, timedOut: false, stdout: '', stderr: '' },
    review: { reviewer: 'claude:sonnet', verdict: 'PASS', commit: head, findings: [], policy: 'always', reviewedAt: new Date().toISOString(), attempt: { number: 1, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() } },
    ci: { state: 'green', headCommit: head, prNumber: 199, details: null, observedAt: new Date().toISOString() } });
  original.save(prerequisite);
  assert.equal((await f.jobs.submit({ project: 'demo', issue: 106 })).issue, 106);
  prerequisite.ci.headCommit = 'stale'; original.save(prerequisite);
  await assert.rejects(async () => f.jobs.submit({ project: 'demo', issue: 106 }), /independently approved merged prerequisites/);
});

test('owner revocation during a GitHub read cannot authorize a stale receipt', async t => {
  const f = await r1Fixture(t); await f.approve(); await f.run('release');
  const gh = f.deps.execFile;
  f.deps.execFile = (file, args, opts, cb) => {
    const db = f.db(); db.grants.g1.state = 'revoked'; fs.writeFileSync(path.join(f.root, 'milestone-grants.json'), JSON.stringify(db));
    gh(file, args, opts, cb);
  };
  await assert.rejects(async () => f.jobs.submit({ project: 'demo', issue: 106 }), /changed during authorization/);
  assert.equal(f.tasks.pending.length, 0);
});

test('a queued R1 job cannot switch to a replacement receipt after submission', async t => {
  const f = await r1Fixture(t); await f.approve(); await f.run('release');
  const task = await f.jobs.submit({ project: 'demo', issue: 106 });
  assert.ok(task.milestoneAuthorization.receiptId);
  const db = f.db(), grant = db.grants.g1, prior = grant.receipts['owner/demo#106'].id;
  const replacement = crypto.randomUUID(); grant.receipts['owner/demo#106'].id = replacement;
  for (const event of grant.ticketEvents) if (event.receiptId === prior) event.receiptId = replacement;
  fs.writeFileSync(path.join(f.root, 'milestone-grants.json'), JSON.stringify(db));
  f.store.moveTask(task.id, 'pending', 'running');
  f.jobs.advance(f.store.readTask(task.id, 'running')); await settled(f);
  assert.equal(f.tasks.done.length, 0);
  assert.match(require('../src/autopilot-state').createJobStore(f.project.stateDir).load(106).authorizationBlocked.message, /receipt changed/);
});
test('expiration during the final GitHub read fails closed', async t => {
  const f = await r1Fixture(t); await f.approve(); await f.run('release');
  const realNow = Date.now, gh = f.deps.execFile;
  f.deps.execFile = (file, args, opts, cb) => {
    Date.now = () => Date.parse(f.db().grants.g1.expiresAt) + 1;
    gh(file, args, opts, cb);
  };
  try { await assert.rejects(async () => f.jobs.submit({ project: 'demo', issue: 106 }), /expired during authorization/); }
  finally { Date.now = realNow; }
});

for (const phase of ['implementation', 'implementation_review']) test(`canonical mixed launch rechecks milestone after ${phase} transition`, async t => {
  const f = await r1Fixture(t); await f.approve(); await f.run('release');
  f.project.autoMerge = false; f.project.verification = 'true';
  const cwd = f.project.checkout, launches = [];
  let transitions = 0;
  const deps = {
    milestoneOptions: f.options,
    jobStore: require('../src/autopilot-state').createJobStore(f.project.stateDir),
    loadProjectConfig: () => f.project,
    discoverReadyIssues: async () => [f.issue],
    checkMilestoneAuthorization: () => require('../src/milestone-admission').checkMilestoneAdmission('demo', f.project, 106, f.options),
    prepareIssueWorkspace: async () => ({ worktreePath: cwd, branch: 'ralph/issue-106', baseRef: 'main' }),
    cleanupIssueWorkspace: async () => {}, readRepositoryInstructions: async () => [],
    prepareRepositoryEnvironment: async () => {}, findOpenIssuePullRequests: async () => [],
    write() {},
    ralphOptions: { onPhaseChange: async current => {
      if (current !== phase) return;
      transitions++;
      if (phase === 'implementation_review' || transitions === 2) {
        const db = f.db(); db.grants.g1.state = 'revoked';
        fs.writeFileSync(path.join(f.root, 'milestone-grants.json'), JSON.stringify(db));
      }
    } },
    createRalphTaskService: options => require('../src/r1-loop-implementation').createR1LoopImplementation({
      ...options,
      config: { allowedProjects: { demo: cwd }, enginePaths: { codex: '/usr/bin/true', claude: '/usr/bin/true' } },
      execFileSync: (_file, args) => args[0] === 'rev-parse' ? 'a'.repeat(40) : '',
      // Only the external CLI is simulated; grant storage and the canonical
      // authorization/phase/implementation path are real.
      spawnImpl: (_file, args) => {
        const child = new (require('node:events').EventEmitter)();
        const { PassThrough } = require('node:stream');
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        launches.push(args);
        child.stdin.on('finish', () => {
          if (args.includes('--output-last-message')) fs.writeFileSync(args[args.indexOf('--output-last-message') + 1],
            'LOOP_RESULT {"status":"' + (phase === 'implementation' ? 'failed' : 'done') + '","summary":"implementation"}');
          child.stdout.end(); child.stderr.end();
          queueMicrotask(() => child.emit('close', 0, null));
        });
        return child;
      },
    }),
  };
  const result = await require('../src/autopilot').run(['--project', 'demo'], deps);
  assert.match(result.job.authorizationBlocked?.message || '', /revoked/);
  assert.equal(launches.length, 1, 'revocation must veto the next actual process');
  for (const name of ['PLAN.md', 'GUIDELINES.md', 'STATE.md']) assert.equal(fs.existsSync(path.join(cwd, name)), false);
});
