'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { configuredProjects } = require('../src/project-registry');

function git(dir, ...args) { return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }); }

test('R1 parent with maxConcurrent=1 admits its own child but not unrelated jobs', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-scheduler-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'repo'); fs.mkdirSync(checkout);
  git(checkout, 'init', '-b', 'main'); git(checkout, 'config', 'user.email', 'test@example.invalid'); git(checkout, 'config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(checkout, 'README'), 'hello'); git(checkout, 'add', '.'); git(checkout, 'commit', '-m', 'init');
  const worktreeRoot = path.join(root, 'worktrees'); fs.mkdirSync(worktreeRoot);
  const worktree = path.join(worktreeRoot, 'issue-5'); git(checkout, 'worktree', 'add', '-b', 'issue-5', worktree);
  fs.writeFileSync(path.join(worktree, 'PLAN.md'), '- Implement change\n');
  const configPath = path.join(root, 'owner.json');
  fs.writeFileSync(configPath, JSON.stringify({ dashboardPort: 0, maxConcurrent: 1, defaultEngine: 'codex',
    enginePaths: { codex: '/usr/bin/true', claude: '/usr/bin/true' },
    allowedProjects: { demo: { root: checkout, worktreeRoot } } }));
  const stateRoot = path.join(root, 'state');
  const old = { config: process.env.AGENTLOOP_CONFIG_PATH, state: process.env.AGENTLOOP_STATE_DIR };
  process.env.AGENTLOOP_CONFIG_PATH = configPath;
  process.env.AGENTLOOP_STATE_DIR = stateRoot;
  const keys = ['../src/store', '../src/daemon'];
  const oldModules = keys.map(name => require.cache[require.resolve(name)]);
  for (const name of keys) delete require.cache[require.resolve(name)];
  const store = require('../src/store');
  const daemon = require('../src/daemon');
  const project = { enabled: true, repo: 'example/repo', checkout, worktreeRoot, baseBranch: 'main',
    reviewPolicy: 'always', worker: 'codex', readyLabel: 'ready-for-agent', humanLabel: 'ready-for-human',
    verification: 'true', maxAttempts: 1, stateDir: path.join(root, 'jobs') };
  let release;
  const discovery = new Promise(resolve => { release = resolve; });
  try {
    store.ensureDirs();
    const parent = store.enqueueTask({ workflow: 'r1', project: 'demo', issue: 5, status: 'running', phase: 'implementation',
      r1: { project: 'demo', issue: { number: 5, title: 'demo' }, status: 'running', runs: 1,
        terminal: false, workspaceState: 'prepared', worktreePath: worktree } });
    store.moveTask(parent.id, 'pending', 'running');
    const current = store.readTask(parent.id, 'running');
    const child = store.enqueueR1ChildLoopOnce(parent.id, 1, {
      type: 'loop', source: 'r1', title: 'child', project: 'demo', projectPath: worktree, engine: 'codex',
      workerEngine: 'codex', criticEngine: 'claude', autoCommit: false, maxCycles: 1,
      taskRetries: 1, r1Child: { parentJobId: parent.id, attempt: 1, issue: 5 },
    });
    const unrelated = store.enqueueTask({ title: 'unrelated', status: 'queued', project: 'demo', cwd: checkout, engine: 'codex' });
    // initialize R1 with a deferred discovery callback so it remains active
    // during this synchronous queue admission without contacting GitHub.
    daemon.start({ r1: { autopilotDependencies: {
      loadProjectConfig: () => project, discoverReadyIssues: () => discovery,
    } } });
    // start() calls fillSlots immediately upon listening: check the real scheduler.
    const deadline = Date.now() + 2500;
    let observed;
    while (Date.now() < deadline) {
      try { observed = store.readTask(child.id, 'running'); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // A very fast dummy worker can already have finished by the time we sample.
    if (!observed) observed = store.readTask(child.id, 'done');
    assert.equal(observed.r1Child.parentJobId, parent.id);
    assert.equal(observed.type, 'loop');
    assert.equal(store.readTask(unrelated.id, 'pending').id, unrelated.id);
    assert.equal(current.workflow, 'r1');
  } finally {
    release([]);
    await daemon.stop(() => {});
    if (old.config === undefined) delete process.env.AGENTLOOP_CONFIG_PATH;
    else process.env.AGENTLOOP_CONFIG_PATH = old.config;
    if (old.state === undefined) delete process.env.AGENTLOOP_STATE_DIR;
    else process.env.AGENTLOOP_STATE_DIR = old.state;
    for (let i = 0; i < keys.length; i++) {
      delete require.cache[require.resolve(keys[i])];
      if (oldModules[i]) require.cache[require.resolve(keys[i])] = oldModules[i];
    }
  }
});

test('daemon restart marks interrupted child terminal and recovers its R1 parent without duplicate child', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-child-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'owner.json');
  fs.writeFileSync(configPath, JSON.stringify({ dashboardPort: 0, allowedProjects: {} }));
  const stateRoot = path.join(root, 'queue');
  const old = { config: process.env.AGENTLOOP_CONFIG_PATH, state: process.env.AGENTLOOP_STATE_DIR };
  process.env.AGENTLOOP_CONFIG_PATH = configPath;
  process.env.AGENTLOOP_STATE_DIR = stateRoot;
  const keys = ['../src/store', '../src/daemon'];
  const oldModules = keys.map(name => require.cache[require.resolve(name)]);
  for (const name of keys) delete require.cache[require.resolve(name)];
  const store = require('../src/store'), daemon = require('../src/daemon');
  try {
    const parent = store.enqueueTask({ workflow: 'r1', project: 'demo', issue: 5, status: 'running', phase: 'implementation' });
    store.moveTask(parent.id, 'pending', 'running');
    const child = store.enqueueLoop({ source: 'r1', project: 'demo', projectPath: root,
      workerEngine: 'codex', criticEngine: 'claude', engine: 'codex', status: 'running',
      cycles: [{ n: 1, status: 'running', phase: 'worker' }],
      workerPid: 99999999, workerStartTime: '12345',
      r1Child: { parentJobId: parent.id, attempt: 1, issue: 5 } });
    store.moveTask(child.id, 'pending', 'running');
    const waitingParent = store.enqueueTask({ workflow: 'r1', project: 'demo', issue: 6, status: 'running' });
    store.moveTask(waitingParent.id, 'pending', 'running');
    const orphan = store.enqueueLoop({ source: 'r1', project: 'demo', type: 'loop', status: 'queued',
      r1Child: { parentJobId: waitingParent.id, attempt: 1, issue: 6 } });
    const retainedParent = store.enqueueTask({ workflow: 'r1', project: 'demo', issue: 7, status: 'running' });
    store.moveTask(retainedParent.id, 'pending', 'running');
    const ambiguous = store.enqueueLoop({ source: 'r1', project: 'demo', type: 'loop', status: 'running',
      r1Child: { parentJobId: retainedParent.id, attempt: 1, issue: 7 } });
    store.moveTask(ambiguous.id, 'pending', 'running');
    daemon.start({ r1: { autopilotDependencies: { discoverReadyIssues: async () => [] } } });
    assert.equal(store.readTask(ambiguous.id, 'running').recoveryBlocked, true,
      'an unclaimed former agent is never guessed to be dead');
    assert.equal(store.readTask(retainedParent.id, 'pending').phase, 'recovering');
    const recovered = store.readTask(child.id, 'done');
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.reason, 'daemon_restarted');
    assert.equal(store.readTask(parent.id, 'pending').phase, 'recovering');
    assert.equal(fs.readdirSync(store.paths.pending).filter(name => name.startsWith(child.id)).length, 0);
    assert.equal(store.readTask(orphan.id, 'done').reason, 'r1_child_unauthorized');
    assert.equal(store.readTask(waitingParent.id, 'pending').phase, 'recovering');
  } finally {
    await daemon.stop(() => {});
    if (old.config === undefined) delete process.env.AGENTLOOP_CONFIG_PATH;
    else process.env.AGENTLOOP_CONFIG_PATH = old.config;
    if (old.state === undefined) delete process.env.AGENTLOOP_STATE_DIR;
    else process.env.AGENTLOOP_STATE_DIR = old.state;
    for (let i = 0; i < keys.length; i++) {
      delete require.cache[require.resolve(keys[i])];
      if (oldModules[i]) require.cache[require.resolve(keys[i])] = oldModules[i];
    }
  }
});

