const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { grantCommand } = require('../src/milestone-grants');
const { ticketCommand, ticketDigest, grantIntegrity } = require('../src/milestone-tickets');
const { checkMilestoneAdmission } = require('../src/milestone-admission');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = { repo: 'owner/demo', checkout: root, readyLabel: 'custom-ready', milestoneAuthorization: true };
  const issues = [200, 201, 202, 203].map(number => ({ number, title: `[DRAFT] Test ${number}`, body: `Exact synthetic task ${number}\n`, state: 'open', labels: [], html_url: `https://github.com/owner/demo/issues/${number}` }));
  const native = new Map(issues.map(i => [i.number, []]));
  let prompts = 0, failLabel = false;
  const writes = [], records = [];
  const options = { stateDir: root, configPath: path.join(root, 'config.json'), projectsPath: path.join(root, 'projects.json'), inputPath: path.join(root, 'input.json'), specPath: path.join(root, 'spec.md'),
    record: (type, value) => records.push({ type, value }), approve: async () => { prompts++; return true; } };
  fs.writeFileSync(options.configPath, JSON.stringify({ allowedProjects: { demo: root } }));
  fs.writeFileSync(options.projectsPath, JSON.stringify({ demo: project }));
  fs.writeFileSync(options.specPath, 'Approved exact synthetic scope');
  const proposal = { project: 'demo', repo: project.repo, spec: { identity: 'owner/demo#103@1', digest: crypto.createHash('sha256').update(fs.readFileSync(options.specPath)).digest('hex') }, objective: 'Synthetic tests', allowedCategories: ['tests'], exclusions: ['deployment'], revision: 1, ticketLimit: 3, concurrencyLimit: 2, expiresAt: new Date(Date.now() + 86400000).toISOString(),
    fixedManifest: { readyLabel: project.readyLabel, tickets: issues.slice(0, 3).map(i => ({ issue: i.number, title: i.title, body: i.body, category: 'tests', reason: 'Only approved synthetic tests', blockers: [] })) } };
  const file = path.join(root, 'milestone-grants.json');
  const db = () => JSON.parse(fs.readFileSync(file));
  options.execFile = (_, args, opts, cb) => {
    try {
      const endpoint = args.find(a => a.startsWith('repos/'));
      const number = Number(/issues\/(\d+)/.exec(endpoint)?.[1]);
      const issue = issues.find(i => i.number === number);
      if (endpoint.includes('/dependencies/blocked_by')) return cb(null, JSON.stringify([native.get(number).map(n => ({ number: n, html_url: `https://github.com/owner/demo/issues/${n}` }))]), '');
      if (args.includes('POST')) {
        assert.ok(db().grants.g1.receipts[`owner/demo#${number}`], 'receipt persisted before label');
        if (failLabel) return cb(new Error('synthetic label failure'), '', 'complete raw error');
        writes.push(number); issue.labels = [{ name: project.readyLabel }];
        return cb(null, JSON.stringify(issue.labels), '');
      }
      cb(null, JSON.stringify(issue), '');
    } catch (error) { cb(error, '', ''); }
  };
  const draft = async () => { fs.writeFileSync(options.inputPath, JSON.stringify(proposal)); return grantCommand('draft', 'g1', options); };
  const g = await draft();
  const run = (number, extra = {}) => {
    const grant = db().grants.g1, issue = issues.find(i => i.number === number);
    const request = { repo: project.repo, issue: number, grantDigest: grant.digest, revision: grant.revision, spec: { identity: grant.spec.identity, digest: grant.spec.digest }, ticketDigest: ticketDigest(issue), category: 'tests', scope: 'in-scope', reason: 'Only approved synthetic tests' };
    return ticketCommand('release', 'g1', { ...options, request, ...extra });
  };
  return { root, options, project, issues, native, proposal, g, run, draft, db, file, writes, records, prompts: () => prompts, failLabel: value => { failLabel = value; } };
}

test('one grant approval authorizes only the fixed set, survives retry and gates admission', async t => {
  const f = await fixture(t);
  assert.equal(grantIntegrity(f.g), true);
  assert.equal((await f.run(200)).decision, 'DENY');
  await grantCommand('activate', 'g1', { ...f.options, digest: f.g.digest });
  assert.equal(f.prompts(), 1);
  assert.equal((await f.run(200)).released, true);
  f.failLabel(true);
  assert.equal((await f.run(201)).decision, 'WAIT');
  const receipt = f.db().grants.g1.receipts['owner/demo#201'];
  f.failLabel(false);
  // Reopen canonical state on each command, with prompting disabled after activation.
  f.options.approve = async () => { throw new Error('Unexpected scope prompt'); };
  assert.equal((await f.run(201)).receipt.id, receipt.id);
  assert.equal((await f.run(202)).decision, 'WAIT', 'active quota still applies');
  f.issues[0].state = 'closed';
  assert.equal((await f.run(202)).released, true, 'approved third ticket can be released later');
  assert.equal(f.prompts(), 1);
  assert.deepEqual(f.writes, [200, 201, 202]);
  assert.deepEqual(f.db().grants.g1.ticketApprovals, {});
  await checkMilestoneAdmission('demo', f.project, 201, f.options);
  f.issues[3].labels = [{ name: f.project.readyLabel }];
  assert.notEqual((await f.run(203)).decision, 'ALLOW');
  await assert.rejects(checkMilestoneAdmission('demo', f.project, 203, f.options), /exact ticket receipt/);
  f.native.set(201, [199]);
  await assert.rejects(checkMilestoneAdmission('demo', f.project, 201, f.options), /blocker set changed/);
  f.native.set(201, []);
  f.issues[1].body += ' changed';
  await assert.rejects(checkMilestoneAdmission('demo', f.project, 201, f.options), /content/);
  assert.ok(f.db().grants.g1.events.some(e => e.type === 'activated' && e.digest === f.g.digest));
  assert.equal(f.db().grants.g1.fixedManifest.tickets[1].body, f.proposal.fixedManifest.tickets[1].body);
});

