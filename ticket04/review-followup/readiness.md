# Ticket 04 second correction loop — readiness

**Not accepted for merge or deployment.** Source/test corrections are uncommitted in the existing worktree and branch `simplify/highlander-one-coordinator-20261122`; HEAD remains `e99b626dd8d20a317a458c9af1bf9cb5ca0fbccd`. The pre-existing terminal setup-claim change in `src/r1-jobs.js` is preserved. Existing untracked `review-corrections/` and `vm-tests/` were preserved. No branch, PR, issue, E2E job, deployment, merge, push, production configuration, Windows or Finance Dashboard action was performed. All existing PRs retain their remote state, including draft status.

This report supersedes historical claims in `implementation-report.md`, `reviews.md`, and the earlier correction readiness report. Those reports describe earlier snapshots, not verification of this worktree. Full independent standards/specification result fields for e99b626 were read from the two exact paths requested by the owner. The earlier 831f36a and 5e0a986 result fields, accepted ADRs 0001/0002, existing readiness, relevant source and regression tests were also inspected.

## Exact review findings and resolutions

| Finding | Code resolution / evidence |
| --- | --- |
| e99 Standards B1 / Spec F2: exhausted outcome cleanup blocks global dispatch | `finish` requires only pending retryable actions to finish; exhausted failed actions remain failed. `advance` releases a matching terminal parent after bounded exhaustion instead of holding dispatch forever. Three branch-delete failures retain raw errors, `nextAction=owner_decision`, exactly one PR close, and admission of issue 2. `01-cleanup-*`, final recovery. No cleanup success is fabricated. |
| e99 Standards B2 / Spec lower: held cancellation bypasses outcome policy | Async `cancelHeldDelivery`, under the existing issue lock and captured execution context, runs canonical `publishOutcome` after confirmed process ownership. Removed cancellation bypass from `finish`. Awaiting-CI and supervisor-held durable cancellation close/comment/relabel/delete the temporary branch idempotently; no worker admission occurs. Missing labels and configuration failures remain bounded failed actions. Initial PR-state uncertainty holds safely; confirmed merge is deferred to full identity-checked merge reconciliation. A merge observed during close reconciliation clears the cancellation verdict and resumes reconciliation. `02-cancel-*`, `08-cancel-policy-*`, `12-merge-race-*`, final recovery. |
| e99 Standards B3: discovery hold cannot recover | Only discovery-sourced ownership holds may re-enter the canonical run. Discovery absence still prevents workspace preparation or workers. Authorized discovery recovery clears its own hold and runs one worker without a second PR/state path. Process and supervisor holds retain their gates. `04-discovery-*`, final recovery. |
| e99 Spec F1: initial discovery miss poisons future submissions | Canonical terminal admission failures record `admissionUnavailable`. A future submission still passes owner registry/worktree/milestone authorization and fresh discovery; the existing rearm helper archives the old checkpoint/journal before reserving a new parent. Historical parent-qualified reads retain the failed attempt. Other terminal failures/cancellations are not implicitly made eligible. `03-rearm-*`, final recovery. This restores the t-3c4172d4 → t-7fadc67e recovery behavior without deleting history. |
| e99 Spec F3: reserve-before-save crash creates duplicate parent | While holding the existing issue lock, reservation reuses one matching pending/running `rearmFrom` parent. State-directory/authorization mismatch, contradictory reservations, cancelled/held reservations and abandoned terminal reservations require reconciliation rather than another reservation. Fault injection after durable enqueue, before checkpoint save, then concurrent submissions returns the same parent and retains original raw archive. `03-rearm-*`, `13-abandoned-*`, final recovery. |
| e99 Spec F4: idle decision reconciliation | Confirmed regression. Idle admission invokes existing `architecture-decisions.reconcile` with canonical issue locks and complete issue/parent execution journals. It publishes/reconciles decisions, not delivery execution or queue copies. A done-stage paused parent with uncertain publication is rechecked with no new parent. Existing owner resume CLI still reuses the original done parent exactly once after guarded acceptance/ADR validation (`architecture-decision-actions`, 96/96, including owner queue resume). `05-decision-*`, final recovery. |
| e99 Standards B4 / Spec F5: size acceptance and stale evidence | Updated `ticket04/measurements.json`; marked historical implementation/review reports superseded. One coordinator, one active delivery-state writer, one active checkpoint copy and 79 source modules remain. Source LOC increased; literal reduced-LOC/modules acceptance remains unmet. No waiver is assumed or requested. |
| N1 strict prologue | `'use strict'` precedes `require` in `r1-status`. Runtime strict-mode regression fails on the old ordering. `09-strict-red.log`, final recovery. |
| N2 null Ralph stop path | Valid canonical schema rejects null Ralph state, so the proposed persisted-null crash was not reproduced. Kept a defensive assignment guard; preparation-stop regression verifies resumability before a worker. The rejected null fixture is not counted as behavioral red evidence. |
| N3 deadline after exact-head green CI | Deadline no longer expires a job with green evidence for the exact delivered head and PR. Fresh CI observation and guarded delivery/review checks still run; stale/different-head evidence does not exempt the deadline. CLI elapsed-deadline regression failed before the fix and passes afterward. |
| N4 stale committed evidence | Historical reports have prominent supersession notices; current measurements and this report replace old readiness/LOC claims. |
| N5 hygiene | Extracted the shared outcome command adapter within Autopilot and removed the fabricated `unknown:project` repository fallback: cancellation of a missing record requires the recorded repository. Missing labels fail explicitly. Remaining cosmetic duplication (spec threshold, phase/status projection, inline requires) is deferred; no architecture/module churn for cosmetic reduction. |
| N6 pending historical children starve | Dispatch terminalizes unauthorized orphan children with `r1_child_unauthorized`, without execution. Existing child authorization remains intact. `07-orphan-*`, scheduler focused 1/1. |
| N7 non-R1 corrected-spec history overwrite | Not reproduced: nonresumable timer selection throws before replacing the checkpoint. New CLI regression compares the entire checkpoint and raw journal bytes before/after; both unchanged. No timer rearm policy or namespace change. |
| N8 `legacy_execution_retired` unexplained | Non-bug: existing `daemon.closeRetiredJob` supplies that default reason; confirmed in source, no invented test-only reason. |
| Spec lower: exhausted child critic narrows correction | Retained existing exhausted-child terminal behavior after checking original mixed-E2E assertions: rejection must consume at most the owner-set three child critic cycles. Repeating a parent worker would multiply that budget. An exploratory parent-retry change was reverted; original assertions were not weakened. Added a focused CLI check that an exhausted critic cannot start another parent worker. `10-critic-*` describes the abandoned exploratory interpretation, not a shipped fix or approval. Real mixed-E2E remains VM-required. |
| Prior exact-head CI 45056757733: terminal ambiguous setup claim holds queue | Preserved the initial narrow `blocked_infrastructure` + `prior_process_unresolved` exception, retaining the uncertain environment claim and terminal checkpoint. New Node/Python canonical-dispatch regressions both release transport without changing the claim or launching any process. `11-prior-claim-red.log` removes only the initial exception as a regression sensitivity replay; restored source passes. Original public Node/Python restart tests remain unchanged and require VM execution. |

