const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { grantCommand } = require('../src/milestone-grants');
const { batchCommand } = require('../src/milestone-batches');
const { checkMilestoneAdmission } = require('../src/milestone-admission');

async function fixture(t, { ticketLimit = 3, concurrencyLimit = 2, blockers = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batches-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { stateDir: root, configPath: path.join(root, 'config.json'), projectsPath: path.join(root, 'projects.json'), inputPath: path.join(root, 'input.json'), specPath: path.join(root, 'spec.md'), approve: async () => true };
  const project = { repo: 'owner/demo', checkout: root, readyLabel: 'custom-ready', milestoneAuthorization: true };
  options.record = () => {};
  fs.writeFileSync(options.configPath, JSON.stringify({ allowedProjects: { demo: root } }));
  fs.writeFileSync(options.projectsPath, JSON.stringify({ demo: project }));
  fs.writeFileSync(options.specPath, 'Approved test scope');
  fs.writeFileSync(options.inputPath, JSON.stringify({ project: 'demo', repo: 'owner/demo', spec: { identity: 'owner/demo#103@1', digest: crypto.createHash('sha256').update('Approved test scope').digest('hex') }, objective: 'Test scope', allowedCategories: ['tests'], exclusions: ['deployment', 'external permissions'], revision: 1, ticketLimit, concurrencyLimit, expiresAt: new Date(Date.now() + 86400000).toISOString() }));
  const grant = await grantCommand('draft', 'g1', options);
  await grantCommand('activate', 'g1', { ...options, digest: grant.digest });
  const batch = { id: 'batch-one', conversation: 'chatgpt:owner-planning-message-1', tickets: ['one', 'two'].map(id => ({
    draft: { id, kind: 'ticket', repo: 'owner/demo', title: `Test ${id}`, sourceSpec: '#103', conversation: 'chatgpt:owner-planning-message-1', summary: 'Add isolated tests', acceptanceCriteria: ['Tests pass in an isolated store'], blockers },
    category: 'tests', scope: 'in-scope', reason: 'Only approved test scope; no deployment or permissions.' })) };
  const issues = [], native = new Map(), writes = [], events = [];
  const db = () => JSON.parse(fs.readFileSync(path.join(root, 'milestone-grants.json')));
  const journal = () => JSON.parse(fs.readFileSync(path.join(root, 'milestone-batches.json')));
  const issue = number => issues.find(i => i.number === number) || { id: number + 1000, number, html_url: `https://github.com/owner/demo/issues/${number}`, state: 'closed' };
  options.record = (type, value) => events.push({ type, value });
  options.execFile = (file, args, opts, cb) => {
    try {
      const endpoint = args.find(a => a.startsWith('repos/'));
      const number = Number(/issues\/(\d+)/.exec(endpoint)?.[1]);
      const post = args.includes('POST');
      let result;
      if (endpoint.includes('/dependencies/blocked_by')) {
        if (post) {
          const blocker = Number(args.find(a => a.startsWith('issue_id=')).slice(9)) - 1000;
          const entry = journal().batches['batch-one'].tickets[issues.find(i => i.number === number).body.match(/draft:([^ ]+)/)[1]];
          assert.equal(entry.pendingBlocker, blocker, 'blocker intent must precede mutation');
          native.set(number, [...(native.get(number) || []), blocker]); result = issue(blocker);
          writes.push({ kind: 'blocker', number });
          if (options.loseBlocker) { options.loseBlocker = false; return cb(new Error('lost blocker response'), '', ''); }
        } else result = [(native.get(number) || []).map(issue)];
      } else if (endpoint.endsWith('/labels')) {
        assert.equal(post, true);
        const receipt = db().grants.g1.receipts[`owner/demo#${number}`];
        assert.ok(receipt, 'exact receipt must be durable before each label');
        assert.equal(receipt.issue.body, issue(number).body);
        assert.deepEqual(receipt.issue.nativeBlockers, native.get(number) || []);
        writes.push({ kind: 'label', number });
        if (options.failLabel === number) return cb(new Error('label offline'), '', '');
        issue(number).labels = [{ name: 'custom-ready' }]; result = issue(number).labels;
        if (options.loseLabel === number) { options.loseLabel = null; return cb(new Error('lost label response'), '', ''); }
      } else if (post) {
        const body = args.find(a => a.startsWith('body=')).slice(5);
        const id = body.match(/draft:([^ ]+)/)[1];
        assert.equal(journal().batches[batch.id].tickets[id].creationAttempted, true, 'creation intent precedes POST');
        result = { id: issues.length + 1200, number: issues.length + 200, title: args.find(a => a.startsWith('title=')).slice(6), body, labels: [], state: 'open', html_url: `https://github.com/owner/demo/issues/${issues.length + 200}` };
        issues.push(result); native.set(result.number, []); writes.push({ kind: 'create', number: result.number });
        if (options.loseCreate) { options.loseCreate = false; return cb(new Error('lost creation response'), '', ''); }
      } else if (number) result = issue(number);
      else result = [issues];
      cb(null, JSON.stringify(result), '');
    } catch (e) { cb(e, '', ''); }
  };
  const run = (action, extra = {}) => {
    fs.writeFileSync(options.inputPath, JSON.stringify(batch));
    return batchCommand(action, 'g1', { ...options, ...extra });
  };
  const approve = async () => { const p = await run('preview'); return run('approve', { digest: p.digest }); };
  return { root, options, batch, project, run, approve, issues, native, writes, events, db, journal };
}

test('two-ticket conversation batch previews, publishes unlabeled, confirms scope and releases exact receipts', async t => {
  const f = await fixture(t);
  const config = fs.readFileSync(f.options.configPath), projects = fs.readFileSync(f.options.projectsPath);
  await f.run('preview'); assert.equal(f.writes.length, 0);
  await f.run('publish'); assert.equal(f.issues.length, 2);
  assert.ok(f.issues.every(i => !i.labels.length));
  assert.ok((await f.run('preview')).tickets.every(i => i.decision === 'NEEDS_APPROVAL'));
  await f.approve();
  const preview = await f.run('preview');
  assert.deepEqual(preview.tickets.map(i => i.decision), ['ALLOW', 'ALLOW']);
  assert.equal(preview.usage.issued, 0); assert.ok(preview.tickets.every(i => i.identity && i.digest && i.reasons.length));
  const released = await f.run('release');
  assert.ok(released.tickets.every(i => i.released));
  const ids = released.tickets.map(i => i.receipt.id);
  const retry = await f.run('release');
  assert.deepEqual(retry.tickets.map(i => i.receipt.id), ids);
  assert.equal(f.writes.filter(w => w.kind === 'create').length, 2);
  assert.equal(f.writes.filter(w => w.kind === 'label').length, 2);
  assert.equal(retry.usage.issued, 2);
  assert.deepEqual(fs.readFileSync(f.options.configPath), config); assert.deepEqual(fs.readFileSync(f.options.projectsPath), projects);
  await checkMilestoneAdmission('demo', f.project, 200, f.options);
  f.native.set(200, [10]);
  await assert.rejects(checkMilestoneAdmission('demo', f.project, 200, f.options), /blocker set changed/);
});

test('ambiguous creation, partial labeling and fresh command retries retain one issue and receipt per identity', async t => {
  const f = await fixture(t); f.options.loseCreate = true;
  const partial = await f.run('publish'); assert.equal(partial.tickets[0].decision, 'WAIT');
  assert.equal(f.issues.length, 2);
  await f.run('publish'); assert.equal(f.issues.length, 2);
  await f.approve(); f.options.failLabel = 201; f.options.loseLabel = 200;
  const first = await f.run('release'); assert.deepEqual(first.tickets.map(i => i.decision), ['WAIT', 'WAIT']);
  assert.equal(first.usage.issued, 2);
  const receipts = JSON.stringify(f.db().grants.g1.receipts);
  delete f.options.failLabel;
  // Commands reopen both fsynced stores instead of relying on in-memory state.
  const retry = await f.run('release'); assert.ok(retry.tickets.every(i => i.released));
  assert.equal(JSON.stringify(f.db().grants.g1.receipts), receipts);
  assert.equal(f.writes.filter(w => w.kind === 'create').length, 2);
  assert.equal(f.writes.filter(w => w.kind === 'label' && w.number === 200).length, 1);
});

test('native write ambiguity reconciles; blocked tickets WAIT without receipts or quota consumption', async t => {
  const f = await fixture(t, { blockers: [10] }); f.options.loseBlocker = true;
  await f.run('publish'); await f.run('publish');
  assert.equal(f.writes.filter(w => w.kind === 'blocker').length, 2);
  assert.deepEqual(f.native.get(200), [10]);
  await f.approve();
  const p = await f.run('preview'); assert.deepEqual(p.tickets.map(i => i.decision), ['WAIT', 'WAIT']);
  assert.ok(p.tickets[0].reasons[0].includes('prerequisites'));
  assert.deepEqual(p.tickets[0].dependencies, [10]);
  await f.run('release'); assert.equal(Object.keys(f.db().grants.g1.receipts).length, 0);
  assert.equal(f.writes.filter(w => w.kind === 'label').length, 0);
});

test('one preview explains all four decisions without changing labels or consuming quota', async t => {
  const f = await fixture(t, { ticketLimit: 5 });
  f.batch.tickets[0].draft.blockers = [10];
  f.batch.tickets.push(...['three', 'four'].map(id => ({ ...f.batch.tickets[1], draft: { ...f.batch.tickets[1].draft, id, title: `Test ${id}` } })));
  f.batch.tickets[2].category = 'deployment'; f.batch.tickets[3].scope = 'ambiguous';
  await f.run('publish'); await f.approve();
  const writes = f.writes.length;
  const preview = await f.run('preview');
  assert.deepEqual(preview.tickets.map(i => i.decision), ['WAIT', 'ALLOW', 'DENY', 'NEEDS_APPROVAL']);
  assert.ok(preview.tickets.every(i => i.identity && i.reasons.length && Array.isArray(i.dependencies)));
  assert.equal(preview.usage.issued, 0); assert.equal(f.writes.length, writes);
  assert.ok(f.issues.every(i => !i.labels.length));
});

test('preview projects active quota; closing a ticket frees active capacity but never issued quota', async t => {
  const f = await fixture(t, { ticketLimit: 2, concurrencyLimit: 1 });
  await f.run('publish'); await f.approve();
  assert.deepEqual((await f.run('preview')).tickets.map(i => i.decision), ['ALLOW', 'WAIT']);
  assert.deepEqual((await f.run('release')).tickets.map(i => i.decision), ['ALLOW', 'WAIT']);
  assert.equal(Object.keys(f.db().grants.g1.receipts).length, 1);
  f.issues[0].state = 'closed';
  const next = await f.run('release'); assert.equal(next.tickets[1].released, true); assert.equal(next.usage.issued, 2);
  f.batch.id = 'batch-two'; f.batch.tickets = [{ ...f.batch.tickets[0], draft: { ...f.batch.tickets[0].draft, id: 'three' } }];
  await f.run('publish');
  assert.equal((await f.run('release')).tickets[0].decision, 'DENY');
  assert.equal(Object.keys(f.db().grants.g1.receipts).length, 2);
});

test('edit, conflicting native dependencies, cross-repo and unknown tasks require review', async t => {
  const f = await fixture(t); await f.run('publish'); await f.approve(); await f.run('release');
  const receipt = JSON.stringify(f.db().grants.g1.receipts);
  f.issues[0].body += '\nNew external permission requirement';
  assert.equal((await f.run('release')).tickets[0].decision, 'NEEDS_APPROVAL');
  f.native.set(201, [10]);
  assert.equal((await f.run('release')).tickets[1].decision, 'NEEDS_APPROVAL');
  assert.equal(JSON.stringify(f.db().grants.g1.receipts), receipt);
  f.batch.id = 'other-batch'; f.batch.tickets[0].draft.repo = 'external/repo'; f.batch.tickets[1].draft.sourceSpec = '#999';
  const held = await f.run('release'); assert.deepEqual(held.tickets.map(i => i.decision), ['DENY', 'NEEDS_APPROVAL']);
  assert.equal(f.writes.filter(w => w.kind === 'label').length, 2);
});

test('durable failure and concurrent publishers cannot produce duplicate side effects', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run('publish', { beforeCommit() { throw new Error('disk full'); } }), /disk full/);
  assert.equal(f.writes.length, 0);
  const gh = f.options.execFile;
  let resume, started;
  const entered = new Promise(resolve => { started = resolve; });
  let first = true;
  f.options.execFile = (file, args, opts, cb) => {
    if (first) { first = false; resume = () => gh(file, args, opts, cb); started(); }
    else gh(file, args, opts, cb);
  };
  const publishing = f.run('publish'); await entered;
  await assert.rejects(f.run('publish'), /Concurrent onboarding/);
  resume(); await publishing;
  assert.equal(f.issues.length, 2);
  f.options.execFile = gh; await f.approve();
  let commits = 0;
  // Failure while reserving a receipt leaves both label and quota unchanged.
  await f.run('release', { beforeCommit() { if (++commits === 1) throw new Error('receipt disk failure'); } });
  assert.equal(f.writes.filter(w => w.kind === 'label' && w.number === 200).length, 0);
  assert.ok(f.journal().batches['batch-one'].events.some(e => e.type === 'held'));
});

