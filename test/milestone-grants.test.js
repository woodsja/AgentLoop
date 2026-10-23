const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout'); fs.mkdirSync(checkout);
  const config = path.join(root, 'config.json'), projects = path.join(root, 'projects.json');
  fs.writeFileSync(config, JSON.stringify({ allowedProjects: { demo: { root: checkout, worktreeRoot: path.join(root, 'worktrees') } } }));
  fs.writeFileSync(projects, JSON.stringify({ demo: { repo: 'owner/demo', checkout, enabled: true, readyLabel: 'custom', autoMerge: true, worker: 'codex' } }));
  const spec = path.join(root, 'spec.md'); fs.writeFileSync(spec, 'Exact approved specification\n');
  const input = path.join(root, 'grant.json');
  const proposal = { project: 'demo', repo: 'owner/demo', spec: { identity: 'owner/demo#103@revision-1', digest: crypto.createHash('sha256').update(fs.readFileSync(spec)).digest('hex') }, objective: 'Implement bounded grant commands', allowedCategories: ['implementation', 'tests'], exclusions: ['deployment'], revision: 1, ticketLimit: 8, concurrencyLimit: 2, expiresAt: new Date(Date.now() + 86400000).toISOString() };
  const write = () => fs.writeFileSync(input, JSON.stringify(proposal)); write();
  const state = path.join(root, 'state');
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '../src/cli.js'), 'grant', ...args, '--config', config, '--projects', projects], { encoding: 'utf8', env: { ...process.env, AGENTLOOP_STATE_DIR: state, AGENTLOOP_CONFIG_PATH: config, AGENTLOOP_PROJECTS_PATH: projects } });
  const ok = (...args) => { const r = run(...args); assert.ifError(r.error); assert.equal(r.status, 0, r.stderr); const line = r.stdout.trim().split('\n').findLast(line => line.startsWith('{"event":"onboarding_result"')); assert.ok(line, JSON.stringify(r)); return JSON.parse(line).result; };
  return { root, config, projects, spec, input, proposal, write, run, ok, state, draft: () => ok('draft', 'm1', '--input', input, '--spec', spec) };
}
test('real owner commands draft, preview, explicitly activate and inspect across restarts without changing admission', t => {
  const f = fixture(t), before = [f.config, f.projects].map(p => fs.readFileSync(p, 'utf8'));
  const draft = f.draft(); assert.equal(draft.state, 'draft'); assert.equal(draft.revision, 1);
  assert.deepEqual(f.draft(), draft);
  assert.equal(f.run('activate', 'm1', '--digest', draft.digest).status, 1);
  assert.equal(f.ok('inspect', 'm1').state, 'draft');
  assert.equal(f.run('activate', 'm1', '--yes', '--digest', '0'.repeat(64)).status, 1);
  const active = f.ok('activate', 'm1', '--yes', '--digest', draft.digest);
  assert.equal(active.state, 'active'); assert.ok(active.activatedAt); assert.ok(active.actor);
  assert.deepEqual(f.ok('activate', 'm1', '--yes', '--digest', draft.digest), active);
  assert.equal(f.ok('inspect', 'm1').events.filter(e => e.type === 'activated').length, 1);
  assert.deepEqual([f.config, f.projects].map(p => fs.readFileSync(p, 'utf8')), before);
  fs.writeFileSync(f.spec, 'changed');
  assert.equal(Buffer.from(f.ok('inspect', 'm1').spec.contentBase64, 'base64').toString(), 'Exact approved specification\n');
});
test('reject mismatched registration, spec and unbounded limits, and ID reuse', t => {
  const f = fixture(t);
  for (const patch of [{ project: 'missing' }, { repo: 'other/repo' }, { ticketLimit: 0 }, { ticketLimit: 101 }, { concurrencyLimit: 9 }, { allowedCategories: ['*'] }, { revision: 0 }, { expiresAt: 'never' }, { state: 'active' }]) {
    const saved = { ...f.proposal }; Object.assign(f.proposal, patch); f.write();
    assert.equal(f.run('draft', 'm1', '--input', f.input, '--spec', f.spec).status, 1, JSON.stringify(patch));
    for (const key of Object.keys(f.proposal)) delete f.proposal[key]; Object.assign(f.proposal, saved);
  }
  f.write(); f.draft(); f.proposal.objective = 'Different'; f.write();
  assert.equal(f.run('draft', 'm1', '--input', f.input, '--spec', f.spec).status, 1);
  fs.writeFileSync(f.spec, 'changed');
  assert.equal(f.run('draft', 'm2', '--input', f.input, '--spec', f.spec).status, 1);
});
test('interrupted approval never authorizes; retry requires explicit approval', async t => {
  const f = fixture(t), draft = f.draft();
  const { grantCommand } = require('../src/milestone-grants');
  const options = { configPath: f.config, projectsPath: f.projects, stateDir: f.state, digest: draft.digest, record() {}, approve: async () => { throw new Error('interrupted approval'); } };
  await assert.rejects(grantCommand('activate', 'm1', options), /interrupted approval/);
  assert.equal(f.ok('inspect', 'm1').state, 'draft');
  assert.ok(f.ok('inspect', 'm1').events.some(e => e.type === 'approval_requested'));
  assert.equal(f.run('activate', 'm1', '--digest', draft.digest).status, 1);
  assert.equal(f.ok('activate', 'm1', '--yes', '--digest', draft.digest).state, 'active');
});
test('interrupted atomic activation leaves a draft and a durable approval request', t => {
  const f = fixture(t), draft = f.draft();
  // Kill at the actual publication boundary, after the temporary file was fsynced.
  const script = `const fs = require('node:fs'); const rename = fs.renameSync;
    fs.renameSync = function(from, to) {
      if (to.endsWith('milestone-grants.json') && JSON.parse(fs.readFileSync(from)).grants.m1.state === 'active') process.exit(73);
      return rename.apply(this, arguments);
    };
    require(${JSON.stringify(path.join(__dirname, '../src/cli.js'))}).main(process.argv.slice(1)).catch(e => { console.error(e); process.exitCode = 1; });`;
  const child = spawnSync(process.execPath, ['-e', script, 'grant', 'activate', 'm1', '--yes', '--digest', draft.digest, '--config', f.config, '--projects', f.projects], { encoding: 'utf8', env: { ...process.env, AGENTLOOP_STATE_DIR: f.state, AGENTLOOP_CONFIG_PATH: f.config, AGENTLOOP_PROJECTS_PATH: f.projects } });
  assert.ifError(child.error); assert.equal(child.status, 73, child.stderr);
  const store = path.join(f.state, 'milestone-grants.json');
  assert.equal(JSON.parse(fs.readFileSync(store)).grants.m1.state, 'draft');
  assert.equal(f.run('activate', 'm1', '--yes', '--digest', draft.digest).status, 1);
  // The child is confirmed stopped. Follow the existing owner-lock recovery procedure.
  for (const p of [f.config, f.projects, store]) fs.rmSync(`${p}.project-lock`, { recursive: true, force: true });
  assert.equal(f.ok('inspect', 'm1').state, 'draft');
  assert.equal(f.run('activate', 'm1', '--digest', draft.digest).status, 1);
  assert.equal(f.ok('activate', 'm1', '--yes', '--digest', draft.digest).state, 'active');
});
test('activation rechecks registration and expiry; lifecycle distinctions survive storage', async t => {
  const f = fixture(t), draft = f.draft();
  const { grantCommand, STATES } = require('../src/milestone-grants');
  const options = { configPath: f.config, projectsPath: f.projects, stateDir: f.state, digest: draft.digest, record() {}, approve: async () => {
    const projects = JSON.parse(fs.readFileSync(f.projects)); projects.alias = { ...projects.demo }; fs.writeFileSync(f.projects, JSON.stringify(projects)); return true;
  } };
  await assert.rejects(grantCommand('activate', 'm1', options), /unique registered/);
  const projects = JSON.parse(fs.readFileSync(f.projects)); delete projects.alias; fs.writeFileSync(f.projects, JSON.stringify(projects));
  const store = path.join(f.state, 'milestone-grants.json');
  for (const state of STATES) {
    const db = JSON.parse(fs.readFileSync(store)); db.grants.m1.state = state;
    fs.writeFileSync(store, JSON.stringify(db));
    assert.equal(f.ok('inspect', 'm1').state, state);
    if (['paused', 'revoked', 'completed', 'expired'].includes(state)) assert.equal(f.run('activate', 'm1', '--yes', '--digest', draft.digest).status, 1);
  }
  const db = JSON.parse(fs.readFileSync(store)); db.grants.m1.state = 'active'; db.grants.m1.expiresAt = '2000-01-01T00:00:00.000Z'; fs.writeFileSync(store, JSON.stringify(db));
  assert.equal(f.ok('inspect', 'm1').state, 'expired');
  assert.equal(JSON.parse(fs.readFileSync(store)).grants.m1.state, 'expired');
});
test('write failure before atomic publication cannot create an active grant', async t => {
  const f = fixture(t), draft = f.draft();
  const { grantCommand } = require('../src/milestone-grants');
  let writes = 0;
  await assert.rejects(grantCommand('activate', 'm1', { configPath: f.config, projectsPath: f.projects, stateDir: f.state, digest: draft.digest, record() {}, approve: async () => true,
    beforeCommit() { if (++writes === 2) throw new Error('disk failure'); }
  }), /disk failure/);
  assert.equal(f.ok('inspect', 'm1').state, 'draft');
  assert.equal(f.ok('activate', 'm1', '--yes', '--digest', draft.digest).state, 'active');
});
test('concurrent activation is rejected and cancellation requires a fresh approval', async t => {
  const f = fixture(t), draft = f.draft();
  const { grantCommand } = require('../src/milestone-grants');
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const first = grantCommand('activate', 'm1', { configPath: f.config, projectsPath: f.projects, stateDir: f.state, digest: draft.digest, record() {},
    approve: async () => { entered(); return new Promise(resolve => { release = resolve; }); }, isCancelled: () => true });
  await waiting;
  const concurrent = f.run('activate', 'm1', '--yes', '--digest', draft.digest);
  assert.ifError(concurrent.error); assert.equal(concurrent.status, 1); assert.match(concurrent.stderr, /Concurrent onboarding/);
  release(true); await assert.rejects(first, /cancelled/);
  assert.equal(f.ok('inspect', 'm1').state, 'draft');
  assert.equal(f.ok('activate', 'm1', '--yes', '--digest', draft.digest).state, 'active');
});

