'use strict';

// Explicit planning-conversation commands only. No queue or scheduler callbacks.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { locked } = require('./project-registration');
const { save, registration } = require('./milestone-grants');
const { ticketCommand, ticketDigest, grantIntegrity } = require('./milestone-tickets');
const { previewDraft, publishDraft } = require('./planning-drafts');
const { nativeBlockers } = require('./milestone-blockers');
const { runGh } = require('./autopilot-github');
const { execFile, withExecution } = require('./execution-log');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function input(options) {
  const value = read(options.inputPath);
  if (!value || Object.keys(value).sort().join() !== 'conversation,id,tickets'
    || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value.id || '')
    || typeof value.conversation !== 'string' || !value.conversation.trim()
    || !Array.isArray(value.tickets) || !value.tickets.length || value.tickets.length > 100) throw new Error('Require batch id, explicit planning conversation and 1..100 tickets.');
  const ids = new Set();
  for (const item of value.tickets) {
    if (!item || Object.keys(item).sort().join() !== 'category,draft,reason,scope'
      || !/^[a-z][a-z0-9-]{0,63}$/.test(item.category || '')
      || !['in-scope', 'ambiguous', 'excluded'].includes(item.scope)
      || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 4000) throw new Error('Invalid batch ticket assessment.');
    previewDraft(item.draft);
    if (item.draft.kind !== 'ticket' || item.draft.conversation !== value.conversation || ids.has(item.draft.id)) throw new Error('Require distinct ticket identities from the explicit batch conversation.');
    ids.add(item.draft.id);
  }
  return value;
}

