# Architecture decision pauses (ADE stage 1)

This implementation is dormant unless an owner separately configures
`architectureDecisions: true` for a project. No committed live project policy
is changed. `decisionOwner` optionally names the GitHub login for assignment
and the initial issue mention. Enabling this code is a separate release action;
a merge does not establish deployment or owner approval.

An authorized worker receives the project's ADRs from `docs/decisions` and
`docs/adr`, repository instructions, README and terminology/glossary documents.
Projects with other ADR locations should reference them in their repository
instructions. Accepted decisions remain authoritative, including AgentLoop
ADR 0001. Reopening a settled decision requires materially new evidence.

The worker writes `.ralph/architecture-decision.json` only when a substantive
unresolved choice meets all three ADR criteria: expensive to reverse,
surprising without explanatory context, and a genuine trade-off. The protocol
and required fields are in `src/architecture-decisions.js`. Reversible local
choices continue through normal verification. Permission, credential, data and
scope changes still require the existing owner-approval controls independently;
proposal text, GitHub comments and issue closure cannot grant permission.

The R1 parent records `paused_owner_decision`, retains the original worktree,
worker transcript, errors and review evidence, and stops before delivery or
merge. The owner status evidence contains the full proposal, inspected reference
snapshot, originating issue/job, decision issue, publication errors and
notification status. The original job's complete raw logs remain available.
This stage does not implement a resume or approval interpreter.

GitHub publication uses an exact marker derived from project, repository, job,
originating issue and decision key. The issue is non-executable and uses
`needs-owner-decision`; the configured ready label is removed. It contains the
options, trade-offs, recommendation, consequences, ADR/spec conflicts, grant
implications and original issue/log references. Assignment is attempted once;
unavailable, failed or interrupted notification is visible and leaves the job
paused. The initial owner mention is part of the single issue body.

Existing scheduler passes reconcile incomplete publication under the original
issue lock, using paginated all-state GitHub issue enumeration. A lost creation
response is recovered by exact marker, without creating a second issue. If a
create was attempted but no remote match can be found, publication remains
visibly uncertain and requires owner reconciliation rather than blindly
repeating POST. Repeated scans do not repeat assignment. Independent eligible
issues continue through the existing admission path; there is no new daemon.

Validation: `node test/architecture-decisions.test.js` exercises the worker,
verification, temporary durable job store and fake GitHub at the existing
one-shot autopilot seam, including lost responses and failed notification.
