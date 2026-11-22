# Highlander Ticket 04 implementation

Status: implemented in the isolated working tree; **not ready or complete**. Baseline: `b56ad5876b1ceca4a67ea90f123d4301fd0b094a`. Branch: `simplify/highlander-one-coordinator-20261122`. No push, PR change, merge, deployment, production configuration/service change or Windows-host access.

## Result

New R1 queue records reference the existing Autopilot issue store. They no longer contain copied delivery jobs, delivery phase histories, terminal verdicts or duplicated result/evidence files. HTTP R1 status, generic status/results and dashboard presentation derive delivery facts from that checkpoint. Repeated submissions reuse the original reservation rather than rebinding history.

Autopilot owns bounded retry/CI timeout, specification/admission outcomes, cancellation and terminal decisions. Phase history is written in the existing issue JSON. New worker/reviewer subprocess launch intent and Linux identity are persisted there before prompts; unresolved ownership holds work and cleanup. Existing process-group recovery is reused. Shutdown defers without becoming owner cancellation. CI deadlines reset for a new delivered SHA. Interrupted delivered jobs resume without another worker/PR, even when discovery temporarily omits the issue; implementation holds when original requirements are unavailable.

Child handoff/admission reads the same authoritative job and preserves the existing child reservation, attempt and process supervision. Complete parent raw journals and existing issue journals remain captured. Historical snapshot inspection remains available; old parents cannot dispatch new workers. No migration, schema-version change, new store, coordinator module or public endpoint was introduced. Incomplete architecture-decision publication retains dispatch and retries through existing Autopilot reconciliation, preserving the owner hold.

Deleted R1's separate success predicate, phase checkpoint writer, failDurably writer and terminal result/evidence writer. Also deleted its outcome-driven PR closing, failure relabel/comment and branch deletion. Autopilot retains its workspace cleanup and guarded delivery behavior; PRs/branches are retained instead of transport-driven deletion. AutoMerge policy and authorization implementation were not changed.

## Validation

Only focused files/integration tests were run; no local full native npm test.

- Autopilot durable state: 29/29 pass.
- Architecture-decision actions/recovery: 95/95 pass.
- Dependency admission: 32/32 pass.
- Focused canonical status/terminal claim recovery: pass. Process ownership hold, missing discovery, owner cancellation and supervisor shutdown: 4/4 pass.
- Full focused Autopilot CLI file: 92/93 pass. The single verifier-output failure reproduces on the untouched baseline (expected stdout/stderr, received empty strings); both outputs are retained. It is not counted as a pass.
- Milestone admission: 30/31 pass; the Git-based child case fails before assertions with `spawnSync git EPERM`.
- HTTP R1, mixed CLI integration and child handoff: attempted, blocked during temporary Git fixture setup by the same subprocess restriction. The expanded HTTP/legacy scheduler tests require execution outside this sandbox. No claim that those changed regressions passed.
- Red/green evidence includes stale queue authority (corrected baseline replay), unidentified process restart, CI deadline reset, shutdown, canonical decision-publication recovery (corrected baseline replay), and terminal process-claim recovery. See sibling logs and reviews.md for invalid initial fixture attempts.
- JavaScript syntax checks and git diff --check pass.

## Measurements and review

See measurements.json for exact physical-line counts (includes comments). Source module count remains 79; no source module was added. The substantial R1 reduction is largely offset by required canonical process recovery and status projection; report the net delta honestly rather than treating relocated behavior as deletion. Delivery checkpoint copies decrease from issue JSON + queue full snapshot + queue result to the existing issue JSON alone. Admission/cancellation and child process records still exist for their separate supervision responsibilities. Raw evidence journals are retained, not counted as delivery-state copies.

| Metric | Baseline | Working tree | Delta |
| --- | ---: | ---: | ---: |
| Source modules | 79 | 79 | 0 |
| Source lines | 16,392 | 16,391 | -1 |
| r1-jobs.js lines | 631 | 457 | -174 |
| Test JavaScript files (including fixtures) | 77 | 77 | 0 |
| Test JavaScript lines | 20,534 | 20,737 | +203 |
| Delivery checkpoint copies | 3 | 1 | -2 |

Two independent agents reviewed and re-reviewed the diff; all concrete reported code findings were addressed. See reviews.md. These were working-tree reviews, not exact-commit approvals.

## Outstanding gates and constraints

- Full native CI at the final exact SHA has not run. The owner prohibited pushing, so no GitHub CI run was requested.
- A fresh independent-repository E2E has not run. No live development/production configuration was changed and no live daemon was restarted. Temporary fixture integration tests are blocked by subprocess restrictions; real descendant-process and HTTP restart coverage still need execution.
- The requested external audit/report path is outside writable roots. Reports are in this worktree's ticket04 directory; no out-of-sandbox write was attempted.
- Local commit outcome is recorded below after the bounded commit attempt. No automatic merge/deploy is authorized by this work.

## Local commit outcome

`git add src test ticket04` failed with exit 128: `Unable to create /home/woodsja/tools/ralph/.git/worktrees/highlander-one-coordinator-20261122/index.lock: Read-only file system`. The worktree's actual Git metadata is outside writable roots. Nothing was staged; no commit or push was made, and HEAD remains the baseline. Approval escalation is unavailable. Creating the requested local commit requires writable access to this isolated worktree's Git metadata, not production access.

## VM verification follow-up (after sandbox restrictions were lifted)

Actual Git-backed, HTTP and subprocess tests were executed outside the Codex workspace sandbox on the disposable Ralph VM. A queued-status null-dereference, early-cancellation parent-identity persistence failure, and nested retry of exhausted child critic cycles were reproduced and corrected in this worktree. Never treat the earlier blocked attempts as passes.

- `test/r1-jobs.test.js`: **5/5 pass**, including fresh submission, rejected alien worktree, status/result/raw journal, queue cancellation, restart and interrupted review; `ticket04/vm-tests/r1-jobs-cancel-fixed.log`.
- `test/r1-runner.test.js`: **1/1 pass**, independent continuous-runner lifecycle; `ticket04/vm-tests/r1-runner.log`.
- `test/r1-mixed-e2e.test.js`: **9/9 pass** in full, including child FAIL/CONTINUE/PASS, bounded critic rejection, malformed verdict, verification veto, SIGKILL recovery, raw capture and active parent cancellation; `ticket04/vm-tests/r1-mixed-full.log`.
- `test/r1-child-scheduler.test.js`: **4/4 pass**; `test/r1-child-handoff.test.js`: **11/11 pass**; `test/r1-milestone-admission.test.js`: **31/31 pass**; `test/r1-loop-implementation.test.js`: **12/12 pass**; `test/r1-child-admission.test.js`: passed.
- Architecture-decision action, Autopilot durable state, and dependency-admission files previously passed 95/95, 29/29 and 32/32. The separate Autopilot CLI test file remained **92/93**, with its one verifier-output case also failing on the unchanged baseline. An exact-SHA full-suite CI result is still required.
- All modifications remain isolated to this development branch. No owner production configuration or daemon, merge, deployment, or Windows host was touched.
