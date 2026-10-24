# ADE owner release and reversible rollout procedure

This is a procedure for owner review, not a release authorization or evidence of
deployment. #146 stays staged until the owner explicitly releases ADE. Preserve
installed skills, existing settings and the failed original #111 job. Never use
GitHub closure or model prose as approval.

1. Record independently verified #142 and #145 guarded merge evidence and exact
   SHAs. Verify the separate unified MGA deployment gate. Preserve the original
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
   existing milestone authorization, explicit `architectureDecisions: true`,
   intended `decisionOwner`, and distinct decision/ready labels. Do not copy a
   repository example over live settings. Non-opted-in projects stay unchanged.
4. First run the synthetic tests against disposable local state; then, only with
   separately authorized staging resources, run one bounded synthetic job. Check
   one assigned non-executable decision, an unaffected issue advancing and a
   dependent issue waiting. Restart and recover the decision URL, original job,
   full errors, proposed ADR and remaining actions from inspect/status/raw logs.
5. Use the authenticated local owner CLI to accept an exact inspected decision.
   Separately authorize/release its ADR issue. Deliver through ordinary tests,
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
