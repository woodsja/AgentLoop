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
function historyResponse(raw) {
  const separator = /\r?\n\r?\n/.exec(raw);
  const status = /^HTTP\/[^ ]+ (\d{3})(?: |\r?\n)/.exec(raw);
  if (!separator || !status || status[1] !== '200') {
    const error = new Error(`Decision history page missing successful HTTP headers${status ? ` (HTTP ${status[1]})` : ''}`);
    if (status) error.statusCode = Number(status[1]);
    throw error;
  }
  const headers = raw.slice(0, separator.index).split(/\r?\n/).slice(1);
  if (headers.some(line => !/^[A-Za-z0-9-]+:/.test(line) || /^location:/i.test(line))) throw new Error('Unexpected decision history response headers or redirect');
  return { headers, body: JSON.parse(raw.slice(separator.index + separator[0].length)) };
}
async function findDecision(gh, repo, marker) {
  const seen = new Set(), visited = new Set(), cursors = new Set();
  const ghHost = String(process.env.GH_HOST || 'github.com').toLowerCase();
  const hosts = ghHost === 'github.com' ? ['api.github.com'] : [ghHost, `api.${ghHost}`];
  const filters = { state: 'all', sort: 'created', direction: 'asc', per_page: String(HISTORY_PAGE_SIZE) };
  let repositoryId;
  async function target(raw, relation, page) {
    const invalid = () => { throw new Error('Unexpected decision history pagination target'); };
    // Parsing is for validation only. The original string is the request argument.
    if (!/^https:\/\//.test(raw) || /[\s\\]/.test(raw) || /%(?![a-f0-9]{2})/i.test(raw)) invalid();
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.username || url.password || url.hash || raw.includes('#') || url.port) invalid();
    const prefix = ghHost !== 'github.com' ? '(?:api/v3/)?' : '';
    const named = new RegExp(`^/${prefix}repos/([^/]+)/([^/]+)/issues$`, 'i').exec(url.pathname);
    const numeric = new RegExp(`^/${prefix}repositories/([1-9][0-9]*)/issues$`, 'i').exec(url.pathname);
    if (named ? `${named[1]}/${named[2]}`.toLowerCase() !== repo.toLowerCase() : !numeric) invalid();
    const params = url.searchParams;
    const keys = [...params.keys()];
    if (new Set(keys).size !== keys.length || keys.some(key => !Object.hasOwn(filters, key) && !['page', 'after', 'before'].includes(key))
      || Object.entries(filters).some(([key, value]) => params.get(key) !== value)) invalid();
    const after = params.get('after'), before = params.get('before');
    if ((after !== null && before !== null) || (after !== null && (!after || !['next', 'last'].includes(relation)))
      || (before !== null && (!before || !['prev', 'first'].includes(relation)))
      || [after, before].some(value => value !== null && /[\s\x00-\x1f\x7f]/.test(value))) invalid();
    const number = params.has('page') ? Number(params.get('page')) : null;
    if (number !== null && (!/^[1-9][0-9]*$/.test(params.get('page')) || !Number.isSafeInteger(number))) invalid();
    if (number === null && after === null && before === null) invalid();
    if (number !== null && ((relation === 'next' && number !== page + 1) || (relation === 'prev' && number !== page - 1)
      || (relation === 'first' && number !== 1) || (relation === 'last' && number < page))) invalid();
    if (numeric) {
      if (repositoryId === undefined) {
        const metadata = historyResponse(await gh(['api', '--include', `repos/${repo}`])).body;
        if (!Number.isSafeInteger(metadata?.id) || metadata.id < 1 || typeof metadata.full_name !== 'string' || metadata.full_name.toLowerCase() !== repo.toLowerCase()) invalid();
        repositoryId = String(metadata.id);
      }
      if (numeric[1] !== repositoryId) invalid();
    }
    // Identity for integrity checks only; never used to construct a request.
    return { raw, number, cursor: after, identity: JSON.stringify([number, after, before]) };
  }
  let match, advertisedLastPage = 1, lastTarget;
  let currentTarget = { identity: JSON.stringify([1, null, null]) };
  let endpoint = `repos/${repo}/issues?state=all&sort=created&direction=asc&per_page=${HISTORY_PAGE_SIZE}&page=1`;
  for (let page = 1; page <= MAX_HISTORY_PAGES; page++) {
    try {
      if (visited.has(endpoint)) throw new Error('Repeated decision history next URL');
      visited.add(endpoint);
      const { headers, body: issues } = historyResponse(await gh(['api', '--include', endpoint]));
      const links = headers.filter(line => /^link:/i.test(line));
      if (links.length > 1) throw new Error('Ambiguous decision history pagination');
      const relations = new Map();
      if (links.length) {
        // Split only between link values: opaque cursors may contain commas.
        const values = links[0].slice(5).trim().split(/,\s*(?=<)/);
        for (const link of values) {
          const parsed = /^<([^>]+)>;\s*rel="(next|prev|first|last)"$/.exec(link);
          if (!parsed || relations.has(parsed[2])) throw new Error('Malformed decision history pagination');
          relations.set(parsed[2], await target(parsed[1], parsed[2], page));
        }
      }
      const next = relations.get('next'), last = relations.get('last');
      if (last) {
        if ((last.number !== null && last.number < advertisedLastPage)
          || (lastTarget && last.identity !== lastTarget.identity)) throw new Error('Contradictory decision history last page');
        advertisedLastPage = Math.max(advertisedLastPage, last.number || page);
        lastTarget = last;
      }
      const reachedLast = lastTarget && (lastTarget.cursor !== null || lastTarget.number === null
        ? lastTarget.identity === currentTarget.identity : lastTarget.number === page);
      if (!next && (advertisedLastPage > page || (lastTarget && !reachedLast))) throw new Error('Partial decision history pagination; next page missing');
      if (next && (visited.has(next.raw) || (next.cursor !== null && cursors.has(next.cursor)) || reachedLast)) throw new Error('Cyclic or no-progress decision history pagination');
      if (!Array.isArray(issues) || issues.length > HISTORY_PAGE_SIZE || (next && issues.length !== HISTORY_PAGE_SIZE) || !issues.every(validHistoryIssue)) throw new Error('Malformed or partial decision history page');
      for (const issue of issues) {
        if (seen.has(issue.number)) throw new Error('Duplicate issue across decision history pages; owner reconciliation required');
        seen.add(issue.number);
        if (!Object.hasOwn(issue, 'pull_request') && exactMarker(issue.body, marker)) {
          if (match) throw new Error('Multiple decision issues have the same identity; owner reconciliation required');
          match = issue;
        }
      }
      if (!next) return match;
      if (next.cursor !== null) cursors.add(next.cursor);
      advertisedLastPage = Math.max(advertisedLastPage, page + 1);
      endpoint = next.raw;
      currentTarget = next;
    } catch (error) {
      error.message = `Decision history page ${page}: ${error.message}`;
      throw error;
    }
  }
  throw new Error('Decision history page resource limit exceeded; owner reconciliation required');
}
// gh follows redirects internally. Include alone exposes only the final response;
// GH_DEBUG=api stderr retains intermediate statuses so a redirected scan cannot
// authorize publication. The normal execution adapter journals both raw pipes.
function historyGh(args, executeFile = require('./execution-log').execFile) {
  return runGh(args, (file, argv, options, callback) => {
    // Scope debugging to these reads; --verbose changes gh's stdout format.
    return executeFile(file, argv, { ...options, env: { ...options.env, GH_DEBUG: 'api' } }, (error, stdout, stderr) => {
      const lines = String(stderr || '').split(/\r?\n/).filter(line => /^< HTTP/.test(line));
      const statuses = lines.map(line => /^< HTTP\/\d+(?:\.\d+)? (\d{3})(?: [^\r\n]*)?$/.exec(line));
      const redirect = statuses.find(status => status && /^3/.test(status[1]));
      if (!error && redirect) {
        error = Object.assign(new Error(`Unapproved decision history redirect (HTTP ${redirect[1]})`), { statusCode: Number(redirect[1]) });
      }
      if (!error) {
        const included = /^HTTP\/[^ ]+ (\d{3})(?: |\r?\n)/.exec(String(stdout));
        // Missing, malformed, additional or inconsistent debug responses cannot
        // prove that gh did not follow a redirect. Keep both raw pipes intact.
        if (statuses.length !== 1 || !statuses[0] || (included && statuses[0][1] !== included[1])) {
          error = new Error('Missing, malformed or inconsistent decision history debug response status');
        }
      }
      callback(error, stdout, stderr);
    });
  }, 'Architecture decision history');
}
async function publish(project, job, store, options = {}) {
  const d = job.architectureDecision;
  if (!d || d.publication === 'complete') return;
  const gh = args => runGh(args, options.execFile, 'Architecture decision publication');
  const save = () => store.save(job);
  try {
    let remote = await findDecision(args => historyGh(args, options.execFile), project.repo, d.marker);
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
    save();
    require('./execution-log').currentRecorder()?.('architecture_publication_failure', d.publicationFailure);
  }
}
module.exports = { captureAdmission: require('./architecture-decision-admission').capture, reconcile, FILE, context, instructions, readProposal, pause, publish, bodyFor };
