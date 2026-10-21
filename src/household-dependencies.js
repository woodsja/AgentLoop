'use strict';
const { approvedMerge } = require('./r1-dependencies');

// Household planning issues use a distinct, documented metadata section.
function prerequisites(issue) {
  if (typeof issue.body !== 'string') throw new Error('issue body must be provided');
  const sections = issue.body.split(/\r?\n(?=## )/);
  const blocked = sections.filter(section => /^## Blocked by\s*\r?\n/i.test(section));
  if (blocked.length !== 1) throw new Error('exactly one ## Blocked by section required');
  const lines = blocked[0].split(/\r?\n/).slice(1).map(s => s.trim()).filter(Boolean);
  if (lines.length === 1 && /^None\.?$/i.test(lines[0])) return [];
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
function eligible(issues, jobs, projectName, repo, log = () => {}) {
  return issues.filter(issue => {
    let ids;
    try { ids = prerequisites(issue); }
    catch(error) { log(`Issue #${issue.number} blocked: ${error.message}`); return false; }
    const missing=ids.filter(id => !jobs.some(job => approvedMerge(job, id, projectName, repo)));
    if(missing.length) log(`Issue #${issue.number} blocked by unresolved ${missing.map(id=>'#'+id).join(', ')}`);
    return missing.length===0;
  });
}
module.exports={prerequisites,eligible};
