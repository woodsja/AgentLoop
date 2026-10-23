# Owner milestone grants

Grant commands store authorization evidence only. They do not publish issues,
apply labels, enqueue jobs, enable enforcement, change project settings, or start a
daemon. The separate exact-ticket release workflow below can apply a ready label. Admission remains unchanged for projects that have not opted in. Run these commands in the
existing owner operator environment, using the same owner configuration paths and
`AGENTLOOP_STATE_DIR` across restarts. Do not derive activation commands from issue
text or model responses: activation is an explicit owner decision.

Create an input JSON file with exactly these fields:

```json
{
  "project": "ralph",
  "repo": "woodsja/AgentLoop",
  "spec": {
    "identity": "woodsja/AgentLoop#103@owner-approved-revision-1",
    "digest": "<64 lowercase hex characters: SHA-256 of exact specification file bytes>"
  },
  "objective": "Implement the eight approved milestone tickets",
  "allowedCategories": ["implementation", "tests", "documentation"],
  "exclusions": ["production deployment", "owner configuration changes"],
  "revision": 1,
  "ticketLimit": 8,
  "expiresAt": "2026-11-01T00:00:00.000Z",
  "concurrencyLimit": 2
}
```

The project name and exact repository spelling must match a unique registration
in both owner configuration files, including the same canonical checkout. Staged
and active registered projects are eligible. Wildcards and unrestricted category
names are rejected. Category names use lowercase letters, digits and hyphens.
Ticket limits are integers from 1 to 100; concurrency is 1 to 10 and cannot exceed
the ticket limit. Expiration must be a canonical UTC ISO timestamp in the future,
within 366 days. These conservative initial bounds are not scheduler settings.

```sh
ralph grant draft milestone-1 --input grant.json --spec approved-spec.md --config /owner/config.json --projects /owner/projects.json
ralph grant inspect milestone-1 --config /owner/config.json --projects /owner/projects.json
ralph grant activate milestone-1 --digest <digest-from-inspect> --config /owner/config.json --projects /owner/projects.json
```

Activation previews the complete stored grant and prompts in a terminal. An owner
may instead supply `--yes` together with the inspected digest. Specification
identity, digest and exact bytes are retained in the draft; approval covers those
bytes and all grant terms. Changing the source file later cannot change the grant.
The grant digest is SHA-256 over the fixed-order stored terms, including registration
identity and specification bytes. Actor names come from the local operator account.
Revisions are positive integers; changed terms require a new grant ID and approval.
Repeating a draft with identical terms or activating an already active grant with
the matching digest returns the existing result without duplicating authorization.

`inspect` includes all lifecycle timestamps and approval events, including approval
requests and failures. The existing owner diagnostics log also captures complete
command previews, results and errors. The store is
`$AGENTLOOP_STATE_DIR/milestone-grants.json` (default: repository `state/`). Lifecycle
states are `draft`, `active`, `expired`, `paused`, `revoked`, and `completed`.
Inspection/activation persist expiration of draft, active and paused grants;
revoked and completed remain terminal. Pause, revoke and complete commands belong
to ticket 7 and are deliberately unavailable here.

Grant state and approval events are committed together by fsynced temporary-file
replacement and directory fsync. Interrupted approvals never resume automatically.
A crash before publication leaves the prior state; a crash after publication may
leave a fully approved active grant, which an explicit retry can inspect. Writers
share existing project registration locks, preventing concurrent registration or
grant edits. External owner edits are rechecked after approval. As with project
registration, a killed process can leave `.project-lock` directories next to the
configuration files and grant store. Inspect their `owner.json` records and verify
the owning process is stopped before removing those lock directories and retrying.
Unpublished `.tmp` files are never loaded. Preserve failed diagnostics; do not
replace or reset the grant store to recover a lock.

This change is implementation only. Independent review, exact-SHA CI and guarded
merge remain delivery requirements; none establishes a verified deployment.

## Exact-ticket authorization

This staged implementation adds explicit `ticket preview`, `ticket approve` and
`ticket release` commands. These commands do **not** enable milestone enforcement, modify live
configuration, enqueue a job, or authorize deployment. R1 enforcement is available
only through the separately owner-configured opt-in described below. Household
uses that same opt-in and validator through its existing autopilot.
Do not run release against live projects until those admission protections are
implemented and rollout is separately authorized. All implementation tests use
fake GitHub operations and isolated registrations.

A planner supplies a request JSON with exactly these fields:

```json
{
  "repo": "owner/demo",
  "issue": 106,
  "grantDigest": "<inspected grant SHA-256>",
  "revision": 1,
  "spec": {
    "identity": "owner/demo#103@owner-approved-revision-1",
    "digest": "<approved specification SHA-256>"
  },
  "ticketDigest": "<SHA-256 of JSON.stringify([exactTitle, exactBody]) in UTF-8>",
  "category": "tests",
  "scope": "in-scope",
  "reason": "Adds isolated tests within the approved objective; no excluded changes."
}
```

`scope` is `in-scope`, `ambiguous`, or `excluded`. These are planner declarations,
never authorization. Because category names and prose exclusions do not provide
machine-verifiable semantic permission, the conservative initial evaluator
requires owner confirmation of every exact ticket's scope. An LLM's verdict has
no authorization role. The owner must inspect the **entire title/body**, objective,
approved specification bytes, category and every exclusion in the preview. Owner
confirmation attests that the ticket fits the existing grant; it cannot enlarge
that grant. An excluded category or proposal is denied. An ambiguous request
remains held: resolve it with the owner and submit a precise in-scope request,
or obtain a new grant with separately approved terms. Do not merely relabel
excluded work as a permitted category.

In an isolated operator environment:

```sh
ralph ticket preview milestone-1 --input request.json --config /owner/config.json --projects /owner/projects.json
ralph ticket approve milestone-1 --input request.json --digest <request-digest-from-preview> --config /owner/config.json --projects /owner/projects.json
ralph ticket release milestone-1 --input request.json --config /owner/config.json --projects /owner/projects.json
```

Only the owner runs `approve`, using a terminal prompt or explicit `--yes` with
the inspected request digest. Planner requests must never invoke this owner-only
step automatically. Approval records exact scope but does not consume quota or
write a label. `release` independently checks the grant and GitHub issue again.
The request digest covers grant ID, all request fields and the configured ready
label. Editing the reason, category, label, issue, title/body, specification or
grant revision invalidates the prior confirmation. Grant terms and retained
specification bytes are hash-checked against owner-approved evidence.

Every decision returns `decision` (`ALLOW`, `WAIT`, `NEEDS_APPROVAL`, `DENY`),
human-readable `reasons`, the request digest, full issue, category, grant and
blockers. `WAIT` indicates missing, malformed or unconfirmed GitHub evidence;
`NEEDS_APPROVAL` indicates missing owner scope confirmation or ambiguity; `DENY`
indicates mismatched authorization, excluded scope, inactive/expired grants or
exhausted quota. An unknown/corrupt store or failed durable write raises an error
and writes no executable label. CLI diagnostics retain the full error. Preview
performs no GitHub mutations, but persists its decision for owner inspection.
Blockers use existing R1 dependency syntax and are displayed; satisfying them
remains the existing admission system's responsibility.

The shared grant store retains `ticketApprovals`, `receipts` and `ticketEvents`.
Receipts bind the exact repository/issue, request, title/body digest and bytes,
grant ID/digest/revision, timestamp and unique receipt ID. The full receipt and
one quota reservation are committed atomically **before** the configured label
is written. All grant/registration writers share the same locks; unexpected
external store edits fail rather than being overwritten. Receipts are immutable:
a changed request for a receipted issue is rejected. Retrying the identical
request reuses its receipt, including after failed or ambiguous labeling. If
GitHub already shows the receipted ready label, retry performs no label write.
No labels other than the configured ready label are accepted on a retry.

Decision events retain full ticket content, blockers, grant references, digest,
category and reasons, including before authorization and after release. Existing
owner diagnostics retain complete command output and errors. Receipt quota
counts distinct issues, including unconfirmed label attempts, never retries.
Preserve receipts and logs when reconciling failures; do not reset the store.

GitHub does not provide an atomic compare-title/body-and-add-label operation.
This helper reads the issue again immediately before receipt creation and label
mutation, but a concurrent edit can still race the label write. Receipts never
confer authority on changed bytes: receipt validation in **both** R1 and Household
admission is required before live rollout. The opt-in below provides admission protection in both runners; live rollout
requires a separate owner decision.

`node test/milestone-tickets.test.js` exercises the isolated grant/draft/approval/
receipt/mock-label flow, failures, retries, quota, exact identity and scope holds.
It is included in `npm test` for exact-head CI and the existing independent review
and guarded merge pipeline.


## R1 milestone admission (disabled on live projects)