test('unresolved creation or blocker intent never repeats a remote POST when reconciliation finds nothing', async t => {
  for (const kind of ['create', 'blocker']) {
    const f = await fixture(t, { blockers: kind === 'blocker' ? [10] : [] });
    const gh = f.options.execFile;
    let attempts = 0;
    f.options.execFile = (file, args, opts, cb) => {
      const endpoint = args.find(a => a.startsWith('repos/'));
      const matching = args.includes('POST') && (kind === 'create' ? endpoint.endsWith('/issues') : endpoint.endsWith('/dependencies/blocked_by'));
      if (matching && attempts++ === 0) return cb(new Error('connection lost before confirmation'), '', '');
      gh(file, args, opts, cb);
    };
    await f.run('publish');
    const count = attempts;
    const retry = await f.run('publish');
    assert.equal(attempts, count, 'retry must not blindly resubmit unresolved writes');
    assert.equal(retry.tickets[0].decision, 'WAIT');
    assert.equal(f.writes.filter(w => w.kind === kind).length, 1);
  }
});

test('stable identities handle object property names and reordered JSON without changing batch digest', async t => {
  const f = await fixture(t);
  f.batch.tickets[0].draft.id = 'constructor';
  await f.run('publish'); await f.approve();
  const before = await f.run('preview');
  f.batch.tickets[0] = Object.fromEntries(Object.entries(f.batch.tickets[0]).reverse());
  assert.equal((await f.run('preview')).digest, before.digest);
  assert.equal((await f.run('release')).tickets[0].released, true);
  assert.equal(f.issues.length, 2);
});

