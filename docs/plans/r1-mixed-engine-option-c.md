# Option C: R1-owned worker/critic loop — implementation plan

Status: engineering plan, not runtime activation. Parent issue #65; delivery #67 -> #68 -> #69.

## Outcome and invariants
An R1 GitHub issue may opt into its already-available AgentLoop child loop as the implementation method, retaining the separate deterministic verifier, exact-SHA CI and independent final PR review. The default R1 implementation stays unchanged. A child cannot inherit authority from issue text, user-supplied paths or a forged queue entry; its durable reservation and still-active parent must authorize it **at execution time**. The parent and child may never concurrently edit the same worktree, and a crash must never start two children for one parent attempt. No new scheduler or production configuration change.

## #67: scheduler/recovery vertical slice
1. Verify the deadlock at `maxConcurrent=1`: running R1 parent currently suppresses all queued work, including its own child; then admit **only** a child matching the parent's durable reservation, active attempt, approved same-repository worktree and configured role engines.
2. Give the parent a coordination slot, not a worker slot. Respect `maxConcurrent` for child/other workers, preserve R1 exclusivity for unrelated tasks, refuse unsupported/forged or detached children. Before execution recheck liveness, cancellation, attempt and canonical authorization; fail closed with a persisted reason if stale.
3. Use the child-index and queue stages to report the parent's active child; never assume `childLoopId` is authoritative. Recover interrupted child as terminal failed (existing loop policy) and R1 parent as resumable, without creating another child for the same attempt. Preserve the worktree until every attached child has been observed terminal; propagate cancellation/timeout.
4. Tests: previously-deadlocked single-slot E2E; no unrelated task admitted; forged child denied; cancel before admission; queued/running/done/restart; intact worktree until child terminal; legacy R1 behavior unaffected.

## #68: optional implementation method vertical slice
1. Add an owner-project `implementationStrategy` opt-in, defaulting to existing `one-shot`; only `worker-critic-loop` uses #67. Keep explicit Codex worker and restricted Opus critic, bound retries.
2. R1 prepares issue requirements as temporary `PLAN.md` / `GUIDELINES.md` / `STATE.md` without touching pre-existing files. Checkpoint and quarantine all synthetic files; no synthetic instruction file may be committed, pushed or delivered. Keep workspace alive until child completes. Reuse existing loop execution, status and verdict parser, not a new engine runner.
3. Parent waits for durable child result with cancel and timeout handling, verifies terminal complete `PASS` with no blocked plan items, captures the exact implementation HEAD, cleans synthetic files, then runs the original deterministic verifier and all existing delivery gates. A child PASS is never equivalent to approved PR review.
4. Tests: mock FAIL -> Codex correction -> PASS with deterministic verification; malformed/partial/timeout/crash fail closed; default legacy unchanged; nothing sensitive or synthetic committed; restart one child per attempt.

## #69: acceptance and rollout (still no production deployment)
1. Disposable owner-authorized worktree, isolated state/config/port; real authenticated Codex and Claude Opus through existing CLIs (no API billing fallback).
2. Demonstrate the failure/correction/pass chain, bounded retry/restart and cancel, parent+child status, exact SHA verifications and authorization denial; run full suites and independent Opus code/spec review. Confirm GitHub CI on final commit.
3. Record activation/rollback/limitations, notably Git worktrees aren't OS sandboxes and Codex critic read-only can read beyond repo. Leave running Ralph checkout/timer, autoMerge and ready-for-agent labels unchanged until separately authorized.

## Implementation seams and failure policy
- `src/r1-child-handoff.js` / durable child store: single authoritative parent+attempt identity; execution-time authorization must check the reservation and canonical workspace again.
- `src/daemon.js` fillSlots and lifecycle: reuse existing queue/engine execution; no new background scheduler. Parent waits without consuming a worker slot.
- `src/r1-jobs.js` / `src/autopilot.js` / `src/ralph-task-service.js`: R1 owns issue contract, verifier and delivery; child owns implementation and criticism.
- A reservation without its queue record, conflicting parent attempt, malformed verdict, stale commit, permission mismatch or ambiguous execution state is **not deliverable**. Persist actionable diagnostics and stop; never infer a PASS.
- Prefer narrow additive interfaces and test the user-visible behavior through the existing R1/loop endpoints. Every PR must be independently reviewed and pass CI before merging.
