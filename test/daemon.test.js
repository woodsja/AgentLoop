const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, execFileSync } = require('node:child_process');

const daemon = require('../src/daemon');
const store = require('../src/store');

const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon.js'), 'utf8');

function requestJson(server, method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      method,
      path: requestPath,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function requestBytes(server, requestPath) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    http.get({ host: '127.0.0.1', port: address.port, path: requestPath }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, bytes: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

function isolatedDaemon(config, stateDir) {
  const configPath = path.join(stateDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const oldConfig = process.env.AGENTLOOP_CONFIG_PATH;
  const oldState = process.env.AGENTLOOP_STATE_DIR;
  const daemonModule = require.resolve('../src/daemon');
  const storeModule = require.resolve('../src/store');
  const oldDaemon = require.cache[daemonModule];
  const oldStore = require.cache[storeModule];
  process.env.AGENTLOOP_CONFIG_PATH = configPath;
  process.env.AGENTLOOP_STATE_DIR = path.join(stateDir, 'state');
  delete require.cache[daemonModule];
  delete require.cache[storeModule];
  const isolatedStore = require('../src/store');
  const isolated = require('../src/daemon');

  return {
    daemon: isolated,
    store: isolatedStore,
    restore() {
      if (oldConfig === undefined) delete process.env.AGENTLOOP_CONFIG_PATH;
      else process.env.AGENTLOOP_CONFIG_PATH = oldConfig;
      if (oldState === undefined) delete process.env.AGENTLOOP_STATE_DIR;
      else process.env.AGENTLOOP_STATE_DIR = oldState;
      delete require.cache[daemonModule];
      delete require.cache[storeModule];
      if (oldDaemon) require.cache[daemonModule] = oldDaemon;
      if (oldStore) require.cache[storeModule] = oldStore;
    },
  };
}

async function listenHttp(t, server) {
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    return true;
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('loopback listeners are unavailable in this sandbox');
      return false;
    }
    throw error;
  }
}

test('legacy HTTP submission routes are removed and cannot enqueue a new task', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlander-http-'));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const isolated = isolatedDaemon({ allowedProjects: { demo: project } }, directory);
  const server = isolated.daemon.createHttpServer();
  try {
    if (!await listenHttp(t, server)) return;
    for (const endpoint of ['/api/jobs', '/api/dispatch', '/api/loop']) {
      const res = await requestJson(server, 'POST', endpoint, { project: 'demo', prompt: 'Do not queue this legacy task' });
      assert.equal(res.status, 404, endpoint + ' must not admit new tasks');
    }
    assert.equal(isolated.store.listTasks('pending').length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    isolated.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('retired pending direct tasks are closed without launching a worker', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlander-pending-'));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const isolated = isolatedDaemon({
    allowedProjects: { demo: project }, maxConcurrent: 1, defaultEngine: 'codex',
    enginePaths: { codex: '/nonexistent/highlander-codex-worker' },
  }, directory);
  const server = isolated.daemon.createHttpServer();
  try {
    if (!await listenHttp(t, server)) return;
    const pending = isolated.store.enqueueTask({ project: 'demo', cwd: fs.realpathSync(project), engine: 'codex', prompt: 'Retired work must not execute' });
    isolated.daemon.fillSlots();
    const done = isolated.store.readTask(pending.id, 'done');
    assert.equal(done.status, 'failed');
    assert.equal(done.reason, 'legacy_execution_retired');
    const result = await requestJson(server, 'GET', `/api/jobs/${pending.id}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.result.reason, 'legacy_execution_retired');
    assert.equal(isolated.store.listTasks('running').length, 0);
    const archived = isolated.store.readExecutionBytes(pending.id, 0, 262144);
    assert.match(Buffer.from(archived.base64, 'base64').toString('utf8'), /legacy_job_terminal/);

    // A pre-upgrade classic loop is terminalized without executing either engine.
    const oldLoop = isolated.store.enqueueTask({ type: 'loop', project: 'demo', projectPath: project, engine: 'codex', maxCycles: 1 });
    isolated.daemon.fillSlots();
    const closedLoop = isolated.store.readTask(oldLoop.id, 'done');
    assert.equal(closedLoop.status, 'failed');
    assert.equal(closedLoop.reason, 'legacy_execution_retired');
    assert.equal((await requestJson(server, 'GET', `/api/jobs/${oldLoop.id}`)).body.result.reason, 'legacy_execution_retired');
    assert.equal(isolated.store.listTasks('running').length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    isolated.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a disappearing pre-upgrade queue record cannot starve other retired jobs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlander-disappearing-'));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const isolated = isolatedDaemon({ allowedProjects: { demo: project }, maxConcurrent: 2 }, directory);
  const realRead = isolated.store.readTask;
  try {
    const missing = isolated.store.enqueueTask({ project: 'demo', priority: 1, prompt: 'disappeared' });
    const intact = isolated.store.enqueueTask({ project: 'demo', priority: 2, prompt: 'retire me' });
    isolated.store.readTask = (id, stage) => {
      if (id === missing.id && stage === 'pending') {
        const error = new Error('record vanished during scan'); error.code = 'ENOENT'; throw error;
      }
      return realRead(id, stage);
    };
    isolated.daemon.fillSlots();
    assert.equal(realRead(intact.id, 'done').reason, 'legacy_execution_retired');
    assert.equal(isolated.store.listTasks('running').length, 0);
  } finally {
    isolated.store.readTask = realRead;
    isolated.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('restart archives an interrupted historical direct task without replay or lost evidence', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlander-restart-'));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const isolated = isolatedDaemon({
    dashboardPort: 0, allowedProjects: { demo: project }, maxConcurrent: 1,
    enginePaths: { codex: '/nonexistent/highlander-legacy-worker' },
  }, directory);
  let started = false;
  try {
    const legacy = isolated.store.enqueueTask({ project: 'demo', engine: 'codex', cwd: project, status: 'running', prompt: 'Never rerun this task', startedAt: new Date().toISOString() });
    isolated.store.moveTask(legacy.id, 'pending', 'running');
    const previouslyCaptured = Buffer.from('raw worker output before interruption\n');
    isolated.store.appendExecution(legacy.id, { event: 'output', role: 'worker', stream: 'stdout', base64: previouslyCaptured.toString('base64') });
    const before = fs.readFileSync(isolated.store.executionPath(legacy.id));
    isolated.daemon.start({ r1: { autopilotDependencies: { discoverReadyIssues: async () => [] } } });
    started = true;
    const done = isolated.store.readTask(legacy.id, 'done');
    assert.equal(done.status, 'failed');
    assert.equal(done.reason, 'daemon_restarted');
    const result = JSON.parse(fs.readFileSync(path.join(isolated.store.paths.results, legacy.id + '.json'), 'utf8'));
    assert.equal(result.reason, 'daemon_restarted');
    assert.equal(isolated.store.listTasks('running').length, 0);
    assert.equal(isolated.store.listTasks('pending').length, 0);
    const after = fs.readFileSync(isolated.store.executionPath(legacy.id));
    assert.deepEqual(after.subarray(0, before.length), before, 'all earlier owner-visible captured bytes survive recovery');
    const event = after.toString('utf8').trim().split('\n').map(JSON.parse).find(entry => entry.event === 'output' && entry.role === 'worker');
    assert.deepEqual(Buffer.from(event.base64, 'base64'), previouslyCaptured);
  } finally {
    if (started) { await isolated.daemon.stop(() => {}); isolated.daemon.resetStopping(); }
    isolated.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('restart retires an interrupted classic loop without relaunching either engine', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlander-classic-restart-'));
  const project = path.join(directory, 'project'); fs.mkdirSync(project);
  const config = { dashboardPort: 0, allowedProjects: { demo: project },
    enginePaths: { codex: '/nonexistent/retired-codex', claude: '/nonexistent/retired-claude' } };
  let id; let raw;
  const first = isolatedDaemon(config, directory);
  let started = false;
  try {
    const loop = first.store.enqueueTask({ type: 'loop', project: 'demo', projectPath: project, status: 'running',
      workerEngine: 'codex', criticEngine: 'claude', maxCycles: 3,
      cycles: [{ n: 1, status: 'running', phase: 'worker' }] });
    id = loop.id; first.store.moveTask(id, 'pending', 'running');
    first.store.appendExecution(id, { event: 'output', role: 'worker', stream: 'stdout',
      base64: Buffer.from('captured classic worker output\n').toString('base64') });
    raw = fs.readFileSync(first.store.executionPath(id));
    first.daemon.start({ r1: { autopilotDependencies: { discoverReadyIssues: async () => [] } } });
    started = true;
    const done = first.store.readTask(id, 'done');
    assert.equal(done.status, 'failed');
    assert.equal(done.reason, 'daemon_restarted');
    assert.equal(done.cycles[0].status, 'running', 'historical cycle evidence is preserved verbatim');
    assert.deepEqual(fs.readFileSync(first.store.executionPath(id)).subarray(0, raw.length), raw);
    assert.deepEqual(first.store.listTasks('running'), []);
  } finally {
    if (started) { await first.daemon.stop(() => {}); first.daemon.resetStopping(); }
    first.restore();
  }
  const second = isolatedDaemon(config, directory);
  started = false;
  try {
    const before = fs.readFileSync(second.store.executionPath(id));
    second.daemon.start({ r1: { autopilotDependencies: { discoverReadyIssues: async () => [] } } });
    started = true;
    assert.equal(second.store.readTask(id, 'done').reason, 'daemon_restarted');
    assert.deepEqual(fs.readFileSync(second.store.executionPath(id)), before,
      'a second restart cannot append another historical terminal transition');
    assert.deepEqual(second.store.listTasks('running'), []);
    assert.deepEqual(second.store.listTasks('pending'), []);
  } finally {
    if (started) { await second.daemon.stop(() => {}); second.daemon.resetStopping(); }
    second.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy archival failure cannot prevent other queued jobs from being retired', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlander-archive-fail-'));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const isolated = isolatedDaemon({ allowedProjects: { demo: project }, maxConcurrent: 2 }, directory);
  const originalWrite = isolated.store.writeResult;
  try {
    const first = isolated.store.enqueueTask({ project: 'demo', priority: 1, prompt: 'legacy first' });
    const second = isolated.store.enqueueTask({ type: 'loop', project: 'demo', priority: 2, projectPath: project });
    isolated.store.writeResult = result => {
      if (result.id === first.id) throw new Error('simulated archived-result storage failure');
      return originalWrite(result);
    };
    const terminalEvents = id => fs.readFileSync(isolated.store.executionPath(id), 'utf8')
      .trim().split('\n').map(JSON.parse).filter(event => event.event === 'legacy_job_terminal');
    isolated.daemon.fillSlots();
    assert.equal(isolated.store.readTask(first.id, 'pending').id, first.id);
    assert.equal(terminalEvents(first.id).length, 0, 'failed archival attempt is not a terminal transition');
    assert.equal(isolated.store.readTask(second.id, 'done').reason, 'legacy_execution_retired');
    isolated.store.writeResult = originalWrite;
    isolated.daemon.fillSlots();
    assert.equal(isolated.store.readTask(first.id, 'done').reason, 'legacy_execution_retired');
    assert.equal(terminalEvents(first.id).length, 1, 'retried archival produces one successful terminal transition');
    isolated.daemon.fillSlots();
    assert.equal(terminalEvents(first.id).length, 1, 'subsequent ticks cannot duplicate a terminal transition');
  } finally {
    isolated.store.writeResult = originalWrite;
    isolated.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('partial legacy archival resumes once after a fresh daemon without replay or lost logs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlander-partial-restart-'));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const config = { allowedProjects: { demo: project }, maxConcurrent: 1,
    enginePaths: { codex: '/nonexistent/highlander-worker-must-never-start' } };
  let id;
  let captured;
  const first = isolatedDaemon(config, directory);
  try {
    const item = first.store.enqueueTask({ project: 'demo', engine: 'codex', prompt: 'Retired work cannot run.' });
    id = item.id;
    first.store.appendExecution(id, { event: 'output', role: 'worker', stream: 'stdout', base64: Buffer.from('earlier captured log\n').toString('base64') });
    captured = fs.readFileSync(first.store.executionPath(id));
    const realMove = first.store.moveTask;
    first.store.moveTask = () => { throw new Error('simulated crash before archive rename'); };
    try { first.daemon.fillSlots(); } finally { first.store.moveTask = realMove; }
    assert.equal(first.store.readTask(id, 'pending').status, 'failed', 'intermediate task record is durable');
    assert.equal(JSON.parse(fs.readFileSync(path.join(first.store.paths.results, id + '.json'))).status, 'failed');
    assert.equal(fs.readFileSync(first.store.executionPath(id), 'utf8').includes('legacy_job_terminal'), false);
  } finally { first.restore(); }
  const restarted = isolatedDaemon(config, directory);
  try {
    restarted.daemon.fillSlots();
    restarted.daemon.fillSlots();
    const events = fs.readFileSync(restarted.store.executionPath(id), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.filter(event => event.event === 'legacy_job_terminal').map(event => event.reason), ['legacy_execution_retired']);
    assert.deepEqual(fs.readFileSync(restarted.store.executionPath(id)).subarray(0, captured.length), captured);
    assert.equal(restarted.store.readTask(id, 'done').reason, 'legacy_execution_retired');
    assert.deepEqual(restarted.store.listTasks('running'), []);
    assert.deepEqual(restarted.store.listTasks('pending'), []);
    assert.equal(restarted.store.readTask(id, 'done').prompt, 'Retired work cannot run.');
  } finally {
    restarted.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed terminal journal append cannot undo an already durable retired archive', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlander-journal-failure-'));
  const project = path.join(directory, 'project'); fs.mkdirSync(project);
  const isolated = isolatedDaemon({ allowedProjects: { demo: project } }, directory);
  const oldAppend = isolated.store.appendExecution;
  const oldError = console.error;
  const diagnostics = [];
  try {
    const legacy = isolated.store.enqueueTask({ project: 'demo', prompt: 'Do not run this old task' });
    isolated.store.appendExecution = (id, record) => {
      if (record.event === 'legacy_job_terminal') throw new Error('simulated ENOSPC while recording audit');
      return oldAppend(id, record);
    };
    console.error = line => { diagnostics.push(String(line)); };
    isolated.daemon.fillSlots();
    assert.equal(isolated.store.readTask(legacy.id, 'done').reason, 'legacy_execution_retired');
    assert.equal(isolated.store.listTasks('pending').length, 0);
    assert.equal(isolated.store.listTasks('running').length, 0);
    assert.ok(isolated.store.readLogLines(legacy.id).some(line => line.includes('Legacy execution admission retired')), 'owner still has a readable archived summary');
    assert.ok(diagnostics.some(line => /Execution log persistence failed/.test(line)), 'the existing recorder reports failed audit persistence');
    assert.ok(!diagnostics.some(line => /could not be archived/.test(line)), 'do not claim the already-completed state move failed');
    isolated.daemon.fillSlots();
    assert.equal(isolated.store.readTask(legacy.id, 'done').status, 'failed');
  } finally {
    console.error = oldError;
    isolated.store.appendExecution = oldAppend;
    isolated.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('historical HTTP jobs remain inspectable after removing new direct submission', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-http-'));
  const project = path.join(directory, 'registered-project');
  fs.mkdirSync(project);
  const isolated = isolatedDaemon({
    allowedProjects: { demo: project },
    defaultEngine: 'codex',
  }, directory);
  const server = isolated.daemon.createHttpServer();

  try {
    if (!await listenHttp(t, server)) return;
    const projects = await requestJson(server, 'GET', '/api/projects');
    assert.deepEqual(projects, { status: 200, body: { projects: ['demo'] } });
    // Simulate an already-captured legacy task. No new HTTP ingress may create one.
    const legacy = isolated.store.enqueueTask({ project: 'demo', cwd: fs.realpathSync(project), prompt: 'Previously admitted task.' });
    const submitted = { body: { id: legacy.id } };
    assert.match(legacy.id, /^t-/);

    const pending = isolated.store.readTask(submitted.body.id, 'pending');
    assert.equal(pending.project, 'demo');
    assert.equal(pending.cwd, fs.realpathSync(project));

    assert.equal((await requestJson(server, 'POST', '/api/loop', { project: 'demo' })).status, 404);

    const queued = await requestJson(server, 'GET', `/api/jobs/${submitted.body.id}`);
    assert.deepEqual(queued.body, { id: submitted.body.id, status: 'pending', project: 'demo' });

    isolated.store.writeTask({ ...pending, status: 'done' }, 'pending');
    isolated.store.moveTask(submitted.body.id, 'pending', 'done');
    isolated.store.writeResult({ id: submitted.body.id, status: 'done', summary: 'Completed.' });
    const completed = await requestJson(server, 'GET', `/api/jobs/${submitted.body.id}`);
    assert.deepEqual(completed.body, {
      id: submitted.body.id,
      status: 'done',
      project: 'demo',
      result: { id: submitted.body.id, status: 'done', summary: 'Completed.' },
    });

    // Read the same historical result through the actual MCP facade and real HTTP handler.
    const facade = require('../src/tools');
    const daemonRequest = async route => {
      const result = await requestJson(server, 'GET', route);
      return { statusCode: result.status, value: result.body };
    };
    const compactStatus = await facade.callTool({ name: 'get_job_status', arguments: { id: legacy.id } }, { daemonRequest });
    const compactResult = await facade.callTool({ name: 'get_job_result', arguments: { id: legacy.id } }, { daemonRequest });
    assert.equal(compactStatus.structuredContent.status, 'done');
    assert.equal(compactResult.structuredContent.result.status, 'done');

    // Both historic loop and R1 job IDs remain visible through the same read-only route.
    const pastLoop = isolated.store.enqueueTask({ type: 'loop', project: 'demo', projectPath: fs.realpathSync(project) });
    const pastR1 = isolated.store.enqueueTask({ project: 'demo', workflow: 'r1', issue: 8 });
    for (const past of [pastLoop, pastR1]) {
      isolated.store.writeResult({ id: past.id, status: 'failed', reason: 'archived_test', summary: 'Retained.' });
      isolated.store.writeTask({ ...past, status: 'failed' }, 'pending');
      isolated.store.moveTask(past.id, 'pending', 'done');
      const found = await requestJson(server, 'GET', `/api/jobs/${past.id}`);
      assert.equal(found.status, 200);
      assert.equal(found.body.status, 'failed');
      assert.equal((await facade.callTool({ name: 'get_job_result', arguments: { id: past.id } }, { daemonRequest })).structuredContent.result.status, 'failed');
    }

    // The owner gets every captured byte from historic records, not only compact summaries.
    const captured = Buffer.from('owner output /home/owner/raw-file\n' + 'z'.repeat(2000));
    isolated.store.appendExecution(legacy.id, { event: 'output', role: 'worker', stream: 'stdout', base64: captured.toString('base64') });
    const source = fs.readFileSync(isolated.store.executionPath(legacy.id));
    const download = await requestBytes(server, `/api/log/${legacy.id}?download=1`);
    assert.equal(download.status, 200);
    assert.deepEqual(download.bytes, source);
    const page = await requestJson(server, 'GET', `/api/log/${legacy.id}?raw=1&bytes=262144`);
    assert.equal(page.status, 200);
    assert.deepEqual(Buffer.from(page.body.base64, 'base64'), source);
    const records = source.toString('utf8').trim().split('\n').map(JSON.parse);
    const output = records.find(record => record.event === 'output' && record.role === 'worker' && record.stream === 'stdout');
    assert.ok(output, 'the archived journal retains the captured stdout event');
    assert.deepEqual(Buffer.from(output.base64, 'base64'), captured);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    isolated.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('obsolete HTTP admission stays closed, and canonical R1 rejects unknown projects', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-http-'));
  const project = path.join(directory, 'registered-project');
  fs.mkdirSync(project);
  const isolated = isolatedDaemon({ allowedProjects: { demo: project } }, directory);
  const server = isolated.daemon.createHttpServer();

  try {
    if (!await listenHttp(t, server)) return;
    const projects = await requestJson(server, 'GET', '/api/projects');
    assert.deepEqual(projects.body, { projects: ['demo'] });
    assert.equal(JSON.stringify(projects.body).includes(project), false);
    for (const [endpoint, body] of [
      ['/api/jobs', { project: 'missing', prompt: 'nope' }],
      ['/api/jobs', { project: 'demo', prompt: 'nope', cwd: os.tmpdir() }],
      ['/api/jobs', { project: 'demo', prompt: 'nope', operation: 'shell' }],
      ['/api/dispatch', { project: 'missing', prompt: 'nope' }],
      ['/api/loop', { project: 'missing' }],
    ]) {
      const response = await requestJson(server, 'POST', endpoint, body);
      assert.equal(response.status, 404);
    }
    const denied = await requestJson(server, 'POST', '/api/development/jobs', { project: 'missing', issue: 5 });
    assert.equal(denied.status, 400);
    assert.equal(isolated.store.listTasks('pending').length, 0);
    assert.equal((await requestJson(server, 'POST', '/api/projects', { project: 'new' })).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    isolated.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-test-'));
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });

  if (git('init', '-q').status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }

  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');

  return { dir, git };
}

test('HTTP access rejects rebinding Hosts and cross-site Origins and keeps legacy filenames', async t => {
  const server = daemon.createHttpServer();
  if (!await listenHttp(t, server)) return;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const request = (headers, requestPath='/') => new Promise((resolve,reject) => {
    const req = http.get({host:'127.0.0.1',port,path:requestPath,headers},res=>{
      let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
    });req.on('error',reject);
  });
  assert.equal((await request({host:`attacker.example:${port}`})).status,403);
  assert.equal((await request({origin:'http://attacker.example'})).status,403);
  assert.equal((await request({origin:'null'})).status,403);
  assert.equal((await request({host:`localhost:${port}`,origin:`http://localhost:${port}`})).status,200);
  const id='t-filename';
  store.appendLogLine(id,'owner legacy output');
  t.after(()=>fs.rmSync(store.executionPath(id,true),{force:true}));
  const result=await request({},`/api/log/${id}?download=1&legacy=1`);
  assert.equal(result.status,200);
  assert.equal(result.headers['content-disposition'],`attachment; filename="${id}.ndjson"`);
});

test('dashboard HTTP handler isolates one bad canonical record and exposes its raw journal link', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-canonical-diagnostic-'));
  const isolated = isolatedDaemon({}, directory);
  t.after(() => { isolated.restore(); fs.rmSync(directory, { recursive: true, force: true }); });
  const s = isolated.store, d = isolated.daemon;
  d.testing.initializeRuntime();
  const bad = s.enqueueTask({ workflow: 'r1', project: 'demo', issue: 1, autopilotStateDir: path.join(directory, 'jobs'), title: 'Bad checkpoint', status: 'running' });
  s.moveTask(bad.id, 'pending', 'running');
  const good = s.enqueueTask({ title: 'Healthy queued job' });
  s.appendExecution(bad.id, { event: 'owner_raw', text: 'RAW TAIL '.repeat(10000) });
  const server = d.createHttpServer();
  // Drive the real HTTP request listener without binding a socket. This also
  // runs in restricted environments; socket/process integration stays separate.
  const response = await new Promise(resolve => {
    const req = { method: 'GET', url: '/api/state', headers: { host: 'localhost:5769' }, socket: { localPort: 5769 } };
    const res = { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } };
    server.emit('request', req, res);
  });
  assert.equal(response.status, 200);
  const diagnostic = response.body.tasks.running.find(task => task.id === bad.id);
  assert.equal(diagnostic.status, 'blocked');
  assert.match(diagnostic.diagnostic, /checkpoint/);
  assert.equal(diagnostic.executionJournal.raw, `/api/log/${bad.id}?raw=1`);
  assert.ok(response.body.tasks.pending.some(task => task.id === good.id));
  const chunks = []; let offset = 0, hasMore;
  do {
    const page = await new Promise(resolve => server.emit('request', {
      method: 'GET', url: `/api/log/${bad.id}?raw=1&offset=${offset}&bytes=32768`,
      headers: { host: 'localhost:5769' }, socket: { localPort: 5769 },
    }, { writeHead(status) { assert.equal(status, 200); }, end(body) { resolve(JSON.parse(body)); } }));
    chunks.push(Buffer.from(page.base64, 'base64'));
    assert.ok(page.nextOffset > offset, 'raw paging makes progress');
    offset = page.nextOffset; hasMore = page.hasMore;
    assert.ok(chunks.length <= 10, 'raw journal paging is bounded');
  } while (hasMore);
  assert.deepEqual(Buffer.concat(chunks), fs.readFileSync(s.executionPath(bad.id)), 'all raw bytes remain available despite a broken checkpoint');
});

for (const queueStage of ['pending', 'running']) test(`HTTP cancellation of a ${queueStage} supervision hold persists canonical cancellation without an executor`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-cancel-hold-'));
  const isolated = isolatedDaemon({}, directory);
  t.after(() => { isolated.restore(); fs.rmSync(directory, { recursive: true, force: true }); });
  const s = isolated.store, d = isolated.daemon;
  d.testing.initializeRuntime({ r1: { autopilotDependencies: { loadProjectConfig: () => assert.fail('held cancellation cannot admit an executor') } } });
  const parent = s.enqueueTask({ workflow: 'r1', project: 'demo', repo: 'owner/demo', issue: 1,
    autopilotStateDir: path.join(directory, 'jobs'), title: 'Held before start', status: 'running',
    supervisionBlocked: { reason: 'Owner configuration revoked' } });
  if (queueStage === 'running') s.moveTask(parent.id, 'pending', 'running');
  const server = d.createHttpServer();
  const invoke = (method, url, body) => new Promise(resolve => {
    const req = new (require('node:stream').PassThrough)();
    Object.assign(req, { method, url, headers: { host: 'localhost:5769' }, socket: { localPort: 5769 } });
    const res = { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } };
    server.emit('request', req, res); req.end(body ? JSON.stringify(body) : '');
  });
  assert.equal((await invoke('POST', '/api/cancel', { id: parent.id })).status, 200);
  d.fillSlots();
  const result = await invoke('GET', `/api/development/jobs/${parent.id}`);
  assert.equal(result.body.status, 'cancelled');
  assert.equal(result.body.evidence.cancelRequested, true);
  assert.equal(require('../src/autopilot-state').createJobStore(parent.autopilotStateDir).load(1).runs, 0);
});

