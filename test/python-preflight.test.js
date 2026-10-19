const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareRepositoryEnvironment } = require('../src/autopilot-environment');

test('fresh Python setup blocks DNS failure before admission with a sanitized infrastructure reason', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'python-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policy = { interpreter: '/usr/bin/python3', indexUrl: 'https://pypi.org/simple', timeoutMs: 1000,
    dependencies: ['pytest', 'ruff'].map(name => ({ name, version: '1.0', sha256: 'a'.repeat(64), wheel: `${name}-1.0-py3-none-any.whl` })), commands: [] };
  const calls = [];
  await assert.rejects(prepareRepositoryEnvironment(root, { pythonEnvironment: policy }, { execFile(file, args, options, callback) {
    calls.push(args);
    if (args.includes('venv')) {
      fs.mkdirSync(path.join(root, '.venv/bin'), { recursive: true });
      fs.writeFileSync(path.join(root, '.venv/bin/python'), '');
      fs.writeFileSync(path.join(root, '.venv/pyvenv.cfg'), 'include-system-site-packages = false');
      callback(null, '', '');
    } else if (args.some(value => value.startsWith('import sys,os; assert os.path.realpath(sys.prefix)'))) callback(null);
    else if (args.includes('install')) callback(new Error('DNS https://secret:password@example.invalid/private'), '', 'Temporary failure in name resolution token=private');
    else callback(new Error('missing dependencies'), '', '');
    return { kill() {} };
  } }), error => error.code === 'PYTHON_PREFLIGHT_BLOCKED' && error.outcome.reason === 'package_index_transport'
    && !JSON.stringify(error.outcome).includes('private'));
  assert.ok(calls.some(args => args.includes('install')));
});