## Original and first follow-up findings retained

These are not newly claimed fixes or independent approvals; the final e99 review considered many resolved already. Current tests and limits are below.

| Original 831f36a / first follow-up 5e0a986 finding | Current disposition |
| --- | --- |
| Historical scheduler starvation (831 standards F1, spec 1); legacy child fallback (5e spec B2) | Historical parents remain inspect-only and do not count as canonical dispatch owners. Explicit canonical child admission/handoff/session/recovery gates remain. N6 now denies pending orphans rather than starving them. Child admission 6/6; actual Git-backed scheduler/handoff blocked here. |
| Permanent rearm loss (831 standards F2, spec 5; 5e standards B3/spec B1) | Corrected specification and initial discovery-miss recovery archive immutable attempts; crash/mismatch guards above. No general terminal-history erasure or unrestricted retry permission. |
| Repeated supervisor/ownership retries (831 standards F3/spec 4; 5e standards B5) | Supervisor/process holds remain observed once; discovery holds alone recheck safely. Cancellation precedes these gates, with outcome policy now restored. Final R1 focused 5/5. |
| Cancellation after merge (831 standards F4/spec 3) | Recorded merge and newly observed cancellation-race merge are reconciled, not turned into cancellation. Existing CLI recorded-merge assertion and new recovery races pass. |
| Late process-close writer / concurrency of claims (831 standards F5, 5e prior-risk tables) | Existing close handler still does not save stale snapshots; prior uncertain worker claims prevent replacement. Process claim tests 4/4, CLI original checks retained. Real descendant-process recovery remains unverified here. |
| Missing PID / failed spawn (831 standards F6, spec low; 5e standards B1/spec M1) | Existing confirmed pre-start cleanup retained; started but unidentifiable workers stay fail-closed. Existing CLI launch tests retained; new unknown-owner cancellation regression passes. |
| Deadline/hold behavior and discovery clear (831 standards F7/F8, spec low) | SHA reset remains; exact-head green exemption and reachable discovery recovery added. No runtime identity/CI gate relaxed. |
| Owner-facing outcomes/tests inverted (831 standards F9/spec 5; 5e standards B3/spec B1) | Existing restored runner assertions untouched. Canonical actions remain, with bounded failure releasing dispatch and held cancellations applying policy. No assertion was inverted to excuse removal. |
| Fragile dashboard / generic result consumers (831 standards F10/spec lower; 5e standards B4/spec M2) | Existing per-job diagnostic and raw-link containment retained; daemon 40 pass / 5 skip, R1 malformed/missing checkpoint cases pass. Queue result copies remain absent; canonical projection remains authoritative. |
| Size, wrapper, stale reports (831 standards F11/spec 7; 5e spec B3) | No compatibility delivery writer restored. Current measured size and supersession below; literal size reduction not satisfied. |
| Legacy owner resume writer (831 spec 2; 5e dead-branch finding) | Remains rejected before mutation; canonical owner resume reuses original parent. Existing actions suite 96/96. |
| Admission/readiness bypass conjecture (831 spec 6) | Owner/milestone authorization remains in submit and canonical run; changed-spec rearm requires current discovered issue. New mismatch/abandonment guards do not grant permission. Existing authorization tests retained; actual Git-backed milestone case blocked here. |
| Decision reconciliation removed (831 spec 8; 5e confirm) | Confirmed idle gap corrected through the existing locked decision reconciler, as above. |
| Phase growth, layering, dead code, timer side effects (831 lower; 5e L1/nits) | Existing 50-phase navigation cap, raw append-only journal, core phase derivation and removed dead branches retained. New timer-history byte comparison passes. No source-store schema/version/namespace introduced. |
| Cancellation absorbed by supervision (5e spec M3) | Safe held cancellation reaches canonical cancellation plus outcomes; unknown ownership remains held and inspectable. |
| Test deadlines, duplicate failure records, catch cancellation read, shutdown group handling (831/5e lower) | Existing bounded milestone wait and prior corrections retained. No new unbounded retry loop or extra process writer introduced. Actual OS/process behavior remains a VM gate, not established by in-process tests. |