test('HTTP R1 corrected specification retains old status result and raw identity while queuing one fresh job', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'http-spec-rearm-'));
  const checkout = path.join(directory, 'repo'); fs.mkdirSync(checkout);
  const worktreeRoot = path.join(directory, 'worktrees');
  const isolated = isolatedDaemon({ allowedProjects: { demo: { root: checkout, worktreeRoot } } }, directory);
  t.after(() => { isolated.restore(); fs.rmSync(directory, { recursive: true, force: true }); });
  const s = isolated.store, d = isolated.daemon;
  const issue = { number: 1, title: 'Correct the specification', body: 'fix it' };
  const project = { enabled: true, autoMerge: true, worker: 'codex', reviewPolicy: 'always', repo: 'owner/demo', checkout, worktreeRoot,
    baseBranch: 'main', readyLabel: 'ready', humanLabel: 'human', stateDir: path.join(directory, 'jobs') };
  d.testing.initializeRuntime({ r1: { ciPollMs: 0, autopilotDependencies: {
    loadProjectConfig: () => project, discoverReadyIssues: async () => [issue],
    createRalphTaskService: () => assert.fail('no worker for insufficient specification'),
    execFile: (_file, args, _options, callback) => callback(null, args.includes('comments') ? '{"comments":[]}' : '', ''),
  } } });
  const server = d.createHttpServer();
  const invoke = (method, url, body) => new Promise(resolve => {
    const req = new (require('node:stream').PassThrough)();
    Object.assign(req, { method, url, headers: { host: 'localhost:5769' }, socket: { localPort: 5769 } });
    server.emit('request', req, { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } });
    req.end(body ? JSON.stringify(body) : '');
  });
  assert.equal((await invoke('POST', '/api/r1/jobs', { project: 'demo', issue: 1 })).status, 404, 'retired public R1 admission must stay closed');
  assert.equal((await invoke('GET', '/api/r1/jobs/t-retired')).status, 404, 'retired R1 read route must stay closed');
  const submitted = await invoke('POST', '/api/development/jobs', { project: 'demo', issue: 1 });
  assert.equal(submitted.status, 201);
  const oldId = submitted.body.id;
  d.fillSlots();
  const deadline = Date.now() + 2000;
  while (!s.listTasks('done').some(task => task.id === oldId) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(s.listTasks('done').some(task => task.id === oldId), 'specification outcome finishes within two seconds');
  const before = await invoke('GET', `/api/development/jobs/${oldId}`);
  const raw = await invoke('GET', `/api/log/${oldId}?raw=1&bytes=262144`);
  assert.equal(before.body.status, 'needs_specification');
  issue.body = '## Acceptance\n- Implement a deterministic sum helper with unit tests for two integers. Keep the result explicit.';
  const [fresh, duplicate] = await Promise.all([invoke('POST', '/api/development/jobs', { project: 'demo', issue: 1 }), invoke('POST', '/api/development/jobs', { project: 'demo', issue: 1 })]);
  assert.equal(fresh.status, 201); assert.equal(duplicate.body.id, fresh.body.id);
  assert.notEqual(fresh.body.id, oldId);
  assert.equal((await invoke('GET', `/api/development/jobs/${fresh.body.id}`)).body.status, 'queued');
  d.testing.initializeRuntime(); // reconstruct service readers without launching a daemon
  assert.deepEqual(await invoke('GET', `/api/development/jobs/${oldId}`), before);
  assert.deepEqual(await invoke('GET', `/api/log/${oldId}?raw=1&bytes=262144`), raw);
  const result = await invoke('GET', `/api/jobs/${oldId}`);
  assert.equal(result.body.result.status, 'needs_specification');
});

