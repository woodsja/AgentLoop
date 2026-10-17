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
  // numeric test counts, repo-relative test filenames, and approved reason IDs.
  const output = [verification.stdout, verification.stderr]
    .filter(value => typeof value === 'string').join('\n').slice(-16000);
  const passed = lastNumber(output, 'pass');
  const failed = lastNumber(output, 'fail');
  if (passed !== null && failed !== null && failed > 0) facts.push(`${passed} passed, ${failed} failed`);

  const sourceFile = /(?:^|\n)test at (test\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.test\.(?:js|cjs|mjs)):[1-9][0-9]*:[1-9][0-9]*(?=\r?\n|$)/.exec(output);
  if (sourceFile && sourceFile[1].length <= 120) facts.push(sourceFile[1]);

  const reason = /(?:^|[\s,{])reason:\s*['"]([a-z][a-z0-9_]{0,40})['"]/.exec(output);
  if (reason && PREFLIGHT_REASONS.has(reason[1])) facts.push(`preflight: ${reason[1]}`);

  return `deterministic verification failed${facts.length ? ` (${facts.join('; ')})` : ''}.`;
}

module.exports = { verificationFailureSummary };
