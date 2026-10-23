// Commands are explicit operator/planner operations. Pure integrity helpers are also used by admission.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { locked } = require('./project-registration');
const { registration, save } = require('./milestone-grants');
const { runGh } = require('./autopilot-github');
const { execFile, withExecution } = require('./execution-log');
const { dependencies } = require('./r1-dependencies');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const ticketDigest = issue => hash(JSON.stringify([issue.title, issue.body]));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function requestInput(options) {
  const r = options.request || read(options.inputPath);
  const fields = ['repo', 'issue', 'grantDigest', 'revision', 'spec', 'ticketDigest', 'category', 'scope', 'reason'];
  if (!r || Object.keys(r).sort().join() !== fields.sort().join()
    || typeof r.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.repo)
    || !Number.isSafeInteger(r.issue) || r.issue < 1 || !Number.isSafeInteger(r.revision) || r.revision < 1
    || !hex(r.grantDigest) || !hex(r.ticketDigest) || !r.spec || Object.keys(r.spec).sort().join() !== 'digest,identity'
    || !hex(r.spec.digest) || typeof r.spec.identity !== 'string'
    || typeof r.category !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(r.category)
    || !['in-scope', 'ambiguous', 'excluded'].includes(r.scope)
    || typeof r.reason !== 'string' || !r.reason.trim() || r.reason.length > 4000) throw new Error('Invalid exact-ticket request; use the documented fields.');
  // Stable request digest, independent of caller key order.
  return { repo: r.repo, issue: r.issue, grantDigest: r.grantDigest, revision: r.revision,
    spec: { identity: r.spec.identity, digest: r.spec.digest }, ticketDigest: r.ticketDigest,
    category: r.category, scope: r.scope, reason: r.reason };
}
function validIssue(issue, request, readyLabel, receipt) {
  if (!issue || issue.number !== request.issue || issue.pull_request || issue.state !== 'open'
    || issue.html_url !== `https://github.com/${request.repo}/issues/${request.issue}`
    || typeof issue.title !== 'string' || !issue.title.startsWith('[DRAFT] ') || typeof issue.body !== 'string' || !issue.body.trim()
    || !Array.isArray(issue.labels) || issue.labels.some(l => !l || typeof l.name !== 'string')
    || (issue.labels.length && (!receipt || issue.labels.length !== 1 || issue.labels[0].name !== readyLabel))) throw new Error('Require the exact open draft with no labels (or its receipted ready label on retry).');
  if (ticketDigest(issue) !== request.ticketDigest) throw new Error('Issue title/body digest changed.');
  return dependencies(issue);
}
function grantIntegrity(g) {
  const keys = ['project', 'repo', 'spec', 'objective', 'allowedCategories', 'exclusions', 'revision', 'ticketLimit', 'expiresAt', 'concurrencyLimit', 'registration'];
  const terms = Object.fromEntries(keys.map(k => [k, g[k]]));
  return hash(JSON.stringify(terms)) === g.digest
    && hash(Buffer.from(g.spec.contentBase64, 'base64')) === g.spec.digest;
}
async function ticketCommand(action, id, options) {
  if (!['preview', 'approve', 'release'].includes(action)) throw new Error('Expected ticket preview, approve or release.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id || '')) throw new Error('Invalid grant ID.');
  const request = requestInput(options);
  const state = fs.realpathSync(path.resolve(options.stateDir || process.env.AGENTLOOP_STATE_DIR || path.join(__dirname, '../state')));
  const file = path.join(state, 'milestone-grants.json');
  const files = [fs.realpathSync(options.configPath), fs.realpathSync(options.projectsPath), file];
  if (new Set(files).size !== 3) throw new Error('State and configuration paths must be distinct.');
  return locked(files, async () => {
    let expected = fs.readFileSync(file, 'utf8');
    const db = JSON.parse(expected);
    if (db.version !== 1 || !db.grants || Array.isArray(db.grants)) throw new Error('Invalid grant store.');
    const g = Object.hasOwn(db.grants, id) ? db.grants[id] : null;
    const project = g ? read(options.projectsPath)[g.project] : null, label = project?.readyLabel;
    const digest = hash(JSON.stringify({ grant: id, ...request, readyLabel: label }));
    let issue = null, blockers = [], receipt = null;
    const result = (decision, ...reasons) => ({ decision, reasons, digest, request, readyLabel: label, grant: g, issue, blockers, receipt, released: false });
    const record = (type, value) => options.record?.(type, value);
    if (!g) { const out = result('DENY', 'Unknown grant.'); record('preview', out); return out; }
    for (const key of ['ticketApprovals', 'receipts']) {
      if (g[key] !== undefined && (!g[key] || typeof g[key] !== 'object' || Array.isArray(g[key]))) throw new Error(`Invalid ${key} store; preserve and reconcile it.`);
      g[key] ||= {};
    }
    if (g.ticketEvents !== undefined && !Array.isArray(g.ticketEvents)) throw new Error('Invalid ticket decision log.');
    g.ticketEvents ||= [];
    const commit = () => {
      if (fs.readFileSync(file, 'utf8') !== expected) throw new Error('Grant store changed outside the shared lock; reconcile before retry.');
      save(file, db, options); expected = fs.readFileSync(file, 'utf8');
    };
    const event = (type, out) => g.ticketEvents.push({ type, at: new Date().toISOString(), actor: os.userInfo().username, ...out });
    // Avoid recursively embedding the event log in itself; retain exact issue and request evidence.
    const evidence = out => ({ decision: out.decision, reasons: out.reasons, digest, request, issue, blockers, readyLabel: label,
      grantId: id, grantDigest: g.digest, revision: g.revision, receiptId: receipt?.id || null, released: out.released });
    const finish = out => { event('decision', evidence(out)); commit(); record('ticket_decision', out); return out; };
    const checkGrant = () => {
      if (fs.readFileSync(file, 'utf8') !== expected) return 'Grant store changed during authorization; reconcile before retry.';
      if (read(options.projectsPath)[g.project]?.readyLabel !== label) return 'Configured ready label changed during authorization.';
      if (g.state !== 'active' || !g.activatedAt || !g.events?.some(e => e.type === 'activated' && e.digest === g.digest && e.revision === g.revision)) return 'Grant is not owner-approved and active.';
      if (!Number.isFinite(Date.parse(g.expiresAt)) || Date.parse(g.expiresAt) <= Date.now()) return 'Grant expired.';
      if (!grantIntegrity(g)) return 'Grant terms or approved specification bytes changed.';
      if (request.repo !== g.repo || request.grantDigest !== g.digest || request.revision !== g.revision
        || request.spec.identity !== g.spec.identity || request.spec.digest !== g.spec.digest) return 'Repository, grant revision/digest or approved specification mismatch.';
      if (JSON.stringify(registration(g.project, request.repo, options)) !== JSON.stringify(g.registration)) return 'Registered identity changed.';
      return null;
    };
    let rejection;
    try { rejection = checkGrant(); } catch (e) { rejection = e.message; }
    if (rejection) { const out = result('DENY', rejection); record('preview', out); return finish(out); }
    const key = `${request.repo}#${request.issue}`;
    if (Object.entries(db.grants).some(([otherId, other]) => otherId !== id && Object.hasOwn(other.receipts || {}, key))) {
      return finish(result('NEEDS_APPROVAL', 'Another grant already retains a receipt for this issue; owner reconciliation required.'));
    }
    receipt = Object.hasOwn(g.receipts, key) ? g.receipts[key] : null;
    if (receipt && (receipt.digest !== digest || receipt.grantId !== id || receipt.grantDigest !== g.digest || receipt.revision !== g.revision
      || JSON.stringify(receipt.request) !== JSON.stringify(request) || !receipt.issue
      || receipt.issue.number !== request.issue || ticketDigest(receipt.issue) !== request.ticketDigest)) {
      const out = result('DENY', 'Existing receipt binds different immutable ticket or grant terms.'); record('preview', out); return finish(out);
    }

    const gh = args => withExecution(options.recordExecution || options.record || (() => {}),
      async () => JSON.parse(await runGh(args, options.execFile || execFile, 'Milestone ticket authorization')));
    const native = options.nativeBlockers === true || Array.isArray(receipt?.issue?.nativeBlockers);
    if (options.nativeBlockers === true && receipt && !Array.isArray(receipt.issue.nativeBlockers)) {
      return finish(result('NEEDS_APPROVAL', 'Existing receipt does not bind native blockers; retain it for owner reconciliation.'));
    }
    const checkIssue = async () => {
      issue = await gh(['api', endpoint]); blockers = validIssue(issue, request, label, receipt);
      if (native) {
        const actual = await require('./milestone-blockers').nativeBlockers(request.repo, issue.number, gh);
        if (JSON.stringify(actual) !== JSON.stringify([...blockers].sort((a, b) => a - b))) throw new Error('Native blockers conflict with exact Depends on metadata; owner review required.');
        if (receipt && JSON.stringify(receipt.issue.nativeBlockers) !== JSON.stringify(actual)) throw new Error('Receipted native blocker evidence changed; owner review required.');
      }
    };
    const endpoint = `repos/${request.repo}/issues/${request.issue}`;
    try {
      if (typeof label !== 'string' || !label.trim() || /[\x00-\x1f\x7f]/.test(label)) throw new Error('Missing configured ready label.');
      await checkIssue();
    } catch (e) { const out = result('WAIT', e.message); record('preview', out); return finish(out); }
    const approval = g.ticketApprovals[digest];
    const scopeApproved = approval?.digest === digest && JSON.stringify(approval.request) === JSON.stringify(request)
      && typeof approval.actor === 'string' && Number.isFinite(Date.parse(approval.at));
    let out;
    if (!g.allowedCategories.includes(request.category) || request.scope === 'excluded') out = result('DENY', 'Category is outside the grant or the proposal includes excluded work.');
    else if (!receipt && Object.keys(g.receipts).length >= g.ticketLimit) out = result('DENY', 'Grant ticket quota exhausted.');
    else if (request.scope === 'ambiguous') out = result('NEEDS_APPROVAL', 'Semantic scope is ambiguous. Resolve scope against the objective, specification and every exclusion with the owner; submit a new exact request.');
    else if (!scopeApproved) out = result('NEEDS_APPROVAL', 'Owner must confirm this exact ticket fits the approved objective/specification, category and all exclusions. A planner category or model verdict cannot authorize scope.');
    else out = result('ALLOW', 'Owner confirmed exact semantic scope within this active grant; immutable ticket and quota checks passed.');
    if (out.decision === 'ALLOW' && options.checkDependencies) {
      try {
        const { createJobStore, resolveStateDir } = require('./autopilot-state');
        const jobs = createJobStore(resolveStateDir(g.project, project, state)).list();
        let reason;
        if (!require('./r1-dependencies').eligibleIssues([issue], jobs, g.project, g.repo, (_, message) => { reason = message; }).length) out = result('WAIT', reason);
      } catch (e) { out = result('WAIT', e.message); }
    }
    if (out.decision === 'ALLOW' && !receipt) {
      try {
        let active = 0;
        for (const r of Object.values(g.receipts)) {
          const current = await gh(['api', `repos/${g.repo}/issues/${r.request.issue}`]);
          if (!current || current.number !== r.request.issue || current.html_url !== `https://github.com/${g.repo}/issues/${r.request.issue}` || !['open', 'closed'].includes(current.state)) throw new Error('Cannot establish active ticket quota.');
          if (current.state === 'open') active++;
        }
        if (active >= g.concurrencyLimit) out = result('WAIT', 'Grant active ticket quota exhausted.');
      } catch (e) { out = result('WAIT', e.message); }
    }
    record('preview', out);
    if (action === 'preview' || ['DENY', 'WAIT'].includes(out.decision) || request.scope === 'ambiguous') return finish(out);
    if (action === 'approve' && out.decision === 'NEEDS_APPROVAL') {
      if (options.digest !== digest) return finish(result('NEEDS_APPROVAL', 'Scope confirmation requires --digest matching this complete preview.'));
      event('scope_approval_requested', evidence(out)); commit();
      if (!await options.approve(`Confirm ticket ${key}, request ${digest}, is entirely within grant ${id}, its approved specification, category ${request.category}, and every exclusion?`) || options.isCancelled?.()) return finish(result('NEEDS_APPROVAL', 'Owner scope confirmation cancelled.'));
      try {
        const why = checkGrant(); if (why) throw new Error(why);
        await checkIssue();
      } catch (e) { return finish(result('WAIT', e.message)); }
      g.ticketApprovals[digest] = { digest, actor: os.userInfo().username, at: new Date().toISOString(), request };
      out = result('ALLOW', 'Owner confirmed this exact scope; release remains a separate command.');
      event('scope_approved', evidence(out)); return finish(out);
    }
    if (action !== 'release' || out.decision !== 'ALLOW') return finish(out);
    // Re-fetch immediately before persisting/releasing. GitHub has no conditional
    // label-write API; later admission must independently validate the receipt.
    try {
      const why = checkGrant(); if (why) throw new Error(why);
      await checkIssue();
    } catch (e) { return finish(result('WAIT', e.message)); }
    if (!receipt) {
      receipt = { id: crypto.randomUUID(), digest, grantId: id, grantDigest: g.digest, revision: g.revision, request, issue: { number: issue.number, title: issue.title, body: issue.body }, at: new Date().toISOString() };
      if (native) receipt.issue.nativeBlockers = [...blockers].sort((a, b) => a - b);
      g.receipts[key] = receipt;
      event('authorized', evidence(result('ALLOW', 'Durable exact-ticket receipt reserved one quota unit.')));
      commit(); // Durable quota reservation and receipt MUST precede the executable label.
    }
    try {
      const why = checkGrant(); if (why) throw new Error(why);
      if (!issue.labels.some(l => l.name === label)) {
        const labels = await gh(['api', '--method', 'POST', `${endpoint}/labels`, '-f', `labels[]=${label}`]);
        if (!Array.isArray(labels) || !labels.some(l => l?.name === label)) throw new Error('GitHub did not confirm the configured label; reconcile on retry.');
      }
      out = { ...result('ALLOW', 'Receipt persisted and configured readiness label confirmed.'), released: true };
      event('released', evidence(out)); return finish(out);
    } catch (e) { return finish(result('WAIT', `Receipt retained; label release unconfirmed: ${e.message}`)); }
  });
}
module.exports = { ticketCommand, ticketDigest, grantIntegrity };