test('historical GET-by-ID preserves classic results and raw cycle records without admissions', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-id-inspection-'));
  const isolated = isolatedDaemon({}, directory);
  t.after(() => { isolated.restore(); fs.rmSync(directory, { recursive: true, force: true }); });
  const s = isolated.store, d = isolated.daemon;
  d.testing.initializeRuntime();
  const server = d.createHttpServer();
  const invoke = (method, url) => new Promise(resolve => server.emit('request', {
    method, url, headers: { host: 'localhost:5769' }, socket: { localPort: 5769 },
  }, { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } }));
  for (const kind of ['task', 'loop', 'r1']) {
    const task = s.enqueueTask({ type: kind === 'loop' ? 'loop' : 'task',
      ...(kind === 'r1' ? { workflow: 'r1', project: 'demo', issue: 5 } : {}), status: 'failed' });
    s.moveTask(task.id, 'pending', 'done');
    const result = { id: task.id, status: 'failed', summary: 'complete historical result\n' + 'x'.repeat(10000) };
    s.writeResult(result);
    const found = (await invoke('GET', `/api/jobs/${task.id}`)).body.result;
    assert.equal(found.id, task.id);
    assert.equal(found.status, 'failed');
    assert.equal(found.summary, result.summary);
    const logId = kind === 'loop' ? `${task.id}-cycle-1-critic` : task.id;
    s.appendExecution(logId, { event: 'output', role: 'critic', base64: Buffer.from('full raw\n').toString('base64') });
    const route = kind === 'loop' ? `${task.id}/cycle/1/critic` : task.id;
    const page = await invoke('GET', `/api/log/${route}?raw=1&bytes=262144`);
    assert.deepEqual(Buffer.from(page.body.base64, 'base64'), fs.readFileSync(s.executionPath(logId)));
  }
  assert.equal(s.enqueueLoop, undefined);
  assert.equal(s.enqueueR1ChildLoopOnce, undefined);
  for (const route of ['/api/loop', '/api/jobs', '/api/dispatch']) assert.equal((await invoke('POST', route)).status, 404);
});

