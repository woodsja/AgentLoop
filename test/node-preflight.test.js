const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareRepositoryEnvironment } = require('../src/autopilot-environment');
const { withExecution } = require('../src/execution-log');

function fixture(t, script = 'process.exit(1)') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-node-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.ralph'));
  fs.writeFileSync(path.join(root, '.ralph/project.json'), JSON.stringify({ runtime: 'node', verification: 'check', lockfile: 'package-lock.json' }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { check: 'node check.js', postinstall: 'node install.js' } }));
  fs.writeFileSync(path.join(root, 'check.js'), script);
  fs.writeFileSync(path.join(root, 'install.js'), 'console.log("lifecycle stdout");console.error("lifecycle stderr");');
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0', hasInstallScript: true } } }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  return root;
}

test('Node locked install is ready despite failing application tests and captures lifecycle streams', async t => {
  const root = fixture(t);
  const before = fs.readFileSync(path.join(root, 'package-lock.json'));
  const records = [], claims = [];
  const result = await withExecution((event, details) => records.push({ event, ...details }), () => prepareRepositoryEnvironment(root, { runtime: 'node' }, { onProcess: claim => claims.push(claim) }));
  assert.equal(result.status, 'ready');
  assert.equal(result.verification, 'npm run check');
  assert.deepEqual(fs.readFileSync(path.join(root, 'package-lock.json')), before);
  assert.ok(claims.some(c => c?.startTime));
  assert.equal(claims.at(-1), null);
  const output = stream => records.filter(r => r.event === 'output' && r.stream === stream).map(r => Buffer.from(r.base64, 'base64').toString()).join('');
  assert.match(output('stdout'), /lifecycle stdout/);
  assert.match(output('stderr'), /lifecycle stderr/);
  assert.ok(records.some(r => r.event === 'command' && r.args.includes('ci')));
  assert.throws(() => execFileSync('npm', ['run', 'check'], { cwd: root, stdio: 'pipe' }));
});

for (const mode of ['contract_missing', 'runtime_invalid', 'lockfile_missing', 'lockfile_invalid', 'lockfile_uncommitted', 'verification_missing']) {
  test(`Node preparation diagnoses ${mode} before installer admission`, async t => {
    const root = fixture(t);
    if (mode === 'contract_missing') fs.unlinkSync(path.join(root, '.ralph/project.json'));
    if (mode === 'runtime_invalid') fs.writeFileSync(path.join(root, '.ralph/project.json'), '{"runtime":"ruby"}');
    if (mode === 'lockfile_missing') fs.unlinkSync(path.join(root, 'package-lock.json'));
    if (mode === 'lockfile_invalid') fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    if (mode === 'lockfile_uncommitted') fs.appendFileSync(path.join(root, 'package-lock.json'), '\n');
    if (mode === 'verification_missing') fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{}}');
    await assert.rejects(prepareRepositoryEnvironment(root, { runtime: 'node' }), e => e.code === 'PROJECT_PREFLIGHT_BLOCKED' && e.outcome.reason === mode && e.message.length > 20);
  });
}

for (const mode of ['install_failed', 'lockfile_changed', 'timeout', 'cancelled']) {
  test(`Node installer ${mode} retains full diagnostics and releases its process claim`, async t => {
    const root = fixture(t), records = [], claims = [];
    let cancel = false;
    const script = mode === 'install_failed' ? "console.log('x'.repeat(25000));console.error('exact setup failure');process.exit(9)"
      : mode === 'lockfile_changed' ? "require('fs').appendFileSync('package-lock.json','\\n')"
        : "require('fs').writeFileSync('install-started','yes');setInterval(()=>{},1000)";
    fs.writeFileSync(path.join(root, 'install.js'), script);
    const interval = setInterval(() => { if (mode === 'cancelled' && fs.existsSync(path.join(root, 'install-started'))) cancel = true; }, 20);
    t.after(() => clearInterval(interval));
    await assert.rejects(withExecution((event, details) => records.push({ event, ...details }), () => prepareRepositoryEnvironment(root, { runtime: 'node' }, {
      timeoutMs: mode === 'timeout' ? 1500 : 10000, isCancelled: () => cancel, onProcess: claim => claims.push(claim),
    })), e => e.outcome?.reason === mode && (mode !== 'install_failed' || (e.outcome.stdout.includes('x'.repeat(25000)) && e.outcome.stderr.includes('exact setup failure'))));
    assert.equal(claims.at(-1), null);
    const { hasLiveClaim } = require('../src/r1-process-claim');
    assert.ok(claims.filter(Boolean).every(claim => !hasLiveClaim({ workerPid: claim.pid, workerStartTime: claim.startTime })));
    if (mode === 'install_failed') assert.ok(records.some(r => r.event === 'output' && r.stream === 'stderr' && Buffer.from(r.base64, 'base64').toString().includes('exact setup failure')));
  });
}

