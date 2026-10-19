'use strict';

// Short navigation labels for the dashboard timeline. Complete command/output
// and exception evidence lives in the owner execution journal; these labels
// are never a substitute for that raw record.
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
  else if (Number.isSafeInteger(verification.exitCode) && verification.exitCode !== 0) facts.push('exit nonzero');
  else if (verification.exitCode === null) facts.push('terminated by signal');

  // Keep the navigation label small. Test names, precise counts, commands and
  // all output remain available verbatim in the owner execution journal.
  const output = [verification.stdout, verification.stderr]
    .filter(value => typeof value === 'string').join('\n').slice(-16000);
  const failed = lastNumber(output, 'fail');
  if (failed === 1) facts.push('reported tests: 1 failed');
  else if (failed >= 2 && failed <= 9) facts.push('reported tests: 2-9 failed');
  else if (failed >= 10) facts.push('reported tests: 10+ failed');

  // A reported reason is a navigation hint, not an authoritative infrastructure
  // verdict: project test output can impersonate a known code.
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
