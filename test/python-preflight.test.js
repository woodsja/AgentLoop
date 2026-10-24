const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareRepositoryEnvironment } = require('../src/autopilot-environment');
const { withExecution } = require('../src/execution-log');

function fixture(t, source = 'python-project') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-python-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(__dirname, 'fixtures', source), root, { recursive: true, filter: source => !source.split(path.sep).some(part => ['.venv', '__pycache__'].includes(part)) });
  execFileSync('git', ['init', '-q', root]);
  commit(root);
  return root;
}
function commit(root) {
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
}
function contract(root, verification) {
  fs.writeFileSync(path.join(root, '.ralph/project.json'), JSON.stringify({ runtime: 'python', verification, lockfile: 'uv.lock' }));
}

test('real locked Python setup uses local venv, preserves red application checks and all raw streams', async t => {
  const root = fixture(t), records = [], claims = [], project = { runtime: 'python', enabled: false, autoMerge: false };
  const before = fs.readFileSync(path.join(root, 'uv.lock'));
  const result = await withExecution((event, details) => records.push({ event, ...details }), () => prepareRepositoryEnvironment(root, project, { onProcess: claim => claims.push(claim) }));
  assert.equal(result.status, 'ready');
  assert.equal(result.runtime, 'python');
  assert.equal(result.baseline.passed, false);
  assert.match(result.baseline.stdout, /x{25000}/);
  assert.match(result.baseline.stderr, /existing application bug/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'uv.lock')), before);
  assert.deepEqual(project, { runtime: 'python', enabled: false, autoMerge: false });
  assert.ok(records.some(r => r.event === 'command' && r.args.includes('--locked') && !r.args.includes('--frozen')));
  const output = stream => Buffer.concat(records.filter(r => r.event === 'output' && r.stream === stream).map(r => Buffer.from(r.base64, 'base64'))).toString();
  assert.match(output('stdout'), /x{25000}/);
  assert.match(output('stderr'), /exact Python check stderr/);
  assert.ok(claims.some(c => c?.startTime));
  assert.equal(claims.at(-1), null);
  assert.equal((await prepareRepositoryEnvironment(root, {})).status, 'ready', 'contract alone selects Python');
  fs.writeFileSync(path.join(root, 'check.py'), 'import sys; assert sys.prefix != sys.base_prefix; print("fixed")');
  assert.equal((await prepareRepositoryEnvironment(root, project)).baseline.passed, true);
});