test('fixed manifest cannot be expanded by exact-ticket scope approval or edited grant bytes', async t => {
  const f = await fixture(t);
  await grantCommand('activate', 'g1', { ...f.options, digest: f.g.digest });
  for (const patch of [{ reason: 'Different scope' }, { scope: 'ambiguous' }, { category: 'deployment' }]) {
    const g = f.g, i = f.issues[0];
    const request = { repo: g.repo, issue: i.number, grantDigest: g.digest, revision: g.revision, spec: { identity: g.spec.identity, digest: g.spec.digest }, ticketDigest: ticketDigest(i), category: 'tests', scope: 'in-scope', reason: 'Only approved synthetic tests', ...patch };
    const preview = await ticketCommand('preview', 'g1', { ...f.options, request });
    assert.notEqual((await ticketCommand('approve', 'g1', { ...f.options, request, digest: preview.digest })).decision, 'ALLOW');
  }
  assert.equal(f.prompts(), 1);
  f.issues[3].labels = [];
  assert.equal((await f.run(203)).decision, 'DENY');
  const db = f.db(); db.grants.g1.fixedManifest.tickets.push({ ...f.proposal.fixedManifest.tickets[0], issue: 203 });
  fs.writeFileSync(f.file, JSON.stringify(db));
  assert.equal((await f.run(200)).decision, 'DENY');
  assert.equal(f.writes.length, 0);
});

test('pause, revoke, expiry and revision edits invalidate fixed receipts at admission and release', async t => {
  for (const patch of [{ state: 'paused' }, { state: 'revoked' }, { expiresAt: '2000-01-01T00:00:00.000Z' }, { revision: 2 }]) {
    const f = await fixture(t);
    await grantCommand('activate', 'g1', { ...f.options, digest: f.g.digest });
    await f.run(200);
    const db = f.db(); Object.assign(db.grants.g1, patch); fs.writeFileSync(f.file, JSON.stringify(db));
    assert.equal((await f.run(200)).decision, 'DENY');
    await assert.rejects(checkMilestoneAdmission('demo', f.project, 200, f.options), /Milestone authorization blocked/);
    assert.equal(f.writes.length, 1);
  }
});

test('manifest validation rejects duplicates, wrong labels and dependency mismatch before drafting', async t => {
  for (const change of [m => m.tickets.push(m.tickets[0]), m => { m.readyLabel = 'other'; }, m => { m.tickets[0].blockers = [10]; }]) {
    const f = await fixture(t);
    change(f.proposal.fixedManifest);
    await assert.rejects(f.draft(), /manifest|dependency/);
    assert.equal(f.prompts(), 0);
  }
});

test('owner-approved manifest amendment invalidates old receipts and retains their evidence', async t => {
  const f = await fixture(t);
  await grantCommand('activate', 'g1', { ...f.options, digest: f.g.digest });
  const old = (await f.run(200)).receipt;
  f.proposal.revision = 2;
  f.proposal.objective = 'Revised owner-approved synthetic tests';
  fs.writeFileSync(f.options.inputPath, JSON.stringify(f.proposal));
  const preview = await grantCommand('amend', 'g1', f.options);
  await grantCommand('amend', 'g1', { ...f.options, digest: preview.digest });
  assert.equal(f.prompts(), 2, 'amendment requires its own owner decision');
  await assert.rejects(checkMilestoneAdmission('demo', f.project, 200, f.options), /Invalid exact ticket receipt/);
  f.options.approve = async () => { throw new Error('Unexpected ticket prompt'); };
  const next = await f.run(200);
  assert.equal(next.released, true);
  assert.notEqual(next.receipt.id, old.id);
  assert.equal(next.receipt.revision, 2);
  assert.deepEqual(f.db().grants.g1.receiptHistory, [old]);
  assert.equal(f.db().grants.g1.history[0].fixedManifest.tickets.length, 3);
  await checkMilestoneAdmission('demo', f.project, 200, f.options);
});
