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
Stage 1 provides the durable pause; the owner actions below extend it with guarded resume.

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

Owner decision and guarded resume (ADE successor stage 2/3)

The existing local operator CLI now supports `ralph decision inspect|accept|reject|revise|resume PROJECT#ISSUE`.
It uses the owner-controlled config files and OS account, explicit confirmation
(or `--yes`) and an inspected digest, like the grant commands. It is an operator
control, not a worker tool or GitHub comment interpreter. Actor identity is
obtained from the local session; request fields cannot supply an actor or an
approval. There is no new public HTTP endpoint or remote ChatGPT identity
assertion. Use the authenticated operator session for decisions made in GitHub
or ChatGPT. Publication, labels, comments and closure never constitute approval.

Inspect using the same `--config` and `--projects` paths as other owner commands.
Save the returned digest. Acceptance uses `--input decision.json --digest DIGEST`
and explicit confirmation. Example input:

```json
{
  "option": "SQL",
  "rationale": "Transactions justify the migration cost.",
  "adrPath": "docs/decisions/0002-storage.md",
  "adrIssue": 200,
  "supersedes": [],
  "conflictResolution": "Preserve ADR 0001; no conflict with accepted policy.",
  "requiresMilestoneAmendment": false,
  "conflictsResolved": true
}
```

`option` must exactly match a proposed option. `adrIssue` must identify a separate,
open, unlabeled draft issue prepared by the owner for ADR delivery. Acceptance
appends the exact proposed ADR to that issue without releasing it. The ADR
contains context, all alternatives, accepted trade-offs, rationale, consequences
and explicit conflict/supersession links. It must use a new filename in the
established `docs/decisions` or `docs/adr` directory. Prior ADRs are preserved. Set `conflictsResolved` to true only after resolving all
identified conflicts; unresolved conflicts keep the original job blocked.
The milestone amendment assessment does not grant new scope: if the choice
needs additional scope, credentials, host access or deployment, set it true;
resume remains blocked pending separate milestone reconciliation. Architectural
acceptance cannot amend the original grant.

Rejection and requests for revised alternatives use an input containing
`rationale`. These actions record the owner's response and leave implementation
blocked. Recorded decisions are immutable; a different submission cannot
replace acceptance or rejection. Repeating the same submission returns the
original evidence and retries an uncertain ADR publication by its exact marker.

The ADR issue needs its own ordinary milestone approval and explicit release.
Its worker then creates the specified ADR through the existing deterministic
verification, independent Claude review, exact-head CI and guarded merge path.
A proposed ADR, a locally committed file, a closed issue, or a merged PR without
that durable pipeline evidence cannot release dependent work.

After that delivery, inspect the original decision again and use `resume` with
its new digest and explicit confirmation. Resume checks the original durable job
identity, exact original issue revision, active/unexpired grant and unchanged
receipt, prerequisite merge evidence, independent ADR delivery evidence, remote
PR/head/merge identity and exact ADR contents both at the merge commit and on
the configured base branch. Existing ADR snapshots must still match; conflicting
changes require owner reconciliation. Failures retain a readable blocked reason.
These checks run again when execution picks up the resume request.

The original parent queue record is moved back to pending once, retaining its
ID, phases, errors, child associations and complete execution journal. The
original worktree is reused; a missing worktree requires explicit recovery.
The next implementation consumes the next existing run, with no retry counter
reset. The original decision and paused execution checkpoint remain available
in `architectureDecisionHistory` and the owner status evidence. The accepted ADR
is supplied to the resumed worker; future jobs discover it through the existing
repository ADR context. Neither this code nor its merge activates project
policy, releases the staged ADE batch or deploys production.

Focused validation also includes `node test/architecture-decision-actions.test.js`.

The #145 CLI extension updates only the `src/cli.js` entry in
`docs/evidence/issue-142/current-source.sha256` to match the current source.
Historical source digests, archived execution records and provenance remain
unchanged; the recovery verifier still checks their original Git blobs.
