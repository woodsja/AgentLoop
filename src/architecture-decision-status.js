'use strict';
const crypto = require('node:crypto');

// Navigation derived only from durable records. This never grants authority.
function decisionStatus(job) {
  const entries = [...(job.architectureDecisionHistory || []), ...(job.architectureDecision ? [job.architectureDecision] : [])];
  return entries.map(d => {
    const accepted = d.resumeEvidence?.merge;
    const action = d.resumedAt ? (job.terminalState === 'merged' ? 'complete' : 'monitor_implementation')
      : d.resumeRequested ? 'await_guarded_resume'
        : !d.ownerDecision ? 'record_owner_decision'
          : d.ownerDecision.action !== 'accept' ? 'reconcile_owner_response'
            : !accepted ? 'deliver_adr_then_request_resume' : 'request_resume';
    return {
      identity: d.identity, decisionIssue: d.issue || null,
      originatingIssue: { number: d.originatingIssue, url: `https://github.com/${job.repo}/issues/${d.originatingIssue}` },
      originatingJob: d.originatingJob, action, blockedReason: d.blockedReason || null,
      state: d.resumedAt ? (job.terminalState === 'merged' ? 'merged' : 'resumed') : 'paused',
      implementationState: job.terminalState || job.status,
      notification: d.notification, publication: d.publication, publicationError: d.publicationError || null,
      ownerDecision: d.ownerDecision || null,
      proposedAdr: d.adr ? { issue: d.adr.issue, path: d.adr.path, publication: d.adr.publication,
        publicationError: d.adr.publicationError || null,
        sha256: crypto.createHash('sha256').update(d.adr.content).digest('hex') } : null,
      acceptedAdr: accepted ? { path: d.adr.path, commit: accepted.commit,
        url: `https://github.com/${job.repo}/blob/${accepted.commit}/${d.adr.path}`, merge: accepted } : null,
      scopeCheck: d.scopeCheck || { status: 'not_checked', authorization: d.authorization,
        reason: 'Fresh original admission (ready label or exact grant), dependency and ADR validation required before authenticated owner resume.' },
      resolution: d.resolution || null, resumedAt: d.resumedAt || null,
      logs: { raw: job.r1ParentJobId ? `/api/log/${encodeURIComponent(job.r1ParentJobId)}?raw=1` : null,
        executionJournal: job.executionJournal || d.pausedExecution?.executionJournal || null },
    };
  });
}
module.exports = { decisionStatus };