test('historical child index stays read-only through GET-by-ID; orphan pending child fails closed on restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-historical-child-'));
  const isolated = isolatedDaemon({ dashboardPort: 0, enginePaths: { codex: '/nonexistent/retired-worker' } }, directory);
  const s = isolated.store, d = isolated.daemon;
  t.after(async () => { await d.stop(() => {}); d.resetStopping(); isolated.restore(); fs.rmSync(directory, { recursive: true, force: true }); });
  const parentId = 't-12345678', attempt = 1;
  const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  const id = `t-${hash(`${parentId}:${attempt}`).slice(0, 24)}`;
  const child = { id, project: 'demo', projectPath: '/tmp/historical', source: 'r1', type: 'loop',
    engine: 'codex', workerEngine: 'codex', criticEngine: 'claude', autoCommit: false, maxCycles: 3, taskRetries: 3,
    r1Child: { parentJobId: parentId, attempt, issue: 5 }, status: 'pending' };
  s.writeTask(child, 'pending');
  const stable = { project: child.project, projectPath: child.projectPath, source: child.source,
    engine: child.engine, workerEngine: child.workerEngine, criticEngine: child.criticEngine,
    autoCommit: child.autoCommit, maxCycles: child.maxCycles, taskRetries: child.taskRetries, r1Child: child.r1Child };
  const indexDir = path.join(s.paths.state, 'r1-child-index', parentId); fs.mkdirSync(indexDir, { recursive: true });
  const index = path.join(indexDir, 'attempt-1.json');
  fs.writeFileSync(index, JSON.stringify({ schemaVersion: 1, parentJobId: parentId, attempt, id, fingerprint: hash(JSON.stringify(stable)) }));
  const indexBytes = fs.readFileSync(index), pendingBytes = fs.readFileSync(path.join(s.paths.pending, `${id}.json`));
  d.testing.initializeRuntime(); const server = d.createHttpServer();
  const get = () => new Promise(resolve => server.emit('request', { method: 'GET', url: `/api/jobs/${id}`,
    headers: { host: 'localhost:5769' }, socket: { localPort: 5769 } }, {
    writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); },
  }));
  assert.equal(s.listR1ChildLoops(parentId)[0].id, id);
  assert.equal((await get()).status, 200); assert.equal((await get()).status, 200);
  assert.deepEqual(fs.readFileSync(index), indexBytes);
  assert.deepEqual(fs.readFileSync(path.join(s.paths.pending, `${id}.json`)), pendingBytes);
  d.start({ r1: { autopilotDependencies: { discoverReadyIssues: async () => [] } } });
  const done = s.readTask(id, 'done');
  assert.equal(done.reason, 'r1_child_unauthorized'); assert.equal(done.status, 'failed');
  assert.equal(s.listR1ChildLoops(parentId)[0].stage, 'done');
  const found = await get(); assert.equal(found.status, 200); assert.equal(found.body.result.reason, 'r1_child_unauthorized');
  assert.deepEqual(fs.readFileSync(index), indexBytes);
  assert.equal(s.listTasks('pending').length, 0); assert.equal(s.listTasks('running').length, 0);
});