## Validation

No full local `npm test` ran. All commands below are direct focused invocations. Raw output remains in this directory; `.gitignore` excludes `.log` files from a future blanket add. No raw evidence was truncated or deleted. `test-results.json` retains exit codes, counts and log hashes; red/green logs 01–13 retain the development sequence. The new recovery file is added to the existing npm test chain so exact-SHA CI will run it.

| Exact command | Exit / result |
| --- | --- |
| `node test/r1-review-recovery.test.js` | 0; final 19/19 |
| `node test/autopilot-cli.test.js` | 1; 103/104. Sole failure is original verifier stdout/stderr capture case (expected actual output, got empty strings), also documented on earlier baseline. Not a pass. |
| `node --test-name-pattern='before a worker\|elapsed deadline\|timer corrected\|exhausted child critic' test/autopilot-cli.test.js` | 0; 4/4 corrected/speculative-finding checks |
| `node --test-name-pattern='canonical\|revoked\|corrected\|ownership\|terminal' test/r1-jobs.test.js` | 0; 5/5 |
| `node --test-name-pattern='pending historical child' test/r1-child-scheduler.test.js` | 0; 1/1 |
| `node test/daemon.test.js` | 0; 40 pass, 5 skip (45 total); skipped assertions are not passes |
| `node test/autopilot-state.test.js` | 0; 30/30 |
| `node test/state.test.js` | 0; 15/15 |
| `node test/architecture-decisions.test.js` | 0; 84/84 |
| `node test/architecture-decision-actions.test.js` | 0; 96/96 |
| `node test/r1-child-admission.test.js` | 0; 6/6 |
| `node test/r1-process-claim.test.js` | 0; 4/4 |
| `node test/r1-child-recover.test.js` | 0; 3/3 |
| `node test/node-preflight.test.js` | 1; 2/25 pass, 23 fixture failures (`spawnSync git EPERM`) |
| `node test/python-preflight.test.js` | 1; 0/16, Git fixture `EPERM` |
| `node test/r1-runner.test.js` | 1; 0/1, Git fixture `EPERM`; attempted full real suite, not shortened |
| `node test/r1-mixed-e2e.test.js` | 1; 0/9, Git fixture `EPERM`; no claim of process/E2E validation |
| `node test/r1-jobs.test.js` | 1; 7/9, both Git fixture failures |
| `node test/r1-child-handoff.test.js` | 1; 0/11, Git fixture failures |
| `node test/r1-child-scheduler.test.js` | 1; 2/5, 2 Git fixture failures and 1 loopback listen `EPERM` |
| `node test/r1-milestone-admission.test.js` | 1; 30/31, Git-backed mixed child fixture blocked |
| `node --check` on changed JS and new recovery test; `git diff --check` | 0 |

