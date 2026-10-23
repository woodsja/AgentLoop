'use strict';

const { runGh } = require('./autopilot-github');
const { execFile } = require('./execution-log');
const { dependencies } = require('./r1-dependencies');

const FIELDS = new Set(['id', 'kind', 'repo', 'title', 'sourceSpec', 'conversation', 'summary', 'acceptanceCriteria', 'blockers', 'labels']);
function line(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0
    && !/[\x00-\x1f\x7f]/.test(value);
}

function previewDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)
    || Object.keys(draft).some(key => !FIELDS.has(key))) throw new Error('Unknown or missing draft metadata');
  for (const field of ['id', 'kind', 'repo', 'title', 'sourceSpec', 'conversation', 'summary']) {
    if (!line(draft[field])) throw new Error(`Missing or malformed ${field}`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(draft.id)
    || !['spec', 'ticket'].includes(draft.kind)
    || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(draft.repo)
    || !/^(?:#[1-9]\d*|https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9]\d*)$/.test(draft.sourceSpec)) {
    throw new Error('Malformed id, kind, repo or sourceSpec');
  }
  if (!Array.isArray(draft.acceptanceCriteria) || !draft.acceptanceCriteria.length
    || !draft.acceptanceCriteria.every(line)) throw new Error('Acceptance criteria must be nonempty verifiable statements');
  if (!Array.isArray(draft.blockers) || draft.blockers.length > 8
    || draft.blockers.some(id => !Number.isSafeInteger(id) || id < 1)
    || new Set(draft.blockers).size !== draft.blockers.length) throw new Error('Malformed blockers');
  if (draft.labels !== undefined && (!Array.isArray(draft.labels) || draft.labels.length)) {
    throw new Error('Draft publication forbids all labels, including custom ready labels');
  }
  // Prose cannot introduce another admission marker or spoof the retry identity.
  for (const value of [draft.title, draft.conversation, draft.summary, ...draft.acceptanceCriteria]) {
    if (/<!--|-->|depend[a-z]*(?:[\s-]+[a-z]+)?\s*:/i.test(value)) throw new Error('Reserved draft metadata in prose');
  }
  const marker = `<!-- agentloop-planning-draft:${draft.id} -->`;
  const title = `[DRAFT] ${draft.title}`;
  const body = [
    '**DRAFT — UNAUTHORIZED. Planning artifact only. Owner review and separate explicit executable release required.**',
    marker,
    `Kind: ${draft.kind}\nSource spec: ${draft.sourceSpec}\nPlanning source: ${draft.conversation}`,
    `## Proposal\n\n${draft.summary}`,
    `## Acceptance criteria\n\n${draft.acceptanceCriteria.map(text => `- [ ] ${text}`).join('\n')}`,
    `## Blockers\n\n${draft.blockers.length ? `Depends on: ${draft.blockers.map(id => `#${id}`).join(', ')}` : 'None.'}`,
    '## Release boundary\n\nPublication grants no execution authorization. Do not apply execution-ready labels, enqueue Ralph jobs, or change production project registration. The owner must separately authorize release of the complete batch.',
  ].join('\n\n');
  return { repo: draft.repo, title, body, marker,
    markdown: `Repository: ${draft.repo}\nLabels: none\n\n# ${title}\n\n${body}\n` };
}

function confirmIssue(issue, preview) {
  if (!issue || !Number.isSafeInteger(issue.number) || issue.number < 1 || issue.pull_request
    || issue.title !== preview.title || issue.body !== preview.body || issue.state !== 'open'
    || !Array.isArray(issue.labels) || issue.labels.length !== 0
    || issue.html_url !== `https://github.com/${preview.repo}/issues/${issue.number}`) {
    throw new Error('GitHub did not confirm the exact open, unlabeled draft; inspect the issue before proceeding');
  }
  dependencies(issue); // Validate R1 smaller-numbered dependencies after allocation.
  return { number: issue.number, url: issue.html_url, ...preview };
}

/** Retry is reconciliation only: an ambiguous POST must never be repeated automatically. */
async function publishDraft(draft, { execFile: executeFile = execFile, retry = false, beforeWrite = () => {} } = {}) {
  const preview = previewDraft(draft);
  if (typeof executeFile !== 'function' || typeof retry !== 'boolean') throw new Error('Invalid draft publication options');
  const endpoint = `repos/${preview.repo}/issues`;
  const request = async args => JSON.parse(await runGh(args, executeFile, 'GitHub draft publication'));
  // Paginate all states so a closed draft cannot be accidentally recreated.
  const pages = await request(['api', '--paginate', '--slurp', `${endpoint}?state=all&per_page=100`]);
  if (!Array.isArray(pages) || !pages.every(page => Array.isArray(page)
    && page.every(issue => issue && (issue.body === null || typeof issue.body === 'string')))) throw new Error('Malformed GitHub issue response');
  const matches = pages.flat().filter(issue => typeof issue.body === 'string' && issue.body.includes(preview.marker));
  if (matches.length > 1) throw new Error('Multiple issues match the draft identity; owner reconciliation required');
  if (matches.length === 1) return confirmIssue(matches[0], preview);
  if (retry) throw new Error('Draft not found; retry performed no write. Inspect the failed attempt before authorizing a fresh publication.');
  // The API avoids issue-template defaults and supplies only title/body. There
  // is no ready-label, queue, registration, release or scheduler operation here.
  await beforeWrite();
  const created = await request(['api', '--method', 'POST', endpoint, '-f', `title=${preview.title}`, '-f', `body=${preview.body}`]);
  return confirmIssue(created, preview);
}

async function main(args) {
  const [mode, filename, ...extra] = args;
  if (!['preview', 'publish', 'retry'].includes(mode) || !filename || extra.length) {
    throw new Error('Usage: node src/planning-drafts.js <preview|publish|retry> draft.json');
  }
  const draft = JSON.parse(require('node:fs').readFileSync(filename, 'utf8'));
  if (mode === 'preview') process.stdout.write(previewDraft(draft).markdown);
  else {
    const result = await publishDraft(draft, { retry: mode === 'retry' });
    process.stdout.write(`${result.markdown}\nPublished draft: ${result.url}\n`);
  }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
module.exports = { previewDraft, publishDraft };
