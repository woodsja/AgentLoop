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
    if (args.includes('--include')) return historyReply(cb, null, pageResponse(remote));
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
function cursorUrl(page, relation = 'next', collection = 'repos/example/repo/issues', host = 'api.github.com') {
  // GitHub REST cursor header structure; cursor bytes are anonymized.
  return `https://${host}/${collection}?state=all&sort=created&direction=asc&per_page=10&${relation === 'prev' ? 'before' : 'after'}=Y3Vyc29yOnYyOpHO%2B%2F${page}%3D&page=${page}`;
}
function cursorResponse(items, page, count, collection, host) {
  const links = [];
  if (page < count) links.push(`<${cursorUrl(page + 1, 'next', collection, host)}>; rel="next"`);
  if (page > 1) links.push(`<${cursorUrl(page - 1, 'prev', collection, host)}>; rel="prev"`);
  return 'HTTP/2.0 200 OK\r\n' + (links.length ? `Link: ${links.join(', ')}\r\n` : '') + '\r\n' + JSON.stringify(items);
}
for (const collection of ['repos/example/repo/issues', 'repositories/123456/issues', 'repos/EXAMPLE/Repo/issues']) {
  test(`authentic cursor headers scan 17 pages verbatim and over 1 MiB: ${collection}`, async t => {
    const f = await pausedFixture(t);
    if (collection === 'repos/example/repo/issues') {
      f.job.architectureDecision.createAttempted = true;
      f.job.architectureDecision.notification.status = 'assigned';
      f.store.save(f.job);
    }
    const pages = Array.from({ length: 17 }, (_, page) => Array.from({ length: page === 16 ? 1 : 10 }, (_, i) => historyIssue(100 + page * 10 + i, 'x'.repeat(7500))));
    pages[1][4].body = f.job.architectureDecision.marker;
    assert.ok(Buffer.byteLength(JSON.stringify(pages)) > 1024 * 1024);
    let reads = 0, metadata = 0;
    const writes = [];
    await decisions.reconcile(f.project, f.store, { execFile: (_file, args, options, cb) => {
      assert.equal(options.maxBuffer, 1024 * 1024);
      if (args.at(-1) === 'repos/example/repo') { metadata++; return historyReply(cb, null, 'HTTP/2.0 200 OK\r\n\r\n' + JSON.stringify({ id: 123456, full_name: 'example/repo' })); }
      if (args.includes('--include')) {
        assert.equal(args.at(-1), reads === 0 ? 'repos/example/repo/issues?state=all&sort=created&direction=asc&per_page=10&page=1' : cursorUrl(reads + 1, 'next', collection));
        reads++;
        return historyReply(cb, null, cursorResponse(pages[reads - 1], reads, 17, collection));
      }
      assert.equal(reads, 17);
      writes.push(args); cb(null, '');
    } });
    const saved = f.store.load(1);
    assert.equal(saved.architectureDecision.publicationError, undefined);
    assert.equal(reads, 17);
    assert.equal(metadata, collection.startsWith('repositories') ? 1 : 0);
    assert.equal(saved.architectureDecision.issue.number, 114);
    assert.ok(!writes.some(a => a.includes('POST')));
    if (collection === 'repos/example/repo/issues') assert.ok(!writes.some(a => a.includes('--add-assignee')));
    for (const key of ['project', 'issue', 'id', 'worktreePath', 'admission', 'runs', 'errors', 'status']) assert.deepEqual(saved[key], f.job[key]);
    assert.deepEqual(saved.architectureDecision.pausedExecution, f.job.architectureDecision.pausedExecution);
  });
}
test('publication failure is durable even when the execution recorder throws', async t => {
  const f = await pausedFixture(t);
  const { withExecution } = require('../src/execution-log');
  await assert.rejects(withExecution(() => { throw new Error('recorder unavailable'); }, () =>
    decisions.publish(f.project, f.job, f.store, { execFile: (_file, _args, _options, cb) => {
      cb(Object.assign(new Error('page read timed out'), { code: 'ETIMEDOUT' }), '', '');
    } })), /recorder unavailable/);
  const saved = f.store.load(1);
  assert.match(saved.architectureDecision.publicationError, /ETIMEDOUT/);
  assert.equal(saved.architectureDecision.publicationFailure.cause.code, 'ETIMEDOUT');
  assert.equal(saved.architectureDecision.publication, 'pending');
  assert.equal(saved.architectureDecision.createAttempted, undefined);
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
      if (reads === 1) return historyReply(cb, null, pageResponse(Array.from({ length: 10 }, (_, i) => historyIssue(100 + i, i === 0 && !['PR and near matches', 'uncertain POST'].includes(scenario) ? marker : '')), 2));
      if (scenario === 'timeout' || scenario === 'resource limit') return cb(Object.assign(new Error('page read failed'), { code: scenario === 'timeout' ? 'ETIMEDOUT' : 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), '', 'raw diagnostics');
      if (scenario === 'garbled') return historyReply(cb, null, 'HTTP/2.0 200 OK\r\n\r\n{broken');
      if (scenario === 'partial') return historyReply(cb, null, pageResponse([], 3));
      if (scenario === 'bad shape') return historyReply(cb, null, pageResponse([{}]));
      const items = scenario === 'duplicate markers' ? [historyIssue(200, marker)] : scenario === 'duplicate number' ? [historyIssue(100)] : scenario === 'PR and near matches' ? [ { ...historyIssue(200, marker), pull_request: {} }, historyIssue(201, marker + 'suffix'), historyIssue(202, marker.replace(' -->', 'x -->')), historyIssue(203, 'embedded ' + marker), historyIssue(204, marker.replace(/:[a-f0-9]/, ':z')) ] : [];
      historyReply(cb, null, pageResponse(items));
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
      return historyReply(cb, null, pageResponse(reads % 2 ? Array.from({ length: 10 }, (_, i) => i === 0
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
    historyReply(cb, null, reads === 1 ? first : pageResponse([]));
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
  pageResponse([], 2).replace('repos/example/repo/issues', 'repos/example/other/issues'),
  pageResponse([], 2).replace('repos/example/repo/issues', 'repositories/not-a-number/issues'),
  pageResponse([], 2).replace('https:', 'http:'),
]) {
  test('invalid pagination or HTTP response stops publication before any write', async t => {
    const f = await pausedFixture(t);
    const writes = [];
    await decisions.publish(f.project, f.job, f.store, { execFile: (_file, args, _opts, cb) => {
      if (!args.includes('--include')) writes.push(args);
      historyReply(cb, null, response);
    } });
    assert.ok(f.store.load(1).architectureDecision.publicationError);
    assert.equal(f.store.load(1).architectureDecision.notification.status, 'pending');
    assert.deepEqual(writes, []);
  });
}

const unsafeTargets = {
  'foreign named repository': url => url.replace('example/repo', 'example/foreign'),
  'foreign numeric repository': url => url.replace('repos/example/repo', 'repositories/654321'),
  'unknown numeric identity': url => url.replace('repos/example/repo', 'repositories/123456'),
  'foreign host': url => url.replace('api.github.com', 'evil.example'),
  'HTTP': url => url.replace('https:', 'http:'),
  'credentials': url => url.replace('https://', 'https://user:password@'),
  'fragment': url => url + '#hidden',
  'port': url => url.replace('api.github.com', 'api.github.com:8443'),
  'substituted endpoint': url => url.replace('/issues?', '/pulls?'),
  'unapproved public API prefix': url => url.replace('/repos/', '/api/v3/repos/'),
  'state': url => url.replace('state=all', 'state=open'),
  'sort': url => url.replace('sort=created', 'sort=updated'),
  'direction': url => url.replace('direction=asc', 'direction=desc'),
  'page size': url => url.replace('per_page=10', 'per_page=100'),
  'duplicate parameter': url => url + '&state=open',
  'duplicate cursor': url => url + '&after=other',
  'ambiguous cursors': url => url + '&before=other',
  'unrelated key': url => url + '&labels=ready',
  'empty cursor': url => url.replace(/after=[^&]*/, 'after='),
  'malformed encoding': url => url.replace(/after=[^&]*/, 'after=%XX'),
  'cursor control': url => url.replace(/after=[^&]*/, 'after=%00'),
  'backward page': url => url.replace('page=2', 'page=1'),
};
for (const [name, mutate] of Object.entries(unsafeTargets)) {
  test(`unsafe continuation fails closed: ${name}`, async t => {
    const f = await pausedFixture(t), calls = [];
    await decisions.reconcile(f.project, f.store, { execFile: (_file, args, _opts, cb) => {
      calls.push(args);
      if (args.at(-1) === 'repos/example/repo') return historyReply(cb, null, 'HTTP/2.0 200 OK\r\n\r\n' + JSON.stringify({ id: name === 'unknown numeric identity' ? null : 123456, full_name: 'example/repo' }));
      assert.ok(args.includes('--include'));
      historyReply(cb, null, 'HTTP/2.0 200 OK\r\nLink: <' + mutate(cursorUrl(2)) + '>; rel="next"\r\n\r\n' + JSON.stringify(Array.from({ length: 10 }, (_, i) => historyIssue(100 + i, i ? '' : f.job.architectureDecision.marker))));
    } });
    const saved = f.store.load(1);
    assert.match(saved.architectureDecision.publicationError, /page 1: Unexpected/);
    assert.equal(saved.architectureDecision.issue, undefined);
    assert.equal(saved.architectureDecision.createAttempted, undefined);
    assert.ok(calls.every(args => args.includes('--include')));
    assert.deepEqual(saved.architectureDecision.pausedExecution, f.job.architectureDecision.pausedExecution);
    assert.equal(saved.status, 'paused_owner_decision');
  });
}
for (const status of [301, 401, 403, 429, 500, 503, 206]) {
  test(`HTTP ${status} cannot authorize publication`, async t => {
    const f = await pausedFixture(t);
    await decisions.publish(f.project, f.job, f.store, { execFile: (_file, args, _opts, cb) => {
      assert.ok(args.includes('--include'));
      historyReply(cb, null, `HTTP/2.0 ${status} Rejected\r\nLocation: https://evil.example\r\n\r\n[]`);
    } });
    assert.match(f.store.load(1).architectureDecision.publicationError, new RegExp(`page 1:.*HTTP ${status}`));
    assert.equal(f.store.load(1).architectureDecision.publicationFailure.statusCode, status);
    assert.equal(f.store.load(1).architectureDecision.createAttempted, undefined);
  });
}
for (const [name, link] of Object.entries({
  'duplicate next': `<${cursorUrl(2)}>; rel="next", <${cursorUrl(2)}>; rel="next"`,
  'duplicate last': `<${cursorUrl(2)}>; rel="last", <${cursorUrl(3)}>; rel="last"`,
  'contradictory last': `<${cursorUrl(2)}>; rel="next", <${cursorUrl(1)}>; rel="last"`,
  'wrong cursor relation': `<${cursorUrl(2, 'prev')}>; rel="next"`,
  'malformed trailing link': `<${cursorUrl(2)}>; rel="next", broken`,
})) {
  test(`pagination integrity: ${name}`, async t => {
    const f = await pausedFixture(t);
    await decisions.publish(f.project, f.job, f.store, { execFile: (_file, args, _opts, cb) => {
      assert.ok(args.includes('--include'));
      historyReply(cb, null, `HTTP/2.0 200 OK\r\nLink: ${link}\r\n\r\n` + JSON.stringify(Array.from({ length: 10 }, (_, i) => historyIssue(100 + i))));
    } });
    assert.ok(f.store.load(1).architectureDecision.publicationError);
    assert.equal(f.store.load(1).architectureDecision.createAttempted, undefined);
  });
}
test('cursor-only next cycle and page budget cannot authorize writes', async t => {
  for (const budget of [false, true]) {
    const f = await pausedFixture(t);
    let reads = 0;
    await decisions.reconcile(f.project, f.store, { execFile: (_file, args, options, cb) => {
      assert.ok(args.includes('--include'));
      assert.equal(options.timeout, 60000);
      reads++;
      const next = cursorUrl(budget ? reads + 1 : 2).replace(/&page=\d+/, '');
      historyReply(cb, null, `HTTP/2.0 200 OK\r\nLink: <${next}>; rel="next"\r\n\r\n` + JSON.stringify(Array.from({ length: 10 }, (_, i) => historyIssue(reads * 10 + i))));
    } });
    assert.equal(reads, budget ? 10000 : 2);
    assert.match(f.store.load(1).architectureDecision.publicationError, budget ? /resource limit/ : /Cyclic/);
    assert.equal(f.store.load(1).architectureDecision.createAttempted, undefined);
  }
});
test('authorized enterprise API-prefixed numeric aliases preserve cursor URLs', async t => {
  const previous = process.env.GH_HOST;
  process.env.GH_HOST = 'github.enterprise.example';
  t.after(() => { if (previous === undefined) delete process.env.GH_HOST; else process.env.GH_HOST = previous; });
  const f = await pausedFixture(t);
  let reads = 0, metadata = 0;
  const next = cursorUrl(2, 'next', 'api/v3/repositories/123456/issues', process.env.GH_HOST);
  await decisions.publish(f.project, f.job, f.store, { execFile: (_file, args, _opts, cb) => {
    if (args.at(-1) === 'repos/example/repo') { metadata++; return historyReply(cb, null, 'HTTP/2.0 200 OK\r\n\r\n' + JSON.stringify({ id: 123456, full_name: 'EXAMPLE/Repo' })); }
    if (args.includes('--include')) {
      reads++;
      if (reads === 1) return historyReply(cb, null, `HTTP/2.0 200 OK\r\nLink: <${next}>; rel="next"\r\n\r\n` + JSON.stringify(Array.from({ length: 10 }, (_, i) => historyIssue(100 + i))));
      assert.equal(args.at(-1), next);
      return historyReply(cb, null, pageResponse([historyIssue(200, f.job.architectureDecision.marker)]));
    }
    assert.equal(reads, 2); cb(null, '');
  } });
  assert.equal(metadata, 1);
  assert.equal(f.store.load(1).architectureDecision.publication, 'complete');
});
test('empty complete history persists createAttempted and creates exactly once', async t => {
  const f = await pausedFixture(t);
  let posts = 0, scans = 0;
  await decisions.publish(f.project, f.job, f.store, { execFile: (_file, args, _opts, cb) => {
    if (args.includes('--include')) { scans++; return historyReply(cb, null, pageResponse([])); }
    assert.equal(scans, 1);
    if (args.includes('POST')) {
      posts++;
      assert.equal(f.store.load(1).architectureDecision.createAttempted, true);
      return cb(null, JSON.stringify(historyIssue(200, f.job.architectureDecision.marker)));
    }
    cb(null, '');
  } });
  await decisions.reconcile(f.project, createJobStore(f.store.directory), { execFile: () => { throw new Error('Completed publication must not replay'); } });
  assert.equal(posts, 1);
  assert.equal(f.store.load(1).architectureDecision.publication, 'complete');
});

for (const mode of ['complete', 'missing next', 'changed last', 'next past last']) {
  test(`cursor-only last-page evidence: ${mode}`, async t => {
    const f = await pausedFixture(t);
    const cursor = page => cursorUrl(page).replace(/&page=\d+/, '');
    let reads = 0;
    const writes = [];
    await decisions.publish(f.project, f.job, f.store, { execFile: (_file, args, _opts, cb) => {
      if (!args.includes('--include')) { writes.push(args); return cb(null, ''); }
      reads++;
      const next = reads < 3 && !(mode === 'missing next' && reads === 2) || mode === 'next past last' && reads === 3;
      const last = cursor(mode === 'changed last' && reads === 2 ? 4 : 3);
      historyReply(cb, null, `HTTP/2.0 200 OK\r\nLink: <${last}>; rel="last"${next ? `, <${cursor(reads + 1)}>; rel="next"` : ''}\r\n\r\n` + JSON.stringify(Array.from({ length: 10 }, (_, i) => historyIssue(100 + reads * 10 + i, reads === 2 && i === 0 ? f.job.architectureDecision.marker : ''))));
    } });
    const saved = f.store.load(1);
    assert.equal(reads, ['missing next', 'changed last'].includes(mode) ? 2 : 3);
    if (mode === 'complete') {
      assert.equal(saved.architectureDecision.publication, 'complete');
      assert.ok(!writes.some(args => args.includes('POST')));
    } else {
      assert.ok(saved.architectureDecision.publicationError);
      assert.deepEqual(writes, []);
    }
  });
}

test('a redirect hidden behind a final successful gh response still forbids publication', async t => {
  const f = await pausedFixture(t);
  await decisions.publish(f.project, f.job, f.store, { execFile: (_file, args, _opts, cb) => {
    assert.ok(args.includes('--include'));
    assert.ok(!args.includes('--verbose'));
    assert.equal(_opts.env.GH_DEBUG, 'api');
    historyReply(cb, null, pageResponse([]), '* Request to https://api.github.com/repos/example/repo/issues\n< HTTP/2.0 301 Moved Permanently\n< Location: https://evil.example/issues\n< HTTP/2.0 200 OK\n');
  } });
  const saved = f.store.load(1);
  assert.match(saved.architectureDecision.publicationError, /page 1:.*Unapproved.*redirect/);
  assert.equal(saved.architectureDecision.publicationFailure.statusCode, 301);
  assert.equal(saved.architectureDecision.createAttempted, undefined);
  assert.equal(saved.architectureDecision.issue, undefined);
});

// Legacy history fixtures retain their original stdout headers; supply the
// independent debug response status now required by the transport boundary.
function historyReply(cb, error, stdout, stderr = '< ' + (/^HTTP[^\r\n]*/.exec(stdout)?.[0] || 'HTTP/2.0 200 OK') + '\n') {
  cb(error, stdout, stderr);
}

for (const seam of ['publish', 'reconcile']) {
  test(`real gh output split succeeds through ${seam} without verbose stdout`, async t => {
    const f = await pausedFixture(t), calls = [];
    const previousDebug = process.env.GH_DEBUG;
    process.env.GH_DEBUG = 'inherited-debug-setting';
    t.after(() => { if (previousDebug === undefined) delete process.env.GH_DEBUG; else process.env.GH_DEBUG = previousDebug; });
    const stdout = 'HTTP/2.0 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nX-Github-Request-Id: fixture\r\n\r\n'
      + JSON.stringify([historyIssue(200, f.job.architectureDecision.marker)]);
    const stderr = '* Request at 2026-10-30 22:00:00 UTC\n* Request to https://api.github.com/repos/example/repo/issues\n> GET /repos/example/repo/issues HTTP/1.1\n< HTTP/2.0 200 OK\n< Content-Type: application/json; charset=utf-8\n';
    const execFile = (_file, args, opts, cb) => {
      calls.push({ args, env: opts.env });
      if (args.includes('--include')) {
        // Model CLI 2.102.0: --verbose moves debug text to stdout.
        return args.includes('--verbose') ? cb(null, '* Request at fixture\n< HTTP/2.0 200 OK\n' + stdout, '') : cb(null, stdout, stderr);
      }
      cb(null, '', '');
    };
    if (seam === 'publish') await decisions.publish(f.project, f.job, f.store, { execFile });
    else await decisions.reconcile(f.project, f.store, { execFile });
    const saved = f.store.load(1);
    assert.equal(saved.architectureDecision.publicationError, undefined);
    assert.equal(saved.architectureDecision.publication, 'complete');
    assert.equal(saved.architectureDecision.issue.number, 200);
    assert.equal(calls[0].env.GH_DEBUG, 'api');
    assert.ok(!calls[0].args.includes('--verbose'));
    assert.ok(calls.slice(1).every(c => c.env.GH_DEBUG === 'inherited-debug-setting'));
    assert.equal(process.env.GH_DEBUG, 'inherited-debug-setting');
    assert.ok(!calls.some(c => c.args.includes('POST')));
    assert.equal(saved.status, 'paused_owner_decision');
    assert.deepEqual(saved.architectureDecision.pausedExecution, f.job.architectureDecision.pausedExecution);
  });
}
for (const [name, stderr] of Object.entries({
  missing: '', malformed: '< HTTP/2.0 twohundred OK\n', truncated: '< HTTP/2.0 20',
  'malformed then success': '< HTTP/2.0 30x Redirect\n< HTTP/2.0 200 OK\n',
  'no response': '> GET / HTTP/1.1\n', 'status mismatch': '< HTTP/2.0 201 Created\n',
  redirect: '< HTTP/2.0 302 Found\n< HTTP/2.0 200 OK\n',
  'multiple responses': '< HTTP/2.0 200 OK\n< HTTP/2.0 200 OK\n',
})) {
  test(`debug response integrity fails closed: ${name}`, async t => {
    const f = await pausedFixture(t), writes = [];
    await decisions.reconcile(f.project, f.store, { execFile: (_file, args, _opts, cb) => {
      if (!args.includes('--include')) { writes.push(args); return cb(null, '', ''); }
      cb(null, pageResponse([]), stderr);
    } });
    const saved = f.store.load(1), d = saved.architectureDecision;
    assert.match(d.publicationError, /page 1:.*(debug|redirect)/i);
    assert.equal(d.publicationFailure.code, 'AUTOPILOT_GITHUB_TRANSPORT');
    assert.ok(d.publicationFailure.cause.message);
    assert.ok(d.publicationFailure.stack);
    if (name === 'redirect') assert.equal(d.publicationFailure.statusCode, 302);
    assert.equal(d.publication, 'pending');
    assert.equal(d.createAttempted, undefined);
    assert.equal(d.issue, undefined);
    assert.deepEqual(writes, []);
    assert.equal(saved.status, 'paused_owner_decision');
    assert.deepEqual(d.pausedExecution, f.job.architectureDecision.pausedExecution);
  });
}

test('history boundary journals both raw pipes before header or subprocess failures', async t => {
  const { execFile, withExecution } = require('../src/execution-log');
  for (const transportFailure of [false, true]) {
    const f = await pausedFixture(t), records = [], writes = [];
    const stdout = 'HTTP/2.0 200 OK\r\nLocation: https://foreign.example/issues\r\n\r\n[]';
    const stderr = '* Request at fixture\n< HTTP/2.0 200 OK\n< X-Raw-Fixture: untouched\n';
    await withExecution((event, details) => records.push({ event, ...details }), () =>
      decisions.publish(f.project, f.job, f.store, { execFile: (_file, args, options, cb) => {
        if (!args.includes('--include')) { writes.push(args); return cb(null, '', ''); }
        return execFile(process.execPath, ['-e',
          `require("node:fs").writeFileSync(1, ${JSON.stringify(stdout)}); require("node:fs").writeFileSync(2, ${JSON.stringify(stderr)}); process.exit(${transportFailure ? 1 : 0});`], options, cb);
      } }));
    for (const [stream, expected] of Object.entries({ stdout, stderr })) {
      const actual = Buffer.concat(records.filter(r => r.event === 'output' && r.stream === stream)
        .map(r => Buffer.from(r.base64, 'base64'))).toString();
      assert.equal(actual, expected);
    }
    const saved = f.store.load(1), d = saved.architectureDecision;
    assert.match(d.publicationError, transportFailure ? /exited unsuccessfully/ : /headers or redirect/);
    assert.ok(records.some(r => r.event === 'architecture_publication_failure'));
    if (transportFailure) assert.equal(d.publicationFailure.cause.code, 1);
    assert.deepEqual(writes, []);
    assert.equal(d.createAttempted, undefined);
    assert.equal(saved.status, 'paused_owner_decision');
    assert.deepEqual(d.pausedExecution, f.job.architectureDecision.pausedExecution);
  }
});
