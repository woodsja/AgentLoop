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
    ciWorkflow: 'CI / token=private-' + 'W'.repeat(300), stateDir: path.join(root, 'r1-state'), verification: `node -e "if(require('fs').readFileSync('answer','utf8')!=='42')process.exit(1);console.log('deterministic test passed'+'D'.repeat(100000)+'EXACT DIAGNOSTIC TAIL token=owner /tmp/context')"` };
  fs.writeFileSync(fixture, JSON.stringify({ root, project, ciPollMs: 1500 }));
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
    fs.writeFileSync(path.join(root, 'ci-input.json'), JSON.stringify({ runs: [] }));
    fs.writeFileSync(path.join(root, 'worker-release'), '');
    const missing = await until(async () => { const job = await get(id); return job.evidence?.ci?.category === 'required_run_missing' && job; });
    assert.equal(missing.evidence.ci.state, 'pending');
    assert.equal(missing.evidence.ci.prNumber, 1);
    assert.equal(missing.evidence.ci.headCommit, missing.evidence.commit);
    const ciRun = { databaseId: 123, workflowName: project.ciWorkflow, name: 'prompt: private thinking',
      status: 'in_progress', conclusion: null, url: 'https://github.com/example/repo/actions/runs/123' };
    fs.writeFileSync(path.join(root, 'ci-input.json'), JSON.stringify({ runs: [ciRun, { ...ciRun, databaseId: 999, workflowName: project.ciWorkflow + '-different', status: 'completed', conclusion: 'success' }] }));
    const pending = await until(async () => { const job = await get(id); return job.evidence?.ci?.category === 'required_run_pending' && job; });
    assert.equal(pending.evidence.ci.requiredRun.databaseId, 123);
    assert.equal(pending.evidence.ci.requiredRun.url, ciRun.url);
    assert.equal(pending.evidence.ci.requiredRun.status, 'in_progress');
    assert.ok(pending.evidence.ci.requiredWorkflow.length <= 160);
    assert.ok(!JSON.stringify(pending).includes('token=private'));
    assert.ok(!JSON.stringify(pending).includes('private thinking'));
    assert.ok(!JSON.stringify(pending).includes('/tmp/context'));
    assert.match(pending.evidence.ci.observedAt, /^\d{4}-/);
    const calls = fs.readFileSync(path.join(root, 'ci-calls'), 'utf8');
    for (let i = 0; i < 5; i++) assert.deepEqual(await get(id), pending);
    assert.equal(fs.readFileSync(path.join(root, 'ci-calls'), 'utf8'), calls, 'status reads never observe GitHub');
    const transcript = (await request(port, `/api/log/${id}`)).value.lines.filter(line => /R1:/.test(line));
    await halt(); port = await launch();
    const resumed = await until(async () => { const job = await get(id); return job.evidence?.ci?.requiredRun?.databaseId === 123 && job; });
    assert.equal(resumed.evidence.ci.headCommit, pending.evidence.ci.headCommit);
    await delay(1800);
    assert.deepEqual((await request(port, `/api/log/${id}`)).value.lines.filter(line => /R1:/.test(line)), transcript, 'polling/recovery does not flood transcript');
    assert.equal(fs.readFileSync(path.join(root, 'workers'), 'utf8').trim().split('\n').length, 1, 'CI restart never retries implementation');
    fs.writeFileSync(path.join(root, 'ci-input.json'), JSON.stringify({ runs: [{ ...ciRun, status: 'completed', conclusion: 'success' }] }));
    const reviewing = await until(async () => { const job = await get(id); return job.phase === 'review' && job; });
    assert.equal(reviewing.evidence.verification.exitCode, 0);
    assert.equal(reviewing.evidence.verification.stdout, undefined);
    assert.equal(reviewing.evidence.reviewHistory[0].status, 'running');
    const context = JSON.parse(fs.readFileSync(path.join(root, 'reviews'), 'utf8').trim());
    assert.equal(context.verification.command, project.verification);
    assert.equal(context.verification.commit, context.headCommit);
    const fullOutput = 'deterministic test passed'+'D'.repeat(100000)+'EXACT DIAGNOSTIC TAIL token=owner /tmp/context\n';
    assert.equal(context.verification.stdout, fullOutput);
    const checkpoint = jobId => JSON.parse(fs.readFileSync(path.join(root,'queue/tasks/running',jobId+'.json')));
    assert.equal(checkpoint(id).r1.verification.stdout,fullOutput);
    assert.equal((await get(second)).phase, 'queued');
    fs.writeFileSync(path.join(root, 'review-release'), '');
    const completed = await until(async () => { const job = await get(id); return job.status === 'passed' && job; });
    assert.equal(completed.evidence.review.commit, completed.evidence.commit);
    assert.match(completed.evidence.commit, /^[a-f0-9]{40}$/);
    assert.equal(completed.evidence.reviewHistory[0].status, 'completed');
    for (const phase of ['queued', 'preparing', 'implementation', 'verification', 'delivering', 'ci', 'review', 'completed']) assert.ok(completed.phases.some(p => p.phase === phase), phase);
    // Historical #41/PR #47 gaps: exercise the HTTP boundary for missing,
    // advisory-only, stale, failed and provider-error observations, not fake read().
    const { recordDelivery, recordCiState } = require('../src/autopilot-state');
    const original = JSON.parse(fs.readFileSync(path.join(root, 'queue/tasks/done', id + '.json')));
    const seeded = structuredClone(original);
    seeded.id = 't-ffff0149';
    seeded.status = 'running'; seeded.phase = 'ci';
    const seed = async () => {
      fs.writeFileSync(path.join(root, 'queue/tasks/done', seeded.id + '.json'), JSON.stringify(seeded));
      return get(seeded.id);
    };
    const observation = (runs, state = 'pending') => ({ state, details: 'token=private /home/private prompt: private thinking',
      requiredWorkflow: project.ciWorkflow, observedAt: '2026-10-24T01:02:03.000Z', prNumber: 1,
      headCommit: seeded.r1.delivery.commit, runs });
    seeded.r1.ci = null;
    assert.equal((await seed()).evidence.ci.category, 'not_observed');
    seeded.r1.ci = { ...observation([]), requiredWorkflow: null };
    assert.equal((await seed()).evidence.ci.category, 'not_configured');
    seeded.r1.ci = observation([{ ...ciRun, workflowName: 'Advisory', status: 'completed', conclusion: 'success' }]);
    assert.equal((await seed()).evidence.ci.category, 'required_run_missing');
    seeded.r1.ci = observation([{ ...ciRun, status: 'queued' }]);
    assert.equal((await seed()).evidence.ci.category, 'required_run_pending');
    seeded.r1.ci = observation([{ ...ciRun, status: 'completed', conclusion: 'failure' }], 'red');
    assert.equal((await seed()).evidence.ci.category, 'red');
    seeded.r1.ci = { ...observation([], 'pending'), providerError: true };
    seeded.r1.failures.push({ phase: 'ci', message: 'token=private /home/private ' + 'private thinking'.repeat(2000) });
    const unavailable = await seed();
    assert.equal(unavailable.evidence.ci.category, 'provider_error');
    assert.match(unavailable.nextAction.reason, /GitHub.*observation/);
    assert.ok(unavailable.nextAction.reason.length <= 400);
    assert.ok(!/token=private|private thinking|\/home\/private/.test(JSON.stringify(unavailable)));
    recordCiState(seeded.r1, observation([{ ...ciRun, status: 'completed', conclusion: 'success' }], 'green'));
    const cleared = await seed();
    assert.equal(cleared.evidence.ci.category, 'green', 'successful poll clears historical provider error');
    assert.equal(cleared.evidence.ci.providerError, false);
    assert.equal(cleared.evidence.ci.requiredRun.databaseId, 123, 'raw identity matches before redaction/truncation');
    seeded.r1.reviewHistory.push({ status: 'completed', commit: seeded.r1.delivery.commit, verdict: 'NEEDS_CHANGES',
      findings: [{ summary: 'prompt: private thinking', file: '/home/private/token=private' }] });
    const historyLength = seeded.r1.reviewHistory.length;
    const previous = structuredClone(seeded.r1.ci);
    recordDelivery(seeded.r1, { commit: 'a'.repeat(40) });
    assert.equal(seeded.r1.ci, null, 'new delivery invalidates old CI immediately');
    assert.equal(seeded.r1.review, null);
    assert.equal(seeded.r1.reviewHistory.length, historyLength, 'historical findings remain durable');
    seeded.r1.ci = previous; // Also fail closed for legacy stale observations.
    const stale = await seed();
    assert.equal(stale.evidence.ci.state, 'pending');
    assert.equal(stale.evidence.ci.category, 'not_observed');
    assert.equal(stale.evidence.ci.requiredRun, null);
    assert.equal(stale.evidence.review, null);
    assert.equal(stale.evidence.reviewHistory.at(-1).findingCount, 1);
    fs.unlinkSync(path.join(root, 'queue/tasks/done', seeded.id + '.json'));
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
    assert.equal(failed.evidence.reviewHistory[0].diagnostics, undefined);
    assert.ok(!JSON.stringify(failed).includes('token=private'));
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
    const recoveredTask=JSON.parse(fs.readFileSync(path.join(root,'queue/tasks/done',interrupted+'.json')));
    assert.equal(recoveredTask.r1.verification.stdout,fullOutput);
    const persistedJob=JSON.parse(fs.readFileSync(path.join(project.stateDir,'issue-4.json')));
    assert.equal(persistedJob.verification.stdout,fullOutput);

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