test('historical child with unknown process ownership remains held and inspectable after restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-ambiguous-child-'));
  const isolated = isolatedDaemon({ dashboardPort: 0, enginePaths: { codex: '/nonexistent/retired-worker' } }, directory);
  const s = isolated.store, d = isolated.daemon;
  t.after(async () => { await d.stop(() => {}); d.resetStopping(); isolated.restore(); fs.rmSync(directory, { recursive: true, force: true }); });
  const child = { id: 't-0123456789abcdef01234567', type: 'loop', source: 'r1', status: 'running',
    r1Child: { parentJobId: 't-12345678', attempt: 1, issue: 5 } };
  s.writeTask(child, 'running');
  s.appendExecution(child.id, { event: 'output', role: 'worker', base64: Buffer.from('captured before restart\n').toString('base64') });
  const before = fs.readFileSync(s.executionPath(child.id));
  d.start({ r1: { autopilotDependencies: { discoverReadyIssues: async () => [] } } });
  const held = s.readTask(child.id, 'running');
  assert.equal(held.recoveryBlocked, true); assert.equal(held.status, 'running');
  assert.deepEqual(s.listTasks('pending'), []); assert.deepEqual(s.listTasks('done'), []);
  assert.deepEqual(fs.readFileSync(s.executionPath(child.id)).subarray(0, before.length), before);
  const server = d.createHttpServer();
  const response = await new Promise(resolve => server.emit('request', {
    method: 'GET', url: `/api/jobs/${child.id}`, headers: { host: 'localhost:5769' }, socket: { localPort: 5769 },
  }, { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } }));
  assert.equal(response.status, 200); assert.equal(response.body.status, 'running'); assert.equal(response.body.id, child.id);
  assert.equal(response.body.result, undefined, 'unknown process exit cannot invent a terminal result');
});
