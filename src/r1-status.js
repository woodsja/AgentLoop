'use strict';

// Navigation over durable evidence only. Complete captured evidence remains in
// the owner execution journal; never copy provider text or model output here.
const oneOf = (value, values) => values.includes(value) ? value : null;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1000) : 0;
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
function reviewProjection(value) {
  return value ? { reviewer: /^claude(?::[a-z0-9.-]{1,40})?$/.test(value.reviewer) ? value.reviewer : 'independent-reviewer',
    verdict: oneOf(value.verdict, ['PASS', 'NEEDS_CHANGES']), commit: sha(value.commit),
    policy: oneOf(value.policy, ['always', 'risk']), findingCount: Array.isArray(value.findings) ? Math.min(value.findings.length, 50) : 0,
    ...(value.attempt ? { attempt: { number: count(value.attempt.number),
      startedAt: date(value.attempt.startedAt), completedAt: date(value.attempt.completedAt) } } : {}) } : null;
}
function correction(value) {
  return value ? { status: oneOf(value.status, ['eligible', 'running', 'passed', 'delivered', 'failed']), commit: sha(value.commit) } : null;
}
function evidence(job, configuredWorkflow) {
  if (!job) return null;
  const ci = ciProjection(job, configuredWorkflow);
  const verification = job.verification;
  return {
    outcome: oneOf(job.terminalState || job.status, ['queued', 'preparing', 'running', 'passed', 'failed', 'awaiting_ci', 'correction_eligible', 'review_correction_eligible', 'ready_for_human', 'ready_for_human_merge', 'merged', 'blocked_infrastructure']),
    commit: sha(job.delivery?.commit),
    verification: verification ? { passed: verification.passed === true, exitCode: Number.isInteger(verification.exitCode) && verification.exitCode >= 0 && verification.exitCode <= 255 ? verification.exitCode : null,
      timedOut: verification.timedOut === true, commit: sha(verification.commit) } : null,
    ci, review: job.review?.commit === job.delivery?.commit ? reviewProjection(job.review) : null,
    reviewAttempts: count(job.reviewAttempts),
    reviewHistory: (job.reviewHistory || []).slice(-8).map(entry => ({ ...reviewProjection(entry),
      number: count(entry.number), startedAt: date(entry.startedAt), completedAt: date(entry.completedAt),
      status: oneOf(entry.status, ['running', 'completed', 'failed', 'timed_out', 'invalid_verdict', 'interrupted']) })),
    reviewPreparationHistory: (job.reviewPreparationHistory || []).slice(-24).map(entry => ({
      number: count(entry.number), commit: sha(entry.commit),
      status: oneOf(entry.status, ['running', 'prepared', 'retry_wait', 'blocked']),
      startedAt: date(entry.startedAt), completedAt: date(entry.completedAt),
    })),
    correction: correction(job.correction), reviewCorrection: correction(job.reviewCorrection),
    environmentPreflight: job.environmentPreflight ? {
      status: oneOf(job.environmentPreflight.status, ['ready', 'blocked']),
      reason: oneOf(job.environmentPreflight.reason, ['contract_missing', 'contract_invalid', 'runtime_invalid', 'runtime_missing',
        'package_invalid', 'lockfile_missing', 'lockfile_invalid', 'lockfile_uncommitted', 'lockfile_changed',
        'verification_missing', 'verification_unavailable', 'install_failed', 'prior_process_unresolved',
        'timeout', 'cancelled', 'policy', 'unsafe_path', 'interpreter_missing', 'dependency_incompatible',
        'offline_bundle_invalid', 'package_index_transport', 'output_limit']),
      baseline: job.environmentPreflight.baseline ? { passed: job.environmentPreflight.baseline.passed === true } : null,
    } : null,
    diagnostics: (job.failures || []).slice(-20).map(() => ({ message: 'Recorded failure; see the complete owner execution journal.' })),
  };
}
function nextAction(task, projected) {
  if (['passed', 'blocked', 'failed', 'merged', 'needs_specification', 'completed'].includes(task.status)) {
    return { action: 'none', reason: 'Job finished; inspect the terminal outcome and recorded owner evidence. Merge does not imply deployment.' };
  }
  if (projected?.commit && (task.phase === 'ci' || task.r1?.status === 'awaiting_ci')) {
    return { action: 'wait', reason: reasons[projected.ci.category] };
  }
  return { action: 'wait', reason: 'Await the current implementation, verification, review or correction phase.' };
}
module.exports = { evidence, nextAction };