Red evidence qualification: the first cleanup fixture lacked a PR URL and was invalid; its retained 01 red is the corrected fixture replay with the blocking finish predicate restored, not a claim of a valid pre-edit run. The strict-mode fixture initially used the wrong require root; retained 09 red is corrected and tests strict runtime behavior. The null-Ralph fixture is rejected by schema; N2 is defensive, not a reproduced persisted-state defect. The 06 red still demonstrates the valid CI deadline failure; its rejected null fixture is excluded. The 11 red is an explicit regression replay against the preserved pre-existing setup fix. The exploratory 10 critic logs do not describe final semantics. Other numbered reds demonstrate the named behavioral failure before its corresponding fix. No Git/socket fixture failure is counted as behavioral red or integration pass.

## Measurement and remaining risks

Physical JavaScript lines, including blanks/comments, in `src/**/*.js`:

| Snapshot | Modules | Source LOC | r1-jobs LOC |
| --- | ---: | ---: | ---: |
| Ticket 03 b56ad58 | 79 | 16,392 | 631 |
| Starting e99b626 | 79 | 16,718 | 534 |
| Corrected uncommitted worktree | 79 | 16,814 | 573 |

Net +96 source lines from e99b626, +422 from Ticket 03. **No source LOC or module reduction is claimed.** There remains one delivery coordinator, one active delivery-state writer and one active delivery checkpoint copy; immutable historical attempts reuse the existing representation and parent-qualified reads. Queue metadata and child process supervision retain their distinct transport roles. Safety, owner policy and evidence take priority over artificial LOC removal; the literal size criterion remains unmet without any inferred waiver.

VM tests and commit/push are the next authorized operator handoff, not performed here. The failed/blocked real Git, socket, setup and descendant-process suites must run on the disposable VM. Full GitHub CI must then validate the actual resulting exact SHA; e99b626 CI 45056757733 failed, and earlier CI passes do not cover these uncommitted changes. Independent exact-diff/SHA reviews and the separately owner-authorized fresh real E2E remain external acceptance gates. No E2E publication or execution is authorized by this report. Production readiness and deployment remain unverified.

## Native VM verification after sandbox

The actual Git/socket/process-backed focused test runner completed on the disposable Ralph Linux VM after the correction worker exited. **All 18 selected test-file commands returned exit 0**, including the unchanged public Node/Python restart-ambiguous cases, continuous runner, mixed child E2E, R1 child handoff/scheduler/milestone, the new 19/19 canonical recovery regression suite, 104/104 Autopilot CLI cases, state, daemon, decision actions, dashboard and utility tests. No complete local npm test was run; final exact-commit GitHub CI is required. Source remains isolated; no production daemon/configuration restart, merge, deployment, Windows or Finance Dashboard change occurred.

Full per-file exit status, stdout/stderr, and observed test counts are in durable verification storage: `/home/woodsja/tools/ralph/state/verification-reports/ralph-highlander-20261122/ticket04-review-followup/vm-summary.txt` and `vm-*.log`. The earlier sandbox failure table remains historical environment evidence, **not** current VM test results. GitHub CI, two exact-commit independent reviews and new owner-authorized E2E remain pending.
