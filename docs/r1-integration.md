# R1 final integration

Independent issues continue developing in their registered issue worktrees. A
published PR enters `synchronizeIssueBranch` before the existing CI and Claude
review gates. The synchronizer checks issue/branch/worktree/PR identity, fetches
the configured target, resolves its commit SHA, and records ancestry evidence.
A behind branch receives a normal two-parent merge; published history is never
rebased or force-pushed. An unexpected PR head is an operator handoff.

A conflict gets one existing authorized Ralph task, with the original issue,
repository instructions, exact old and target commits, paths and index stages.
The worker must resolve and stage without committing. Policy/configuration and
lockfile conflicts are handed off; protected edits and changes to other
registered worktrees are rejected. Ambiguous requirements and divergent
architecture must be refused by the resolver. Additive package test commands
from both parents must survive. Unmerged entries and conflict markers block
commit. Tests failing on an integrated commit get one repair task, followed by
a new commit and another deterministic verification. Both verifier results
remain available. The exact final commit must pass before an ordinary push to
the same branch. New CI and independent review must refer to this SHA.

## Bounds and recovery

There are at most three synchronization records per issue job (including initial
up-to-date ancestry evidence), one conflict task and one repair task per record,
and two transient interruption retries per active record. Review allows two
attempts per SHA and eight attempts across the entire job. Legacy review counts
without attributed history count against the current SHA. No review history is
reset. A malformed verdict, exception or interrupted reviewer remains fail
closed under the existing review policy.

`integrationActive` records the current transition before merge, worker,
commit, verifier and push side effects. `integrationHistory` retains finalized
records with identities, old/target/final SHAs, affected paths, stages, worker
results, prior verification/CI/review evidence, complete captured command and
verifier logs, push results and timestamps. The job's execution journal also
retains checkpoint changes. Historical job failures remain intact. An escalated
integration worktree is retained for inspection rather than automatically
removed by terminal workspace cleanup.

On reload, an existing expected merge or repair commit is recognized by its
parents. A completed verifier checkpoint (including its completion log event)
is reused only for its exact commit. A verifier interrupted before a completion
record may run again: deterministic verification is safe to repeat. A worker
with an unfinished invocation is handed off, never silently invoked again.
The resolver uses the existing owner-scoped CLI-worker service, tracked by the
parent's process lifecycle; it does not replay a completed implementation child.
Worker admission refuses an active implementation child or a stopping parent.
Pre-commit task-service test failures remain captured; a completed resolver
process may proceed to the mandatory exact-commit verifier after environment
preparation. Only that verifier can authorize publishing, and a red result
requires the bounded repair path. A failed or timed-out worker never qualifies.
Observation failures before an attempt exists also stop after three failures.
Persisted push intent accepts only the old or final remote head; an already
completed push is reconciled without another push or another PR. Infrastructure
failures retain active checkpoints for bounded retry. Ordinary failed verification
never grants permission to skip a gate.
An integration handoff retains its worktree, published branch and open PR;
autonomous failure cleanup may report the failure but cannot delete these assets.

## Merge serialization and race window

The existing durable job lock implementation also provides a lock keyed by
repository and target branch in the project's state directory. Final integration,
CI observation, review, target recheck and guarded merge share this lock for each
one-shot invocation; pending CI releases it. Other issue implementation workers
remain concurrent. Processes using the same project state directory serialize;
separate installations or owner aliases using different state directories do
not share this lock and must not be treated as globally serialized.

Immediately before requesting merge, R1 separately observes the PR head and
remote target SHA, comparing the latter with the recorded integrated target.
An advanced target invalidates the active approval and repeats synchronization,
verification, CI and review within the same total bounds. GitHub's existing
expected-head merge guard remains in place, as does merged-PR/issue-closure
reconciliation. GitHub's merge API cannot atomically assert an expected base SHA:
an external merge between the final target read and the API call remains a race
window. The local target lock closes that window between cooperating R1 jobs,
not between unrelated GitHub writers.

## Delivery and #105 recovery

Implementation and merging of this feature do not deploy it. Independent Claude
review and GitHub Actions on the delivered feature head remain required before
its guarded merge. Deployment is a separate owner-authorized operation.

This implementation must not rearm, relabel, merge, or rewrite terminal #105 /
PR #117. After independent approval, feature merge and separately verified
deployment, an owner-authorized recovery procedure must first back up and
identify the original terminal record, failed Claude attempt, logs, old PR head,
current target and existing recovery backups. Keep that terminal record and all
backups immutable; create a distinct recovery record with explicit provenance.
Use the deployed synchronizer and fresh exact-SHA verification, CI and Claude
review, then the normal guarded merge. Re-observe dependency admission for #106
only after #105 validly merges. Never assume an older `guarded-reconcile.js`
remains valid after a PR head changes. Live owner config, its `.bak`, owner
registry and historical jobs are outside this implementation's mutation scope.
