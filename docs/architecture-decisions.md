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
issue lock, using paginated all-state GitHub issue enumeration. Reconciliation
reads and validates one page of 100 entries at a time, including closed issues,
without a total-history subprocess buffer limit. Even a single page may exceed
1 MiB; only this read removes the subprocess byte cap. Complete captured stdout
and stderr remain in the execution journal. Failed or malformed pages block
publication, and subprocess diagnostics retain the underlying error code and
message, including buffer or resource failures. A lost creation
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

Admission mode is fixed by the original durable job. With
`milestoneAuthorization: true`, the exact original receipt and active, unexpired,
unrevoked grant remain required, including scope, revision, quota, native blockers
and textual dependencies. Disabling grants cannot convert that job to ready-label
authority. A replaced receipt still blocks ADE resume.

With milestone authorization disabled, a new ADE job records its original
ready-label admission: project/repository/issue identity, exact title/body digest,
configured ready label, owner registration and execution policy. No grant is
created or required. Resume re-reads the original open GitHub issue, rejects PRs
and decision issues, requires that same label and revision, and checks textual
`Depends on: #...` plus any configured dependency policy against canonical
verification/Claude-PASS/exact-head-green-CI/guarded-merge receipts. GitHub closure
alone is insufficient. Changed mode, label, repository, worker/host settings or
scope blocks resume. Older nongrant jobs without admission metadata fail closed;
do not fabricate metadata or reset their history to bypass this check.

The ADR issue needs its own explicit release under the project's original mode.
For a grant project, use its separate ordinary milestone approval and release.
For a nongrant project, inspect the final ADR delivery issue title/body and apply
the configured ready label through the existing owner workflow. Do not enable
grants for this purpose. Acceptance itself leaves that ADR issue unlabeled;
never mark the decision issue ready. Its deterministic decision marker and
`needs-owner-decision` label independently exclude it from execution.
Its worker then creates the specified ADR through the existing deterministic
verification, independent Claude review, exact-head CI and guarded merge path.
A proposed ADR, a locally committed file, a closed issue, or a merged PR without
that durable pipeline evidence cannot release dependent work.

After that delivery, inspect the original decision again and use `resume` with
its new digest and explicit confirmation. Resume checks the original durable job
identity, exact original issue revision and original admission mode (the unchanged
ready-label binding or active/unexpired grant and unchanged receipt), prerequisite merge evidence, independent ADR delivery evidence, remote
PR/head/merge identity and exact ADR contents both at the merge commit and on
the configured base branch. Existing ADR snapshots must still match; conflicting
changes require owner reconciliation. Failures retain a readable blocked reason.
These checks run again when execution picks up the resume request and before
subsequent execution attempts and delivery gates. Every check uses live GitHub
reads; a saved scope check is never reusable authority. A removed label or an
uncertain GitHub response returns the same job to `paused_owner_decision` with an
actionable reason and retained worktree, budget, failure history and raw logs.
There is no automatic acceptance or resume. After correcting a reversible cause,
inspect again and explicitly run authenticated `ralph decision resume PROJECT#ISSUE`
with the new digest. An edited source ticket or policy binding needs supported
owner recovery; restoring eligibility does not silently queue the job.

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

Decision status and synthetic lifecycle (ADE successor stage 3/3)

`ralph decision inspect PROJECT#ISSUE` and `GET /api/r1/jobs/ID` now expose
`status` / `evidence.decisions` navigation records, including decision and code
issue URLs, original job ID, notification owner/attempt/status, proposed ADR
content SHA-256, accepted ADR merge revision, resolution publication, execution
state and remaining action. The dashboard transcript drawer renders these
records above the full captured journal. Status reads are local and read-only;
they never contact GitHub to approve, publish or resume work. R1 reads refresh
from the matching canonical project job so CLI decisions survive an older queue
checkpoint. Full proposals, accepted ADR content, original diagnostics and paused
execution remain in canonical records and the complete journal.

`scopeCheck` explicitly reports `not_checked`, or the last resume validation's
result and timestamp. It is an observation, not a reusable permission. Resume
and subsequent execution still validate the original admission mode, live scope, applicable grant expiry/revocation,
dependencies and exact ADR contents. A previously passed observation does not
promise that admission remains valid now.

After verifying owner acceptance and guarded ADR delivery, `resume` appends one
deterministic resolution to the original GitHub decision issue and closes it.
The resolution links the accepted ADR at its merge commit, ADR PR, originating
implementation and original job. No new comment or mention is sent. A failed or
lost response remains visible and blocks the resume request; inspect and repeat
the owner command to reconcile the same issue. A changed resolution requires
owner reconciliation. Manual closure and comments remain irrelevant to approval.
Decision labels and original decision markers exclude issues from admission even
if somebody adds a ready label; the separate ADR proposal marker remains eligible
only through its own normal authorization/release path.

Synthetic validation uses temporary durable stores, fake GitHub transport and
the existing one-shot runner/owner CLI seams. `architecture-decisions.test.js`
executes a structured worker proposal, publication, restart recovery and independent
issue selection. `architecture-decision-actions.test.js` exercises authenticated
local owner acceptance, fixture ADR merge evidence, resolution/lost-response
reconciliation and real resumed deterministic verification/delivery. Its complete
synthetic pipeline also takes the ADR and original implementation through the
normal one-shot exact-head CI, independent review and guarded merge gates; the
independent task verifies while the original remains paused. ADR remote CI and
Claude results in these tests are synthetic adapters, not claims of a real
GitHub deployment. Existing integration tests separately exercise independent
Claude gates, target integration, exact-head CI and guarded merge. Negative cases
cover ordinary choices, opt-out, spoofed/closed decisions, grant expiry and
revocation, new permission/amendment, duplicate events, restarts and attempted
execution/merge without approval.

See [the separate rollout procedure](architecture-decisions-rollout.md). No live
policy, owner registry, ADE release labels or deployment is changed by this slice.
