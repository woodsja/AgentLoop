const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { grantCommand } = require('../src/milestone-grants');
const { ticketCommand, ticketDigest } = require('../src/milestone-tickets');
async function fixture(t) {
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
  const grant = await grantCommand('draft', 'g1', options);
  await grantCommand('activate', 'g1', { ...options, digest: grant.digest });
  const issue = { number: 106, title: '[DRAFT] Add tests', body: 'Draft tests\n', state: 'open', labels: [], html_url: 'https://github.com/owner/demo/issues/106' };
  const request = { repo: 'owner/demo', issue: 106, grantDigest: grant.digest, revision: 1, spec: { identity: grant.spec.identity, digest: grant.spec.digest }, ticketDigest: ticketDigest(issue), category: 'tests', scope: 'in-scope', reason: 'Only adds tests; no deployment.' };
  const db = () => JSON.parse(fs.readFileSync(path.join(root, 'milestone-grants.json')));
  options.execFile = (file, args, opts, callback) => {
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

const { run: autopilot } = require('../src/autopilot');
const { createJobStore, createJob } = require('../src/autopilot-state');
const head = 'a'.repeat(40), target = 'b'.repeat(40);
async function householdFixture(t, body = '## Blocked by\nNone') {
  const f = await fixture(t);
  f.issue.body = body; f.request.ticketDigest = ticketDigest(f.issue);
  const project = { repo: 'owner/demo', checkout: path.join(f.root, 'repo'), readyLabel: 'custom-ready',
    enabled: true, baseBranch: 'main', worker: 'codex', reviewPolicy: 'always', autoMerge: true,
    dependencyFormat: 'household-blocked-by', milestoneAuthorization: true,
    worktreeRoot: path.join(f.root, 'worktrees'), stateDir: path.join(f.root, 'jobs') };
  const store = createJobStore(project.stateDir), lines = [];
  let workers = 0, merges = 0;
  const deps = { loadProjectConfig: () => project, jobStore: store, milestoneOptions: f.options,
    execFile: f.options.execFile, discoverReadyIssues: async () => [structuredClone(f.issue)], write: line => lines.push(line),
    findOpenIssuePullRequests: async () => [], cleanupIssueWorkspace: async () => {},
    prepareIssueWorkspace: async () => ({ worktreePath: path.join(f.root, 'work'), branch: 'ralph/issue-106', baseRef: 'origin/main' }),
    readRepositoryInstructions: async () => [], prepareRepositoryEnvironment: async () => ({}),
    createRalphTaskService: () => ({ run: async () => { workers++; return { status: 'passed', attempts: [] }; } }),
    deliverPassedWork: async () => ({ branch: 'ralph/issue-106', commit: head, pushed: true, pr: { number: 200, url: 'https://github.com/owner/demo/pull/200' } }),
    synchronizeIssueBranch: async () => ({ changed: false }),
    observePullRequestCi: async () => ({ state: 'green', headCommit: head, prNumber: 200 }),
    reviewPullRequest: async () => ({ reviewer: 'claude:sonnet', verdict: 'PASS', findings: [], commit: head }),
    observePullRequest: async () => ({ number: 200, state: 'OPEN', isCrossRepository: false, headRefName: 'ralph/issue-106', headRefOid: head, baseRefName: 'main' }),
    observeTargetSha: async () => target,
    mergePullRequest: async () => { merges++; return { mergeCommit: 'c'.repeat(40) }; },
    reconcileIssueClosure: async () => ({}),
  };
  const run = dry => autopilot(['--project', 'demo', ...(dry ? ['--dry-run'] : [])], deps);
  const release = async () => { await f.approve(); await f.run('release'); };
  const checkpoint = (number = 106, merged = false) => {
    const job = createJob({ projectName: 'demo', repo: project.repo, issue: { number, title: 'Synthetic' }, branch: 'ralph/issue-' + number, worktreePath: path.join(f.root, 'work'), now: store.now });
    Object.assign(job, { status: merged ? 'merged' : 'awaiting_ci', terminal: merged, terminalState: merged ? 'merged' : null,
      runs: 1, workspaceState: 'prepared', pr: { number: 200, url: 'https://github.com/owner/demo/pull/200' },
      delivery: { branch: job.branch, commit: head, pushed: true },
      verification: { command: 'npm test', commit: head, passed: true, exitCode: 0, timedOut: false, stdout: 'verbatim evidence', stderr: '' },
      integration: { headSha: head, targetSha: target } });
    if (merged) Object.assign(job, {
      reviewAttempts: 1,
      review: { reviewer: 'claude:sonnet', verdict: 'PASS', commit: head, findings: [], policy: 'always', reviewedAt: store.now(), attempt: { number: 1, startedAt: store.now(), completedAt: store.now() } },
      ci: { state: 'green', headCommit: head, prNumber: 200, details: null, observedAt: store.now() },
      merge: { prNumber: 200, approvedHead: head, commit: 'c'.repeat(40), repo: project.repo, mergedAt: store.now(), issueClosed: true },
    });
    store.save(job); return job;
  };
  return { ...f, project, store, lines, deps, execute: run, release, checkpoint, counts: () => ({ workers, merges }),
    diagnostics: () => fs.readFileSync(path.join(f.root, 'milestone-admission.ndjson'), 'utf8').trim().split('\n').map(JSON.parse) };
}

test('read-only Household selection proves ALLOW, WAIT, NEEDS_APPROVAL and DENY with durable blockers', async t => {
  const f = await householdFixture(t, '## Blocked by\n- #105: prerequisite');
  f.issue.labels = [{ name: 'custom-ready' }];
  assert.equal(await f.execute(true), null);
  assert.equal(f.diagnostics().at(-1).decision, 'WAIT');
  f.checkpoint(105, true);
  assert.equal(await f.execute(true), null);
  assert.equal(f.diagnostics().at(-1).decision, 'NEEDS_APPROVAL');
  f.issue.labels = []; await f.release();
  const before = fs.readFileSync(path.join(f.root, 'milestone-grants.json'), 'utf8');
  assert.equal((await f.execute(true)).number, 106);
  assert.ok(f.lines.some(line => line.startsWith('ALLOW:')));
  assert.equal(fs.readFileSync(path.join(f.root, 'milestone-grants.json'), 'utf8'), before);
  f.issue.title += ' changed';
  assert.equal(await f.execute(true), null);
  assert.equal(f.diagnostics().at(-1).decision, 'DENY');
  assert.equal(f.store.load(106), null);
  assert.deepEqual(f.counts(), { workers: 0, merges: 0 });
  assert.equal(f.writes.length, 1, 'only explicit synthetic release writes GitHub');
});

test('malformed Household metadata is a durable WAIT and never starts work', async t => {
  const f = await householdFixture(t, '## Blocked by\n- other/repo#1');
  assert.equal(await f.execute(false), null);
  assert.match(f.diagnostics().at(-1).message, /dependency metadata blocked/);
  assert.equal(f.diagnostics().at(-1).decision, 'WAIT');
  assert.deepEqual(f.counts(), { workers: 0, merges: 0 });
});

for (const change of ['none', 'edited', 'revoked', 'expired', 'receipt', 'dependency']) {
  test(`Household actual resume and guarded merge rechecks ${change}`, async t => {
    const f = await householdFixture(t, '## Blocked by\n- #105: prerequisite');
    f.checkpoint(105, true); await f.release();
    f.checkpoint();
    f.deps.reviewPullRequest = async () => {
      if (change === 'edited') f.issue.body += '\nChanged scope';
      if (change === 'dependency') { const job = f.store.load(105); job.ci.headCommit = 'stale'; f.store.save(job); }
      if (['revoked', 'expired', 'receipt'].includes(change)) {
        const db = f.db();
        if (change === 'revoked') db.grants.g1.state = 'revoked';
        if (change === 'expired') db.grants.g1.expiresAt = '2000-01-01T00:00:00.000Z';
        if (change === 'receipt') db.grants.g1.receipts['owner/demo#106'].id = crypto.randomUUID();
        fs.writeFileSync(path.join(f.root, 'milestone-grants.json'), JSON.stringify(db));
      }
      return { reviewer: 'claude:sonnet', verdict: 'PASS', findings: [], commit: head };
    };
    const result = await f.execute(false);
    assert.equal(result.job.review.verdict, 'PASS');
    assert.equal(f.counts().merges, change === 'none' ? 1 : 0);
    assert.equal(f.counts().workers, 0);
    assert.equal(f.store.load(106).verification.stdout, 'verbatim evidence');
    if (change !== 'none') assert.ok(f.store.load(106).authorizationBlocked);
    await f.execute(false);
    assert.equal(f.counts().merges, change === 'none' ? 1 : 0, 'no duplicate merge or admission');
  });
}

test('Household worker admission checks again after preparation and preserves labels and workspace', async t => {
  const f = await householdFixture(t); await f.release();
  f.deps.prepareRepositoryEnvironment = async () => { f.issue.title += ' changed'; return {}; };
  const result = await f.execute(false);
  assert.equal(result.outcome.deliverable, false);
  assert.ok(f.store.load(106).authorizationBlocked);
  assert.equal(f.store.load(106).workspaceState, 'prepared');
  assert.deepEqual(f.counts(), { workers: 0, merges: 0 });
  assert.deepEqual(f.issue.labels, [{ name: 'custom-ready' }]);
});

test('legitimate Household work advances once through the existing worker and resumes without duplicate admission', async t => {
  const f = await householdFixture(t); await f.release();
  const result = await f.execute(false);
  assert.equal(result.job.status, 'awaiting_ci');
  assert.ok(result.job.milestoneAuthorization.receiptId);
  // Record exact verification as the real worker would before the merge pass.
  const job = f.store.load(106);
  job.verification = { command: 'npm test', commit: head, passed: true, exitCode: 0, timedOut: false, stdout: 'worker verification', stderr: '' };
  job.integration = { headSha: head, targetSha: target }; f.store.save(job);
  await f.execute(false); await f.execute(false);
  assert.deepEqual(f.counts(), { workers: 1, merges: 1 });
});

for (const damage of ['missing', 'ambiguous', 'out-of-scope', 'stale-body', 'wrong-repository', 'registration', 'missing-approval']) {
  test(`ready-labeled Household selection blocks ${damage} after prerequisites merge`, async t => {
    const f = await householdFixture(t, '## Blocked by\n- #105: prerequisite');
    f.checkpoint(105, true); await f.release();
    const db = f.db();
    if (damage === 'missing') db.grants.g1.receipts = {};
    if (damage === 'ambiguous') db.grants.g2 = structuredClone(db.grants.g1);
    if (damage === 'out-of-scope') db.grants.g1.receipts['owner/demo#106'].request.scope = 'excluded';
    if (damage === 'stale-body') f.issue.body += '\nExtra work';
    if (damage === 'wrong-repository') f.issue.html_url = 'https://github.com/elsewhere/demo/issues/106';
    if (damage === 'registration') {
      const projects = JSON.parse(fs.readFileSync(f.options.projectsPath));
      projects.demo.repo = 'elsewhere/demo'; fs.writeFileSync(f.options.projectsPath, JSON.stringify(projects));
    }
    if (damage === 'missing-approval') db.grants.g1.ticketApprovals = {};
    fs.writeFileSync(path.join(f.root, 'milestone-grants.json'), JSON.stringify(db));
    assert.equal(await f.execute(false), null);
    assert.equal(f.store.load(106), null);
    assert.ok(f.diagnostics().at(-1).message.includes('blocked'));
    assert.deepEqual(f.counts(), { workers: 0, merges: 0 });
    assert.deepEqual(f.issue.labels, [{ name: 'custom-ready' }]);
  });
}

test('R1 scanner yields receipted Household work to its existing autopilot', async t => {
  const f = await householdFixture(t); await f.release();
  const { createR1Jobs } = require('../src/r1-jobs');
  const { configuredProjects } = require('../src/project-registry');
  const store = { paths: { config: f.options.configPath, state: f.root },
    config: { allowedProjects: configuredProjects({ demo: f.project.checkout }, f.options.configPath) },
    listTasks: () => [], enqueueTask: () => { throw new Error('R1 must not enqueue Household work'); } };
  const jobs = createR1Jobs(store, { projectsPath: f.options.projectsPath, admitIntervalMs: 0,
    autopilotDependencies: { loadProjectConfig: () => f.project,
      discoverReadyIssues: async () => { throw new Error('R1 must not scan Household'); } } });
  assert.equal(await jobs.admit(), null);
  assert.equal((await f.execute(true)).number, 106);
});
