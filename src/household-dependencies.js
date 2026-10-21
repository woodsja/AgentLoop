'use strict';
const { hasPassingVerification } = require('./autopilot-state');

// Household planning issues use a distinct, documented metadata section.
function prerequisites(issue) {
  if (typeof issue.body !== 'string') throw new Error('issue body must be provided');
  const sections = issue.body.split(/\r?\n(?=## )/);
  const blocked = sections.filter(section => /^## Blocked by\s*\r?\n/i.test(section));
  if (blocked.length !== 1) throw new Error('exactly one ## Blocked by section required');
  const lines = blocked[0].split(/\r?\n/).slice(1).map(s => s.trim()).filter(Boolean);
  if (lines.length === 1 && /^None\b/i.test(lines[0])) return [];
  if (!lines.length || lines.length > 8) throw new Error('requires 1-8 explicit prerequisite bullet lines');
  const ids = lines.map(line => {
    const match = /^- #([1-9]\d*)(?::.*)?$/.exec(line);
    if (!match) throw new Error('invalid prerequisite bullet; expected - #N: title');
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(issue.number) || id >= issue.number) throw new Error('prerequisites must be smaller issue numbers');
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error('duplicate prerequisites');
  return ids;
}
function approved(job, id, projectName, repo) {
  const sha=job?.delivery?.commit;
  return Boolean(job?.issue?.number === id && job.project === projectName && job.repo === repo
    && job.terminal === true && job.terminalState === 'merged' && job.merge?.issueClosed
    && job.merge.repo === repo && job.merge.commit && job.merge.approvedHead === sha
    && job.ci?.state === 'green' && job.ci.headCommit === sha
    && job.review?.verdict === 'PASS' && job.review.commit === sha
    && String(job.review.reviewer || '').startsWith('claude:')
    && Array.isArray(job.review.findings) && job.review.findings.length === 0
    && hasPassingVerification(job.verification, sha));
}
function eligible(issues, jobs, projectName, repo, log = () => {}) {
  return issues.filter(issue => {
    let ids;
    try { ids = prerequisites(issue); }
    catch(error) { log(`Issue #${issue.number} blocked: ${error.message}`); return false; }
    const missing=ids.filter(id => !jobs.some(job => approved(job,id,projectName,repo)));
    if(missing.length) log(`Issue #${issue.number} blocked by unresolved ${missing.map(id=>'#'+id).join(', ')}`);
    return missing.length===0;
  });
}
module.exports={prerequisites,eligible};
