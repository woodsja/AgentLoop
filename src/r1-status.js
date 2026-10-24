'use strict';

// Preserve owner-visible evidence; sanitize only the new CI display fields.
// Owner text is verbatim, with escaping left to the rendering layer.
function ownerText(value) { return String(value ?? ''); }
const oneOf = (value, values) => values.includes(value) ? value : null;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ? value : null;
function workflowLabel(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)/gi, '[redacted]')
    .replace(/\b(?:token|secret|password|credential|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/\b(?:prompt|reasoning|chain.of.thought)\s*[:=].*/gi, '[redacted]')
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s]+/g, '[path]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 160);
}
function runProjection(run) {
  return run ? {
    databaseId: Number.isSafeInteger(run.databaseId) && run.databaseId > 0 ? run.databaseId : null,
    workflowName: workflowLabel(run.workflowName),
    url: typeof run.url === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+$/.test(run.url) && run.url.length <= 400 ? run.url : null,
    status: oneOf(run.status, ['queued', 'requested', 'waiting', 'pending', 'in_progress', 'completed']),
    conclusion: oneOf(run.conclusion, ['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure']),
  } : null;
}
function ciProjection(job, configuredWorkflow) {
  const ci = job?.ci;
  const configured = ci && Object.hasOwn(ci, 'requiredWorkflow') ? ci.requiredWorkflow : configuredWorkflow;
  const requiredWorkflow = typeof configured === 'string' && configured.trim() ? configured : null;
  const headCommit = sha(job?.delivery?.commit);
  const current = Boolean(headCommit && ci?.headCommit === headCommit && ci?.prNumber === job?.pr?.number);
  // Identity comparison must use full raw names, before display redaction and
  // bounds. In particular slash names and secret-looking names are valid IDs.
  const run = current && Array.isArray(ci.runs) ? ci.runs.filter(run => run.workflowName === requiredWorkflow)
    .reduce((latest, run) => !latest || run.databaseId > latest.databaseId ? run : latest, null) : null;
  const category = !requiredWorkflow ? 'not_configured' : !current ? 'not_observed'
    : ci.providerError ? 'provider_error' : !Array.isArray(ci.runs) ? 'not_observed'
      : !run ? 'required_run_missing' : run.status !== 'completed' || !run.conclusion ? 'required_run_pending'
        : ci.state === 'green' && run.conclusion === 'success' ? 'green' : ci.state === 'red' ? 'red' : 'required_run_pending';
  // Legacy injected observers can carry scheduler evidence without run metadata;
  // display it as not observed rather than claiming required CI is green.
  return { state: category === 'green' ? 'green' : category === 'red' ? 'red' : 'pending', category,
    requiredWorkflow: workflowLabel(requiredWorkflow), prNumber: Number.isSafeInteger(job?.pr?.number) && job.pr.number > 0 ? job.pr.number : null, headCommit,
    observedAt: current ? date(ci.observedAt) : null, providerError: current && ci.providerError === true,
    requiredRun: runProjection(run) };
}
const reasons = {
  not_configured: 'Configure the required GitHub Actions workflow before CI can pass.',
  not_observed: 'Await a GitHub Actions observation for this exact PR head.',
  required_run_missing: 'Wait for the required workflow to run on this exact head; advisory runs cannot substitute.',
  required_run_pending: 'Wait for the required GitHub Actions workflow and all observed checks to finish.',
  provider_error: 'GitHub Actions observation failed; check provider access and wait for the next scheduled observation.',
  red: 'Required CI is red; inspect the recorded CI evidence and correction state.',
  green: 'Exact-head CI is green; await independent review and guarded delivery.',
};
function correction(value) {
  return value ? { status: oneOf(value.status, ['eligible', 'running', 'passed', 'delivered', 'failed']), commit: sha(value.commit) } : null;
}
function evidence(job, configuredWorkflow) {
  const review = value => value && ({
    reviewer: ownerText(value.reviewer), verdict: value.verdict, commit: value.commit, policy: value.policy,
    findingCount: Math.min((value.findings || []).length, 50),
    findings: (value.findings || []).map(finding => ({ ...finding, summary: ownerText(finding.summary), file: ownerText(finding.file) || null })),
    ...(value.attempt ? { attempt: value.attempt } : {}),
  });
  return job && {
    outcome: job.terminalState || job.status,
    commit: job.delivery && job.delivery.commit,
    verification: job.verification && { ...job.verification },
    ci: ciProjection(job, configuredWorkflow),
    review: job.review?.commit === job.delivery?.commit ? review(job.review) : null,
    correction: correction(job.correction), reviewCorrection: correction(job.reviewCorrection),
    decisions: require('./architecture-decision-status').decisionStatus(job),
    architectureDecision: job.architectureDecision,
    architectureDecisionHistory: job.architectureDecisionHistory || [],
    environmentPreflight: job.environmentPreflight,
    reviewAttempts: job.reviewAttempts,
    reviewPreparationHistory: job.reviewPreparationHistory || [],
    reviewHistory: (job.reviewHistory || []).map(entry => ({ ...entry, reviewer: ownerText(entry.reviewer), findings: review(entry).findings, findingCount: review(entry).findingCount, diagnostics: entry.diagnostics && ownerText(entry.diagnostics) })),
    diagnostics: (job.failures || []).map(failure => ({ ...failure, message: ownerText(failure.message) })),
  };
}

function nextAction(task, projected) {
  if (projected?.architectureDecision?.resumeRequested) return { action: 'wait', reason: 'Owner resume requested; awaiting fresh guarded authorization.' };
  if (task.status === 'paused_owner_decision' || projected?.architectureDecision) return { action: 'owner_decision', reason: projected?.architectureDecision?.blockedReason || 'Implementation and guarded merge are paused. Inspect the decision issue, notification status and original logs; prose is not approval.' };
  if (['passed', 'blocked', 'failed', 'merged', 'needs_specification', 'completed'].includes(task.status)) {
    return { action: 'none', reason: 'Job finished; inspect the terminal outcome and recorded owner evidence. Merge does not imply deployment.' };
  }
  if (projected?.commit && (task.phase === 'ci' || task.r1?.status === 'awaiting_ci')) {
    return { action: 'wait', reason: reasons[projected.ci.category] };
  }
  return { action: 'wait', reason: 'Await the current implementation, verification, review or correction phase.' };
}
module.exports = { evidence, nextAction };
