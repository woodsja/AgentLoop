'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createR1Jobs } = require('../src/r1-jobs');
const { createJobStore, createJob, markTerminal } = require('../src/autopilot-state');
const { configuredProjects } = require('../src/project-registry');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout'); fs.mkdirSync(checkout);
  const configPath = path.join(root, 'config.json'); fs.writeFileSync(configPath, '{}');
  const project = { enabled: true, autoMerge: true, repo: 'owner/demo', checkout,
    worktreeRoot: path.join(root, 'worktrees'), stateDir: path.join(root, 'jobs'),
    worker: 'codex', reviewPolicy: 'always', baseBranch: 'main', readyLabel: 'ready', humanLabel: 'human' };
  const durable = createJobStore(project.stateDir), tasks = [], commands = [];
  let issues = [], outage = false, state = 'OPEN', revoked = false;
  const queue = { paths: { config: configPath }, config: { allowedProjects: configuredProjects({ demo: { root: checkout, worktreeRoot: project.worktreeRoot } }, configPath) },
    listTasks: stage => tasks.filter(task => task.stage === stage), listR1ChildLoops: () => [],
    readTask(id, stage) { const task = tasks.find(task => task.id === id && task.stage === stage); if (!task) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return structuredClone(task); },
    writeTask(task, stage) { Object.assign(tasks.find(value => value.id === task.id), task, { stage }); },
    moveTask(id, from, to) { const task = tasks.find(task => task.id === id); assert.equal(task.stage, from); task.stage = to; },
    enqueueTask(task) { const saved = { ...task, id: `t-${String(tasks.length + 1).padStart(8, '0')}`, stage: 'pending' }; tasks.push(saved); return saved; },
    appendExecution() {}, appendLogLine() {},
  };
  const deps = { loadProjectConfig: () => { if (revoked) throw new Error('owner config unavailable'); return project; }, discoverReadyIssues: async () => issues,
    cleanupIssueWorkspace: async () => {},
    execFile(file, args, options, cb) {
      commands.push([file, ...args]);
      if (args[0] === 'api' && outage) return cb(new Error('branch outage'), '', 'branch outage RAW');
      if (args[0] === 'pr' && args[1] === 'close') state = 'CLOSED';
      cb(null, args.includes('--json') ? JSON.stringify(args.includes('comments') ? { comments: [] } : { state }) : '', '');
    },
    createRalphTaskService: () => assert.fail('no duplicate worker'),
  };
  const jobs = createR1Jobs(queue, { ciPollMs: 0, admitIntervalMs: 0, autopilotDependencies: deps });
  t.after(() => jobs.stop(() => {}));
  function saved(status = 'failed') {
    const task = queue.enqueueTask({ workflow: 'r1', project: 'demo', issue: 1, title: 'Recovery', status: 'running', autonomous: true, autopilotStateDir: durable.directory, repo: project.repo });
    task.stage = 'running';
    const job = createJob({ projectName: 'demo', repo: project.repo, issue: { number: 1, title: 'Recovery' }, branch: 'ralph/issue-1-recovery', worktreePath: null, now: durable.now });
    job.r1ParentJobId = task.id; job.status = status;
    if (status === 'failed') markTerminal(job, status);
    job.workspaceState = 'removed'; durable.save(job); return { task, job };
  }
  async function tick(task) { jobs.advance(task); await delay(30); }
  return { project, durable, tasks, commands, queue, jobs, deps, saved, tick,
    revoke: () => { revoked = true; }, issues: value => { issues = value; }, outage: () => { outage = true; } };
}
test('exhausted branch outage releases dispatch with failed raw actions and permits next admission', async t => {
  const f = fixture(t), { task, job } = f.saved();
  job.pr = { number: 9, url: 'https://github.com/owner/demo/pull/9' }; job.delivery = { branch: job.branch, commit: 'a'.repeat(40), pushed: true }; f.durable.save(job); f.outage();
  for (let i = 0; i < 5 && task.stage !== 'done'; i++) await f.tick(task);
  assert.equal(task.stage, 'done');
  const result = f.jobs.read(task.id);
  assert.equal(result.nextAction.action, 'owner_decision');
  assert.equal(result.evidence.outcomeActions['delete-remote-branch'].ok, false);
  assert.equal(result.evidence.outcomeActions['delete-remote-branch'].attempts, 3);
  assert.match(result.evidence.outcomeActions['delete-remote-branch'].error, /RAW/);
  assert.equal(f.commands.filter(c => c[1] === 'pr' && c[2] === 'close').length, 1);
  f.issues([{ number: 2, title: 'Next', body: 'Implement the next explicitly scoped issue and verify it with deterministic tests.' }]);
  assert.equal((await f.jobs.admit()).issue, 2);
});
for (const held of ['awaiting_ci', 'supervisor']) test(`durable cancellation of ${held} publishes owner actions once`, async t => {
  const f = fixture(t), { task, job } = f.saved('awaiting_ci');
  job.pr = { number: 9, url: 'https://github.com/owner/demo/pull/9' };
  job.delivery = { branch: job.branch, commit: 'a'.repeat(40), pushed: true }; f.durable.save(job);
  if (held === 'supervisor') task.supervisionBlocked = { reason: 'executor held' };
  task.cancelRequested = true;
  await f.tick(task);
  assert.equal(task.stage, 'done');
  assert.equal(f.jobs.read(task.id).status, 'cancelled');
  assert.equal(f.commands.filter(c => c[1] === 'pr' && c[2] === 'close').length, 1);
  assert.equal(f.commands.filter(c => c[1] === 'issue' && c[2] === 'comment').length, 1);
  assert.equal(f.commands.filter(c => c.includes('--remove-label') && c.includes('--add-label')).length, 1);
  assert.equal(f.commands.filter(c => c[1] === 'api').length, 1);
  const { cancelHeldDelivery } = require('../src/autopilot');
  await cancelHeldDelivery(task, f.durable, () => f.project, f.deps);
  assert.equal(f.commands.filter(c => c[1] === 'pr' && c[2] === 'close').length, 1);
});
test('transient initial discovery miss can be resubmitted without losing the failed attempt', async t => {
  const f = fixture(t);
  const first = await f.jobs.submit({ project: 'demo', issue: 1 });
  f.queue.moveTask(first.id, 'pending', 'running'); await f.tick(first);
  assert.equal(f.jobs.read(first.id).status, 'failed');
  const raw = fs.readFileSync(f.durable.jobPath(1), 'utf8');
  f.issues([{ number: 1, title: 'Recovered', body: 'Implement the exact authorized recovery behavior and deterministic acceptance tests.' }]);
  const fresh = await f.jobs.submit({ project: 'demo', issue: 1 });
  assert.notEqual(fresh.id, first.id);
  assert.deepEqual(f.durable.load(1, first.id), JSON.parse(raw));
  assert.equal(f.jobs.read(first.id).status, 'failed');
  assert.equal((await f.jobs.submit({ project: 'demo', issue: 1 })).id, fresh.id);
});
test('crash after rearm reservation reuses the pending parent and preserves raw history', async t => {
  const f = fixture(t), { task, job } = f.saved();
  job.status = 'needs_specification'; markTerminal(job, 'needs_specification');
  job.originalIssue = { number: 1, title: 'Recovery', body: 'fix it' }; f.durable.save(job); task.stage = 'done';
  const raw = fs.readFileSync(f.durable.jobPath(1), 'utf8');
  f.durable.appendIntegrationEvent(job, { event: 'original', text: 'RAW ORIGINAL' });
  const rawJournal = fs.readFileSync(f.durable.jobPath(1).replace('.json', '.execution.ndjson'));
  const archivedJournal = path.join(f.durable.directory, 'attempts', task.id, 'issue-1.execution.ndjson');
  f.issues([{ number: 1, title: 'Recovery', body: 'Implement the exact authorized recovery behavior and deterministic acceptance tests.' }]);
  const enqueue = f.queue.enqueueTask;
  f.queue.enqueueTask = value => { enqueue(value); throw new Error('crash after durable reservation'); };
  await assert.rejects(f.jobs.submit({ project: 'demo', issue: 1 }), /crash/);
  assert.deepEqual(fs.readFileSync(archivedJournal), rawJournal);
  f.queue.enqueueTask = enqueue;
  const [fresh, duplicate] = await Promise.all([f.jobs.submit({ project: 'demo', issue: 1 }), f.jobs.submit({ project: 'demo', issue: 1 })]);
  assert.equal(f.tasks.length, 2);
  assert.equal(fresh.id, f.tasks[1].id); assert.equal(duplicate.id, fresh.id);
  assert.deepEqual(f.durable.load(1, task.id), JSON.parse(raw));
  assert.deepEqual(fs.readFileSync(archivedJournal), rawJournal, 'retry cannot rewrite the archived raw attempt');
});
test('canonical discovery hold rechecks safely and recovers one worker when authorized discovery returns', async t => {
  const f = fixture(t), { task } = f.saved('pending');
  let workers = 0, prepared = 0;
  f.deps.prepareIssueWorkspace = async () => { prepared++; return { worktreePath: f.project.checkout, branch: 'ralph/issue-1-recovery', baseRef: 'main' }; };
  f.deps.readRepositoryInstructions = async () => [];
  f.deps.prepareRepositoryEnvironment = async () => {};
  f.deps.findOpenIssuePullRequests = async () => [];
  f.deps.createRalphTaskService = () => ({ run: async () => { workers++; return { status: 'needs_planning', attempts: [] }; } });
  await f.tick(task); await f.tick(task);
  assert.equal(f.durable.load(1).ownershipBlockSource, 'discovery');
  assert.equal(prepared, 0); assert.equal(workers, 0);
  f.issues([{ number: 1, title: 'Recovery', body: 'Implement the exact authorized recovery behavior and deterministic acceptance tests.' }]);
  await f.tick(task);
  assert.equal(f.durable.load(1).ownershipBlocked, undefined);
  assert.equal(workers, 1); assert.equal(prepared, 1);
  assert.equal(task.stage, 'done');
  assert.equal(f.commands.filter(c => c[1] === 'pr' && c[2] === 'create').length, 0);
});
test('idle admission reconciles paused owner decision publication without another delivery parent', async t => {
  const f = fixture(t), { task, job } = f.saved(); task.stage = 'done';
  f.project.architectureDecisions = true;
  require('../src/architecture-decisions').pause(job, { key: 'choice', problem: 'Owner choice' }, [], f.durable);
  const paused = f.durable.load(1);
  paused.architectureDecision.createAttempted = true; f.durable.save(paused);
  let observations = 0;
  f.deps.execFile = (file, args, options, cb) => { observations++; cb(null, 'HTTP/2.0 200 OK\r\n\r\n[]', '< HTTP/2.0 200 OK\n'); };
  await f.jobs.admit();
  assert.equal(observations, 1);
  assert.match(f.durable.load(1).architectureDecision.publicationError, /uncertain/);
  assert.equal(f.tasks.length, 1); assert.equal(f.tasks[0].stage, 'done');
});
test('held cancellation with a remotely confirmed merge stays non-cancelled', async t => {
  const f = fixture(t), { task, job } = f.saved('awaiting_ci');
  job.pr = { number: 9, url: 'https://github.com/owner/demo/pull/9' };
  job.delivery = { branch: job.branch, commit: 'a'.repeat(40), pushed: true }; f.durable.save(job);
  f.deps.execFile = (_file, _args, _opts, cb) => cb(null, '{"state":"MERGED"}', '');
  task.cancelRequested = true; await f.tick(task);
  assert.notEqual(f.durable.load(1).terminalState, 'cancelled');
  assert.equal(f.durable.load(1).outcomePrState, 'MERGED');
  assert.equal(f.commands.length, 0);
});
for (const failure of ['config', 'labels']) test(`held cancellation retains bounded ${failure} policy failures`, async t => {
  const f = fixture(t), { task } = f.saved('awaiting_ci'); task.cancelRequested = true;
  if (failure === 'config') f.revoke();
  else delete f.project.humanLabel;
  for (let i = 0; i < 5 && task.stage !== 'done'; i++) await f.tick(task);
  assert.equal(task.stage, 'done');
  const result = f.jobs.read(task.id);
  assert.equal(result.nextAction.action, 'owner_decision');
  const action = result.evidence.outcomeActions[failure === 'config' ? 'outcome-policy' : 'relabel-issue'];
  assert.equal(action.ok, false); assert.equal(action.attempts, 3);
});
test('R1 status executes in strict mode', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../src/r1-status'), 'utf8');
  assert.throws(() => vm.runInNewContext(source + '\nstrictModeProbe = true;', { require: require('node:module').createRequire(require.resolve('../src/r1-status')), module: { exports: {} } }), /strictModeProbe is not defined/);
});
for (const runtime of ['node', 'python']) test(`${runtime} terminal ambiguous setup releases transport without altering claim or reexecuting`, async t => {
  const f = fixture(t), { task, job } = f.saved(); f.project.autoMerge = false; delete task.autonomous;
  job.status = 'blocked_infrastructure'; markTerminal(job, 'blocked_infrastructure');
  job.environmentPreflight = { runtime, status: 'blocked', category: 'infrastructure', reason: 'prior_process_unresolved' };
  job.environmentProcess = { pid: null, startTime: null }; f.durable.save(job);
  const before = structuredClone(f.durable.load(1));
  await f.tick(task);
  assert.equal(task.stage, 'done');
  assert.deepEqual(f.durable.load(1).environmentProcess, before.environmentProcess);
  assert.deepEqual(f.durable.load(1).environmentPreflight, before.environmentPreflight);
  assert.equal(f.durable.load(1).terminalState, 'blocked_infrastructure');
  assert.equal(f.durable.load(1).runs, 0);
  assert.equal(f.commands.length, 0);
});
for (const invalid of ['mismatch', 'cancelled', 'held', 'finished']) test(`rearm refuses ${invalid} reserved parents without allocating another`, async t => {
  const f = fixture(t), { task, job } = f.saved(); task.stage = 'done';
  job.status = 'needs_specification'; markTerminal(job, 'needs_specification');
  job.originalIssue = { number: 1, title: 'Recovery', body: 'fix it' }; f.durable.save(job);
  const pending = f.queue.enqueueTask({ workflow: 'r1', project: 'demo', issue: 1, rearmFrom: invalid === 'mismatch' ? 't-deadbeef' : task.id,
    autopilotStateDir: f.durable.directory });
  if (invalid === 'cancelled') pending.cancelRequested = true;
  if (invalid === 'held') pending.supervisionBlocked = { reason: 'abandoned' };
  if (invalid === 'finished') f.queue.moveTask(pending.id, 'pending', 'done');
  f.issues([{ number: 1, title: 'Recovery', body: 'Implement the exact authorized recovery behavior and deterministic acceptance tests.' }]);
  await assert.rejects(f.jobs.submit({ project: 'demo', issue: 1 }), /reservation mismatch/);
  assert.equal(f.tasks.length, 2); assert.equal(f.durable.load(1).r1ParentJobId, task.id);
});
test('merge confirmed during cancellation PR-close reconciliation is never recorded as cancelled', async t => {
  const f = fixture(t), { task, job } = f.saved('awaiting_ci');
  job.pr = { number: 9, url: 'https://github.com/owner/demo/pull/9' };
  job.delivery = { branch: job.branch, commit: 'a'.repeat(40), pushed: true }; f.durable.save(job);
  let reads = 0;
  f.deps.execFile = (_file, args, _opts, cb) => {
    assert.equal(args[0], 'pr', 'no failure notification or destructive action after merge');
    assert.equal(args[1], 'view');
    cb(null, JSON.stringify({ state: ++reads === 1 ? 'OPEN' : 'MERGED' }), '');
  };
  task.cancelRequested = true; await f.tick(task);
  assert.equal(f.durable.load(1).outcomePrState, 'MERGED');
  assert.equal(f.durable.load(1).terminal, false);
  assert.notEqual(f.durable.load(1).terminalState, 'cancelled');
  assert.equal(task.stage, 'running');
});
test('unknown worker ownership keeps cancellation held without outcome actions or a replacement worker', async t => {
  const f = fixture(t), { task, job } = f.saved('running');
  job.agentProcess = { status: 'launching' }; f.durable.save(job);
  task.cancelRequested = true; await f.tick(task); await f.tick(task);
  assert.equal(task.stage, 'running'); assert.equal(f.durable.load(1).terminal, false);
  assert.deepEqual(f.durable.load(1).agentProcess, { status: 'launching' });
  assert.equal(f.commands.length, 0);
  assert.equal(f.jobs.read(task.id).nextAction.action, 'owner_decision');
});
