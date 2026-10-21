'use strict';

const { eligibleIssues } = require('./r1-dependencies');

// Household planning issues use a distinct, documented metadata section.
function prerequisites(issue) {
  if (!Number.isSafeInteger(issue.number) || issue.number < 1) throw new Error('issue number must be a positive integer');
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
    if (!Number.isSafeInteger(id) || id >= issue.number) throw new Error('prerequisites must be smaller issue numbers');
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error('duplicate prerequisites');
  return ids;
}

// Reuse the R1 approved-merge admission predicate and diagnostics.
function eligible(issues, jobs, projectName, repo, log = () => {}) {
  return eligibleIssues(issues, jobs, projectName, repo, log, prerequisites, 'Household autopilot');
}

module.exports = { prerequisites, eligible };