for (const mode of ['lockfile_missing', 'lockfile_uncommitted', 'invalid', 'stale', 'metadata_missing']) {
  test(`Python ${mode} lock/setup errors require explicit repair`, async t => {
    const root = fixture(t), lock = path.join(root, 'uv.lock');
    if (mode === 'lockfile_missing') fs.unlinkSync(lock);
    if (mode === 'lockfile_uncommitted') fs.appendFileSync(lock, '\n');
    if (mode === 'invalid') { fs.writeFileSync(lock, 'invalid = ['); commit(root); }
    if (mode === 'stale') fs.writeFileSync(path.join(root, 'pyproject.toml'), fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8').replace('>=3.11', '>=3.12'));
    if (mode === 'metadata_missing') fs.unlinkSync(path.join(root, 'pyproject.toml'));
    const before = fs.existsSync(lock) ? fs.readFileSync(lock) : null;
    await assert.rejects(prepareRepositoryEnvironment(root, { runtime: 'python' }), e => e.code === 'PROJECT_PREFLIGHT_BLOCKED' && e.outcome.reason === (mode === 'metadata_missing' ? 'package_invalid' : ['invalid', 'stale'].includes(mode) ? 'install_failed' : mode) && /uv.lock|pyproject.toml/.test(e.message));
    if (before) assert.deepEqual(fs.readFileSync(lock), before);
  });
}

test('Python tooling resolves ordinary PATH and reports missing uv without installation', async t => {
  const root = fixture(t), prior = process.env.PATH;
  t.after(() => { process.env.PATH = prior; });
  process.env.PATH = '/usr/bin:/bin';
  if (!require('../src/engines').findOnPath('uv')) await assert.rejects(prepareRepositoryEnvironment(root, { runtime: 'python' }), e => e.outcome.reason === 'runtime_missing' && /uv/.test(e.message));
  process.env.PATH = prior;
  assert.equal((await prepareRepositoryEnvironment(root, { runtime: 'python' })).status, 'ready');
});

for (const mode of ['verification_unavailable', 'timeout', 'cancelled']) {
  test(`Python ${mode} terminates setup ownership and supports recovery`, async t => {
    const root = fixture(t), claims = [];
    let cancel = false;
    contract(root, mode === 'verification_unavailable' ? 'agentloop-missing-check' : 'python wait.py');
    fs.writeFileSync(path.join(root, 'wait.py'), 'import pathlib, time\npathlib.Path("started").touch()\ntime.sleep(60)\n');
    const interval = setInterval(() => { if (mode === 'cancelled' && fs.existsSync(path.join(root, 'started'))) cancel = true; }, 20);
    t.after(() => clearInterval(interval));
    await assert.rejects(prepareRepositoryEnvironment(root, { runtime: 'python' }, { timeoutMs: mode === 'timeout' ? 1500 : 10000, isCancelled: () => cancel, onProcess: claim => claims.push(claim) }), e => e.outcome.reason === mode);
    assert.equal(claims.at(-1), null);
    const { hasLiveClaim } = require('../src/r1-process-claim');
    assert.ok(claims.filter(Boolean).every(c => !hasLiveClaim({ workerPid: c.pid, workerStartTime: c.startTime })));
    contract(root, 'python -c "import sys; assert sys.prefix != sys.base_prefix" && python -c "import sys; assert sys.prefix != sys.base_prefix"');
    assert.equal((await prepareRepositoryEnvironment(root, { runtime: 'python' })).baseline.passed, true);
  });
}
const { createR1Jobs } = require('../src/r1-jobs');
const { configuredProjects } = require('../src/project-registry');
const { createJobStore } = require('../src/autopilot-state');
for (const mode of ['red-tests', 'missing-lock', 'restart-dead', 'restart-ambiguous']) {
  test(`public R1 Python ${mode}: durable readiness and zero wasted setup attempts`, async t => {
    const checkout = fixture(t);
    if (mode === 'missing-lock') {
      fs.unlinkSync(path.join(checkout, 'uv.lock'));
      execFileSync('git', ['-C', checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qam', 'remove lock']);
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-node-state-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const registry = path.join(root, 'owner.json'); fs.writeFileSync(registry, '{}');
    const project = { runtime: 'python', enabled: true, autoMerge: false, worker: 'codex', reviewPolicy: 'always', maxAttempts: 1,
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
        assert.equal(task.verification, 'export VIRTUAL_ENV="$PWD/.venv"; export PATH="$PWD/.venv/bin:$PATH"; python check.py');
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
      assert.equal(result.evidence.verification.stdout, undefined);
      assert.match(stages.done.get(task.id).r1.verification.stdout, /x{25000}/);
      assert.match(stages.done.get(task.id).r1.verification.stderr, /exact Python check stderr/);
      assert.ok(records.some(r => r.event === 'output' && Buffer.from(r.base64, 'base64').toString().includes('baseline stdout')));
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



test('real pytest source/cache failure preserves exact diagnostics, then repaired setup admits red tests', async t => {
  const root = fixture(t, 'python-pytest'), records = [];
  const oldCache = process.env.UV_CACHE_DIR, oldOffline = process.env.UV_OFFLINE;
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-empty-uv-cache-'));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const restore = () => {
    if (oldCache === undefined) delete process.env.UV_CACHE_DIR; else process.env.UV_CACHE_DIR = oldCache;
    if (oldOffline === undefined) delete process.env.UV_OFFLINE; else process.env.UV_OFFLINE = oldOffline;
  };
  t.after(restore);
  process.env.UV_CACHE_DIR = cache;
  process.env.UV_OFFLINE = 'true';
  await assert.rejects(withExecution((event, details) => records.push({ event, ...details }), () => prepareRepositoryEnvironment(root, { runtime: 'python' })), e => e.outcome.reason === 'install_failed' && /offline|cache|network/i.test(e.outcome.stderr) && /retry/.test(e.message));
  assert.ok(records.some(r => r.event === 'output' && r.stream === 'stderr'));
  restore();
  const result = await prepareRepositoryEnvironment(root, { runtime: 'python' });
  assert.equal(result.status, 'ready');
  assert.equal(result.baseline.passed, false);
  assert.match(result.baseline.stdout, /existing pytest application bug/);
  fs.writeFileSync(path.join(root, 'test_existing.py'), 'def test_fixed(): assert 1 == 1\n');
  assert.equal((await prepareRepositoryEnvironment(root, { runtime: 'python' })).baseline.passed, true);
});


test('ambient active venv and uv target cannot redirect project-local setup', async t => {
  const root = fixture(t), previous = { VIRTUAL_ENV: process.env.VIRTUAL_ENV, UV_PROJECT_ENVIRONMENT: process.env.UV_PROJECT_ENVIRONMENT };
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.VIRTUAL_ENV = '/tmp/agentloop-unrelated-venv';
  process.env.UV_PROJECT_ENVIRONMENT = '/tmp/agentloop-unrelated-venv';
  const result = await prepareRepositoryEnvironment(root, { runtime: 'python' });
  assert.equal(result.status, 'ready');
  assert.match(result.baseline.stderr, /existing application bug/);
  assert.ok(fs.existsSync(path.join(root, '.venv/bin/python')));
});