test('owner actions preview exact transitions, audit retries and preserve successive pause/resume cycles', async t => {
  const f = fixture(t), { grantCommand } = require('../src/milestone-grants');
  const previews = [];
  const options = { configPath: f.config, projectsPath: f.projects, stateDir: f.state,
    inputPath: f.input, specPath: f.spec, record: (type, value) => previews.push({ type, value }), approve: async () => true };
  const draft = await grantCommand('draft', 'm1', options);
  await grantCommand('activate', 'm1', { ...options, digest: draft.digest });
  const action = async name => {
    const preview = await grantCommand(name, 'm1', options);
    const changed = await grantCommand(name, 'm1', { ...options, digest: preview.digest });
    assert.deepEqual(await grantCommand(name, 'm1', { ...options, digest: preview.digest }), changed);
    return { preview, changed };
  };
  const first = await action('pause'); assert.equal(first.changed.state, 'paused');
  await action('resume');
  const second = await action('pause'); assert.notEqual(second.preview.digest, first.preview.digest);
  await assert.rejects(grantCommand('resume', 'm1', { ...options, digest: second.preview.digest }), /matching/);
  const declined = await grantCommand('resume', 'm1', options);
  await assert.rejects(grantCommand('resume', 'm1', { ...options, digest: declined.digest, approve: async () => false }), /cancelled/);
  assert.equal((await grantCommand('inspect', 'm1', options)).state, 'paused');
  await action('resume'); await action('complete');
  await assert.rejects(grantCommand('resume', 'm1', options), /completed/);
  const grant = await grantCommand('inspect', 'm1', options);
  assert.equal(grant.events.filter(e => e.type === 'owner_action' && e.action === 'pause').length, 2);
  assert.ok(previews.some(e => e.value.inspection?.quotaRemaining === 8));
});
test('amendment requires the next revision, rejects identity changes and detects owner edits during approval', async t => {
  const f = fixture(t), { grantCommand } = require('../src/milestone-grants');
  const options = { configPath: f.config, projectsPath: f.projects, stateDir: f.state, inputPath: f.input, specPath: f.spec, record() {}, approve: async () => true };
  const draft = await grantCommand('draft', 'm1', options);
  await grantCommand('activate', 'm1', { ...options, digest: draft.digest });
  await assert.rejects(grantCommand('amend', 'm1', options), /next revision/);
  f.proposal.revision = 2; f.write();
  const preview = await grantCommand('amend', 'm1', options);
  await assert.rejects(grantCommand('amend', 'm1', { ...options, digest: preview.digest, approve: async () => {
    const file = path.join(f.state, 'milestone-grants.json'), db = JSON.parse(fs.readFileSync(file));
    db.grants.m1.state = 'revoked'; fs.writeFileSync(file, JSON.stringify(db)); return true;
  } }), /changed outside/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, 'milestone-grants.json'))).grants.m1.state, 'revoked');
});
test('durable authoritative time prevents expiration rollback across module restart', async t => {
  const f = fixture(t), { grantCommand } = require('../src/milestone-grants');
  const options = { configPath: f.config, projectsPath: f.projects, stateDir: f.state, inputPath: f.input, specPath: f.spec, record() {}, approve: async () => true };
  const draft = await grantCommand('draft', 'm1', options);
  await grantCommand('activate', 'm1', { ...options, digest: draft.digest });
  const original = Date.now;
  try {
    Date.now = () => Date.parse(f.proposal.expiresAt) + 1;
    const { currentTime } = require('../src/milestone-clock'); currentTime(f.state);
    Date.now = () => Date.parse(f.proposal.expiresAt) - 60000;
    delete require.cache[require.resolve('../src/milestone-clock')];
    assert.equal((await grantCommand('inspect', 'm1', options)).state, 'expired');
    await assert.rejects(grantCommand('resume', 'm1', options), /expired/);
    const revoke = await grantCommand('revoke', 'm1', options);
    assert.equal((await grantCommand('revoke', 'm1', { ...options, digest: revoke.digest })).state, 'revoked');
  } finally { Date.now = original; }
});