test('racing releases cannot exceed active quota while the first publisher is between receipt and label', async t => {
  const f = await fixture(t, { concurrencyLimit: 1 });
  await f.run('publish'); await f.approve();
  const gh = f.options.execFile;
  let resume, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.options.execFile = (file, args, opts, cb) => {
    if (args.some(a => a.endsWith('/labels'))) { resume = () => gh(file, args, opts, cb); entered(); }
    else gh(file, args, opts, cb);
  };
  const releasing = f.run('release'); await waiting;
  assert.equal(Object.keys(f.db().grants.g1.receipts).length, 1);
  await assert.rejects(f.run('release'), /Concurrent onboarding/);
  resume();
  const result = await releasing;
  assert.deepEqual(result.tickets.map(i => i.decision), ['ALLOW', 'WAIT']);
  assert.equal(Object.keys(f.db().grants.g1.receipts).length, 1);
  assert.equal(f.writes.filter(w => w.kind === 'label').length, 1);
});

test('CLI batch commands are explicit and reject automatic owner authorization on release', () => {
  const { parseArguments } = require('../src/cli');
  assert.equal(parseArguments(['batch', 'publish', 'g1', '--input', 'batch.json']).group, 'batch');
  assert.throws(() => parseArguments(['batch', 'release', 'g1', '--input', 'batch.json', '--yes']), /Option/);
});

