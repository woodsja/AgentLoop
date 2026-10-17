'use strict';

// Public dashboard transcript: derive useful diagnostics from bounded,
// allowlisted fields. Never print command text, raw test output, model output,
// secrets, host paths, or arbitrary exception messages here.
const PREFLIGHT_REASONS = new Set([
  'runtime_missing', 'sandbox_unavailable', 'lockfile_missing', 'lockfile_invalid',
  'lockfile_stale', 'manifest_mismatch', 'install_failed', 'audit_unavailable',
  'dependency_source_unavailable', 'verification_command_missing',
]);

function lastNumber(output, name) {
  const pattern = new RegExp(`(?:^|\\n)[\\u2139#] ${name} ([0-9]{1,6})(?=\\r?\\n|$)`, 'g');
  let last = null;
  for (const match of output.matchAll(pattern)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value)) last = value;
  }
  return last;
}

function verificationFailureSummary(verification) {
  if (!verification || typeof verification !== 'object') return 'deterministic verification failed.';
  const facts = [];
  if (verification.timedOut === true) facts.push('timed out');
  else if (Number.isSafeInteger(verification.exitCode) && verification.exitCode >= 0 && verification.exitCode <= 255) {
    facts.push(`exit ${verification.exitCode}`);
  }

  // Test runners may print arbitrary repository-supplied text. Select only
  // numeric test counts and approved reason IDs. Never display test filenames:
  // malicious repository code can embed a credential into a plausible path.
  const output = [verification.stdout, verification.stderr]
    .filter(value => typeof value === 'string').join('\n').slice(-16000);
  const passed = lastNumber(output, 'pass');
  const failed = lastNumber(output, 'fail');
  if (passed !== null && failed !== null && failed > 0) facts.push(`reported tests: ${passed} passed, ${failed} failed`);

  // This is a diagnostic hint, not an authoritative infrastructure verdict:
  // project test output can still impersonate a known code, but an allowlisted
  // reason cannot carry arbitrary secrets into the public transcript.
  const preflightPattern = /code:\s*['"]PROJECT_PREFLIGHT_BLOCKED['"][\s\S]{0,320}?reason:\s*['"]([a-z][a-z0-9_]{0,40})['"]/g;
  let reportedReason = null;
  for (const match of output.matchAll(preflightPattern)) {
    if (PREFLIGHT_REASONS.has(match[1])) reportedReason = match[1];
  }
  if (reportedReason) facts.push(`reported preflight: ${reportedReason}`);

  const summary = `deterministic verification failed${facts.length ? ` (${facts.join('; ')})` : ''}.`;
  return summary.slice(0, 400);
}

module.exports = { verificationFailureSummary };
