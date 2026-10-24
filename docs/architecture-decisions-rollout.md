# ADE owner release and reversible rollout procedure

This is a procedure for owner review, not a release authorization or evidence of
deployment. Option B (#154) preserves the installed AgentLoop-only opt-in
(`architectureDecisions: true`, `decisionOwner: woodsja`) and disabled milestone
grants. Source merge, separate deployment and a real pilot are distinct releases.
Preserve
installed skills, existing settings and the failed original #111 job. Never use
GitHub closure or model prose as approval.

1. Record independently verified predecessor #146 and patch #154 guarded merge
   evidence and exact SHAs. Preserve the existing admission mode; enabling MGA
   is not a prerequisite for Option B. Preserve the original
   #111 terminal failure and the original #116 reconciliation snapshot. Obtain
   separate owner approval for ADE release and this rollout, including project,
   revision, rollback revision, maintenance window and operator identity.
2. At the candidate SHA, run `npm ci`, focused ADE tests and `npm test`; retain
   complete stdout/stderr. Require independent specification/standards review,
   independent Claude PASS, green GitHub CI for that exact SHA and guarded merge.
   A merge completes source delivery only. Preserve ADR 0001 owner visibility and
   the physical Windows host boundary; no host settings or credentials change.
3. Back up operator-modified project/config files and the complete durable state,
   queue, grants, receipts and raw logs. Record their locations and hashes in the
   owner's release record. Review a config diff for only the named test project:
   unchanged milestone authorization mode, existing `architectureDecisions: true`,
   intended `decisionOwner`, and distinct decision/ready labels. Do not copy a
   repository example over live settings. Non-opted-in projects stay unchanged.
4. First run the synthetic tests against disposable local state; then, only with
   separately authorized staging resources, run one bounded synthetic job. Check
   one assigned non-executable decision, an unaffected issue advancing and a
   dependent issue waiting. Restart and recover the decision URL, original job,
   full errors, proposed ADR and remaining actions from inspect/status/raw logs.
5. Use the authenticated local owner CLI to accept an exact inspected decision.
   Separately authorize/release its ADR issue: in the installed nongrant mode,
   inspect the final published ADR issue and explicitly add the configured ready
   label through the existing owner workflow; grant projects require their own
   separate grant receipt. Never add ready to the decision issue or switch modes
   to unblock a job. Deliver through ordinary tests,
   independent review, exact-head CI and guarded merge. Inspect and resume the
   original job. Verify the resolved GitHub links and resumed evidence, unchanged
   job identity/budget, fresh scope checks, complete journals and final verified
   implementation outcome. Test duplicate/restart events without notifications
   or duplicate issues. Record separate staging verification evidence.
6. Review current R1, Household scheduler and non-opted-in behavior with the
   existing regression tests. Obtain a separate owner deployment decision for a
   named production revision and project. Deploy using the existing operator
   procedure, verify the running revision and repeat bounded checks with owner
   approval. Do not report source merge as verified deployment.

Rollback: stop new admission with the existing operator controls and wait for or
cancel active workers through supported cancellation. Restore the previous
runtime revision and only the reviewed project config diff from backup; retain
all jobs, terminal failures, grants, decisions, ADRs, receipts and raw logs.
Disabling ADE must not release paused jobs. Do not relabel decisions ready or
reset job budgets. Reconcile any uncertain GitHub publication by its exact marker
before retrying owner actions. An ADR already merged is historical policy: a
reversal requires a new explicit owner decision and ordinary ADR delivery, not
history deletion. Verify the prior runtime/config and unaffected scheduler
behavior, and record the rollback result independently of the merge record.

For #154, first complete ordinary Ralph R1 deterministic verification, independent
Claude PASS with zero findings, required GitHub Actions success for the exact PR
head, and guarded merge. Retain every review finding and complete captured log.
Then perform a separately authorized, independently verified reversible source
deployment: record the rollback SHA, complete backups, health check and read-only
settings/state audit. Preserve operator-modified project files, `.bak`, registries,
secrets, installed skills and all historical jobs including failed #111. Finance,
Household and other projects keep their settings. No host bridge, credential or
sandbox change is part of this patch.

Only a new explicit owner release after verified installation permits one real
bounded AgentLoop pilot. Do not create a live synthetic decision as part of source
implementation. Real acceptance and resume remain deliberate authenticated local
CLI actions. If a check fails, retain the paused job and raw logs, inspect the
reason, restore a reversible label/transport problem and inspect/resume explicitly.
Missing legacy admission metadata, an edited ticket or a changed policy needs
supported owner recovery; never guess authority, erase history or reset budgets.
For rollback, restore the recorded source revision through the existing procedure
and verify health and the read-only audit again. Paused jobs stay paused; a merged
ADR is retained as history. Do not infer successful installation from PR merge.
