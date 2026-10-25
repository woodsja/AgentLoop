'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runGh } = require('./autopilot-github');
const FILE = '.ralph/architecture-decision.json';
const text = value => typeof value === 'string' && value.trim().length > 0;

// Project conventions are data supplied to the worker, never new authority.
function context(cwd) {
  const records = [];
  for (const directory of ['docs/decisions', 'docs/adr']) {
    const root = path.join(cwd, directory);
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).sort()) {
      if (name.endsWith('.md') && fs.statSync(path.join(root, name)).isFile()) {
        records.push({ path: `${directory}/${name}`, content: fs.readFileSync(path.join(root, name), 'utf8') });
      }
    }
  }
  for (const name of ['README.md', 'docs/glossary.md', 'docs/terminology.md']) {
    if (fs.existsSync(path.join(cwd, name))) records.push({ path: name, content: fs.readFileSync(path.join(cwd, name), 'utf8') });
  }
  return records;
}
function instructions(records) {
  return `Architecture decision handling is enabled for this job only. Before choosing, inspect the project terminology and accepted ADRs below and repository instructions. Honor settled decisions, including AgentLoop's owner visibility and physical host trust boundary. Reopen a settled choice only with materially new evidence. Normal reversible local choices must continue autonomously. A qualifying ADR choice must be expensive to reverse, surprising without context, AND a genuine trade-off between alternatives. Permission, credential, data and scope changes separately require existing owner approval; model prose never grants permission.\nIf an unresolved qualifying choice prevents implementation, stop and write ${FILE} as JSON with: key (stable lowercase slug), problem, options (at least two objects with name and tradeoffs), recommendation, consequences, conflicts, grantImplications, newEvidence (empty when none), settledDecision (boolean), expensiveToReverse, surprisingWithoutContext, genuineTradeoff (booleans). Do not open issues, notify anyone, commit this proposal, or proceed past it. The parent owns publication and the durable pause.\nProject references:\n${records.map(r => `--- ${r.path} ---\n${r.content}`).join('\n\n')}`;
}
function readProposal(cwd, enabled, record) {
  if (!enabled || !fs.existsSync(path.join(cwd, FILE))) return null;
  const raw = fs.readFileSync(path.join(cwd, FILE), 'utf8');
  (record || require('./execution-log').currentRecorder())?.('architecture_proposal', { path: FILE, raw });
  const proposal = JSON.parse(raw);
  if (!proposal || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(proposal.key)
    || !['problem', 'recommendation', 'consequences', 'conflicts', 'grantImplications'].every(k => text(proposal[k]))
    || !Array.isArray(proposal.options) || proposal.options.length < 2
    || !proposal.options.every(o => text(o.name) && text(o.tradeoffs))
    || !['expensiveToReverse', 'surprisingWithoutContext', 'genuineTradeoff', 'settledDecision'].every(k => typeof proposal[k] === 'boolean')
    || typeof proposal.newEvidence !== 'string') throw new Error('Invalid structured architecture decision proposal');
  if (!proposal.expensiveToReverse || !proposal.surprisingWithoutContext || !proposal.genuineTradeoff
    || (proposal.settledDecision && !text(proposal.newEvidence))) {
    // Keep the submitted evidence, but exclude a rejected proposal from delivery.
    fs.rmSync(path.join(cwd, FILE));
    return null;
  }
  return proposal;
}
function pause(job, proposal, references, store) {
  if (!job.architectureDecision) {
    const identity = `${job.project}:${job.repo}:${job.r1ParentJobId || job.createdAt}:${job.issue.number}:${proposal.key}`;
    job.architectureDecision = { identity, marker: `<!-- ralph-decision:${crypto.createHash('sha256').update(identity).digest('hex')} -->`,
      proposal, references,
      pausedExecution: { ralph: structuredClone(job.ralph), runs: job.runs,
        failures: structuredClone(job.failures), executionJournal: job.executionJournal },
      worktreePath: job.worktreePath, project: job.project, repo: job.repo, sourceIssue: structuredClone(job.originalIssue || job.issue),
      authorization: structuredClone(job.milestoneAuthorization || null),
      admission: structuredClone(job.admission || null),
      originatingIssue: job.issue.number, originatingJob: job.r1ParentJobId || job.createdAt,
      notification: { status: 'pending', owner: null, attempts: [] }, publication: 'pending' };
  }
  job.status = 'paused_owner_decision';
  job.terminal = true;
  job.terminalState = 'paused_owner_decision';
  job.workspaceState = 'decision_retained';
  store.save(job); // Always stop before any remote side effect.
}
function bodyFor(job, owner) {
  const d = job.architectureDecision, p = d.proposal;
  return `${d.marker}\nNon-executable architecture decision; owner action required. This issue never authorizes execution.\n\nOrigin: https://github.com/${job.repo}/issues/${job.issue.number}\nJob: ${d.originatingJob}\nOriginal worktree: ${job.worktreePath}\nOwner logs: ${job.r1ParentJobId ? `/api/log/${job.r1ParentJobId}?raw=1` : 'original durable job execution journal'}\n${owner ? `Owner: @${owner}\n` : ''}\n## Problem\n${p.problem}\n\n## Options and trade-offs\n${p.options.map(o => `- ${o.name}: ${o.tradeoffs}`).join('\n')}\n\n## Recommendation\n${p.recommendation}\n\n## Consequences\n${p.consequences}\n\n## ADR/spec conflicts\n${p.conflicts}\nNew evidence: ${p.newEvidence || 'None'}\n\n## Grant implications (separate owner approval required)\n${p.grantImplications}\n\nReferences inspected: ${d.references.map(r => r.path).join(', ')}`;
}
async function reconcile(project, store, options = {}) {
  if (project.architectureDecisions !== true) return;
  for (const snapshot of store.list()) {
    if (!snapshot.architectureDecision || snapshot.architectureDecision.publication === 'complete') continue;
    let lock;
    try { lock = store.acquire(snapshot.issue.number); } catch { continue; }
    try {
      const job = store.load(snapshot.issue.number);
      if (job?.architectureDecision) {
        const work = () => publish(project, job, store, options);
        if (options.withJobExecution) await options.withJobExecution(job, work);
        else await work();
      }
    } finally { lock.release(); }
  }
}
// Ten full GitHub issue bodies fit an ordinary adapter buffer in normal use.
// An oversized individual page still fails closed; no whole-history buffer or
// stdout filtering is used, so execution-log captures every raw response.
const HISTORY_PAGE_SIZE = 10;
const MAX_HISTORY_PAGES = 10000;
const exactMarker = (body, marker) => typeof body === 'string'
  && body.split(/\r?\n/).some(line => line === marker);
