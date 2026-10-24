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
      proposal, references, originatingIssue: job.issue.number, originatingJob: job.r1ParentJobId || job.createdAt,
      notification: { status: 'pending' }, publication: 'pending' };
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
async function publish(project, job, store, options = {}) {
  const d = job.architectureDecision;
  if (!d || d.publication === 'complete') return;
  const gh = args => runGh(args, options.execFile, 'Architecture decision publication');
  const save = () => store.save(job);
  try {
    // Paginated, all-state reconciliation uses exact body identity, not search indexing.
    const pages = JSON.parse(await gh(['api', '--paginate', '--slurp', `repos/${project.repo}/issues?state=all&per_page=100`]));
    const matches = pages.flat().filter(i => !i.pull_request && typeof i.body === 'string' && i.body.includes(d.marker));
    if (matches.length > 1) throw new Error('Multiple decision issues have the same identity; owner reconciliation required');
    let remote = matches[0];
    if (!remote && d.createAttempted) throw new Error('Decision creation outcome uncertain; awaiting remote reconciliation, no duplicate creation attempted');
    if (!remote) {
      await gh(['label', 'create', 'needs-owner-decision', '--repo', project.repo, '--color', 'D876E3', '--description', 'Non-executable owner architecture decision', '--force']);
      d.createAttempted = true; save();
      remote = JSON.parse(await gh(['api', '--method', 'POST', `repos/${project.repo}/issues`, '-f', `title=Architecture decision: ${d.proposal.problem.slice(0, 160)}`, '-f', `body=${bodyFor(job, project.decisionOwner)}`, '-f', 'labels[]=needs-owner-decision']));
    }
    if (!Number.isSafeInteger(remote.number)) throw new Error('Decision publication returned no issue number');
    d.issue = { number: remote.number, url: remote.html_url }; save();
    await gh(['issue', 'edit', String(remote.number), '--repo', project.repo, '--add-label', 'needs-owner-decision', '--remove-label', project.readyLabel]);
    if (d.notification.status === 'pending') {
      d.notification = { status: project.decisionOwner ? 'attempting' : 'unavailable', at: store.now() }; save();
      if (project.decisionOwner) {
        try {
          await gh(['issue', 'edit', String(remote.number), '--repo', project.repo, '--add-assignee', project.decisionOwner]);
          d.notification.status = 'assigned';
        } catch (error) { d.notification.status = 'failed'; d.notification.error = error.message; }
        save();
      }
    } else if (d.notification.status === 'attempting') {
      d.notification.status = remote.assignees?.some(a => a.login === project.decisionOwner) ? 'assigned' : 'uncertain'; save();
    }
    d.publication = 'complete'; save();
  } catch (error) {
    d.publicationError = error.message; save();
  }
}
module.exports = { reconcile, FILE, context, instructions, readProposal, pause, publish, bodyFor };
