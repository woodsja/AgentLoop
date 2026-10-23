'use strict';

// GitHub native dependencies are evidence as well as body metadata. Never
// silently discard cross-repository or malformed references.
async function nativeBlockers(repo, number, gh) {
  const pages = await gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/dependencies/blocked_by?per_page=100`]);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('Malformed native blocker response; owner review required.');
  const ids = pages.flat().map(issue => {
    if (!issue || !Number.isSafeInteger(issue.number) || issue.number < 1 || issue.number >= number
      || issue.pull_request || issue.html_url !== `https://github.com/${repo}/issues/${issue.number}`) throw new Error('Unknown or cross-repository native blocker; owner review required.');
    return issue.number;
  });
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate native blockers; owner review required.');
  return ids.sort((a, b) => a - b);
}
module.exports = { nativeBlockers };
