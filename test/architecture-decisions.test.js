'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/autopilot');
const { runTask } = require('../src/task-loop');
const { createJobStore, selectIssueForJobs } = require('../src/autopilot-state');
const { selectReadyIssue } = require('../src/autopilot-github');
const decisions = require('../src/architecture-decisions');
const proposal = { key: 'durable-format', problem: 'Choose durable event storage', options: [{ name: 'SQL', tradeoffs: 'Migration cost; transactions' }, { name: 'Journal', tradeoffs: 'Simple append; compaction cost' }], recommendation: 'SQL', consequences: 'Data migration', conflicts: 'None; preserve accepted host boundary', grantImplications: 'No additional grants requested; any new scope requires owner approval', newEvidence: '', settledDecision: false, expensiveToReverse: true, surprisingWithoutContext: true, genuineTradeoff: true };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.ralph'));
  fs.mkdirSync(path.join(root, 'docs/decisions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/decisions/0001.md'), 'Accepted: complete owner logs, protect physical host.');
  fs.writeFileSync(path.join(root, 'README.md'), 'Project terminology: R1 job.');
  const store = createJobStore(path.join(root, 'state'));
  const issues = [1, 2].map(number => ({ number, title: `Work ${number}`, body: 'Implement the independently authorized feature with tests.' }));
  const project = { enabled: true, autoMerge: true, architectureDecisions: true, decisionOwner: 'owner', repo: 'example/repo', checkout: root, worktreeRoot: root, baseBranch: 'main', readyLabel: 'ready-for-agent', humanLabel: 'human', worker: 'codex', reviewPolicy: 'always', verification: 'node -e "process.stdout.write(\'verified\')"' };
  const configPath = path.join(root, 'config.json'), projectsPath = path.join(root, 'projects.json');
  fs.writeFileSync(configPath, JSON.stringify({ allowedProjects: { demo: root } }));
  fs.writeFileSync(projectsPath, JSON.stringify({ demo: project }));
  const remote = [], calls = []; let loseCreate = false, failAssignment = false;
  const execFile = (file, args, options, cb) => {
    calls.push(args);
    const original = issues.find(i => args[1] === `repos/example/repo/issues/${i.number}`);
    if (original) return cb(null, JSON.stringify({ ...original, state: 'open', html_url: `https://github.com/example/repo/issues/${original.number}`, labels: [{ name: 'ready-for-agent' }] }));
    if (args.includes('--include')) return cb(null, pageResponse(remote));
    if (args.includes('--slurp')) return cb(null, JSON.stringify([remote]));
    if (args.includes('POST')) {
      const issue = { state: 'open', number: 50, html_url: 'https://github.com/example/repo/issues/50', body: args.find(a => a.startsWith('body=')).slice(5), assignees: [] };
      remote.push(issue);
      return loseCreate ? cb(new Error('connection lost'), '', 'lost create response') : cb(null, JSON.stringify(issue));
    }
    if (args.includes('--add-assignee') && failAssignment) return cb(new Error('forbidden'), '', 'assignment forbidden');
    cb(null, '');
  };
  const dependencies = { milestoneOptions: { configPath, projectsPath, stateDir: root }, loadProjectConfig: () => project, jobStore: store, discoverReadyIssues: async () => issues,
    findOpenIssuePullRequests: async () => [], prepareIssueWorkspace: async (p, i) => ({ branch: `ralph/issue-${i.number}`, worktreePath: root, baseRef: 'main' }),
    prepareRepositoryEnvironment: async () => ({}), readRepositoryInstructions: async () => [], execFile, write: () => {},
    cleanupIssueWorkspace: async () => { if (fs.existsSync(path.join(root, 'worker-state.json'))) throw new Error('Paused evidence must survive'); },
    createRalphTaskService: () => ({ run: async (cwd, task) => {
      assert.match(task.goal, /Accepted: complete owner logs/); assert.match(task.goal, /Project terminology/);
      return runTask(cwd, task, { runWorker: async () => { fs.writeFileSync(path.join(cwd, decisions.FILE), JSON.stringify(proposal)); return { stdout: 'complete worker evidence', stderr: 'worker diagnostics', exitCode: 0 }; }, onStateChange: state => fs.writeFileSync(path.join(root, 'worker-state.json'), JSON.stringify(state)) });
    } }), deliverPassedWork: async () => { throw new Error('Premature delivery'); }, mergePullRequest: async () => { throw new Error('Premature merge'); } };
  return { root, store, project, issues, remote, calls, dependencies, loseCreate: () => { loseCreate = true; }, failAssignment: () => { failAssignment = true; } };
}
test('real worker escalation pauses durably, publishes once, retains logs and leaves independent work eligible', async t => {
  const f = fixture(t);
  const result = await run(['--project', 'demo'], f.dependencies);
  assert.equal(result.outcome.status, 'paused_owner_decision');
  let saved = createJobStore(f.store.directory).load(1);
  assert.equal(saved.terminalState, 'paused_owner_decision'); assert.equal(saved.workspaceState, 'decision_retained');
  assert.equal(saved.delivery.pushed, false); assert.equal(saved.verification, null);
  assert.equal(saved.architectureDecision.notification.status, 'assigned');
  assert.match(f.remote[0].body, /issues\/1/); assert.match(f.remote[0].body, /Grant implications/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'worker-state.json'))).attempts[0].worker.stdout, 'complete worker evidence');
  assert.equal(selectIssueForJobs(f.issues, f.store.list(), selectReadyIssue).issue.number, 2);
  const dependent = { number: 3, title: 'Dependent implementation', body: 'Depends on: #1' };
  const eligible = require('../src/r1-dependencies').eligibleIssues([f.issues[1], dependent], f.store.list(), 'demo', f.project.repo);
  assert.deepEqual(eligible.map(i => i.number), [2]);
  await decisions.publish(f.project, saved, f.store, { execFile: f.dependencies.execFile });
  assert.equal(f.remote.length, 1); assert.equal(f.calls.filter(a => a.includes('--add-assignee')).length, 1);
  assert.ok(!f.calls.some(a => a[a.indexOf('--add-label') + 1] === 'ready-for-agent' && a.includes('--add-label')));
});
test('lost creation response and failed assignment reconcile without duplicate issue or repeated notification', async t => {
  const f = fixture(t); f.loseCreate(); f.failAssignment();
  await run(['--project', 'demo'], f.dependencies);
  let saved = f.store.load(1); assert.match(saved.architectureDecision.publicationError, /lost create response/);
  await decisions.reconcile(f.project, f.store, { execFile: f.dependencies.execFile });
  saved = f.store.load(1); assert.equal(saved.architectureDecision.publication, 'complete');
  assert.equal(saved.architectureDecision.notification.status, 'failed');
  await decisions.reconcile(f.project, f.store, { execFile: f.dependencies.execFile });
  assert.equal(f.remote.length, 1); assert.equal(f.calls.filter(a => a.includes('--add-assignee')).length, 1);
  assert.equal(saved.status, 'paused_owner_decision');
});
test('reversible and settled choices continue through actual verification; opt-out ignores proposal', async t => {
  const f = fixture(t);
  for (const [enabled, p] of [[true, { ...proposal, expensiveToReverse: false }], [true, { ...proposal, settledDecision: true }], [false, proposal]]) {
    const result = await runTask(f.root, { id: 'ordinary', goal: 'local choice', acceptance: ['works'], worker: 'codex', verification: f.project.verification, ...(enabled ? { architectureDecisions: true } : {}) }, { runWorker: async () => { fs.writeFileSync(path.join(f.root, decisions.FILE), JSON.stringify(p)); return { exitCode: 0 }; } });
    assert.equal(result.status, 'passed'); assert.equal(result.attempts[0].verification.passed, true);
  }
  assert.equal(f.remote.length, 0);
});
test('ambiguous create without a remote match never retries POST or authorizes work', async t => {
  const f = fixture(t); f.loseCreate();
  await run(['--project', 'demo'], f.dependencies);
  f.remote.length = 0;
  await decisions.reconcile(f.project, f.store, { execFile: f.dependencies.execFile });
  await decisions.reconcile(f.project, f.store, { execFile: f.dependencies.execFile });
  assert.equal(f.calls.filter(a => a.includes('POST')).length, 1);
  assert.match(f.store.load(1).architectureDecision.publicationError, /uncertain/);
  assert.equal(selectIssueForJobs(f.issues, f.store.list(), selectReadyIssue).issue.number, 2);
});
test('interrupted assignment is observed, never blindly replayed', async t => {
  const f = fixture(t); await run(['--project', 'demo'], f.dependencies);
  const saved = f.store.load(1);
  saved.architectureDecision.publication = 'pending';
  saved.architectureDecision.notification.status = 'attempting'; f.store.save(saved);
  await decisions.reconcile(f.project, f.store, { execFile: f.dependencies.execFile });
  assert.equal(f.store.load(1).architectureDecision.notification.status, 'uncertain');
  assert.equal(f.calls.filter(a => a.includes('--add-assignee')).length, 1);
});
test('restart recovers a completed proposal before workspace cleanup or another worker', async t => {
  const f = fixture(t); await run(['--project', 'demo'], f.dependencies);
  const interrupted = f.store.load(1);
  delete interrupted.architectureDecision;
  interrupted.status = 'running'; interrupted.ralph.status = 'running';
  interrupted.workspaceState = 'prepared'; interrupted.terminal = false; interrupted.terminalState = null;
  f.store.save(interrupted);
  f.dependencies.createRalphTaskService = () => { throw new Error('Must not rerun worker'); };
  const result = await run(['--project', 'demo'], f.dependencies);
  assert.equal(result.job.status, 'paused_owner_decision');
  assert.equal(f.remote.length, 1);
  const { evidence, nextAction } = require('../src/r1-status');
  assert.equal(evidence(result.job).architectureDecision.issue.number, 50);
  assert.equal(nextAction({ status: 'paused_owner_decision' }, evidence(result.job)).action, 'owner_decision');
});