async function batchCommand(action, grantId, options) {
  if (!['preview', 'publish', 'approve', 'release'].includes(action)) throw new Error('Expected batch preview, publish, approve or release.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(grantId || '')) throw new Error('Invalid grant ID.');
  const batch = input(options);
  const state = fs.realpathSync(options.stateDir || process.env.AGENTLOOP_STATE_DIR || path.join(__dirname, '../state'));
  const file = path.join(state, 'milestone-batches.json');
  const grantFile = path.join(state, 'milestone-grants.json');
  if ([options.configPath, options.projectsPath, grantFile].map(p => path.resolve(p)).includes(file)) throw new Error('Batch journal and configuration paths must differ.');
  // Serializes creation across all batches and reserves creation intent before
  // the first POST. Ticket/grant mutations additionally take their shared locks.
  return locked([file], async () => {
    let raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const db = raw === null ? { version: 1, batches: {} } : JSON.parse(raw);
    if (db.version !== 1 || !db.batches || typeof db.batches !== 'object' || Array.isArray(db.batches)) throw new Error('Invalid durable batch journal.');
    const grant = read(grantFile).grants?.[grantId];
    const grantDigest = grant?.digest || null;
    const digest = hash({ grantId, grantDigest, batch });
    let job = Object.hasOwn(db.batches, batch.id) ? db.batches[batch.id] : null;
    if (job && (job.digest !== digest || hash({ grantId: job.grantId, grantDigest: job.grantDigest, batch: job.batch }) !== digest)) throw new Error('Batch identity already binds different immutable input or grant revision; preserve it and use a new batch ID for reassessment.');
    job ||= { digest, grantId, grantDigest, batch, tickets: {}, events: [] };
    if (!job.tickets || typeof job.tickets !== 'object' || Array.isArray(job.tickets) || !Array.isArray(job.events)) throw new Error('Invalid batch checkpoints; preserve and reconcile the journal.');
    const commit = (type, details) => {
      if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null) !== raw) throw new Error('Batch journal changed outside the lock.');
      job.events.push({ type, at: new Date().toISOString(), ...details });
      db.batches[batch.id] = job;
      save(file, db, options); raw = fs.readFileSync(file, 'utf8');
      options.record?.('batch_event', job.events.at(-1));
    };
    const checkCurrentGrant = () => {
      const current = read(grantFile).grants?.[grantId];
      if (!current || current.digest !== grantDigest || current.state !== 'active' || !grantIntegrity(current)
        || !Number.isFinite(Date.parse(current.expiresAt))
        || Date.parse(current.expiresAt) <= require('./milestone-clock').currentTime(state)) throw new Error('Canonical grant changed or expired; owner review required.');
      if (JSON.stringify(registration(current.project, current.repo, options)) !== JSON.stringify(current.registration)) throw new Error('Registered grant identity changed.');
    };
    const gh = args => withExecution(options.recordExecution || options.record || (() => {}),
      async () => { if (args.includes('POST')) checkCurrentGrant();
        return JSON.parse(await runGh(args, options.execFile || execFile, 'Milestone batch')); });
    const publish = (draft, retry) => withExecution(options.recordExecution || options.record || (() => {}),
      () => publishDraft(draft, { execFile: options.execFile || execFile, retry, beforeWrite: checkCurrentGrant }));
    let invalid;
    try {
      if (!grant || !grantIntegrity(grant) || grant.state !== 'active' || Date.parse(grant.expiresAt) <= require('./milestone-clock').currentTime(state)
        || !Number.isFinite(Date.parse(grant.expiresAt)) || !grant.activatedAt
        || !grant.events?.some(e => e.type === 'activated' && e.digest === grant.digest && e.revision === grant.revision)) throw new Error('Require an active owner-approved grant.');
      if (JSON.stringify(registration(grant.project, grant.repo, options)) !== JSON.stringify(grant.registration)) throw new Error('Registered grant identity changed.');
    } catch (e) { invalid = e.message; }
    const results = [];
    for (const item of batch.tickets) {
      const preview = previewDraft(item.draft);
      const base = { identity: `${item.draft.repo}:${item.draft.id}`, draft: preview, dependencies: item.draft.blockers, released: false };
      if (invalid || item.draft.repo !== grant.repo) {
        results.push({ ...base, decision: 'DENY', reasons: [invalid || 'Cross-repository ticket requires owner review.'] }); continue;
      }
      const specNumber = /#([1-9]\d*)(?:@|$)/.exec(grant.spec.identity)?.[1];
      if (!specNumber || ![`#${specNumber}`, `https://github.com/${grant.repo}/issues/${specNumber}`].includes(item.draft.sourceSpec)) {
        results.push({ ...base, decision: 'NEEDS_APPROVAL', reasons: ['Unknown or cross-repository source specification; owner review required.'] }); continue;
      }
      let entry = Object.hasOwn(job.tickets, item.draft.id) ? job.tickets[item.draft.id] : null;
      let issue;
      try {
        if (action === 'publish' && !entry?.number) {
          const retry = !!entry?.creationAttempted;
          entry ||= {};
          job.tickets[item.draft.id] = entry;
          entry.creationAttempted = true;
          commit('creation_intent', { identity: base.identity, retry });
          const published = await publish(item.draft, retry);
          entry.number = published.number;
          commit('created', { identity: base.identity, number: entry.number });
        }
        if (!entry?.number) {
          // Read-only reconciliation also makes preview useful for drafts
          // published by the existing planning helper.
          const found = await publish(item.draft, true);
          entry = { creationAttempted: true, number: found.number };
          if (action !== 'preview') { job.tickets[item.draft.id] = entry; commit('reconciled', { identity: base.identity, number: entry.number }); }
        }
        issue = await gh(['api', `repos/${grant.repo}/issues/${entry.number}`]);
        if (!issue || issue.number !== entry.number || issue.html_url !== `https://github.com/${grant.repo}/issues/${entry.number}`
          || issue.pull_request || issue.state !== 'open' || issue.title !== preview.title || issue.body !== preview.body) throw new Error('Ticket identity or title/body changed; owner reassessment required.');
        let actual = await nativeBlockers(grant.repo, entry.number, gh);
        const expected = [...item.draft.blockers].sort((a, b) => a - b);
        if (actual.some(n => !expected.includes(n))) throw new Error('Conflicting native blockers; owner review required.');
        if (action === 'publish') {
          if (entry.pendingBlocker) {
            if (!actual.includes(entry.pendingBlocker)) throw new Error('Unconfirmed native blocker write; owner reconciliation required.');
            delete entry.pendingBlocker; commit('blocker_reconciled', { number: entry.number });
          }
          for (const number of expected.filter(n => !actual.includes(n))) {
            const blocker = await gh(['api', `repos/${grant.repo}/issues/${number}`]);
            if (!blocker || blocker.number !== number || blocker.html_url !== `https://github.com/${grant.repo}/issues/${number}` || !Number.isSafeInteger(blocker.id) || blocker.pull_request) throw new Error('Unknown blocker identity; owner review required.');
            entry.pendingBlocker = number; commit('blocker_intent', { number: entry.number, blocker: number });
            await gh(['api', '--method', 'POST', `repos/${grant.repo}/issues/${entry.number}/dependencies/blocked_by`, '-F', `issue_id=${blocker.id}`]);
            actual = await nativeBlockers(grant.repo, entry.number, gh);
            if (!actual.includes(number)) throw new Error('Native blocker write unconfirmed.');
            delete entry.pendingBlocker; commit('blocker_confirmed', { number: entry.number, blocker: number });
          }
        }
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Native/body blockers differ; publish metadata before release.');
        const request = { repo: grant.repo, issue: entry.number, grantDigest: grant.digest, revision: grant.revision,
          spec: { identity: grant.spec.identity, digest: grant.spec.digest }, ticketDigest: ticketDigest(issue),
          category: item.category, scope: item.scope, reason: item.reason };
        const command = action === 'release' ? 'release' : 'preview';
        let result = await ticketCommand(command, grantId, { ...options, request, nativeBlockers: true, checkDependencies: true });
        if (action === 'approve') {
          // The caller must explicitly approve the immutable complete batch,
          // then confirm each exact scope using the existing owner-only flow.
          if (options.digest !== digest) result = { ...result, decision: 'NEEDS_APPROVAL', reasons: ['Batch approval requires its inspected digest.'] };
          else result = await ticketCommand('approve', grantId, { ...options, request, digest: result.digest, nativeBlockers: true, checkDependencies: true });
        }
        results.push({ ...base, ...result, dependencies: item.draft.blockers, identity: base.identity });
      } catch (e) {
        const result = { ...base, issue, decision: /changed|owner review|reassessment/.test(e.message) ? 'NEEDS_APPROVAL' : 'WAIT', reasons: [e.message] };
        results.push(result);
        // Retain failure evidence before continuing with another ticket. If
        // that durable checkpoint fails too, stop the batch immediately.
        if (action !== 'preview') commit('held', result);
      }
    }
    const current = read(grantFile).grants?.[grantId];
    const usage = { issued: Object.keys(current?.receipts || {}).length, ticketLimit: current?.ticketLimit, activeLimit: current?.concurrencyLimit };
    // Preview projects reservations in input order without consuming quota.
    let projected = usage.issued, active = 0;
    if (action === 'preview' && current) {
      for (const receipt of Object.values(current.receipts || {})) {
        const issue = await gh(['api', `repos/${current.repo}/issues/${receipt.request.issue}`]);
        if (!issue || issue.number !== receipt.request.issue || issue.html_url !== `https://github.com/${current.repo}/issues/${receipt.request.issue}` || !['open', 'closed'].includes(issue.state)) throw new Error('Cannot establish active quota preview.');
        if (issue.state === 'open') active++;
      }
      usage.active = active;
      for (const result of results) {
        if (result.decision !== 'ALLOW' || result.receipt) continue;
        if (projected >= current.ticketLimit) { result.decision = 'DENY'; result.reasons = ['Projected issued ticket quota exhausted.']; }
        else if (active >= current.concurrencyLimit) { result.decision = 'WAIT'; result.reasons = ['Projected active ticket quota exhausted.']; }
        else { projected++; active++; }
      }
    }
    const out = { id: batch.id, digest, grantId, grant, conversation: batch.conversation, usage, tickets: results };
    if (action !== 'preview') commit('batch_result', out);
    options.record?.('batch_preview', out);
    return out;
  });
}
module.exports = { batchCommand };