test('abrupt process exits after creation, native linking, receipt commit and labeling resume from durable state', async t => {
  const { spawnSync } = require('node:child_process');
  for (const crash of ['create', 'blocker', 'receipt', 'label']) {
    const f = await fixture(t, { blockers: crash === 'blocker' ? [10] : [] });
    const publication = ['create', 'blocker'].includes(crash);
    fs.writeFileSync(f.options.inputPath, JSON.stringify(f.batch));
    const remote = path.join(f.root, 'fake-github.json');
    const worker = (action, point = '') => spawnSync(process.execPath, [path.join(__dirname, 'fixtures/milestone-batch-crash.js'), f.root, action, point], { encoding: 'utf8' });
    fs.writeFileSync(remote, JSON.stringify({ issues: [], writes: [] }));
    if (!publication) {
      await f.run('publish'); await f.approve();
      fs.writeFileSync(remote, JSON.stringify({ issues: f.issues, writes: [] }));
    }
    const stopped = worker(publication ? 'publish' : 'release', crash);
    assert.equal(stopped.status, 73, stopped.stderr);
    if (!publication) assert.equal(Object.keys(f.db().grants.g1.receipts).length, 1);
    // The child is confirmed stopped. Reconcile only its isolated abandoned
    // locks; retain both authorization journals and fake remote state.
    for (const filename of fs.readdirSync(f.root).filter(n => n.endsWith('.project-lock'))) fs.rmSync(path.join(f.root, filename), { recursive: true });
    const resumed = worker(publication ? 'publish' : 'release');
    assert.equal(resumed.status, 0, resumed.stderr);
    const saved = JSON.parse(fs.readFileSync(remote));
    assert.equal(saved.issues.length, 2);
    if (publication) {
      assert.equal(saved.writes.filter(k => k === 'create').length, 2);
      if (crash === 'blocker') assert.equal(saved.writes.filter(k => k === 'blocker').length, 2);
    }
    else {
      assert.equal(saved.writes.filter(k => k === 'label').length, 2);
      assert.equal(Object.keys(f.db().grants.g1.receipts).length, 2);
    }
  }
});