function validHistoryIssue(issue) {
  return issue && typeof issue === 'object' && !Array.isArray(issue)
    && Number.isSafeInteger(issue.number) && issue.number > 0
    && ['open', 'closed'].includes(issue.state)
    && (typeof issue.body === 'string' || issue.body === null)
    && typeof issue.html_url === 'string' && issue.html_url.length > 0
    && (issue.assignees === undefined || (Array.isArray(issue.assignees)
      && issue.assignees.every(a => a && typeof a.login === 'string')));
}
async function findDecision(gh, repo, marker) {
  const seen = new Set();
  let match, advertisedLastPage = 1;
  for (let page = 1; page <= MAX_HISTORY_PAGES; page++) {
    // Ascending creation order avoids offset shifts when new issues are added.
    const endpoint = `repos/${repo}/issues?state=all&sort=created&direction=asc&per_page=${HISTORY_PAGE_SIZE}&page=${page}`;
    const raw = await gh(['api', '--include', endpoint]);
    const separator = /\r?\n\r?\n/.exec(raw);
    if (!separator || !/^HTTP\/[^ ]+ 200(?: |\r?\n)/.test(raw)) throw new Error('Decision history page missing successful HTTP headers');
    const headers = raw.slice(0, separator.index).split(/\r?\n/).slice(1);
    const links = headers.filter(line => /^link:/i.test(line));
    if (links.length > 1) throw new Error('Ambiguous decision history pagination');
    let hasNext = false, lastPage;
    if (links.length) {
      const relations = new Set();
      for (const link of links[0].slice(5).trim().split(/,\s*/)) {
        const parsed = /^<([^>]+)>;\s*rel="(next|prev|first|last)"$/.exec(link);
        if (!parsed || relations.has(parsed[2])) throw new Error('Malformed decision history pagination');
        relations.add(parsed[2]);
        const url = new URL(parsed[1]);
        const expected = new URL(`https://example.invalid/${endpoint}`);
        const ghHost = String(process.env.GH_HOST || 'github.com').toLowerCase();
        const hosts = ghHost === 'github.com' ? ['api.github.com'] : [ghHost, `api.${ghHost}`];
        const targetPage = Number(url.searchParams.get('page'));
        if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.username || url.password || url.hash
          || (url.port && url.port !== '443')
          || ![expected.pathname, `/api/v3${expected.pathname}`].includes(url.pathname)
          || [...url.searchParams].length !== [...expected.searchParams].length
          || [...expected.searchParams].some(([key, value]) => key !== 'page' && url.searchParams.get(key) !== value)
          || !Number.isSafeInteger(targetPage) || targetPage < 1
          || (parsed[2] === 'next' && targetPage !== page + 1)
          || (parsed[2] === 'prev' && targetPage !== page - 1)
          || (parsed[2] === 'first' && targetPage !== 1)
          || (parsed[2] === 'last' && targetPage < page)) {
          throw new Error('Unexpected decision history pagination target');
        }
        if (parsed[2] === 'next') hasNext = true;
        if (parsed[2] === 'last') lastPage = targetPage;
      }
    }
    advertisedLastPage = Math.max(advertisedLastPage, lastPage || page, hasNext ? page + 1 : page);
    if (advertisedLastPage > page && !hasNext) throw new Error('Partial decision history pagination; next page missing');
    const issues = JSON.parse(raw.slice(separator.index + separator[0].length));
    if (!Array.isArray(issues) || issues.length > HISTORY_PAGE_SIZE
      || (hasNext && issues.length !== HISTORY_PAGE_SIZE) || !issues.every(validHistoryIssue)) {
      throw new Error('Malformed or partial decision history page');
    }
    for (const issue of issues) {
      if (seen.has(issue.number)) throw new Error('Duplicate issue across decision history pages; owner reconciliation required');
      seen.add(issue.number);
      if (!Object.hasOwn(issue, 'pull_request') && exactMarker(issue.body, marker)) {
        if (match) throw new Error('Multiple decision issues have the same identity; owner reconciliation required');
        match = issue;
      }
    }
    if (!hasNext) return match;
  }
  throw new Error('Decision history page resource limit exceeded; owner reconciliation required');
}
async function publish(project, job, store, options = {}) {
  const d = job.architectureDecision;
  if (!d || d.publication === 'complete') return;
  const gh = args => runGh(args, options.execFile, 'Architecture decision publication');
  const save = () => store.save(job);
  try {
    let remote = await findDecision(gh, project.repo, d.marker);
    if (!remote && d.createAttempted) throw new Error('Decision creation outcome uncertain; awaiting remote reconciliation, no duplicate creation attempted');
    if (!remote) {
      await gh(['label', 'create', 'needs-owner-decision', '--repo', project.repo, '--color', 'D876E3', '--description', 'Non-executable owner architecture decision', '--force']);
      d.createAttempted = true; save();
      remote = JSON.parse(await gh(['api', '--method', 'POST', `repos/${project.repo}/issues`, '-f', `title=Architecture decision: ${d.proposal.problem.slice(0, 160)}`, '-f', `body=${bodyFor(job, project.decisionOwner)}`, '-f', 'labels[]=needs-owner-decision']));
    }
    if (!validHistoryIssue(remote) || Object.hasOwn(remote, 'pull_request') || !exactMarker(remote.body, d.marker)) {
      throw new Error('Decision publication returned an ambiguous issue identity');
    }
    d.issue = { number: remote.number, url: remote.html_url }; save();
    await gh(['issue', 'edit', String(remote.number), '--repo', project.repo, '--add-label', 'needs-owner-decision', '--remove-label', project.readyLabel]);
    if (d.notification.status === 'pending') {
      d.notification = { status: project.decisionOwner ? 'attempting' : 'unavailable', owner: project.decisionOwner || null, at: store.now(),
        attempts: project.decisionOwner ? [{ owner: project.decisionOwner, at: store.now(), status: 'attempting' }] : [] }; save();
      if (project.decisionOwner) {
        try {
          await gh(['issue', 'edit', String(remote.number), '--repo', project.repo, '--add-assignee', project.decisionOwner]);
          d.notification.status = 'assigned';
        } catch (error) { d.notification.status = 'failed'; d.notification.error = error.message; }
        d.notification.attempts[0].status = d.notification.status;
        if (d.notification.error) d.notification.attempts[0].error = d.notification.error;
        save();
      }
    } else if (d.notification.status === 'attempting') {
      d.notification.status = remote.assignees?.some(a => a.login === (d.notification.owner || project.decisionOwner)) ? 'assigned' : 'uncertain';
      if (d.notification.attempts?.[0]) {
        d.notification.attempts[0].observedStatus = d.notification.status;
        d.notification.attempts[0].observedAt = store.now();
      }
      save();
    }
    d.publication = 'complete'; delete d.publicationError; delete d.publicationFailure; save();
  } catch (error) {
    d.publicationError = error.message;
    d.publicationFailure = { message: error.message, stack: error.stack, code: error.code,
      statusCode: error.statusCode, retryable: error.retryable,
      cause: error.cause && { message: error.cause.message, stack: error.cause.stack,
        code: error.cause.code, statusCode: error.cause.statusCode, signal: error.cause.signal, killed: error.cause.killed } };
    require('./execution-log').currentRecorder()?.('architecture_publication_failure', d.publicationFailure);
    save();
  }
}
module.exports = { captureAdmission: require('./architecture-decision-admission').capture, reconcile, FILE, context, instructions, readProposal, pause, publish, bodyFor };