const crypto = require('node:crypto');
const execGit = require('node:util').promisify(require('node:child_process').execFile);
const { createR1Jobs } = require('../src/r1-jobs');
const { configuredProjects } = require('../src/project-registry');
const { createJobStore } = require('../src/autopilot-state');
async function harness(t, mode = 'fresh') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-python-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'repo'); fs.mkdirSync(checkout);
  const git = (...args) => execGit('git', args, { cwd: checkout });
  await git('init', '-b', 'main'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(checkout, 'initial'), 'fixture'); await git('add', '.'); await git('commit', '-m', 'Initial');
  const registry = path.join(root, 'owner.json'); fs.writeFileSync(registry, '{}');
  const dependencies = ['pytest', 'ruff'].map(name => ({ name, version: '1.0', wheel: `${name}-1.0-py3-none-any.whl`, sha256: crypto.createHash('sha256').update(name).digest('hex') }));
  const policy = { interpreter: '/usr/bin/python3', indexUrl: 'https://pypi.org/simple', timeoutMs: 2000, dependencies, commands: ['project-check'] };
  if (mode === 'install-command-network') policy.indexUrl = 'https://network.example.invalid/simple';
  const project = { enabled: true, autoMerge: false, worker: 'codex', reviewPolicy: 'always', maxAttempts: 1,
    repo: 'example/repo', checkout, worktreeRoot: path.join(root, 'worktrees'), baseBranch: 'main', readyLabel: 'staged-fixture',
    humanLabel: 'human', stateDir: path.join(root, 'state'), verification: 'true', pythonEnvironment: policy };
  if (mode.startsWith('offline')) {
    delete policy.indexUrl;
    policy.wheelhouse = path.join(root, 'wheels'); fs.mkdirSync(policy.wheelhouse);
    for (const d of dependencies) fs.writeFileSync(path.join(policy.wheelhouse, d.wheel), d.name);
    if (mode === 'offline-corrupt') fs.writeFileSync(path.join(policy.wheelhouse, dependencies[0].wheel), 'corrupt');
    if (mode === 'offline-incomplete') fs.unlinkSync(path.join(policy.wheelhouse, dependencies[0].wheel));
    if (mode === 'offline-unapproved') fs.writeFileSync(path.join(policy.wheelhouse, 'unapproved.whl'), 'unapproved');
  }
  const stages = { pending: new Map(), running: new Map(), done: new Map() };
  const store = {
    paths: { config: registry }, config: { allowedProjects: configuredProjects({ demo: { root: checkout, worktreeRoot: project.worktreeRoot } }, registry) },
    enqueueTask(task) { const value = { ...task, id: `t-${String(stages.pending.size + stages.running.size + stages.done.size + 1).padStart(8, '0')}` }; stages.pending.set(value.id, value); return value; },
    appendLogLine() {},
    appendExecution() {},
    writeTask(task, stage) { stages[stage].set(task.id, structuredClone(task)); },
    readTask(id, stage) { const value = stages[stage].get(id); if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return structuredClone(value); },
    listTasks(stage) { return [...stages[stage].values()]; },
    listR1ChildLoops() { return []; },
    writeResult() {},
    moveTask(id, from, to) { const task = stages[from].get(id); stages[from].delete(id); stages[to].set(id, task); },
  };
  let installers = 0, workers = 0, reviewers = 0, prepared = mode === 'legacy-prepared', release;
  const calls = [];
  const fakeExec = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const cwd = options.cwd;
    if (args.includes('venv')) {
      if (mode === 'interpreter') { callback(Object.assign(new Error('missing'), { code: 'ENOENT' })); return; }
      fs.mkdirSync(path.join(cwd, '.venv/bin'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.venv/bin/python'), '');
      fs.writeFileSync(path.join(cwd, '.venv/pyvenv.cfg'), 'include-system-site-packages = false');
      callback(null); return;
    }
    if (args.includes('install')) {
      installers++;
      assert.equal(options.env.PYTHONPATH, undefined);
      assert.equal(options.shell, false);
      assert.ok(file.startsWith(path.join(cwd, '.venv/bin/')));
      const complete = () => {
        if (['network', 'offline-network'].includes(mode)) callback(new Error('DNS token=private'), '', 'Temporary failure in name resolution https://private.invalid');
        else if (mode === 'timeout') callback(Object.assign(new Error('timed out'), { killed: true }));
        else if (mode === 'output-overflow') callback(Object.assign(new Error('overflow'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), '', '');
        else if (mode === 'install-command-network') callback(new Error(`Command failed: ${file} ${args.join(' ')}`), '', 'Incompatible wheel');
        else if (mode === 'install-requirement-echo') callback(new Error('pip failed'), '', 'ERROR: Could not find a version that satisfies the requirement dnspython==1.0\nERROR: No matching distribution found for dnspython==1.0');
        else {
          prepared = !['incompatible', 'probe-dns'].includes(mode);
          if (policy.dependencies.some(d => d.name === 'dnspython')) fs.writeFileSync(path.join(cwd, '.venv/old-distribution'), 'dnspython');
          callback(null);
        }
      };
      if (mode === 'cancel' || mode === 'concurrent') {
        release = complete;
        return { kill() { callback(Object.assign(new Error('cancelled'), { killed: true })); } };
      }
      complete(); return;
    }
    if (args.some(value => value.startsWith('import sys,os; assert os.path.realpath(sys.prefix)'))) { callback(null); return; }
    if (prepared && !(fs.existsSync(path.join(cwd, '.venv/old-distribution')) && !policy.dependencies.some(d => d.name === 'dnspython'))) callback(null);
    else callback(new Error(`Command failed: ${file} ${args.join(' ')}`), '', 'not installed');
  };
  const deps = {
    loadProjectConfig: () => project, discoverReadyIssues: async () => [{ number: 1, title: 'Issue', body: 'Acceptance criteria for isolated Python verification environment.' }],
    findOpenIssuePullRequests: async () => [], readRepositoryInstructions: async () => [],
    prepareIssueWorkspace: async (_p, issue, options) => {
      const worktreePath = path.join(project.worktreeRoot, `issue-${issue.number}`);
      if (!fs.existsSync(worktreePath)) await git('worktree', 'add', '-b', options.branch, worktreePath, 'HEAD');
      if (mode === 'escape') fs.symlinkSync(checkout, path.join(worktreePath, '.venv'));
      if (mode === 'escape-bin') { fs.mkdirSync(path.join(worktreePath, '.venv')); fs.symlinkSync(checkout, path.join(worktreePath, '.venv/bin')); }
      if (mode === 'legacy-prepared') {
        fs.mkdirSync(path.join(worktreePath, '.venv/bin'), { recursive: true });
        fs.writeFileSync(path.join(worktreePath, '.venv/bin/python'), '');
        fs.writeFileSync(path.join(worktreePath, '.venv/pyvenv.cfg'), 'include-system-site-packages = false');
      }
      return { worktreePath, branch: options.branch };
    },
    cleanupIssueWorkspace: async () => {},
    prepareRepositoryEnvironment: async (cwd, p, options) => {
      const outcome = await prepareRepositoryEnvironment(cwd, p, mode === 'offline-real' ? options : { ...options, execFile: fakeExec });
      if (mode === 'cancel-after-ready') {
        const read = store.readTask;
        // The readiness checkpoint and subsequent admission check both see
        // the task missing from running; later result reads work normally.
        let missingReads = 2;
        store.readTask = () => {
          if (--missingReads === 0) store.readTask = read;
          throw Object.assign(new Error('task left running'), { code: 'ENOENT' });
        };
      }
      return outcome;
    },
    createRalphTaskService: () => ({ run: async () => { workers++; return { status: 'failed', attempts: [] }; } }),
    reviewPullRequest: async () => { reviewers++; assert.fail('No failed implementation or preflight should reach review'); },
  };
  const jobs = createR1Jobs(store, { autopilotDependencies: deps });
  const start = () => { const task = jobs.submit({ project: 'demo', issue: 1 }); store.moveTask(task.id, 'pending', 'running'); jobs.advance(task); return task; };
  const until = async condition => { const deadline = Date.now() + (mode === 'offline-real' ? 25000 : 5000); while (!condition()) { assert.ok(Date.now() < deadline, 'job completed within deadline'); await new Promise(resolve => setTimeout(resolve, 10)); } };
  return { root, project, jobs, store, stages, start, until, calls, fakeExec, release: () => release(), counts: () => ({ installers, workers, reviewers }),
    feature: () => createJobStore(project.stateDir).load(1), restart: () => createR1Jobs(store, { autopilotDependencies: deps }) };
}
for (const [mode, reason] of [['network', 'package_index_transport'], ['interpreter', 'interpreter_missing'], ['timeout', 'timeout'], ['incompatible', 'dependency_incompatible'], ['probe-dns', 'dependency_incompatible'],
  ['install-command-network', 'dependency_incompatible'], ['install-requirement-echo', 'dependency_incompatible'], ['output-overflow', 'output_limit'], ['offline-network', 'dependency_incompatible'], ['cancel-after-ready', 'cancelled'],
  ['offline-corrupt', 'offline_bundle_invalid'], ['offline-incomplete', 'offline_bundle_invalid'], ['offline-unapproved', 'offline_bundle_invalid'], ['escape', 'unsafe_path'], ['escape-bin', 'unsafe_path']]) {
  test(`public R1 admission blocks ${mode} before any worker or critic`, async t => {
    const h = await harness(t, mode);
    if (mode === 'probe-dns') h.project.pythonEnvironment.dependencies.push({ ...h.project.pythonEnvironment.dependencies[0], name: 'dnspython', wheel: 'dnspython-1.0-py3-none-any.whl' });
    const task = h.start();
    await h.until(() => h.stages.done.has(task.id));
    const result = h.jobs.read(task.id);
    assert.equal(result.status, 'blocked');
    assert.equal(result.evidence.environmentPreflight.reason, reason);
    assert.equal(result.evidence.environmentPreflight.category, 'infrastructure');
    assert.equal(result.evidence.verification, null);
    assert.equal(result.evidence.review, null);
    assert.deepEqual(h.counts(), { installers: ['network', 'timeout', 'incompatible', 'probe-dns', 'install-command-network', 'install-requirement-echo', 'output-overflow', 'offline-network', 'cancel-after-ready'].includes(mode) ? 1 : 0, workers: 0, reviewers: 0 });
    assert.ok(!JSON.stringify(result).includes('private'));
    assert.deepEqual(h.restart().read(task.id), result, 'durable queue evidence survives recreation');
    const replay = h.start(); await h.until(() => h.stages.done.has(replay.id));
    assert.equal(h.counts().workers, 0, 'blocked feature record prevents automatic retries');
  });
}
for (const mode of ['fresh', 'offline']) {
  test(`public R1 ${mode} setup admits only after readiness and reuses approved environment`, async t => {
    const h = await harness(t, mode), task = h.start();
    await h.until(() => h.stages.done.has(task.id));
    assert.equal(h.jobs.read(task.id).evidence.environmentPreflight.status, 'ready');
    assert.deepEqual(h.counts(), { installers: 1, workers: 1, reviewers: 0 });
    const install = h.calls.find(c => c.args.includes('install'));
    assert.ok(install.args.includes('--require-hashes'));
    if (mode === 'offline') { assert.ok(install.args.includes('--no-index')); assert.ok(!install.args.includes('--index-url')); }
    const before = h.counts().installers;
    const outcome = await prepareRepositoryEnvironment(h.feature().worktreePath, h.project, { execFile: (file, args, options, cb) => {
      assert.ok(!args.includes('install')); cb(null);
    } });
    assert.equal(outcome.reused, true); assert.equal(h.counts().installers, before);
  });
}
test('public R1 cancellation terminates setup without admitting a worker', async t => {
  const h = await harness(t, 'cancel'), task = h.start();
  await h.until(() => h.counts().installers === 1);
  const current = h.store.readTask(task.id, 'running'); current.cancelRequested = true; h.store.writeTask(current, 'running');
  await h.until(() => h.stages.done.has(task.id));
  assert.equal(h.jobs.read(task.id).evidence.environmentPreflight.reason, 'cancelled');
  assert.equal(h.counts().workers, 0);
});
test('public R1 duplicate/concurrent admission never starts a duplicate installer', async t => {
  const h = await harness(t, 'concurrent'), first = h.start();
  await h.until(() => h.counts().installers === 1);
  h.jobs.advance(first);
  const second = h.start();
  await h.until(() => h.stages.done.has(second.id));
  assert.equal(h.counts().installers, 1);
  h.release();
  await h.until(() => h.stages.done.has(first.id));
  assert.equal(h.counts().workers, 1);
});
test('public R1 default non-Python project remains compatible', async t => {
  const h = await harness(t); delete h.project.pythonEnvironment;
  const task = h.start(); await h.until(() => h.stages.done.has(task.id));
  assert.deepEqual(h.counts(), { installers: 0, workers: 1, reviewers: 0 });
  assert.equal(h.jobs.read(task.id).evidence.environmentPreflight, undefined);
});

for (const mode of ['legacy-fresh', 'legacy-prepared']) {
  test(`public R1 ${mode} Python project requires owner policy before installation`, async t => {
    const h = await harness(t, mode); delete h.project.pythonEnvironment; h.project.prepareVenv = true;
    const task = h.start(); await h.until(() => h.stages.done.has(task.id));
    const outcome = h.jobs.read(task.id).evidence.environmentPreflight;
    assert.equal(outcome.status, mode === 'legacy-prepared' ? 'ready' : 'blocked');
    assert.equal(h.counts().installers, 0);
    assert.equal(h.counts().workers, mode === 'legacy-prepared' ? 1 : 0);
  });
}
for (const unresolved of [false, true]) {
  test(`public R1 restart ${unresolved ? 'blocks ambiguous installer ownership' : 'recovers interrupted unreceipted preparation'}`, async t => {
    const h = await harness(t), task = h.start();
    await h.until(() => h.stages.done.has(task.id));
    const featureStore = createJobStore(h.project.stateDir), job = featureStore.load(1);
    job.terminal = false; job.terminalState = null; job.status = 'environment_preflight'; job.workspaceState = 'prepared';
    job.ralph = { status: null, attempts: 0, taskId: null };
    job.environmentPreflight = { status: 'preparing', category: 'infrastructure' };
    job.environmentProcess = unresolved ? { pid: null, startTime: null } : { pid: 99999999, startTime: '1' };
    featureStore.save(job);
    fs.unlinkSync(path.join(job.worktreePath, '.venv/ralph-python-policy.json'));
    fs.writeFileSync(path.join(job.worktreePath, '.venv/ralph-requirements.txt'), 'interrupted partial file');
    h.store.moveTask(task.id, 'done', 'running');
    const restarted = h.restart(); restarted.recover(h.store.readTask(task.id, 'running'));
    h.store.moveTask(task.id, 'pending', 'running'); restarted.advance(h.store.readTask(task.id, 'running'));
    await h.until(() => h.stages.done.has(task.id));
    const outcome = restarted.read(task.id).evidence.environmentPreflight;
    assert.equal(outcome.status, unresolved ? 'blocked' : 'ready');
    if (unresolved) assert.equal(outcome.reason, 'prior_process_unresolved');
    assert.equal(h.counts().installers, unresolved ? 1 : 2);
    assert.equal(h.counts().workers, unresolved ? 1 : 2);
  });
}

test('public R1 approved offline wheels exercise the real isolated venv, pip and readiness runner', { timeout: 30000 }, async t => {
  const h = await harness(t, 'offline-real');
  // Some managed execution sandboxes discard writes to child stdin. The
  // production admission handshake must fail closed there; do not bypass it.
  const stdinProbe = path.join(h.root, 'stdin-probe');
  await new Promise(resolve => {
    const child = require('node:child_process').execFile(process.execPath, ['-e',
      "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>require('fs').writeFileSync(process.argv[1],s))", stdinProbe], () => resolve());
    child.stdin.end('start\n');
  });
  if (fs.readFileSync(stdinProbe, 'utf8') !== 'start\n') { t.skip('Execution sandbox discards child stdin required by the durable installer handshake'); return; }
  h.project.pythonEnvironment.timeoutMs = 20000;
  await execGit('/usr/bin/python3', [path.join(__dirname, 'fixtures/build-python-wheels.py'), h.project.pythonEnvironment.wheelhouse]);
  for (const d of h.project.pythonEnvironment.dependencies) d.sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(h.project.pythonEnvironment.wheelhouse, d.wheel))).digest('hex');
  const task = h.start();
  await h.until(() => h.stages.done.has(task.id));
  const outcome = h.jobs.read(task.id).evidence.environmentPreflight;
  assert.equal(outcome.status, 'ready', JSON.stringify(outcome));
  assert.equal(h.counts().workers, 1);
  const reused = await prepareRepositoryEnvironment(h.feature().worktreePath, h.project);
  assert.equal(reused.reused, true);
});

