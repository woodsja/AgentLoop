const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(30); }
  throw new Error('Timed out waiting for persisted job phase');
}
function request(port, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' } }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(data) }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
test('R1 submission is independent, serialized, checkpointed, fail closed and retrievable after restart', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-async-'));
  const checkout = path.join(root, 'repo'); fs.mkdirSync(checkout);
  const git = (...args) => execFileSync('git', args, { cwd: checkout, stdio: 'pipe' });
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(checkout, 'initial'), 'fixture'); git('add', '.'); git('commit', '-m', 'Initial');
  const config = path.join(root, 'config.json'), fixture = path.join(root, 'fixture.json');
  const worktreeRoot = path.join(root, 'worktrees');
  const project = { enabled: true, repo: 'example/repo', checkout, worktreeRoot, baseBranch: 'main', worker: 'codex', reviewPolicy: 'always', maxAttempts: 1,
    stateDir: path.join(root, 'r1-state'), verification: `node -e "if(require('fs').readFileSync('answer','utf8')!=='42')process.exit(1);console.log('deterministic test passed')"` };
  fs.writeFileSync(fixture, JSON.stringify({ root, project }));
  fs.writeFileSync(config, JSON.stringify({ dashboardPort: 0, allowedProjects: { demo: { root: checkout, worktrees: Object.fromEntries([1, 2, 3, 4].map(n => [`issue${n}`, path.join(worktreeRoot, `issue-${n}`)])) } } }));
  let child, output = '';
  const launch = async () => {
    child = spawn(process.execPath, [path.join(__dirname, 'fixtures/r1-daemon.js')], { env: { ...process.env, AGENTLOOP_CONFIG_PATH: config, AGENTLOOP_STATE_DIR: path.join(root, 'queue'), R1_FIXTURE: fixture }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    return until(() => {
      try { const info = JSON.parse(fs.readFileSync(path.join(root, 'queue/daemon.json'))); return info.pid === child.pid && info.port > 0 && info.port; } catch { return false; }
    });
  };
  const halt = async () => {
    const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await ended;
  };
  try {
    let port = await launch();
    const bad = await request(port, '/api/r1/jobs', { project: 'demo', issue: 99 }); assert.equal(bad.status, 400);
    const submitted = await request(port, '/api/r1/jobs', { project: 'demo', issue: 1 }); assert.equal(submitted.status, 201);
    const id = submitted.value.id;
    assert.equal(fs.existsSync(path.join(root, 'worker-release')), false, 'HTTP response precedes release of implementation');
    const get = async jobId => (await request(port, `/api/r1/jobs/${jobId}`)).value;
    await until(async () => (await get(id)).phase === 'implementation');
    const second = (await request(port, '/api/r1/jobs', { project: 'demo', issue: 2 })).value.id;
    await delay(1700);
    assert.equal((await get(second)).phase, 'queued');
    assert.equal(fs.readFileSync(path.join(root, 'workers'), 'utf8').trim().split('\n').length, 1);
    fs.writeFileSync(path.join(root, 'worker-release'), '');
    const reviewing = await until(async () => { const job = await get(id); return job.phase === 'review' && job; });
    assert.equal(reviewing.evidence.verification.exitCode, 0);
    assert.match(reviewing.evidence.verification.stdout, /deterministic test passed/);
    assert.equal(reviewing.evidence.reviewHistory[0].status, 'running');
    const context = JSON.parse(fs.readFileSync(path.join(root, 'reviews'), 'utf8').trim());
    assert.equal(context.verification.command, project.verification);
    assert.equal(context.verification.commit, context.headCommit);
    assert.equal((await get(second)).phase, 'queued');
    fs.writeFileSync(path.join(root, 'review-release'), '');
    const completed = await until(async () => { const job = await get(id); return job.status === 'passed' && job; });
    assert.equal(completed.evidence.review.commit, completed.evidence.commit);
    assert.match(completed.evidence.commit, /^[a-f0-9]{40}$/);
    assert.equal(completed.evidence.reviewHistory[0].status, 'completed');
    for (const phase of ['queued', 'preparing', 'implementation', 'verification', 'delivering', 'ci', 'review', 'completed']) assert.ok(completed.phases.some(p => p.phase === phase), phase);
    // The generic job contract is unchanged: it reports R1 IDs compactly and
    // never accepts an R1-shaped submission.
    const generic = await request(port, `/api/jobs/${id}`);
    assert.equal(generic.status, 200);
    assert.deepEqual([generic.value.id, generic.value.status, generic.value.project, generic.value.phases], [id, 'passed', 'demo', undefined]);
    const r1Shaped = await request(port, '/api/jobs', { project: 'demo', issue: 1 });
    assert.deepEqual([r1Shaped.status, r1Shaped.value.error], [400, 'prompt is required.']);
    await until(async () => (await get(second)).status === 'passed');
    fs.writeFileSync(path.join(root, 'review-error'), '');
    const third = (await request(port, '/api/r1/jobs', { project: 'demo', issue: 3 })).value.id;
    const failed = await until(async () => { const job = await get(third); return job.status === 'blocked' && job; });
    assert.equal(failed.evidence.reviewHistory[0].status, 'failed');
    assert.match(failed.evidence.reviewHistory[0].diagnostics, /could not be completed/);
    assert.ok(!JSON.stringify(failed).includes('private'));
    const blockedLog = (await request(port, `/api/log/${third}`)).value.lines;
    assert.equal(blockedLog.filter(line => /terminal outcome: blocked/.test(line)).length, 1, 'the transcript preserves the actual non-autonomous terminal status');
    await halt(); port = await launch();
    assert.deepEqual(await get(id), completed);
    const before = fs.readFileSync(path.join(root, 'reviews'), 'utf8');
    const replay = (await request(port, '/api/r1/jobs', { project: 'demo', issue: 1 })).value.id;
    await until(async () => (await get(replay)).status === 'passed');
    assert.equal(fs.readFileSync(path.join(root, 'reviews'), 'utf8'), before, 'persisted exact-SHA approval is reused');
    assert.equal((await request(port, '/api/r1/jobs/unknown')).status, 404);
    fs.unlinkSync(path.join(root, 'review-release'));
    const interrupted = (await request(port, '/api/r1/jobs', { project: 'demo', issue: 4 })).value.id;
    await until(async () => (await get(interrupted)).phase === 'review');
    const recorded = fs.readFileSync(path.join(root, 'reviews'), 'utf8');
    const died = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await died;
    port = await launch();
    const recovered = await until(async () => { const job = await get(interrupted); return job.status === 'blocked' && job; });
    assert.equal(recovered.evidence.reviewHistory[0].status, 'interrupted');
    assert.equal(fs.readFileSync(path.join(root, 'reviews'), 'utf8'), recorded);

  } catch (error) { error.message += '\n' + output; throw error; }
  finally { if (child && child.exitCode === null) await halt(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('R1 submission accepts issue worktrees planned inside an owner-managed root only', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-r1-managed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'repo'); fs.mkdirSync(checkout);
  execFileSync('git', ['init', '-q'], { cwd: checkout });
  const managed = path.join(root, 'worktrees');
  const registryPath = path.join(root, 'owner.json'); fs.writeFileSync(registryPath, '{}');
  const { configuredProjects } = require('../src/project-registry');
  const { createR1Jobs } = require('../src/r1-jobs');
  const queued = [];
  const store = {
    paths: { config: registryPath },
    config: { allowedProjects: configuredProjects({ demo: { root: checkout, worktreeRoot: managed } }, registryPath) },
    enqueueTask: task => { queued.push(task); return { id: 't-0000abcd', ...task }; },
    // Logging is best effort: even a full log volume cannot reject an
    // otherwise authorized R1 submission.
    appendLogLine: () => { throw new Error('fixture log append failure'); },
    writeTask: () => { throw new Error('fixture transcript checkpoint failure'); },
  };
  const project = { enabled: true, repo: 'example/repo', checkout, worktreeRoot: managed, baseBranch: 'main', worker: 'codex', reviewPolicy: 'always', verification: 'true' };
  let current = project;
  const jobs = createR1Jobs(store, { autopilotDependencies: { loadProjectConfig: () => current } });

  assert.equal(jobs.submit({ project: 'demo', issue: 5 }).id, 't-0000abcd', 'an accepted queue entry remains accepted if transcript metadata cannot be checkpointed');
  assert.equal(queued[0].worktree, undefined);
  assert.throws(() => jobs.submit({ project: 'demo', issue: 5, worktree: 'issue5' }), /explicitly authorized/);
  // A worker-writable project file cannot move the worktree outside the owner root.
  current = { ...project, worktreeRoot: path.join(root, 'elsewhere') };
  assert.throws(() => jobs.submit({ project: 'demo', issue: 6 }), /explicitly authorized/);
  current = { ...project, worktreeRoot: root };
  assert.throws(() => jobs.submit({ project: 'demo', issue: 7 }), /explicitly authorized/);
  assert.equal(queued.length, 1);
});