test('ordinary system node/npm resolve without a private tool directory or bubblewrap', async t => {
  const root = fixture(t), priorPath = process.env.PATH;
  t.after(() => { process.env.PATH = priorPath; });
  process.env.PATH = '/usr/bin:/bin';
  const { findOnPath } = require('../src/engines');
  assert.equal(findOnPath('npm'), '/usr/bin/npm');
  assert.equal((await prepareRepositoryEnvironment(root, { runtime: 'node' })).status, 'ready');
  process.env.PATH = path.join(root, 'missing-tools');
  await assert.rejects(prepareRepositoryEnvironment(root, { runtime: 'node' }), e => e.outcome.reason === 'runtime_missing');
});

test('npm ci rejects package/lock dependency mismatch without rewriting the lockfile', async t => {
  const root = fixture(t);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  pkg.dependencies = { 'local-fixture': 'file:./local-fixture' };
  fs.mkdirSync(path.join(root, 'local-fixture'));
  fs.writeFileSync(path.join(root, 'local-fixture/package.json'), '{"name":"local-fixture","version":"1.0.0"}');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  const before = fs.readFileSync(path.join(root, 'package-lock.json'));
  await assert.rejects(prepareRepositoryEnvironment(root, { runtime: 'node' }), e => e.outcome.reason === 'install_failed' && /npm (?:ERR!|error)/i.test(e.outcome.stderr));
  assert.deepEqual(fs.readFileSync(path.join(root, 'package-lock.json')), before);
});

test('missing verification executable blocks tool readiness', async t => {
  const root = fixture(t), pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  pkg.scripts.check = 'ralph-nonexistent-check-tool';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  await assert.rejects(prepareRepositoryEnvironment(root, { runtime: 'node' }), e => e.outcome.reason === 'verification_unavailable' && e.outcome.exitCode === 127);
});