test('public mixed-engine R1 preflight failure produces no child/critic recovery verdict', async t => {
  const h = await harness(t, 'network'); h.project.implementationStrategy = 'worker-critic-loop';
  const task = h.start(); await h.until(() => h.stages.done.has(task.id));
  const result = h.jobs.read(task.id);
  assert.equal(result.evidence.environmentPreflight.reason, 'package_index_transport');
  assert.equal(result.evidence.review, null);
  assert.equal(h.counts().workers, 0);
  assert.ok(!result.evidence.diagnostics.some(item => item.phase === 'cleanup'));
});
test('owner Python policy rejects unapproved sources, incomplete identities and unsafe paths', () => {
  const { validatePythonPolicy } = require('../src/python-preflight');
  const valid = { interpreter: '/usr/bin/python3', timeoutMs: 1000, indexUrl: 'https://pypi.org/simple', commands: [],
    dependencies: ['pytest', 'ruff'].map(name => ({ name, version: '1.0', wheel: `${name}-1.0-py3-none-any.whl`, sha256: 'a'.repeat(64) })) };
  const variants = [ { indexUrl: 'http://index.invalid' }, { indexUrl: 'https://token:private@index.invalid' },
    { wheelhouse: '/owner/wheels' }, { interpreter: 'python3' }, { timeoutMs: 0 }, { commands: ['../outside'] },
    { dependencies: [valid.dependencies[0]] }, { dependencies: valid.dependencies.map(d => ({ ...d, sha256: '' })) },
    { dependencies: valid.dependencies.map(d => ({ ...d, wheel: '../escape.whl' })) } ];
  for (const variant of variants) assert.throws(() => validatePythonPolicy({ ...valid, ...variant }), error => error.code === 'PYTHON_PREFLIGHT_BLOCKED');
});

