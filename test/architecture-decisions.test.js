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
    if (args.includes('--slurp')) return cb(null, JSON.stringify([remote]));
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