The optional boolean `milestoneAuthorization` in an existing registered R1
project's autopilot policy enables receipt enforcement when it is exactly `true`.
Omission or `false` preserves existing R1 admission, review, labels and automatic
merge behavior. No shipped project enables it. Enabling a live project requires a
separate owner rollout decision; this implementation does not authorize that edit.

The existing R1 queue calls one read-only validator during periodic discovery,
direct/manual submission, queue advancement and resumed execution. Reserved mixed
implementation children are checked again before starting. The same validator
checks continuation before integration, worker admission, delivery and independent
review, and immediately before the guarded merge request. It reads the current
GitHub issue and the durable grant store again; cached labels and a prior receipt
check cannot authorize a later merge. Existing tests, independent Claude review,
exact-head CI, PR identity and target integration gates remain required.

Admission requires one exact receipt, active unexpired owner-approved grant,
unchanged grant/specification bytes and registered identity, exact scope approval,
and unchanged issue title/body at the exact repository/number with its configured
ready label. Queued tasks retain the exact grant/receipt binding, so an in-flight
job cannot silently switch to a replacement receipt. Dependency proof still requires independently reviewed, exact-head
CI-green merged job evidence; a closed issue is insufficient. GitHub reads or
store/configuration reads that fail or change during the check deny execution.
GitHub and the local store cannot participate in a single transaction: a change
after the final read cannot be atomically coupled to GitHub's merge operation.

The validator uses the same owner configuration, projects file and global
`AGENTLOOP_STATE_DIR/milestone-grants.json` as the grant/ticket commands, rather
than a worker-provided path or the per-project job store. Embedders can supply
`projectsPath` to `createR1Jobs` when using an isolated owner projects file.
Denied checks append and fsync specific diagnostics to
`$AGENTLOOP_STATE_DIR/milestone-admission.ndjson`. Existing task execution records
also retain execution/merge authorization failures. Authorization holds preserve
worktrees, branches, labels, attempts, reviews and captured output for owner
reconciliation; automatic cleanup does not remove held work.

`node test/r1-milestone-admission.test.js` uses isolated owner policies, the actual
R1 submit/discover/recover/advance/merge paths, fake GitHub and the real grant and
receipt commands. It covers missing/corrupt/unreadable authorization, dependency
proof and revocation, expiry or issue edits after green CI and independent PASS.


## Household milestone admission (disabled on live projects)

A registered project with `dependencyFormat: "household-blocked-by"` retains
its existing Household autopilot and `## Blocked by` parsing. Setting
`milestoneAuthorization` to exactly `true` additionally selects the shared R1
receipt validator. No shipped owner policy is changed. R1 discovery continues to
skip these projects, so the two runners do not compete for the ready label.

Household selection, including `--dry-run`, checks current receipts and GitHub
identity/content before choosing work. The selected title/body must match the
receipted revision as well as the fresh GitHub read. The issue lock protects new
job creation and recovery; authorization is rechecked under that lock and before
worker admission, integration, delivery, independent review and guarded merge.
Jobs retain their grant/receipt binding across restarts. A prior ready label,
merged prerequisites or a cached receipt never replaces a fresh check.

The shared validator selects Household dependency parsing from registered policy.
Every blocker still needs a terminal merged job with independent exact-head
Claude PASS, green CI, passing verification and reconciled issue closure. These
prerequisites are checked again during continuation and merge. Missing or
malformed metadata cannot silently become a dependency-free ticket.

Selection reports `ALLOW`, `WAIT` (dependency evidence or metadata),
`NEEDS_APPROVAL` (missing receipt or owner scope approval), or `DENY` (invalid,
modified, ambiguous duplicate or expired authorization). All blocking decisions
append fsynced diagnostics to `milestone-admission.ndjson`; no label is removed.
An execution-time hold also retains job evidence and its workspace for owner
reconciliation instead of retrying as a transient worker error. A dry run writes
only local diagnostics; it does not create jobs, mutate grants, execute workers
or write GitHub.

`node test/household-milestone-admission.test.js` proves all four decisions using
isolated stores, real grant/receipt commands and fake GitHub adapters through the
actual Household selection, worker admission, resume and guarded merge paths.
It also checks stale prerequisite proof, receipt replacement, scope/identity
changes, retained evidence, no duplicate execution and R1 scanner exclusion.
No real Household work, readiness label, grant activation, production setting or
deployment is authorized by these tests or this implementation.