function pageResponse(items, next) {
  return 'HTTP/2.0 200 OK\r\n' + (next ? `Link: <https://api.github.com/repos/example/repo/issues?state=all&sort=created&direction=asc&per_page=10&page=${next}>; rel="next"\r\n` : '') + '\r\n' + JSON.stringify(items);
}
function historyIssue(number, body = '') {
  return { number, body, state: 'closed', html_url: `https://github.com/example/repo/issues/${number}` };
}
async function pausedFixture(t) {
  const f = fixture(t);
  await run(['--project', 'demo'], f.dependencies);
  const job = f.store.load(1);
  job.architectureDecision.publication = 'pending';
  delete job.architectureDecision.issue;
  job.architectureDecision.notification = { status: 'pending', attempts: [] };
  delete job.architectureDecision.createAttempted;
  f.store.save(job);
  return { ...f, job };
}
test('public reconciliation scans over 1 MiB across all pages before accepting a closed exact marker', async t => {
  const f = await pausedFixture(t), marker = f.job.architectureDecision.marker;
  const pages = Array.from({ length: 3 }, (_, page) => Array.from({ length: 10 }, (_, i) => historyIssue(page * 10 + i + 100, 'x'.repeat(45000))));
  pages[1][4].body = marker;
  assert.ok(Buffer.byteLength(JSON.stringify(pages)) > 1024 * 1024);
  const reads = [], writes = [];
  const execFile = (file, args, options, cb) => {
    assert.equal(options.maxBuffer, 1024 * 1024);
    if (args.includes('--slurp')) {
      const aggregate = JSON.stringify(pages);
      return cb(Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), aggregate.slice(0, options.maxBuffer), '');
    }
    if (args.includes('--include')) {
      const endpoint = args.at(-1);
      assert.match(endpoint, /state=all&sort=created&direction=asc&per_page=10&page=/);
      const page = Number(new URL('https://api.github.com/' + endpoint).searchParams.get('page'));
      reads.push(page);
      return cb(null, pageResponse(pages[page - 1], page < 3 ? page + 1 : null));
    }
    assert.equal(reads.length, 3, 'no write before complete scan');
    writes.push(args); cb(null, '');
  };
  await decisions.reconcile(f.project, f.store, { execFile });
  const saved = f.store.load(1);
  assert.deepEqual(reads, [1, 2, 3]);
  assert.equal(saved.architectureDecision.issue.number, 114);
  assert.equal(saved.architectureDecision.publication, 'complete');
  assert.ok(!writes.some(a => a.includes('POST')));
  assert.deepEqual(saved.architectureDecision.pausedExecution, f.job.architectureDecision.pausedExecution);
  assert.equal(saved.worktreePath, f.job.worktreePath);
  assert.deepEqual(saved.admission, f.job.admission);
  assert.equal(saved.runs, f.job.runs);
  assert.equal(saved.status, 'paused_owner_decision');
});
for (const scenario of ['duplicate markers', 'duplicate number', 'timeout', 'resource limit', 'garbled', 'partial', 'bad shape', 'PR and near matches', 'uncertain POST']) {
  test(`history scan fails closed: ${scenario}`, async t => {
    const f = await pausedFixture(t), marker = f.job.architectureDecision.marker;
    if (['PR and near matches', 'uncertain POST'].includes(scenario)) {
      f.job.architectureDecision.createAttempted = true; f.store.save(f.job);
    }
    let reads = 0;
    const writes = [];
    const execFile = (file, args, options, cb) => {
      if (!args.includes('--include')) { writes.push(args); return cb(new Error('Unexpected write')); }
      reads++;
      if (reads === 1) return cb(null, pageResponse(Array.from({ length: 10 }, (_, i) => historyIssue(100 + i, i === 0 && !['PR and near matches', 'uncertain POST'].includes(scenario) ? marker : '')), 2));
      if (scenario === 'timeout' || scenario === 'resource limit') return cb(Object.assign(new Error('page read failed'), { code: scenario === 'timeout' ? 'ETIMEDOUT' : 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), '', 'raw diagnostics');
      if (scenario === 'garbled') return cb(null, 'HTTP/2.0 200 OK\r\n\r\n{broken');
      if (scenario === 'partial') return cb(null, pageResponse([], 3));
      if (scenario === 'bad shape') return cb(null, pageResponse([{}]));
      const items = scenario === 'duplicate markers' ? [historyIssue(200, marker)] : scenario === 'duplicate number' ? [historyIssue(100)] : scenario === 'PR and near matches' ? [ { ...historyIssue(200, marker), pull_request: {} }, historyIssue(201, marker + 'suffix'), historyIssue(202, marker.replace(' -->', 'x -->')) ] : [];
      cb(null, pageResponse(items));
    };
    await decisions.reconcile(f.project, f.store, { execFile });
    const saved = f.store.load(1);
    assert.ok(saved.architectureDecision.publicationError);
    if (scenario === 'resource limit' || scenario === 'timeout') {
      assert.equal(saved.architectureDecision.publicationFailure.code, 'AUTOPILOT_GITHUB_TRANSPORT');
      assert.equal(saved.architectureDecision.publicationFailure.cause.code, scenario === 'timeout' ? 'ETIMEDOUT' : 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    }
    assert.equal(saved.architectureDecision.publication, 'pending');
    assert.equal(saved.architectureDecision.notification.status, 'pending');
    assert.deepEqual(saved.architectureDecision.pausedExecution, f.job.architectureDecision.pausedExecution);
    assert.equal(saved.status, 'paused_owner_decision');
    assert.equal(reads, 2);
    assert.deepEqual(writes, []);
  });
}

test('complete marker-free scan precedes POST; ambiguous response is durable and never notifies or retries create', async t => {
  const f = await pausedFixture(t);
  let reads = 0, posts = 0;
  const execFile = (_file, args, _options, cb) => {
    if (args.includes('--include')) {
      reads++;
      return cb(null, pageResponse(reads % 2 ? Array.from({ length: 10 }, (_, i) => i === 0
        ? { ...historyIssue(100, f.job.architectureDecision.marker), pull_request: {} }
        : historyIssue(100 + i, f.job.architectureDecision.marker + 'suffix')) : [], reads % 2 ? 2 : null));
    }
    assert.equal(reads, 2);
    if (args.includes('POST')) {
      posts++;
      assert.equal(f.store.load(1).architectureDecision.createAttempted, true);
      return cb(null, JSON.stringify(historyIssue(300, 'unrelated body')));
    }
    assert.equal(args[0], 'label', 'ambiguous issue must never be edited or assigned');
    cb(null, '');
  };
  await decisions.publish(f.project, f.job, f.store, { execFile });
  const saved = f.store.load(1);
  assert.match(saved.architectureDecision.publicationError, /ambiguous/);
  assert.equal(saved.architectureDecision.createAttempted, true);
  await decisions.reconcile(f.project, createJobStore(f.store.directory), { execFile });
  assert.equal(reads, 4);
  assert.equal(posts, 1);
  assert.match(f.store.load(1).architectureDecision.publicationError, /uncertain/);
});
test('a later page cannot terminate before the previously advertised last page', async t => {
  const f = await pausedFixture(t);
  let reads = 0;
  const writes = [];
  await decisions.reconcile(f.project, f.store, { execFile: (_file, args, _options, cb) => {
    if (!args.includes('--include')) { writes.push(args); return cb(new Error('Unexpected write')); }
    reads++;
    const first = pageResponse(Array.from({ length: 10 }, (_, i) => historyIssue(100 + i)), 2)
      .replace('; rel="next"', '; rel="next", <https://api.github.com/repos/example/repo/issues?state=all&sort=created&direction=asc&per_page=10&page=3>; rel="last"');
    cb(null, reads === 1 ? first : pageResponse([]));
  } });
  assert.equal(reads, 2);
  assert.match(f.store.load(1).architectureDecision.publicationError, /Partial decision history pagination/);
  assert.deepEqual(writes, []);
});
for (const response of [
  '[]',
  'HTTP/2.0 206 Partial Content\r\n\r\n[]',
  'HTTP/2.0 200 OK\r\nLink: broken\r\n\r\n[]',
  pageResponse([], 1),
  pageResponse([], 2).replace('rel="next"', 'rel="last"'),
  pageResponse([], 2).replace('state=all', 'state=open'),
  pageResponse([], 2).replace('api.github.com', 'unrelated.example'),
]) {
  test('invalid pagination or HTTP response stops publication before any write', async t => {
    const f = await pausedFixture(t);
    const writes = [];
    await decisions.publish(f.project, f.job, f.store, { execFile: (_file, args, _opts, cb) => {
      if (!args.includes('--include')) writes.push(args);
      cb(null, response);
    } });
    assert.ok(f.store.load(1).architectureDecision.publicationError);
    assert.equal(f.store.load(1).architectureDecision.notification.status, 'pending');
    assert.deepEqual(writes, []);
  });
}
