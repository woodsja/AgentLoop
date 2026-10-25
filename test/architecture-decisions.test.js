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
    if (args[0] === 'api' && args[1]?.includes('?state=all&per_page=100&page=')) {
      const page = Number(new URL(`https://api.github.com/${args[1]}`).searchParams.get('page'));
      return cb(null, JSON.stringify(remote.slice((page - 1) * 100, page * 100)));
    }
    if (args.includes('POST')) {
      const issue = { number: 50, html_url: 'https://github.com/example/repo/issues/50', body: args.find(a => a.startsWith('body=')).slice(5), assignees: [] };
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

async function unpublished(t) {
  const f = fixture(t);
  await run(['--project', 'demo'], { ...f.dependencies, execFile: (file, args, options, cb) => {
    if (args[1]?.includes('?state=all')) return cb(new Error('GitHub unavailable'), '', 'offline');
    return f.dependencies.execFile(file, args, options, cb);
  } });
  assert.equal(f.store.load(1).architectureDecision.createAttempted, undefined);
  return f;
}

test('large all-state pages reconcile a closed exact marker with complete raw subprocess pipes and paused history', async t => {
  const f = await unpublished(t);
  const before = f.store.load(1);
  const marker = before.architectureDecision.marker;
  const history = Array.from({ length: 200 }, (_, n) => ({ number: n + 100, state: n % 2 ? 'open' : 'closed', body: 'owner token=verbatim\r\n' + 'x'.repeat(14000) }));
  // Search indexing, PR markers, and near markers cannot substitute for identity.
  history[0].body += marker.replace(' -->', 'x -->');
  history[1] = { ...history[1], body: marker, pull_request: {} };
  history.push({ number: 500, state: 'closed', body: marker, html_url: 'https://github.com/example/repo/issues/500', assignees: [] });
  const pages = [history.slice(0, 100), history.slice(100, 200), history.slice(200)].map(JSON.stringify);
  assert.ok(pages.every((p, i) => i === 2 || Buffer.byteLength(p) > 1024 * 1024));
  const { execFile, withExecution } = require('../src/execution-log');
  const records = [], reads = [];
  const stderr = 'raw token=owner\r\n\u001b[31mstderr\0end';
  const adapter = (file, args, options, cb) => {
    if (!args[1]?.includes('?state=all')) return f.dependencies.execFile(file, args, options, cb);
    assert.equal(args.length, 2);
    assert.equal(options.maxBuffer, Infinity);
    const page = Number(new URL(`https://api.github.com/${args[1]}`).searchParams.get('page'));
    reads.push(page);
    const outputPath = path.join(f.root, `page-${page}.json`);
    fs.writeFileSync(outputPath, pages[page - 1]);
    return execFile(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1])); process.stderr.write(Buffer.from(process.argv[2], "base64"));', outputPath, Buffer.from(stderr).toString('base64')], options, cb);
  };
  await withExecution((event, details) => records.push({ event, ...details }), () => decisions.reconcile(f.project, createJobStore(f.store.directory), { execFile: adapter }));
  assert.equal(f.store.load(1).architectureDecision.publicationError, undefined);
  assert.deepEqual(reads, [1, 2, 3]);
  const output = stream => Buffer.concat(records.filter(r => r.event === 'output' && r.stream === stream).map(r => Buffer.from(r.base64, 'base64'))).toString();
  assert.equal(output('stdout'), pages.join(''));
  assert.equal(output('stderr'), stderr.repeat(3));
  const saved = f.store.load(1);
  assert.equal(saved.architectureDecision.issue.number, 500);
  assert.equal(saved.architectureDecision.publication, 'complete');
  for (const key of ['status', 'terminalState', 'runs', 'ralph', 'executionJournal', 'failures', 'milestoneAuthorization', 'admission']) assert.deepEqual(saved[key], before[key]);
  assert.deepEqual(saved.architectureDecision.pausedExecution, before.architectureDecision.pausedExecution);
  assert.equal(saved.architectureDecision.identity, before.architectureDecision.identity);
  assert.equal(saved.architectureDecision.ownerDecision, undefined);
  assert.equal(saved.architectureDecision.createAttempted, undefined);
  assert.equal(f.calls.filter(a => a.includes('POST')).length, 0);
  assert.equal(f.calls.filter(a => a.includes('--add-assignee')).length, 1);
  assert.ok(!f.calls.some(a => a.includes('--add-label') && a[a.indexOf('--add-label') + 1] === f.project.readyLabel));
  await decisions.reconcile(f.project, f.store, { execFile: adapter });
  assert.deepEqual(reads, [1, 2, 3]);
});

