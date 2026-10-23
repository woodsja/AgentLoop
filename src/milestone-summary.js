// Owner inspection only: no locks, writes, GitHub calls, or scheduler callbacks.
const fs = require('node:fs');
const path = require('node:path');
const { resolveStateDir } = require('./autopilot-state');
const { grantIntegrity } = require('./milestone-tickets');
const { dependencies, eligibleIssues } = require('./r1-dependencies');
const household = require('./household-dependencies');

function milestoneSummary(id, options = {}) {
  const root = path.resolve(options.stateDir || process.env.AGENTLOOP_STATE_DIR || path.join(__dirname, '../state'));
  const evidence = [], errors = [];
  function capture(file, optional = false) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      evidence.push({ file, raw });
      return raw;
    } catch (error) {
      if (!(optional && error.code === 'ENOENT')) errors.push({ file, message: error.message });
      return null;
    }
  }
  function json(file, optional = false) {
    const raw = capture(file, optional);
    if (raw === null) return null;
    try { return JSON.parse(raw); }
    catch (error) { errors.push({ file, message: error.message }); return null; }
  }
  function entries(dir) {
    try { return fs.readdirSync(dir).sort(); }
    catch (error) { if (error.code !== 'ENOENT') errors.push({ file: dir, message: error.message }); return []; }
  }
  const db = json(path.join(root, 'milestone-grants.json'));
  if (db?.version !== 1 || !Object.hasOwn(db.grants || {}, id)) throw new Error('Unknown grant or invalid grant store; preserve and reconcile the store.');
  const grant = db.grants[id];
  const projects = json(options.projectsPath || process.env.AGENTLOOP_PROJECTS_PATH || path.join(__dirname, '../autopilot-projects.json'));
  const project = projects?.[grant.project];
  const jobs = [];
  if (project) {
    const dir = resolveStateDir(grant.project, project, root);
    for (const file of entries(dir).filter(name => /^issue-[1-9]\d*\.json$/.test(name))) {
      const job = json(path.join(dir, file));
      if (job?.repo === grant.repo && job.project === grant.project) jobs.push(job);
    }
    for (const file of entries(dir).filter(name => /^issue-[1-9]\d*\.execution\.ndjson$/.test(name))) capture(path.join(dir, file));
  } else errors.push({ message: 'Project registration missing; restore the owner registration before execution.' });
  // Queue records and their complete journals survive a new operator conversation.
  const queueTasks = [];
  for (const stage of ['pending', 'running', 'done']) {
    for (const file of entries(path.join(root, 'tasks', stage)).filter(name => name.endsWith('.json'))) {
      const task = json(path.join(root, 'tasks', stage, file));
      if (task?.project === grant.project) {
        queueTasks.push({ stage, task });
        capture(path.join(root, 'results', task.id + '.json'), true);
        const runId = require('node:crypto').createHash('sha256').update(task.id).digest('hex');
        capture(path.join(root, 'task-runs', runId + '.json'), true);
        for (const suffix of ['.execution.ndjson', '.ndjson']) capture(path.join(root, 'logs', task.id + suffix), true);
      }
    }
  }
  // Includes operator command output/errors, even when no receipt was issued.
  for (const file of entries(path.join(root, 'logs')).filter(name => name.startsWith('onboarding-') && name.endsWith('.ndjson'))) capture(path.join(root, 'logs', file));
  capture(path.join(root, 'events.ndjson'), true);
  const batches = json(path.join(root, 'milestone-batches.json'), true);
  const admissionRaw = capture(path.join(root, 'milestone-admission.ndjson'), true);
  const admissions = [];
  for (const line of (admissionRaw || '').split('\n').filter(Boolean)) {
    try { const event = JSON.parse(line); if (event.project === grant.project) admissions.push(event); }
    catch (error) { errors.push({ message: `Malformed admission event: ${error.message}` }); }
  }
  const clockRaw = capture(path.join(root, 'milestone-clock.ndjson'), true);
  let now = Date.now();
  for (const line of (clockRaw || '').split('\n').filter(Boolean)) {
    if (!/^\d+$/.test(line) || !Number.isSafeInteger(Number(line))) errors.push({ message: 'Invalid durable authorization clock; reconcile before execution.' });
    else now = Math.max(now, Number(line));
  }
  const expired = Date.parse(grant.expiresAt) <= now;
  const state = expired && ['active', 'draft', 'paused'].includes(grant.state) ? 'expired' : grant.state;
  const receipts = Object.values(grant.receipts || {});
  const events = grant.ticketEvents || [];
  const numbers = new Set([...receipts.map(r => r.request.issue), ...events.map(e => e.request?.issue), ...admissions.map(e => e.issue)].filter(Number.isSafeInteger));
  const tickets = [...numbers].sort((a, b) => a - b).map(number => {
    const receipt = receipts.find(r => r.request.issue === number);
    const event = events.filter(e => e.request?.issue === number).at(-1);
    const admission = admissions.filter(e => e.issue === number).at(-1);
    const job = jobs.find(j => j.issue?.number === number);
    const queued = queueTasks.find(q => q.stage !== 'done' && q.task.issue === number);
    const reasons = [];
    if (state !== 'active') reasons.push(`Grant is ${state}; inspect lifecycle evidence and obtain the appropriate owner action.`);
    if (!grantIntegrity(grant)) reasons.push('Grant integrity failed; reconcile approved terms and specification.');
    if (!receipt) reasons.push('No receipt; publish and obtain exact owner scope approval before release.');
    else if (receipt.revision !== grant.revision || receipt.grantDigest !== grant.digest) reasons.push('Stale receipt; obtain exact owner re-evaluation for the current revision.');
    let prerequisites = [];
    const issue = receipt?.issue || event?.issue;
    if (issue) {
      try {
        prerequisites = (project?.dependencyFormat === 'household-blocked-by' ? household.prerequisites : dependencies)(issue);
        const eligible = project?.dependencyFormat === 'household-blocked-by' ? household.eligible : eligibleIssues;
        eligible([issue], jobs, grant.project, grant.repo, (_, message) => reasons.push(message));
      } catch (error) { reasons.push(`Repair prerequisite metadata: ${error.message}`); }
    }
    if (errors.length) reasons.push('Local evidence is incomplete; inspect errors and restore the durable records before execution.');
    const queueHold = queued?.task.authorizationBlocked || queued?.task.r1?.authorizationBlocked;
    if (queueHold) reasons.push(queueHold.message);
    if (job?.authorizationBlocked) reasons.push(job.authorizationBlocked.message);
    if (job?.terminal && job.terminalState !== 'merged') reasons.push(`Job stopped in ${job.terminalState || job.status}; inspect retained failures and resolve the delivery hold.`);
    if (event?.decision === 'DENY' || (!receipt && event?.decision && event.decision !== 'ALLOW')) reasons.push(...(event.reasons || []));
    const unapprovedDraft = !receipt && !job && !queued && event?.decision === 'NEEDS_APPROVAL';
    const status = job?.terminalState === 'merged' ? 'merged' : unapprovedDraft && state === 'active' && !errors.length ? 'draft' : reasons.length ? (state !== 'active' || event?.decision === 'DENY' || (!receipt && admission?.decision === 'DENY') ? 'denied' : 'waiting') : (job && !job.terminal) || queued ? 'running' : receipt ? 'authorized' : 'draft';
    return { issue: number, status, ticketDigest: receipt?.request.ticketDigest || event?.request?.ticketDigest,
      receiptId: receipt?.id || null, prerequisites, jobStatus: job?.status || null, reasons, lastDecision: event || null, lastAdmission: admission || null };
  });
  const retainedBatches = Object.values(batches?.batches || {}).filter(b => b.grantId === id);
  return { inspectedAt: new Date().toISOString(), authority: 'Recorded local evidence only; current GitHub bytes, labels and native blockers must be rechecked at admission and merge.',
    grant, effectiveState: state, scope: { objective: grant.objective, allowedCategories: grant.allowedCategories, exclusions: grant.exclusions, expiresAt: grant.expiresAt },
    enforcement: { optedIn: project?.milestoneAuthorization === true, scheduler: project?.dependencyFormat === 'household-blocked-by' ? 'standalone Household autopilot (R1 yields)' : 'existing R1/operator admission' },
    quotas: { activeJobs: jobs.filter(j => !j.terminal).length, ticketLimit: grant.ticketLimit, concurrencyLimit: grant.concurrencyLimit, issued: receipts.length, remaining: Math.max(0, grant.ticketLimit - receipts.length) },
    authorizedTickets: receipts.map(r => ({ issue: r.request.issue, ticketDigest: r.request.ticketDigest, receiptId: r.id, revision: r.revision })),
    plannedTickets: retainedBatches.flatMap(b => b.batch.tickets.map(t => ({ draft: t.draft, issue: b.tickets[t.draft.id]?.number || null, status: tickets.find(ticket => ticket.issue === b.tickets[t.draft.id]?.number)?.status || 'draft' }))),
    queueTasks, tickets, activeJobs: jobs.filter(j => !j.terminal), jobs,
    batches: retainedBatches, admissions, errors,
    evidence, consistency: 'Files are read independently while writers may run; repeat inspection if evidence changes. This report grants no execution authority.' };
}
module.exports = { milestoneSummary };