const { createR1Jobs } = require('../src/r1-jobs');
const { configuredProjects } = require('../src/project-registry');
const { createJobStore } = require('../src/autopilot-state');
for (const mode of ['red-tests', 'missing-lock', 'restart-dead', 'restart-ambiguous']) {
  test(`public R1 Node ${mode}: durable readiness and zero wasted setup attempts`, async t => {
    const checkout = fixture(t, "console.log('full baseline/verification stdout\\n'+'x'.repeat(25000));console.error('exact test failure');process.exit(7)");
    if (mode === 'missing-lock') {
      fs.unlinkSync(path.join(checkout, 'package-lock.json'));
      execFileSync('git', ['-C', checkout, 'commit', '-qam', 'remove lock']);
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-node-state-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const registry = path.join(root, 'owner.json'); fs.writeFileSync(registry, '{}');
    const project = { runtime: 'node', enabled: true, autoMerge: false, worker: 'codex', reviewPolicy: 'always', maxAttempts: 1,
      repo: 'example/node', checkout, worktreeRoot: path.join(root, 'worktrees'), baseBranch: 'master', readyLabel: 'staged', humanLabel: 'human', stateDir: path.join(root, 'state'), verification: 'false' };
    const stages = { pending: new Map(), running: new Map(), done: new Map() }, records = [];
    const store = {
      paths: { config: registry }, config: { allowedProjects: configuredProjects({ demo: { root: checkout, worktreeRoot: project.worktreeRoot } }, registry) },
      enqueueTask(task) { const value = { ...task, id: 't-12345678' }; stages.pending.set(value.id, value); return value; },
      appendLogLine() {}, appendExecution(id, record) { records.push({ id, ...record }); },
      writeTask(task, stage) { stages[stage].set(task.id, structuredClone(task)); },
      readTask(id, stage) { const value = stages[stage].get(id); if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return structuredClone(value); },
      listTasks(stage) { return [...stages[stage].values()]; }, listR1ChildLoops() { return []; }, writeResult() {},
      moveTask(id, from, to) { const task = stages[from].get(id); stages[from].delete(id); stages[to].set(id, task); },
    };
    let workers = 0;
    const deps = {
      loadProjectConfig: () => project, discoverReadyIssues: async () => [{ number: 1, title: 'Fix tests', body: 'Fix existing application tests.' }],
      findOpenIssuePullRequests: async () => [], readRepositoryInstructions: async () => [], cleanupIssueWorkspace: async () => {},
      prepareIssueWorkspace: async (_p, _issue, options) => {
        const worktreePath = path.join(project.worktreeRoot, 'issue-1');
        if (!fs.existsSync(worktreePath)) execFileSync('git', ['-C', checkout, 'worktree', 'add', '-b', options.branch, worktreePath, 'HEAD'], { stdio: 'pipe' });
        return { worktreePath, branch: options.branch };
      },
      createRalphTaskService: () => ({ run: async (cwd, task) => {
        workers++;
        assert.equal(task.verification, 'npm run check');
        const verification = await require('../src/verifier').runVerification(cwd, task.verification, 10000);
        return { task, status: 'needs_planning', attempts: [{ number: 1, status: 'failed', verification }] };
      } }),
      reviewPullRequest: async () => assert.fail('failed checks cannot reach review'),
    };
    const jobs = createR1Jobs(store, { autopilotDependencies: deps });
    const task = jobs.submit({ project: 'demo', issue: 1 }); store.moveTask(task.id, 'pending', 'running'); jobs.advance(task);
    const deadline = Date.now() + 15000;
    while (!stages.done.has(task.id)) { assert.ok(Date.now() < deadline, 'R1 fixture completes'); await new Promise(resolve => setTimeout(resolve, 20)); }
    const result = jobs.read(task.id);
    const ready = result.evidence.environmentPreflight;
    assert.equal(ready.status, mode === 'missing-lock' ? 'blocked' : 'ready');
    assert.equal(workers, mode === 'missing-lock' ? 0 : 1);
    if (mode !== 'missing-lock') {
      assert.equal(ready.baseline.passed, false);
      assert.equal(result.evidence.verification.passed, false);
      assert.match(result.evidence.verification.stdout, /x{25000}/);
      assert.match(result.evidence.verification.stderr, /exact test failure/);
      assert.ok(records.some(r => r.event === 'output' && Buffer.from(r.base64, 'base64').toString().includes('lifecycle stdout')));
    } else {
      assert.equal(ready.reason, 'lockfile_missing');
      assert.equal(result.evidence.verification, null);
      assert.equal(result.evidence.review, null);
    }
    assert.deepEqual(createR1Jobs(store, { autopilotDependencies: deps }).read(task.id), result);
    const state = createJobStore(project.stateDir);
    assert.equal(state.load(1).environmentProcess ?? null, null);
    if (mode.startsWith('restart-')) {
      const prior = state.load(1);
      prior.terminal = false; prior.terminalState = null; prior.status = 'environment_preflight';
      prior.ralph = { status: null, attempts: 0, taskId: null };
      prior.environmentPreflight = { status: 'preparing', category: 'infrastructure' };
      prior.environmentProcess = mode === 'restart-dead' ? { pid: 99999999, startTime: '1' } : { pid: null, startTime: null };
      state.save(prior);
      store.moveTask(task.id, 'done', 'running');
      const restarted = createR1Jobs(store, { autopilotDependencies: deps });
      restarted.recover(store.readTask(task.id, 'running'));
      store.moveTask(task.id, 'pending', 'running'); restarted.advance(store.readTask(task.id, 'running'));
      const restartDeadline = Date.now() + 15000;
      while (!stages.done.has(task.id)) { assert.ok(Date.now() < restartDeadline); await new Promise(resolve => setTimeout(resolve, 20)); }
      const recovered = restarted.read(task.id).evidence.environmentPreflight;
      assert.equal(recovered.status, mode === 'restart-dead' ? 'ready' : 'blocked');
      assert.equal(workers, mode === 'restart-dead' ? 2 : 1);
      if (mode === 'restart-ambiguous') assert.equal(recovered.reason, 'prior_process_unresolved');
    }
  });
}

test('clean passing Node project is ready without changing owner activation policy', async t => {
  const root = fixture(t, "console.log('check passed')");
  const project = { runtime: 'node', enabled: false, autoMerge: false };
  const result = await prepareRepositoryEnvironment(root, project);
  assert.equal(result.baseline.passed, true);
  assert.equal(result.status, 'ready');
  assert.deepEqual(project, { runtime: 'node', enabled: false, autoMerge: false });
});

for (const content of ['{', '{"runtime":"node","lockfile":"package-lock.json","verification":"check","autoMerge":true}']) {
  test(`invalid common contract fails concretely: ${content}`, async t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, '.ralph/project.json'), content);
    await assert.rejects(prepareRepositoryEnvironment(root, { runtime: 'node' }), e => e.outcome.reason === 'contract_invalid');
  });
}

test('npm script signal exit remains visible in the baseline evidence', async t => {
  const root = fixture(t, "process.kill(process.pid, 'SIGKILL')");
  // npm maps a script signal to the conventional shell exit 128 + signal.
  // A shell invoking npm itself can still report application exit statuses;
  // this fixture records the precise baseline rather than assuming a pass.
  const result = await prepareRepositoryEnvironment(root, { runtime: 'node' });
  assert.equal(result.baseline.passed, false);
  assert.equal(result.baseline.exitCode, 137);
});
