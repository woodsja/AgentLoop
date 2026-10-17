const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');
const { projectCommand, transaction, rollback } = require('../src/project-registration');
const { configuredProjects } = require('../src/project-registry');
function json(file) { return JSON.parse(fs.readFileSync(file)); }
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value)); }
function git(root, args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim(); }
function commit(root) { git(root, ['add', '.']); git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'fixture']); }
function fixture(t, runtime = 'node') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  if (runtime === 'python') fs.cpSync(path.join(__dirname, 'fixtures/python-project'), source, { recursive: true });
  else {
    fs.mkdirSync(path.join(source, '.ralph'));
    write(path.join(source, '.ralph/project.json'), { runtime, verification: 'check', lockfile: 'package-lock.json' });
    write(path.join(source, 'package.json'), { name: 'fixture', version: '1.0.0', scripts: { check: 'node check.js' } });
    write(path.join(source, 'package-lock.json'), { name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0' } } });
    fs.writeFileSync(path.join(source, 'check.js'), 'console.log("x".repeat(25000));console.error("exact red test");process.exit(1)');
  }
  execFileSync('git', ['init', '-qb', 'main', source]); commit(source);
  const configPath = path.join(root, 'config.json'), projectsPath = path.join(root, 'projects.json');
  write(configPath, { ownerEdit: 'preserve', allowedProjects: { legacy: source } });
  const existing = { enabled: true, repo: 'owner/existing', autoMerge: true, custom: 'owner' };
  write(projectsPath, { existing });
  const records = [];
  const record = (event, details) => records.push({ event, ...details });
  const options = { configPath, projectsPath, checkoutRoot: path.join(root, 'repos'), worktreeRoot: path.join(root, 'worktrees'), source,
    logId: 'onboarding-test', approve: async () => true, record, recordExecution: record };
  return { root, source, options, records, existing, run: (action, extra = {}) => projectCommand(action, 'owner/repository', { ...options, ...extra }) };
}
for (const runtime of ['node', 'python']) test(`${runtime}: staged add, duplicate, red baseline readiness, explicit activation`, async t => {
  const f = fixture(t, runtime);
  const registered = await f.run('add');
  assert.equal(registered.enabled, false); assert.equal(registered.autoMerge, false);
  assert.equal(registered.onboarding.readiness.status, 'unchecked');
  assert.equal(f.records.some(r => r.event === 'command' && (r.args.includes('ci') || r.args.includes('sync'))), false);
  const config = json(f.options.configPath);
  assert.deepEqual(Object.keys(configuredProjects(config.allowedProjects, f.options.configPath)), ['legacy']);
  assert.deepEqual(json(f.options.projectsPath).existing, f.existing);
  assert.equal(config.ownerEdit, 'preserve');
  const snapshot = fs.readFileSync(f.options.projectsPath, 'utf8');
  await f.run('add'); assert.equal(fs.readFileSync(f.options.projectsPath, 'utf8'), snapshot);
  await assert.rejects(f.run('activate'), /project check/);
  const checked = await f.run('check');
  assert.equal(checked.onboarding.readiness.status, 'ready');
  assert.equal(checked.onboarding.readiness.baseline.passed, false);
  assert.equal(checked.enabled, false);
  const preview = f.records.find(r => r.event === 'preview');
  for (const key of ['repo', 'runtime', 'install', 'check', 'contract', 'ciWorkflow', 'worker', 'reviewModel', 'readyLabel', 'maxAttempts', 'autoMerge', 'checkout', 'worktreeRoot', 'tools']) assert.ok(Object.hasOwn(preview, key), key);
  const active = await f.run('activate');
  assert.equal(active.enabled, true); assert.equal(active.autoMerge, false);
  assert.equal(active.onboarding.activation, 'active');
  assert.ok(configuredProjects(json(f.options.configPath).allowedProjects, f.options.configPath)['owner--repository']);
  assert.deepEqual(json(f.options.projectsPath).existing, f.existing);
});
for (const mode of ['missing-lock', 'stale-lock', 'missing-runtime', 'cancelled', 'interrupted']) test(`onboarding ${mode} preserves failed evidence and supports retry`, async t => {
  const f = fixture(t);
  if (mode === 'missing-lock') { fs.unlinkSync(path.join(f.source, 'package-lock.json')); commit(f.source); await assert.rejects(f.run('add'), /package-lock.json/); return; }
  if (mode === 'stale-lock') { const pkg = json(path.join(f.source, 'package.json')); pkg.dependencies = { nonexistent: 'file:./absent' }; write(path.join(f.source, 'package.json'), pkg); commit(f.source); }
  await f.run('add');
  let priorPath;
  if (mode === 'missing-runtime') {
    priorPath = process.env.PATH;
    const tools = path.join(f.root, 'tools'); fs.mkdirSync(tools); fs.symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(tools, 'git'));
    process.env.PATH = tools;
  }
  if (mode === 'interrupted') {
    const projects = json(f.options.projectsPath);
    projects['owner--repository'].onboarding.process = { pid: 2147483647, startTime: '1' };
    write(f.options.projectsPath, projects);
  }
  try {
    if (mode === 'interrupted') assert.equal((await f.run('check')).onboarding.readiness.status, 'ready');
    else await assert.rejects(f.run('check', mode === 'cancelled' ? { isCancelled: () => true } : {}));
  } finally { if (priorPath) process.env.PATH = priorPath; }
  const p = json(f.options.projectsPath)['owner--repository'];
  assert.equal(p.enabled, false);
  if (mode !== 'interrupted') assert.equal(p.onboarding.readiness.status, 'blocked');
  if (mode === 'missing-runtime' || mode === 'cancelled') assert.equal((await f.run('check')).onboarding.readiness.status, 'ready');
  if (mode === 'stale-lock') assert.ok(f.records.some(r => r.event === 'output' && r.stream === 'stderr'));
});
test('owner cancellation, concurrent operation, external edit and duplicate conflicts preserve owner intent', async t => {
  const f = fixture(t);
  await assert.rejects(f.run('add', { approve: async () => false }), /cancelled/);
  assert.equal(json(f.options.projectsPath)['owner--repository'], undefined);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const first = f.run('add', { approve: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  await waiting;
  await assert.rejects(f.run('add'), /Concurrent onboarding/);
  release(true); await first;
  const projects = json(f.options.projectsPath); projects['owner--repository'].autoMerge = true; write(f.options.projectsPath, projects);
  assert.equal((await f.run('add')).autoMerge, true);
  const other = fixture(t);
  await assert.rejects(other.run('add', { approve: async () => { const config = json(other.options.configPath); config.newOwnerEdit = true; write(other.options.configPath, config); return true; } }), /Concurrent owner edit/);
  assert.equal(json(other.options.configPath).newOwnerEdit, true);
  assert.equal(json(other.options.projectsPath)['owner--repository'], undefined);
});
for (const index of [0, 1]) test(`two-store write failure ${index} rolls back exactly and retry succeeds`, async t => {
  const f = fixture(t), before = [f.options.configPath, f.options.projectsPath].map(file => fs.readFileSync(file, 'utf8'));
  await assert.rejects(f.run('add', { afterWrite: i => { if (i === index) throw new Error('disk failure'); } }), /disk failure/);
  assert.deepEqual([f.options.configPath, f.options.projectsPath].map(file => fs.readFileSync(file, 'utf8')), before);
  assert.equal((await f.run('add')).enabled, false);
});
test('recovery rolls back interrupted transaction and refuses to erase a divergent owner edit', async t => {
  const f = fixture(t), files = [f.options.configPath, f.options.projectsPath], journal = `${files[0]}.project-transaction`;
  const entries = files.map(file => ({ file, before: fs.readFileSync(file, 'utf8'), after: '{"interrupted":true}' }));
  write(journal, entries); fs.writeFileSync(files[0], entries[0].after);
  await f.run('recover'); assert.equal(fs.readFileSync(files[0], 'utf8'), entries[0].before);
  write(journal, entries); fs.writeFileSync(files[0], '{"ownerEdit":42}');
  assert.throws(() => rollback(journal), /Owner edit preserved/);
  assert.equal(json(files[0]).ownerEdit, 42); assert.ok(fs.existsSync(journal));
});
test('activation refuses a moved base and preserves merge policy set by the owner', async t => {
  const f = fixture(t); await f.run('add'); await f.run('check');
  const projects = json(f.options.projectsPath), p = projects['owner--repository'];
  p.autoMerge = true; p.runtime = 'python'; write(f.options.projectsPath, projects);
  await assert.rejects(f.run('activate'), /project check/);
  p.runtime = 'node'; write(f.options.projectsPath, projects);
  await f.run('activate', { approve: async () => false }).then(() => assert.fail(), error => assert.match(error.message, /cancelled/));
  fs.writeFileSync(path.join(p.checkout, 'new-file'), 'new base'); commit(p.checkout);
  await assert.rejects(f.run('activate'), /Base branch changed/);
  assert.equal(json(f.options.projectsPath)['owner--repository'].autoMerge, true);
  assert.equal(json(f.options.projectsPath)['owner--repository'].enabled, false);
});
test('CLI failures persist complete records, discoverable through the real dashboard API', async t => {
  const f = fixture(t), state = path.join(f.root, 'state');
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, '../src/cli.js'), 'project', 'add', 'invalid', '--yes', '--config', f.options.configPath, '--projects', f.options.projectsPath], { env: { ...process.env, AGENTLOOP_STATE_DIR: state } });
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; }); child.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 1); assert.match(result.stderr, /owner\/repository/);
  const log = fs.readdirSync(path.join(state, 'logs')).find(file => file.endsWith('.execution.ndjson'));
  const records = fs.readFileSync(path.join(state, 'logs', log), 'utf8');
  assert.match(records, /onboarding_start/); assert.match(records, /onboarding_failure/);
  const priorConfig = process.env.AGENTLOOP_CONFIG_PATH, priorState = process.env.AGENTLOOP_STATE_DIR;
  process.env.AGENTLOOP_CONFIG_PATH = f.options.configPath; process.env.AGENTLOOP_STATE_DIR = state;
  delete require.cache[require.resolve('../src/store')]; delete require.cache[require.resolve('../src/daemon')];
  const daemon = require('../src/daemon'), server = daemon.createHttpServer();
  t.after(() => { server.close(); if (priorConfig === undefined) delete process.env.AGENTLOOP_CONFIG_PATH; else process.env.AGENTLOOP_CONFIG_PATH = priorConfig; if (priorState === undefined) delete process.env.AGENTLOOP_STATE_DIR; else process.env.AGENTLOOP_STATE_DIR = priorState; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const get = url => new Promise((resolve, reject) => { http.get({ hostname: '127.0.0.1', port: server.address().port, path: url }, res => { let body = ''; res.on('data', b => { body += b; }); res.on('end', () => resolve({ status: res.statusCode, body })); }).on('error', reject); });
  const diagnostics = await get('/api/project-onboarding'); assert.equal(diagnostics.status, 200);
  const id = JSON.parse(diagnostics.body).runs[0].logId;
  const download = await get(`/api/log/${id}?download=1`); assert.equal(download.body, records);
  const raw = await get(`/api/log/${id}?raw=1`); assert.equal(raw.status, 200);
});
test('SIGTERM during a real check preserves complete diagnostics, stops setup and permits retry', async t => {
  const f = fixture(t), started = path.join(f.root, 'check-started');
  fs.writeFileSync(path.join(f.source, 'check.js'), `require('fs').writeFileSync(${JSON.stringify(started)}, 'started');console.log('Y'.repeat(30000));console.error('signal check stderr');setInterval(()=>{},1000);`);
  commit(f.source); await f.run('add');
  const child = spawn(process.execPath, [path.join(__dirname, '../src/cli.js'), 'project', 'check', 'owner/repository', '--config', f.options.configPath, '--projects', f.options.projectsPath], { env: { ...process.env, AGENTLOOP_STATE_DIR: path.join(f.root, 'state') }, stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const exited = new Promise(resolve => child.on('close', code => resolve(code)));
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(started)) {
    if (Date.now() > deadline) assert.fail('check failed to start');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await assert.rejects(f.run('check'), /Concurrent onboarding/);
  child.kill('SIGTERM'); assert.equal(await exited, 1);
  const p = json(f.options.projectsPath)['owner--repository'];
  assert.equal(p.onboarding.readiness.reason, 'cancelled'); assert.equal(p.onboarding.process, null); assert.equal(p.enabled, false);
  const file = fs.readdirSync(path.join(f.root, 'state/logs')).find(file => file.endsWith('.execution.ndjson'));
  const records = fs.readFileSync(path.join(f.root, 'state/logs', file), 'utf8').trim().split('\n').map(JSON.parse);
  const output = Buffer.concat(records.filter(r => r.event === 'output' && r.stream === 'stdout').map(r => Buffer.from(r.base64, 'base64'))).toString();
  assert.match(output, /Y{30000}/); assert.equal(records.at(-1).event, 'onboarding_failure');
  fs.writeFileSync(path.join(p.checkout, 'check.js'), 'process.exit(0)'); commit(p.checkout);
  assert.equal((await f.run('check')).onboarding.readiness.status, 'ready');
});
