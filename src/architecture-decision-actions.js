'use strict';
// Owner CLI only, using the same local operator trust boundary as grant actions.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { runGh } = require('./autopilot-github');
const { createJobStore, resolveStateDir } = require('./autopilot-state');
const { ticketDigest } = require('./milestone-tickets');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function preview(job) {
  const d = job.architectureDecision;
  if (!d) throw new Error('No pending architecture decision.');
  return { identity: d.identity, proposal: d.proposal, references: d.references, issue: d.issue,
    job: job.r1ParentJobId || job.createdAt, source: d.sourceIssue, authorization: d.authorization,
    ownerDecision: d.ownerDecision, adr: d.adr, status: require('./architecture-decision-status').decisionStatus(job) };
}
function adrFor(job, input) {
  const d = job.architectureDecision, p = d.proposal;
  const directory = d.references.some(r => r.path.startsWith('docs/decisions/')) ? 'docs/decisions' : 'docs/adr';
  if (!new RegExp(`^${directory}/[a-zA-Z0-9][a-zA-Z0-9._-]*\\.md$`).test(input.adrPath || '')
    || d.references.some(r => r.path === input.adrPath)) throw new Error('ADR must use a new file in the established ADR directory.');
  if (!Array.isArray(input.supersedes) || input.supersedes.some(p => !d.references.some(r => r.path === p))
    || typeof input.conflictResolution !== 'string' || !input.conflictResolution.trim()) throw new Error('Explicit conflict resolution and supersession links required.');
  const selected = p.options.find(o => o.name === input.option);
  if (!selected) throw new Error('Select an exact proposed option.');
  return { path: input.adrPath, content: `# ADR: ${p.problem}\n\nStatus: Accepted by owner; authoritative only after guarded merge.\nDecision issue: ${d.issue.url}\nSupersedes: ${input.supersedes.map(p => `[${p}](../../${p})`).join(', ') || 'None'}\n\n## Context\n${p.problem}\n\n## Alternatives and trade-offs\n${p.options.map(o => `- ${o.name}: ${o.tradeoffs}`).join('\n')}\n\n## Decision\n${selected.name}\n${input.rationale}\n\n## Accepted trade-offs\n${selected.tradeoffs}\n\n## Consequences\n${p.consequences}\n\n## Existing ADR conflicts\n${p.conflicts}\nResolution: ${input.conflictResolution}\n\n## Authority\nNo new scope, credentials, host access or deployment authority.\n` };
}
// Populate a separate, unreleased ADR issue. Never add an executable label.
async function publishAdr(job, store, options) {
  const d = job.architectureDecision;
  if (!d.adr || d.adr.publication === 'complete') return;
  const gh = args => runGh(args, options.execFile, 'ADR proposal');
  try {
    const issue = JSON.parse(await gh(['api', `repos/${job.repo}/issues/${d.adr.issue}`]));
    if (issue.number !== d.adr.issue || issue.state !== 'open' || issue.pull_request
      || !Array.isArray(issue.labels) || issue.labels.length !== 0) throw new Error('ADR proposal requires a separate open, unreleased issue.');
    const marker = `${d.marker} ADR proposal`;
    const addition = `${marker}\nOwner-approved architecture choice; separate milestone authorization and release required.\nCreate only ${d.adr.path} with the exact following content; preserve earlier ADRs. Deliver through deterministic verification, independent Claude review, exact-head CI and guarded merge. No deployment.\n\n${d.adr.content}`;
    if (typeof issue.body !== 'string') throw new Error('ADR issue body missing.');
    if (issue.body.includes(marker) && !issue.body.endsWith(addition)) throw new Error('ADR proposal changed; owner reconciliation required.');
    if (!issue.body.includes(marker)) await gh(['api', '--method', 'PATCH', `repos/${job.repo}/issues/${d.adr.issue}`, '-f', `body=${issue.body}\n\n${addition}`]);
    d.adr.publication = 'complete'; delete d.adr.publicationError; store.save(job);
  } catch (error) { d.adr.publicationError = error.message; store.save(job); throw error; }
}
async function validateResumeChecks(project, job, store, options = {}) {
  const d = job.architectureDecision;
  if (!d?.ownerDecision || d.ownerDecision.action !== 'accept') throw new Error('Missing owner acceptance; rejection or revision remains paused.');
  if (!d.ownerDecision.actor || !d.ownerDecision.at || !d.ownerDecision.digest) throw new Error('Missing authenticated owner decision evidence.');
  if (d.ownerDecision.conflictsResolved !== true) throw new Error('Existing ADR conflicts remain unresolved; owner reconciliation required.');
  if (d.ownerDecision.requiresMilestoneAmendment !== false) throw new Error('Architectural choice requires a separate milestone amendment; no new scope, credentials, host access or deployment is authorized.');
  if (!d.authorization || project.milestoneAuthorization !== true) throw new Error('Original milestone grant evidence required; request a separate milestone amendment.');
  if (job.project !== d.project || job.repo !== d.repo || (job.r1ParentJobId || job.createdAt) !== d.originatingJob
    || job.issue.number !== d.originatingIssue) throw new Error('Original durable job identity changed.');
  const gh = args => runGh(args, options.execFile, 'Architecture resume');
  const issue = JSON.parse(await gh(['api', `repos/${job.repo}/issues/${job.issue.number}`]));
  if (issue.state !== 'open' || ticketDigest(issue) !== ticketDigest(d.sourceIssue)) throw new Error('Original issue content revision or state changed.');
  const authorization = await require('./milestone-admission').checkMilestoneAdmission(job.project, project, job.issue.number, {
    ...options, jobs: () => store.dependencyJobs ? store.dependencyJobs() : store.list(), expectedIssue: issue, expectedAuthorization: d.authorization,
  });
  if (!same(authorization, d.authorization)) throw new Error('Milestone grant changed; request a separate milestone amendment.');
  if (d.adr?.publication !== 'complete') throw new Error('ADR proposal publication is incomplete.');
  const adrJob = store.load(d.adr.issue);
  if (!require('./r1-dependencies').approved(adrJob, d.adr.issue, job.project, job.repo)) throw new Error('ADR awaits independent Claude PASS, exact-head green CI and guarded merge.');
  const pr = JSON.parse(await gh(['api', `repos/${job.repo}/pulls/${adrJob.merge.prNumber}`]));
  if (pr.merged !== true || pr.head?.sha !== adrJob.delivery.commit || pr.merge_commit_sha !== adrJob.merge.commit
    || pr.base?.repo?.full_name !== job.repo || pr.base?.ref !== project.baseBranch) throw new Error('ADR remote merged identity does not match guarded evidence.');
  const read = async ref => JSON.parse(await gh(['api', `repos/${job.repo}/contents/${d.adr.path}?ref=${encodeURIComponent(ref)}`]));
  for (const ref of [adrJob.merge.commit, project.baseBranch]) {
    const file = await read(ref);
    if (file.encoding !== 'base64' || Buffer.from(file.content, 'base64').toString('utf8') !== d.adr.content) throw new Error('Approved ADR content is absent or changed on the merged base.');
  }
  // Existing ADRs are immutable in this change; supersession adds links in the new file.
  for (const r of d.references.filter(r => /^docs\/(decisions|adr)\//.test(r.path))) {
    const file = JSON.parse(await gh(['api', `repos/${job.repo}/contents/${r.path}?ref=${encodeURIComponent(project.baseBranch)}`]));
    if (file.encoding !== 'base64' || Buffer.from(file.content, 'base64').toString('utf8') !== r.content) throw new Error(`Unresolved existing ADR change: ${r.path}`);
  }
  if (job.runs >= (project.maxJobRuns ?? require('./autopilot-state').DEFAULT_MAX_JOB_RUNS)) throw new Error('Original implementation run budget exhausted; explicit supported recovery required.');
  if (!fs.existsSync(job.worktreePath)) throw new Error('Original worktree missing; explicit recovery required.');
  const fresh = await require('./milestone-admission').checkMilestoneAdmission(job.project, project, job.issue.number, {
    ...options, jobs: () => store.dependencyJobs ? store.dependencyJobs() : store.list(), expectedIssue: issue, expectedAuthorization: d.authorization,
  });
  if (!same(fresh, d.authorization)) throw new Error('Milestone grant changed during ADR validation.');
  return { at: store.now(), adrIssue: d.adr.issue, merge: adrJob.merge, authorization };
}
// Read-only remote validation, with its observation time preserved for status.
// A status read never refreshes authority or implicitly requests execution.
async function validateResume(project, job, store, options = {}) {
  const d = job.architectureDecision;
  try {
    const evidence = await validateResumeChecks(project, job, store, options);
    d.scopeCheck = { at: store.now(), status: 'passed', authorization: evidence.authorization };
    store.save(job);
    return evidence;
  } catch (error) {
    if (d) { d.scopeCheck = { at: store.now(), status: 'blocked', reason: error.message }; store.save(job); }
    throw error;
  }
}
// Update the one existing issue; no comments, duplicate issues or owner mentions.
// Lost PATCH responses are reconciled by reading the same deterministic suffix.
async function publishResolution(project, job, store, options = {}) {
  const d = job.architectureDecision;
  if (d.resolution?.status === 'complete') return;
  if (d.ownerDecision?.action !== 'accept' || !d.resumeEvidence) throw new Error('Verified owner acceptance and ADR delivery required.');
  const gh = args => runGh(args, options.execFile, 'Architecture decision resolution');
  const marker = `${d.marker} resolution`;
  const merge = d.resumeEvidence.merge;
  const adrUrl = `https://github.com/${job.repo}/blob/${merge.commit}/${d.adr.path}`;
  const suffix = `${marker}\n## Verified owner decision\nAccepted option: ${d.ownerDecision.option}\nAccepted ADR: ${adrUrl}\nADR delivery: https://github.com/${job.repo}/pull/${merge.prNumber}\nOriginating implementation: https://github.com/${job.repo}/issues/${d.originatingIssue}\nOriginal job: ${d.originatingJob}\nOwner decision recorded: ${d.ownerDecision.at}\nResume remains subject to fresh milestone and exact ADR checks. Merge does not imply deployment.`;
  d.resolution = { status: 'pending', adrUrl }; store.save(job);
  try {
    const issue = JSON.parse(await gh(['api', `repos/${job.repo}/issues/${d.issue.number}`]));
    if (issue.number !== d.issue.number || issue.html_url !== `https://github.com/${job.repo}/issues/${d.issue.number}`
      || issue.pull_request || !['open', 'closed'].includes(issue.state) || typeof issue.body !== 'string' || !issue.body.includes(d.marker)) throw new Error('Decision issue identity changed; owner reconciliation required.');
    if (issue.body.includes(marker) && !issue.body.endsWith(suffix)) throw new Error('Decision resolution changed; owner reconciliation required.');
    await gh(['issue', 'edit', String(d.issue.number), '--repo', job.repo, '--add-label', 'needs-owner-decision', '--remove-label', project.readyLabel]);
    if (!issue.body.endsWith(suffix) || issue.state !== 'closed') {
      const updated = JSON.parse(await gh(['api', '--method', 'PATCH', `repos/${job.repo}/issues/${d.issue.number}`, '-f', `body=${issue.body.endsWith(suffix) ? issue.body : issue.body + '\n\n' + suffix}`, '-f', 'state=closed']));
      if (updated.number !== issue.number || updated.html_url !== issue.html_url || updated.state !== 'closed'
        || updated.pull_request || !updated.body?.endsWith(suffix)) throw new Error('GitHub did not confirm the exact decision resolution.');
    }
    d.resolution = { status: 'complete', at: store.now(), adrUrl }; store.save(job);
  } catch (error) {
    d.resolution.error = error.message; store.save(job); throw error;
  }
}
async function decisionCommand(action, id, options = {}) {
  if (!['inspect', 'accept', 'reject', 'revise', 'resume'].includes(action)) throw new Error('Unknown decision action.');
  const match = /^([A-Za-z0-9._-]+)#([1-9][0-9]*)$/.exec(id || '');
  if (!match) throw new Error('Supply PROJECT#ISSUE.');
  const configSnapshot = [options.configPath, options.projectsPath].map(p => fs.readFileSync(p, 'utf8'));
  const project = require('./autopilot-config').loadProjectConfig(match[1], { configPath: options.projectsPath });
  if (project.architectureDecisions !== true) throw new Error('Architecture decisions are not enabled by owner policy.');
  const store = createJobStore(resolveStateDir(match[1], project, options.stateRoot));
  const lock = store.acquire(Number(match[2]));
  try {
    const job = store.load(Number(match[2]));
    if (!job) throw new Error('Original job missing.');
    if (!job.architectureDecision && action === 'inspect' && job.architectureDecisionHistory?.length) return { history: job.architectureDecisionHistory, status: require('./architecture-decision-status').decisionStatus(job) };
    if (!job.architectureDecision && action === 'resume' && job.architectureDecisionHistory?.at(-1)?.resumedAt) return job;
    const view = preview(job), d = job.architectureDecision;
    if (action === 'inspect') return { ...view, digest: hash(view), blockedReason: d.blockedReason };
    // Identity comes from the owner-controlled local CLI session, never the request.
    if (fs.statSync(options.configPath).uid !== process.getuid() || fs.statSync(options.projectsPath).uid !== process.getuid()) throw new Error('Unverified local operator.');
    const input = options.inputPath ? JSON.parse(fs.readFileSync(options.inputPath, 'utf8')) : {};
    if (Object.keys(input).some(k => !['option', 'rationale', 'adrPath', 'supersedes', 'conflictResolution', 'adrIssue', 'requiresMilestoneAmendment', 'conflictsResolved'].includes(k))) throw new Error('Unknown owner decision fields; actor and approval cannot be supplied.');
    const requestDigest = hash({ action, input });
    if (d.ownerDecision?.requestDigest === requestDigest && action !== 'resume') {
      if (action === 'accept') await publishAdr(job, store, { ...options, readyLabel: project.readyLabel });
      return job;
    }
    if (d.ownerDecision && action !== 'resume') throw new Error('Decision already recorded; contradictory approval prohibited.');
    if (options.digest !== hash(view)) throw new Error('Inspect the current decision and supply its exact digest.');
    if (!await options.approve?.(`Record owner ${action} for ${id}?`)) throw new Error('Explicit owner approval required.');
    if ([options.configPath, options.projectsPath].some((p, i) => fs.readFileSync(p, 'utf8') !== configSnapshot[i])) throw new Error('Owner configuration changed during approval.');
    if (action === 'resume') {
      let queue, task, queueStage;
      if (job.r1ParentJobId) {
        queue = options.queueStore || require('./store');
        for (const stage of ['done', 'pending', 'running']) {
          try { task = queue.readTask(job.r1ParentJobId, stage); queueStage = stage; break; }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        if (!task || !['paused_owner_decision', 'pending', 'running'].includes(task.status)
          || task.workflow !== 'r1' || task.project !== job.project || task.issue !== job.issue.number
          || task.r1?.createdAt !== job.createdAt) throw new Error('Original owner queue job identity changed or is missing.');
      }
      try {
        d.resumeEvidence = await validateResume(project, job, store, options);
        await publishResolution(project, job, store, options);
      }
      catch (error) { d.blockedReason = error.message; store.save(job); throw error; }
      d.resumeRequested = true; delete d.blockedReason;
      job.terminal = false; job.terminalState = null; job.status = 'decision_resume_pending';
      store.save(job);
      if (task && queueStage === 'done') {
        task.r1 = structuredClone(job); task.status = 'pending'; task.phase = 'admitted';
        queue.writeTask(task, 'done'); queue.moveTask(task.id, 'done', 'pending');
      }
      return job;
    }
    if (typeof input.rationale !== 'string' || !input.rationale.trim()) throw new Error('Exact owner rationale required.');
    if (action === 'accept') {
      if (typeof input.conflictsResolved !== 'boolean') throw new Error('Explicit ADR conflict assessment required.');
      if (typeof input.requiresMilestoneAmendment !== 'boolean') throw new Error('Explicit milestone amendment assessment required.');
      if (!Number.isSafeInteger(input.adrIssue) || input.adrIssue <= 0 || [job.issue.number, d.issue?.number].includes(input.adrIssue)) throw new Error('Supply a separate ADR delivery issue; its release needs independent milestone authorization.');
      if (!d.issue?.url || !d.sourceIssue) throw new Error('Published decision and original issue revision required.');
      d.adr = { ...adrFor(job, input), issue: input.adrIssue };
    }
    let milestoneGrantRevision = null;
    if (d.authorization) {
      const state = options.stateDir || process.env.AGENTLOOP_STATE_DIR || path.join(__dirname, '../state');
      const grant = JSON.parse(fs.readFileSync(path.join(state, 'milestone-grants.json'), 'utf8')).grants[d.authorization.grantId];
      if (!grant || grant.digest !== d.authorization.grantDigest) throw new Error('Original milestone grant changed; amendment required.');
      milestoneGrantRevision = grant.revision;
    }
    d.ownerDecision = { action, ...input, milestoneGrantRevision, actor: os.userInfo().username, uid: process.getuid(), at: store.now(),
      digest: options.digest, requestDigest, sourceDecisionIssue: d.issue, affectedJobIds: [d.originatingJob],
      conflicts: d.proposal.conflicts, milestoneAuthorization: d.authorization };
    d.blockedReason = action === 'accept' ? 'ADR proposed; awaiting separately authorized guarded merge.' : `Owner ${action}: ${input.rationale}`;
    store.save(job);
    options.record?.('architecture_owner_decision', { decision: d });
    if (action === 'accept') await publishAdr(job, store, { ...options, readyLabel: project.readyLabel });
    return job;
  } finally { lock.release(); }
}
module.exports = { decisionCommand, validateResume, preview, adrFor, hash };