test('cancelling an R1 parent cancels its pending reserved child before any worker starts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-cancel-child-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ dashboardPort: 0, allowedProjects: {} }));
  const old = { config: process.env.AGENTLOOP_CONFIG_PATH, state: process.env.AGENTLOOP_STATE_DIR };
  process.env.AGENTLOOP_CONFIG_PATH = configPath;
  process.env.AGENTLOOP_STATE_DIR = path.join(root, 'state');
  const keys = ['../src/store', '../src/daemon'];
  const oldModules = keys.map(name => require.cache[require.resolve(name)]);
  for (const name of keys) delete require.cache[require.resolve(name)];
  const store = require('../src/store'), daemon = require('../src/daemon');
  const server = daemon.createHttpServer();
  try {
    const parent = store.enqueueTask({ workflow: 'r1', project: 'demo', issue: 5,
      status: 'running', phase: 'implementation' });
    store.moveTask(parent.id, 'pending', 'running');
    const loop = store.enqueueR1ChildLoopOnce(parent.id, 1, {
      source: 'r1', title: 'child', type: 'loop', project: 'demo', projectPath: root,
      engine: 'codex', workerEngine: 'codex', criticEngine: 'claude', autoCommit: false,
      maxCycles: 1, taskRetries: 1, r1Child: { parentJobId: parent.id, attempt: 1, issue: 5 },
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/cancel`;
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: parent.id }) });
    assert.equal(res.status, 200);
    assert.equal(store.readTask(parent.id, 'running').cancelRequested, true);
    assert.equal(store.readTask(loop.id, 'done').status, 'cancelled');
    assert.equal(store.listR1ChildLoops(parent.id)[0].stage, 'done');
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: parent.id }) })).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (old.config === undefined) delete process.env.AGENTLOOP_CONFIG_PATH;
    else process.env.AGENTLOOP_CONFIG_PATH = old.config;
    if (old.state === undefined) delete process.env.AGENTLOOP_STATE_DIR;
    else process.env.AGENTLOOP_STATE_DIR = old.state;
    for (let i = 0; i < keys.length; i++) {
      delete require.cache[require.resolve(keys[i])];
      if (oldModules[i]) require.cache[require.resolve(keys[i])] = oldModules[i];
    }
  }
});
