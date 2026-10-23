# Issue 111 implementation and rehearsal handoff

This ticket implements owner inspection and a synthetic release regression. It
changes no production registry, settings, labels, services or deployments.
Implementation authorization does not activate a milestone. Production activation
still requires a later explicit owner decision.

## Reproduce and inspect

Run `node test/milestone-batches.test.js` and `npm test`. The batch suite creates
fresh temporary registered projects, isolated durable stores and fake GitHub.
The new dependent-release case publishes two exact drafts, approves their entire
batch once, releases #200, and holds #201 on #200. The worker adapter creates a calculator module, then a dependent report module,
and executes deterministic Node product acceptance assertions for each, supplies explicitly synthetic Claude PASS
and exact-SHA CI observations, and exercises the existing guarded merge pipeline.
Only retained exact-head test/review/CI/merge evidence unlocks #201. A second
release uses the original approvals without requesting owner approval again.
Each invocation reopens the durable job store. Ready-labeled out-of-scope #202
is repeatedly denied and has no job; exactly two workers and merges occur.

Assertions inspect both final job records, exact approved heads, verification
results, review/CI commits, dependency links, receipts, unchanged approval evidence
and owner-visible raw journals. GitHub closure alone cannot satisfy this test.
The summary regression checks byte-for-byte state preservation, including through
the real CLI, effective expiry without mutation, damaged job evidence, and full
long raw records including terminal escapes. The rehearsal invokes no real model review,
GitHub mutation or production registry.

Existing acceptance evidence remains in the same full suite:

- `milestone-batches.test.js`: partial/ambiguous creation, native blocker and label
  failures; abrupt process exits; retry reconciliation; receipt/quota preservation.
- `r1-milestone-admission.test.js`: stale/edited receipts cannot start jobs or merge
  after green review/CI; pause, revoke, expiry, child admission and restart holds.
- `household-milestone-admission.test.js`: the same validator at admission and merge,
  cancellation during work, pause/resume after restart, amendment history and fresh
  owner approval for replacement receipts. R1 yields Household scanning rather
  than competing with the standalone runner.
- Existing non-opted-in R1/AgentLoop, Household and project registration suites
  remain in `npm test`; no scheduler or default configuration is added here.

## Delivery evidence and outstanding gates

The rehearsal is a deterministic integration simulation. Its reviewer and CI
adapters do not establish a real independent Claude review or GitHub Actions
success for this implementation. A fully accepted end-to-end external demonstration
is **not yet verified**. Its disposable job stores are removed after assertions;
the full exported evidence and test output are retained below. Production evidence is
never used or removed by these tests.

The workspace started at `e7caf791e59127639f3f946755b98b33a4cf9046`.
The implementation remains a working-tree change for Ralph's delivery pipeline.
Exact tested-head independent review and remote CI must be attached to the final
committed SHA after these edits. An earlier base-SHA pass cannot satisfy that gate.
`gh auth status` reports an invalid active GitHub token in this environment, so
remote CI verification is blocked here. Do not infer CI, merge or deployment from
this handoff or issue closure. See the validation record below for local results.

## Separate production activation plan — not executed

1. Obtain explicit owner authorization naming the final reviewed implementation
   SHA, project, exact milestone revision/digest, scope, expiry and quotas. Resolve
   any failed local checks, independent review findings or exact-head CI first.
   Rehearse the operator summary against the intended registry without mutations.
2. In an owner-approved maintenance window, stop new admissions using the existing
   owner procedure and let active jobs settle or pause their grants with durable
   evidence. Back up owner config, project registry, full state roots, grant/batch
   journals, clock, jobs, queues and execution logs together. Record checksums,
   permissions, current service version and health baseline. Verify the backup is
   readable. Do not replace owner-modified files with repository defaults.
3. Only under that later authorization, install the reviewed version through the
   existing deployment procedure and opt in the one approved registered project
   with `milestoneAuthorization: true`. Verify its canonical registration, state
   paths, ready label and single existing scheduler. Household must remain owned
   by its standalone runner; R1 must yield. Preserve all unrelated project settings.
4. Inspect the durable specification and exact-ticket batch preview with the owner;
   separately activate the intended grant and approve/release only reviewed exact
   tickets using existing commands. Never use a draft or ready label as authority.
5. Health checks: read-only summary shows expected digest/revision/expiry/quotas;
   complete raw events are readable after operator restart; unrelated ready work
   is denied; prerequisite work stays waiting until verified merge evidence;
   exact-head tests, independent Claude review and GitHub CI gate every merge.
   Confirm existing non-opted-in projects continue their baseline behavior.
6. Roll back on unexpected admission, lost observability, duplicate scheduling or
   health regression: pause/revoke the grant through the existing owner commands,
   stop new admission using the approved procedure, retain in-flight work and all
   raw diagnostics, and return to the recorded reviewed service version. Do not
   disable opt-in while ready-labeled milestone work can be admitted by legacy
   rules. Keep enforcement or stop admission until all such work is held. Restore
   configuration from backup only after reconciling owner edits. Never restore an
   old grant/clock/job database over newer evidence: that can resurrect authority
   or duplicate completed work. Reconcile append-only evidence before recovery.
7. Report the actual deployed SHA, owner activation evidence and product health
   checks separately. A merged PR establishes none of these deployment facts.

## Local validation record

The focused batch/rehearsal/summary suite passes all 15 tests. Full `npm test`
was invoked in the execution sandbox: the first 12 suites passed, then both
existing `project-preflight-runner.test.js` native output/signal tests failed with
empty captured output. The complete output is retained in
[evidence/issue-111/npm-test-sandbox.log](evidence/issue-111/npm-test-sandbox.log).
The second full `npm test` invocation outside that sandbox completed with exit 0: 723 passing tests across 56 test files, zero failures. Its complete output is retained in [evidence/issue-111/npm-test.log](evidence/issue-111/npm-test.log). `git diff --check` also passes.

An installed Claude CLI review was attempted with tools disabled; the first attempt failed with `EAI_AGAIN` reaching its API. A second attempt also disabled session persistence. The second attempt returned no review within a 55-second timeout (exit 124).
This is not an independent PASS. The final committed implementation still requires
independent review and GitHub exact-SHA CI through Ralph's guarded delivery flow.
No external demonstration, live milestone, service restart or deployment occurred.
The final implementation file hashes are retained in
[evidence/issue-111/implementation.sha256](evidence/issue-111/implementation.sha256).
They identify local tested contents and are not a substitute for commit-bound CI.

The completed synthetic run retains
[product/job acceptance evidence](evidence/issue-111/rehearsal-acceptance.json),
[all 15 test results](evidence/issue-111/batch-tests.log), and the
[complete raw inspection export](evidence/issue-111/rehearsal.json.gz).
The latter is losslessly compressed; read it with
`gzip -dc docs/evidence/issue-111/rehearsal.json.gz`.
Its fake Claude/CI observations are explicitly marked synthetic. Temporary source
paths identify the rehearsal fixture; the embedded bytes remain available after
fixture cleanup. Reproduce an export with:

```sh
AGENTLOOP_REHEARSAL_EVIDENCE=/tmp/rehearsal.json node test/milestone-batches.test.js
```

This export contains both jobs' full retained journals, grant/specification,
receipts, approvals, prerequisite proof, batch events and the denied outsider's
admission events. Product assertions execute the calculator/report code before
recording success. The compact acceptance file is navigation; the compressed
export preserves complete raw records.