test('exact marker duplicates across pages block every remote write', async t => {
  const f = await unpublished(t), saved = f.store.load(1);
  f.remote.push(...Array.from({ length: 101 }, (_, i) => ({ number: i + 100, state: 'closed', body: i === 0 || i === 100 ? saved.architectureDecision.marker : '' })));
  f.calls.length = 0;
  await decisions.reconcile(f.project, f.store, { execFile: f.dependencies.execFile });
  assert.match(f.store.load(1).architectureDecision.publicationError, /Multiple decision issues/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.store.load(1).architectureDecision.createAttempted, undefined);
});

test('unavailable, malformed, and resource-failed later pages cannot authorize creation or assignment', async t => {
  const f = await unpublished(t);
  for (const response of ['{bad', '{}', '[null]', JSON.stringify([{ number: 123 }]), 'resource', 'offline']) {
    const writes = [];
    await decisions.reconcile(f.project, f.store, { execFile: (file, args, options, cb) => {
      if (!args[1]?.includes('?state=all')) { writes.push(args); return cb(null, ''); }
      if (args[1].endsWith('page=1')) return cb(null, JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ number: i + 100, body: '' }))));
      if (response === 'resource') return cb(Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'partial raw stdout', 'raw stderr');
      if (response === 'offline') return cb(Object.assign(new Error('spawn gh EAGAIN'), { code: 'EAGAIN' }), '', 'offline');
      return cb(null, response);
    } });
    const saved = f.store.load(1);
    assert.ok(saved.architectureDecision.publicationError);
    if (response === 'resource') assert.match(saved.architectureDecision.publicationError, /ERR_CHILD_PROCESS_STDIO_MAXBUFFER.*maxBuffer/);
    if (response === 'offline') assert.match(saved.architectureDecision.publicationError, /EAGAIN/);
    assert.equal(saved.architectureDecision.createAttempted, undefined);
    assert.equal(saved.status, 'paused_owner_decision');
    assert.deepEqual(writes, []);
  }
});

test('creation waits for an exhaustive multi-page read and checkpoints intent before POST', async t => {
  const f = await unpublished(t);
  f.remote.push(...Array.from({ length: 200 }, (_, n) => ({ number: n + 100, body: 'x'.repeat(12000), state: 'closed' })));
  f.calls.length = 0;
  const adapter = (file, args, options, cb) => {
    if (args.includes('POST')) {
      assert.equal(f.store.load(1).architectureDecision.createAttempted, true);
      assert.deepEqual(f.calls.filter(a => a[1]?.includes('?state=all')).map(a => a[1].split('page=').at(-1)), ['1', '2', '3']);
      assert.equal(options.maxBuffer, 1024 * 1024, 'write response limits stay unchanged');
    }
    return f.dependencies.execFile(file, args, options, cb);
  };
  await decisions.reconcile(f.project, f.store, { execFile: adapter });
  assert.equal(f.store.load(1).architectureDecision.publication, 'complete');
  assert.equal(f.calls.filter(a => a.includes('POST')).length, 1);
  assert.equal(f.calls.filter(a => a.includes('--add-assignee')).length, 1);
});

test('malformed successful creation response remains uncertain across restart without another POST', async t => {
  const f = await unpublished(t);
  const adapter = (file, args, options, cb) => {
    if (args.includes('POST')) {
      f.calls.push(args);
      assert.equal(f.store.load(1).architectureDecision.createAttempted, true);
      return cb(null, '{lost response');
    }
    return f.dependencies.execFile(file, args, options, cb);
  };
  await decisions.reconcile(f.project, f.store, { execFile: adapter });
  await decisions.reconcile(f.project, createJobStore(f.store.directory), { execFile: adapter });
  assert.match(f.store.load(1).architectureDecision.publicationError, /uncertain/);
  assert.equal(f.store.load(1).status, 'paused_owner_decision');
  assert.equal(f.calls.filter(a => a.includes('POST')).length, 1);
  assert.equal(f.calls.filter(a => a.includes('--add-assignee')).length, 0);
});