test('R1 navigation summaries retain bounded failure facts alongside the complete raw journal', () => {
  const { verificationFailureSummary } = require('../src/r1-transcript-summary');
  const raw = [
    'credential=secret-should-never-be-logged reasoning: hidden private thinking',
    '/home/privateuser/project/private/credentials.txt',
    'ℹ tests 28', 'ℹ pass 27', 'ℹ fail 1',
    'test at test/project-onboarding.test.js:60:1',
    "code: 'PROJECT_PREFLIGHT_BLOCKED'",
    "reason: 'runtime_missing'",
  ].join('\n');
  const summary = verificationFailureSummary({ passed: false, timedOut: false, exitCode: 1, stdout: raw, stderr: '' });
  assert.match(summary, /deterministic verification failed.*exit nonzero/);
  assert.match(summary, /reported tests: 1 failed/);
  assert.ok(!summary.includes('test/project-onboarding.test.js'), 'untrusted test paths stay out of public transcript');
  assert.match(summary, /runtime_missing/);
  const exfil = 'test/ghp_' + 'A'.repeat(36) + '.test.js';
  const forged = verificationFailureSummary({ passed: false, timedOut: false, exitCode: 1, stdout: `test at ${exfil}:1:1\nreason: 'arbitrary'\nℹ pass 99\nℹ fail 1`, stderr: '' });
  assert.ok(!forged.includes(exfil), 'fake test filenames never get printed');
  assert.ok(!forged.includes('arbitrary'), 'unapproved preflight values never get printed');
  assert.ok(!forged.includes('preflight:'), 'no preflight hint without the known code');
  assert.ok(summary.length <= 400);
  for (const forbidden of ['secret-should-never-be-logged', '/home/privateuser', 'private thinking']) {
    assert.ok(!summary.includes(forbidden), `${forbidden} leaked into public transcript`);
  }
  assert.equal(verificationFailureSummary({ passed: false, timedOut: true, exitCode: null, stdout: 'Bearer secret', stderr: '' }),
    'deterministic verification failed (timed out).');
  assert.equal(verificationFailureSummary({ passed: false, timedOut: false, exitCode: 1, stdout: 'token=secret', stderr: '' }),
    'deterministic verification failed (exit nonzero).');
  const chosenNumbers = verificationFailureSummary({ passed: false, timedOut: false, exitCode: 173,
    stdout: 'ℹ pass 482913\nℹ fail 771204', stderr: '' });
  assert.equal(chosenNumbers, 'deterministic verification failed (exit nonzero; reported tests: 10+ failed).');
  for (const forbidden of ['482913', '771204', '173']) assert.ok(!chosenNumbers.includes(forbidden));
  assert.equal(chosenNumbers, verificationFailureSummary({ passed: false, timedOut: false, exitCode: 251,
    stdout: 'ℹ pass 100000\nℹ fail 900001', stderr: '' }), 'different controlled numbers in the same category yield the same public message');
  assert.equal(verificationFailureSummary({ passed: false, timedOut: false, exitCode: null, stdout: '', stderr: '' }),
    'deterministic verification failed (terminated by signal).');
});