test('changed owner policy rebuilds a retained environment without removed distributions', async t => {
  const h = await harness(t);
  const policy = h.project.pythonEnvironment;
  policy.dependencies.push({ ...policy.dependencies[0], name: 'dnspython', wheel: 'dnspython-1.0-py3-none-any.whl' });
  const task = h.start();
  await h.until(() => h.stages.done.has(task.id));
  assert.equal(h.jobs.read(task.id).evidence.environmentPreflight.status, 'ready');
  const cwd = h.feature().worktreePath;
  assert.ok(fs.existsSync(path.join(cwd, '.venv/old-distribution')));
  policy.dependencies.pop();
  const outcome = await prepareRepositoryEnvironment(cwd, h.project, { execFile: h.fakeExec });
  assert.equal(outcome.status, 'ready');
  assert.equal(outcome.reused, false);
  assert.ok(!fs.existsSync(path.join(cwd, '.venv/old-distribution')));
  assert.equal(h.calls.filter(c => c.args.includes('venv')).length, 2);
  const reused = await prepareRepositoryEnvironment(cwd, h.project, { execFile: h.fakeExec });
  assert.equal(reused.reused, true);
  assert.equal(h.counts().installers, 2);
});

test('real Python preflight subprocess bounds megabyte output while retaining transport diagnostics', async () => {
  const { execFile } = require('../src/execution-log');
  const runner = path.join(__dirname, '..', 'src', 'python-preflight-runner.js');
  const flood = "process.stdout.write('x'.repeat(1024 * 1024)); process.stderr.write('é'.repeat(64 * 1024)); process.stderr.write('Temporary failure in name resolution'); process.exitCode = 7;";
  const result = await new Promise(resolve => {
    const child = execFile(process.execPath, [runner, process.execPath, '-e', flood], {
      encoding: 'utf8', executionPreviewBytes: 4096, timeout: 12000,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    child.stdin.end('start\n');
  });
  assert.equal(result.error?.code, 7, `runner must preserve actual exit code, not ${result.error?.code}`);
  assert.equal(result.stdout, 'x'.repeat(4096));
  assert.ok(Buffer.byteLength(result.stderr) <= 4096, 'forwarded diagnostic output must fit buffer');
  assert.match(result.stderr, /Temporary failure in name resolution$/);
});
