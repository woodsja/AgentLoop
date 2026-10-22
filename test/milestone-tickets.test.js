const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { grantCommand } = require('../src/milestone-grants');
const { ticketCommand, ticketDigest } = require('../src/milestone-tickets');
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json'), projectsPath = path.join(root, 'projects.json');
  fs.writeFileSync(configPath, JSON.stringify({ allowedProjects: { demo: root } }));
  fs.writeFileSync(projectsPath, JSON.stringify({ demo: { repo: 'owner/demo', checkout: root, readyLabel: 'custom-ready' } }));
  const specPath = path.join(root, 'spec.md'); fs.writeFileSync(specPath, 'Approved scope');
  const inputPath = path.join(root, 'input.json');
  fs.writeFileSync(inputPath, JSON.stringify({ project: 'demo', repo: 'owner/demo', spec: { identity: '#103@1', digest: crypto.createHash('sha256').update('Approved scope').digest('hex') }, objective: 'Tests', allowedCategories: ['tests'], exclusions: ['deployment'], revision: 1, ticketLimit: 1, concurrencyLimit: 1, expiresAt: new Date(Date.now() + 86400000).toISOString() }));
  const events = [], writes = [];
  const options = { configPath, projectsPath, stateDir: root, inputPath, specPath, record: (type, details) => events.push({ type, ...details }), approve: async () => true };
  const grant = await grantCommand('draft', 'g1', options);
  await grantCommand('activate', 'g1', { ...options, digest: grant.digest });
  const issue = { number: 106, title: '[DRAFT] Add tests', body: 'Draft tests\n', state: 'open', labels: [], html_url: 'https://github.com/owner/demo/issues/106' };
  const request = { repo: 'owner/demo', issue: 106, grantDigest: grant.digest, revision: 1, spec: { identity: grant.spec.identity, digest: grant.spec.digest }, ticketDigest: ticketDigest(issue), category: 'tests', scope: 'in-scope', reason: 'Only adds tests; no deployment.' };
  const db = () => JSON.parse(fs.readFileSync(path.join(root, 'milestone-grants.json')));
  options.execFile = (file, args, opts, callback) => {
    if (args.includes('POST')) {
      assert.equal(Object.keys(db().grants.g1.receipts).length, 1, 'receipt precedes label');
      writes.push(args); if (options.failLabel) return callback(new Error('offline'), '', 'offline');
      issue.labels = [{ name: 'custom-ready' }]; return callback(null, JSON.stringify(issue.labels), '');
    }
    callback(null, JSON.stringify(issue), '');
  };
  const run = async (action, extra = {}) => { fs.writeFileSync(inputPath, JSON.stringify(request)); return ticketCommand(action, 'g1', { ...options, ...extra }); };
  const approve = async () => { const p = await run('preview'); return run('approve', { digest: p.digest }); };
  return { root, options, request, issue, run, approve, writes, events, db };
}
test('isolated draft through owner scope confirmation, receipt and configured label; retry is idempotent', async t => {
  const f = await fixture(t), before = fs.readFileSync(f.options.projectsPath, 'utf8');
  assert.equal((await f.run('release')).decision, 'NEEDS_APPROVAL'); assert.equal(f.writes.length, 0);
  assert.equal((await f.approve()).decision, 'ALLOW');
  const first = await f.run('release'); assert.equal(first.decision, 'ALLOW'); assert.equal(first.released, true);
  assert.equal((await f.run('release')).receipt.id, first.receipt.id);
  assert.equal(f.writes.length, 1); assert.equal(Object.keys(f.db().grants.g1.receipts).length, 1);
  assert.equal(fs.readFileSync(f.options.projectsPath, 'utf8'), before);
  assert.ok(f.events.some(e => e.type === 'preview' && e.issue?.body === f.issue.body));
  assert.ok(f.db().grants.g1.ticketEvents.some(e => e.type === 'released'));
});
test('label failure retries from durable receipt, including after restart', async t => {
  const f = await fixture(t); await f.approve(); f.options.failLabel = true;
  assert.equal((await f.run('release')).decision, 'WAIT');
  assert.equal(Object.keys(f.db().grants.g1.receipts).length, 1);
  f.options.failLabel = false;
  assert.equal((await f.run('release')).released, true);
  assert.equal(Object.keys(f.db().grants.g1.receipts).length, 1);
});
test('untrusted scope, exclusions, category, exact identity, revision and spec fail closed', async t => {
  const f = await fixture(t); await f.approve(); const original = structuredClone(f.request);
  for (const patch of [{ repo: 'other/repo' }, { issue: 107 }, { revision: 2 }, { grantDigest: '0'.repeat(64) }, { spec: { identity: '#other', digest: original.spec.digest } }, { ticketDigest: '0'.repeat(64) }, { category: 'deployment' }, { scope: 'excluded' }, { scope: 'ambiguous' }]) {
    Object.assign(f.request, original, patch);
    assert.notEqual((await f.run('release')).decision, 'ALLOW', JSON.stringify(patch));
  }
  assert.equal(f.writes.length, 0);
});
test('changed title/body, missing GitHub data, labels, PR and closed issues never label', async t => {
  const f = await fixture(t); await f.approve(); const original = structuredClone(f.issue);
  for (const patch of [{ title: 'changed' }, { body: 'changed' }, { body: null }, { labels: null }, { labels: [{ name: 'unexpected' }] }, { pull_request: {} }, { state: 'closed' }, { html_url: 'https://github.com/other/repo/issues/106' }]) {
    Object.assign(f.issue, original, patch);
    assert.notEqual((await f.run('release')).decision, 'ALLOW');
    for (const key of Object.keys(f.issue)) delete f.issue[key]; Object.assign(f.issue, original);
  }
  assert.equal(f.writes.length, 0);
});
test('persistence failure prevents labels; expired and inactive grants reject even a receipt', async t => {
  const f = await fixture(t); await f.approve();
  await assert.rejects(f.run('release', { beforeCommit() { throw new Error('disk failure'); } }), /disk failure/);
  assert.equal(f.writes.length, 0); assert.equal(Object.keys(f.db().grants.g1.receipts || {}).length, 0);
  await f.run('release');
  for (const patch of [{ state: 'paused' }, { state: 'revoked' }, { state: 'active', expiresAt: '2000-01-01T00:00:00.000Z' }]) {
    const db = f.db(); Object.assign(db.grants.g1, patch); fs.writeFileSync(path.join(f.root, 'milestone-grants.json'), JSON.stringify(db));
    assert.notEqual((await f.run('release')).decision, 'ALLOW');
  }
  assert.equal(f.writes.length, 1);
});
test('quota counts distinct issues once, not repeated authorizations', async t => {
  const f = await fixture(t); await f.approve(); await f.run('release');
  f.issue.number = 107; f.issue.labels = []; f.issue.html_url = 'https://github.com/owner/demo/issues/107'; f.request.issue = 107;
  assert.equal((await f.run('release')).decision, 'DENY'); assert.equal(f.writes.length, 1);
});
test('scope approval requires preview digest and rechecks exact issue after prompt', async t => {
  const f = await fixture(t);
  assert.equal((await f.run('approve', { digest: '0'.repeat(64) })).decision, 'NEEDS_APPROVAL');
  const p = await f.run('preview');
  assert.equal((await f.run('approve', { digest: p.digest, approve: async () => { f.issue.body += 'deployment'; return true; } })).decision, 'WAIT');
  assert.equal(f.writes.length, 0); assert.equal(Object.keys(f.db().grants.g1.ticketApprovals).length, 0);
});
test('concurrent release shares grant quota lock; registration/label changes invalidate approval', async t => {
  const f = await fixture(t); await f.approve();
  const gh = f.options.execFile; let entered, resume;
  const started = new Promise(resolve => { entered = resolve; });
  f.options.execFile = (file, args, opts, cb) => { entered(); resume = () => gh(file, args, opts, cb); };
  const first = f.run('preview'); await started;
  await assert.rejects(f.run('release'), /Concurrent onboarding/); resume(); await first;
  f.options.execFile = gh;
  const projects = JSON.parse(fs.readFileSync(f.options.projectsPath)); projects.demo.readyLabel = 'changed-ready';
  fs.writeFileSync(f.options.projectsPath, JSON.stringify(projects));
  assert.equal((await f.run('release')).decision, 'NEEDS_APPROVAL');
  projects.alias = { ...projects.demo }; fs.writeFileSync(f.options.projectsPath, JSON.stringify(projects));
  assert.equal((await f.run('release')).decision, 'DENY'); assert.equal(f.writes.length, 0);
});
test('transport failure, malformed dependency metadata and changed issue before commit hold release', async t => {
  const f = await fixture(t); await f.approve(); const gh = f.options.execFile;
  assert.equal((await f.run('release', { execFile(file, args, opts, cb) { cb(new Error('offline'), '', 'offline'); } })).decision, 'WAIT');
  f.issue.body += 'Depends on: #999'; f.request.ticketDigest = ticketDigest(f.issue);
  assert.equal((await f.run('release')).decision, 'WAIT');
  f.issue.body = 'Draft tests\n'; f.request.ticketDigest = ticketDigest(f.issue);
  let calls = 0;
  assert.equal((await f.run('release', { execFile(file, args, opts, cb) { if (++calls === 2) f.issue.title += ' changed'; gh(file, args, opts, cb); } })).decision, 'WAIT');
  assert.equal(f.writes.length, 0);
});
test('CLI accepts exact ticket commands and rejects publication/activation options', () => {
  const { parseArguments } = require('../src/cli');
  assert.equal(parseArguments(['ticket', 'release', 'g1', '--input', 'ticket.json']).group, 'ticket');
  for (const extra of [['--yes'], ['--ready-label', 'ready'], ['--digest', 'abc']]) {
    assert.throws(() => parseArguments(['ticket', 'release', 'g1', '--input', 'ticket.json', ...extra]), /Option/);
  }
  assert.throws(() => parseArguments(['ticket', 'approve', 'g1']), /Usage/);
});
test('ambiguous successful labeling reconciles without a second mutation or quota charge', async t => {
  const f = await fixture(t); await f.approve(); const gh = f.options.execFile;
  const first = await f.run('release', { execFile(file, args, opts, cb) {
    if (args.includes('POST')) return gh(file, args, opts, () => cb(new Error('lost response'), '', 'lost response'));
    gh(file, args, opts, cb);
  } });
  assert.equal(first.decision, 'WAIT'); assert.equal(f.writes.length, 1);
  const retry = await f.run('release'); assert.equal(retry.released, true);
  assert.equal(retry.receipt.id, first.receipt.id); assert.equal(f.writes.length, 1);
  assert.equal(Object.keys(f.db().grants.g1.receipts).length, 1);
});
test('a durable receipt rejects changed bytes and cannot be transferred to another issue', async t => {
  const f = await fixture(t); await f.approve(); await f.run('release');
  f.issue.body += 'edited';
  assert.equal((await f.run('release')).decision, 'WAIT');
  f.request.ticketDigest = ticketDigest(f.issue);
  assert.equal((await f.run('release')).decision, 'DENY');
  assert.equal(f.writes.length, 1);
});
test('owner edits during GitHub reads cannot be overwritten or label a revoked grant', async t => {
  const f = await fixture(t); await f.approve(); const gh = f.options.execFile;
  await assert.rejects(f.run('release', { execFile(file, args, opts, cb) {
    const db = f.db(); db.grants.g1.state = 'revoked';
    fs.writeFileSync(path.join(f.root, 'milestone-grants.json'), JSON.stringify(db));
    gh(file, args, opts, cb);
  } }), /changed outside/);
  assert.equal(f.db().grants.g1.state, 'revoked'); assert.equal(f.writes.length, 0);
});
test('incomplete stored scope evidence cannot authorize; corrupted receipt evidence rejects', async t => {
  const f = await fixture(t); await f.approve();
  const store = path.join(f.root, 'milestone-grants.json');
  let db = f.db(); const digest = Object.keys(db.grants.g1.ticketApprovals)[0];
  db.grants.g1.ticketApprovals[digest] = null; fs.writeFileSync(store, JSON.stringify(db));
  assert.equal((await f.run('release')).decision, 'NEEDS_APPROVAL'); assert.equal(f.writes.length, 0);
  await f.approve(); await f.run('release');
  db = f.db(); db.grants.g1.receipts['owner/demo#106'].issue.body += 'corrupted'; fs.writeFileSync(store, JSON.stringify(db));
  assert.equal((await f.run('release')).decision, 'DENY'); assert.equal(f.writes.length, 1);
});
