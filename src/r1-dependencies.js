'use strict';

const { hasPassingVerification } = require('./autopilot-state');

// Only a dedicated metadata line creates an admission dependency. Never parse
// issue prose or GitHub's closed flag as evidence of completion.
function dependencies(issue) {
  const text = String(issue.body || '');
  const lines = text.split(/\r?\n/).filter(line => /^\s*(?:[-*>]\s*)?\*{0,2}Depends[\s-]+on\b/i.test(line));
  if (lines.length > 1) throw new Error('multiple Depends on metadata lines');
  if (lines.length && !/^\s*Depends on\s*:/i.test(lines[0])) throw new Error('malformed Depends on marker; use: Depends on: #1');
  if (lines.length === 0) return [];
  const value = lines[0].replace(/^\s*Depends on\s*:/i, '').trim();
  if (!/^#[1-9]\d*(?:\s*,\s*#[1-9]\d*){0,7}$/.test(value)) {
    throw new Error('invalid Depends on metadata; expected: Depends on: #1, #2 (up to eight)');
  }
  const ids = value.split(',').map(part => Number(part.trim().slice(1)));
  if (!Number.isSafeInteger(issue.number) || issue.number < 1
    || ids.some(id => !Number.isSafeInteger(id) || id >= issue.number)
    || new Set(ids).size !== ids.length) {
    throw new Error('Depends on must list distinct, smaller same-repository issue numbers');
  }
  return ids;
}

function approved(job, number, projectName, repo) {
  if (!job || job.issue?.number !== number || job.project !== projectName || job.repo !== repo
    || job.terminal !== true || job.terminalState !== 'merged' || !job.merge?.commit
    || job.merge.repo !== repo || !job.merge.issueClosed || !job.delivery?.commit
    || job.merge.approvedHead !== job.delivery.commit || !job.review
    || !String(job.review.reviewer || '').startsWith('claude:')
    || job.review.verdict !== 'PASS' || job.review.commit !== job.delivery.commit
    || !Array.isArray(job.review.findings) || job.review.findings.length !== 0
    || job.ci?.state !== 'green' || job.ci.headCommit !== job.delivery.commit
    || !hasPassingVerification(job.verification, job.delivery.commit)) return false;
  return true;
}

function eligibleIssues(issues, jobs, projectName, repo, diagnostic = () => {}) {
  return issues.filter(issue => {
    let ids;
    try { ids = dependencies(issue); }
    catch (error) { diagnostic(`R1 issue #${issue.number} dependency metadata blocked: ${error.message}`); return false; }
    const missing = ids.filter(id => !jobs.some(job => approved(job, id, projectName, repo)));
    if (missing.length) diagnostic(`R1 issue #${issue.number} awaits independently approved merged prerequisites: ${missing.map(id => '#'+id).join(', ')}`);
    return missing.length === 0;
  });
}

module.exports = { dependencies, eligibleIssues };
