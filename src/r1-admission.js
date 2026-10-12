// One-shot admission for owner-registered R1 projects.  This module deliberately
// does discovery and claiming only; execution remains the existing R1 submit path.
const crypto = require('node:crypto');
const path = require('node:path');
const { execFile } = require('node:child_process');
const store = require('./store');

const terminal = new Set(['delivered', 'review_completed', 'completed', 'cancelled']);
const active = new Set(['claimed', 'queued', 'working', 'reviewing']);

function issueNumber(issue) {
  return Number.isSafeInteger(issue?.number) && issue.number > 0 ? issue.number : null;
}

function labels(issue) {
  return new Set((Array.isArray(issue?.labels) ? issue.labels : []).map((label) =>
    typeof label === 'string' ? label : label?.name).filter(Boolean));
}

function blockedBy(issue) {
  const body = typeof issue?.body === 'string' ? issue.body : '';
  const matches = [...body.matchAll(/\bBlocked by\s*:?\s*([^\n]+)/ig)];
  if (!matches.length) return { numbers: [], ambiguous: false };
  const numbers = [];
  for (const match of matches) {
    const found = [...match[1].matchAll(/#(\d+)/g)].map((value) => Number(value[1]));
    if (!found.length) return { numbers: [], ambiguous: true };
    numbers.push(...found);
  }
  return { numbers: [...new Set(numbers)], ambiguous: false };
}

function completionEvidence(issue) {
  const all = labels(issue);
  if (['implemented', 'delivered', 'review-completed'].some((label) => all.has(label))) return true;
  const text = `${issue?.title || ''}\n${issue?.body || ''}`;
  return /\b(?:implemented|delivered|review completed)\b/i.test(text) && /\b(?:PR|commit)\s*(?:#|[0-9a-f]{7,})/i.test(text);
}

function evaluateIssue(issue, issues, project, storeImpl = store) {
  const number = issueNumber(issue);
  if (!number) return { issue, eligible: false, reason: 'malformed issue' };
  if (issue.state && String(issue.state).toUpperCase() !== 'OPEN') return { issue, eligible: false, reason: 'not open' };
  const all = labels(issue);
  if (all.has('deferred')) return { issue, eligible: false, reason: 'deferred' };
  if (!all.has('ready-for-agent')) return { issue, eligible: false, reason: 'unlabeled' };
  if (completionEvidence(issue)) return { issue, eligible: false, reason: 'already implemented/delivered' };
  const deps = blockedBy(issue);
  if (deps.ambiguous) return { issue, eligible: false, reason: 'ambiguous Blocked by dependency' };
  for (const dependency of deps.numbers) {
    const item = issues.find((candidate) => issueNumber(candidate) === dependency);
    if (!item || String(item.state || '').toUpperCase() !== 'CLOSED') {
      return { issue, eligible: false, reason: `blocked by #${dependency}` };
    }
  }
  const job = storeImpl.readR1Job(project.repository, number);
  const claim = storeImpl.readR1Claim(project.repository, number);
  if (job && (active.has(job.status) || terminal.has(job.status))) return { issue, eligible: false, reason: `already ${job.status}` };
  if (job) return { issue, eligible: false, reason: `requires reconciliation (${job.status})` };
  if (claim) return { issue, eligible: false, reason: 'already claimed' };
  return { issue, eligible: true, reason: 'eligible' };
}

function validateProject(project) {
  if (!project || typeof project !== 'object' || project.id !== 'ralph' || project.repository !== 'woodsja/AgentLoop') {
    throw new Error('Unknown or unauthorized R1 project.');
  }
  if (typeof project.worktree !== 'string' || !path.isAbsolute(project.worktree)) {
    throw new Error('R1 project requires an authorized absolute worktree.');
  }
}

function selectIssues(issues, project, storeImpl = store) {
  if (!Array.isArray(issues)) throw new Error('GitHub discovery returned malformed issues.');
  validateProject(project);
  const running = typeof storeImpl.listR1Jobs === 'function' && storeImpl.listR1Jobs()
    .some((job) => job?.project === project.repository && active.has(job.status));
  const report = issues.map((issue) => running
    ? { issue, eligible: false, reason: 'another R1 job is active' }
    : evaluateIssue(issue, issues, project, storeImpl));
  const selected = report.filter((entry) => entry.eligible).sort((a, b) => issueNumber(a.issue) - issueNumber(b.issue))[0] || null;
  return { selected, report };
}

function jobId(project, number) {
  return `r1-${crypto.createHash('sha256').update(`${project.repository}#${number}`).digest('hex').slice(0, 16)}`;
}

async function admitOne({ project, issues, dryRun = false, submitR1Job, storeImpl = store, now = () => new Date().toISOString() }) {
  const selection = selectIssues(issues, project, storeImpl);
  if (dryRun || !selection.selected) return { dryRun: Boolean(dryRun), admitted: null, ...selection };
  if (typeof submitR1Job !== 'function') throw new TypeError('submitR1Job must be a function');
  const issue = selection.selected.issue;
  const number = issueNumber(issue);
  const id = jobId(project, number);
  const claim = { id, project: project.repository, issueNumber: number, claimedAt: now(), source: 'r1-admission' };
  if (!storeImpl.claimR1Issue(project.repository, number, claim)) {
    return { admitted: null, ...selection, duplicate: true };
  }
  const job = { ...claim, status: 'claimed', issue: { number, title: issue.title, url: issue.url || issue.html_url || null }, phases: [{ name: 'admission', status: 'passed', at: claim.claimedAt }], autoMerge: false };
  try {
    storeImpl.writeR1Job(job);
    const submitted = await submitR1Job({ id, project, issue, reviewPolicy: 'always', autoMerge: false });
    const durableId = submitted?.id || id;
    const queued = { ...job, id: durableId, status: 'queued', phases: [...job.phases, { name: 'submission', status: 'queued', at: now() }] };
    storeImpl.writeR1Job(queued);
    return { admitted: queued, ...selection };
  } catch (error) {
    // Retain the claim and record the failure: retry needs deliberate reconciliation,
    // never an automatic duplicate after an uncertain submission outcome.
    storeImpl.writeR1Job({ ...job, status: 'failed', error: error.message, phases: [...job.phases, { name: 'submission', status: 'failed', at: now(), error: error.message }] });
    throw error;
  }
}

function ghIssues(repository) {
  return new Promise((resolve, reject) => execFile('gh', ['issue', 'list', '--repo', repository, '--state', 'open', '--limit', '100', '--json', 'number,title,body,labels,state,url'], { timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) return reject(new Error(`GitHub discovery failed: ${error.message}`));
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error('GitHub discovery returned invalid JSON.')); }
  }));
}

module.exports = { admitOne, selectIssues, evaluateIssue, blockedBy, completionEvidence, validateProject, ghIssues, jobId };
