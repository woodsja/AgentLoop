# Ralph Highlander — Ticket 05: classic-loop retirement and review corrections

**Status: implementation and regression corrections prepared; final acceptance pending.**

## Source and authorization

- Repository: woodsja/AgentLoop.
- Authoritative draft PR: https://github.com/woodsja/AgentLoop/pull/196
- Correct PR base: simplify/highlander-one-coordinator-20261122 (Ticket 04 PR #195).
- Accepted base commit: 9accff6526a47aabc1ab36eea8fed57747fd7865.
- First Ticket 05 implementation commit: 8bad621dd7ff602e2114cae22053e78a2c97a617.
- Corrected head: use the exact current PR #196 commit; verification and review must refer to that SHA.
- Isolated worktree: /home/woodsja/worktrees/ralph/highlander-retire-classic-20261122.
- Owner scope: implement and verify Ticket 05 only; no PR merges, production deployment, daemon restart, production configuration, Windows host, Finance Dashboard, autonomous merging, or Ticket 06. New real external E2E issue/execution needs separate owner authorization.

The durable Ticket 05 specification under the 2026-11-22 Highlander verification root is authoritative. The deletion map in docs/highlander-ticket05-deletion-map.md records the actual call graph and deleted responsibilities.

## Removed versus retained

**Removed:** competing classic-loop daemon cycle scheduling, queue admission and child handoff, independent child task/result lifecycle writers, plan/polish scheduler, pass latches, checkpoint commits, obsolete classic-only submission and execution paths. Removed, not moved to another coordinator.

**Retained:** one canonical Autopilot development-job coordinator and durable issue checkpoint; Codex implementation and independent Claude critic; PASS, FAIL, CONTINUE and malformed-verdict handling; deterministic verification veto; bounded correction and parent attempts; explicit cancellation, worktree and milestone authorization, safe process-claim recovery, owner decision holds; complete raw output and historical read-only GET by job ID. No new queue, scheduler, lifecycle store, custom skill runner, or classic execution admission was added.

The first Ticket 05 implementation required corrections identified by independent Opus standards/specification reviews. Reviews of initial commit 8bad621 did **not** pass. Their original complete outputs are preserved in the durable VM verification root as standards-authenticated-review.json and spec-authenticated-review.json.

## Corrections made after independent review

1. Milestone pause, revocation and authorization drift are rechecked immediately before each actual worker or critic process launch. Current project registration, repository identity, worktree linkage, owner scope, parent identity, attempt and cancellation are also checked at the canonical worker interface.
2. Recovery distinguishes a passed implementation child (which may continue PR/CI delivery) from an interrupted child. Confirmed-stopped processes use the existing bounded recovery mechanism, without inventing a permanent owner hold or duplicating a worker; ambiguous process ownership continues to fail closed.
3. Cancellation/revocation cleanup uses proof of process exit rather than the continued validity of the owner's authorization, preserving the original cancellation error; temporary instruction files are validated and removed only when safe.
4. Legitimate unfinished STATE.md progress is retained across interrupted execution if it has the generated R1 progress header. Existing unrelated files, tracked instruction files and insertion into Git history are rejected.
5. Worker/critic identity is passed explicitly to the execution recorder, rather than inferred from CLI arguments. CONTINUE feedback describes remaining work, not a rejection. Three exhausted critic cycles remain terminal even if the outer retry budget is larger.
6. Restored tests cover real Git index/commit/add-remove tampering, real authorized-worktree linkage, forged checkout/alien repository, changed registration, stale attempts, cancelled parents, historical child inspection, orphan pending child recovery, corrected restart and proposal-pause behavior.

Second-round independent Opus reviews of commit 9a663776f67c1dfb9c589a0918aba0bf48fdf65e returned spec PASS and standards NOT PASS, specifically on confirmed-stopped failed-work capture, process-group cancellation, and a default reviewer role. The follow-up source changes correct those findings: a stopped child has terminal failed/cancelled evidence; ambiguous process ownership remains interrupted, including during cancellation; and canonical capture derives a stable owner-bound provenance identifier from the existing checkpoint without adding a child queue. Explicit role propagation no longer defaults missing roles to worker. The actual detached process group is signalled on cancellation and timeout; cancellation now escalates to SIGKILL after a short grace period even when the leader and grandchild ignore SIGTERM. The authoritative process-claim reconciler independently verifies the process group before allowing cleanup. New tests cover a real subprocess grandchild, a stubborn parent and grandchild, one- and two-attempt Git recovery capture, and unknown-process cancellation. Red/green logs are retained with the existing Ticket 05 records.

The same prior commit passed the full GitHub Actions CI run https://github.com/woodsja/AgentLoop/actions/runs/45103206383 using verification-only draft PR #197, which targets ralph-dev while authoritative PR #196 remains stacked. That historical PASS does not verify any subsequent fixes; CI must run again against the new final commit.

The independent third-round specification review of commit bd98f2be80c02798472cb6e68f81f9e42be0e647 returned PASS with no blocking or major findings. Its standards review found one remaining major: cancellation of a SIGTERM-resistant worker could wait for the normal worker timeout. The bounded escalation and real stubborn-process regression were added after that review; both axes must review the exact new commit before final acceptance.

The temporary tests and raw red-green logs (including original failures) are preserved under the durable Ticket 05 verification root. No model thoughts are claimed beyond the events actually exported by the CLI.

## Architectural measurements

| Measure | Ticket 04 baseline | First Ticket 05 commit | Corrected working tree |
| --- | ---: | ---: | ---: |
| Lifecycle coordinator implementations | 2 | 1 | 1 |
| Active lifecycle writer families | 2 | 1 | 1 |
| Active job-state representations | 2 | 1 | 1 |
| Public development submission interfaces | 1 | 1 | 1 |
| Active classic-loop-only modules | 4 | 0 | 0 |
| JS source modules | 79 | 77 | 77 |
| Source JS lines | 16,835 | 14,787 | 14,855 |
| Top-level test files | 69 | 65 | 66 |
| Textual test declarations | 975 | 916 | 935 |

Corrected working-tree metrics were measured after the second review fixes; final commit SHA, full test pass and independent review remain unverified. These counts include blank/comment lines. The decrease of 2,048 source LOC at the first Ticket 05 commit is real deletion, not an added compatibility coordinator.

## Verification evidence and distinction between environments

The first Codex workspace-write sandbox failed synchronous Git subprocess setup with EPERM and skipped socket tests. Those failed/skipped runs were **not** counted as passes. Under the ordinary unprivileged Linux VM with normal process, Git, sockets and PATH access, the initial Ticket 05 commit passed the mixed-engine E2E, daemon HTTP, continuous runner, R1 job and failed-work integration suites. First native full npm test still failed during Python preflight because a supervised shell did not expose installed uv on PATH; a normal-VM rerun of the Python suite passed all 16 tests.

The corrected source was separately tested with actual Git and VM subprocesses. The normal-VM test log files in the durable Ticket 05 directory use the names corrections-native-<suite>.log, including r1-mixed-e2e. The new repository authorization suite initially used an overly narrow error-message assertion despite all process launches being denied; that assertion was corrected to inspect the canonical durable checkpoint's denial evidence. Its final normal-VM rerun passed 5/5. The first failed suite run remains preserved rather than erased.

Corrected normal-VM focused/integration results before the second-round fixes: R1 implementation 33/33, R1 review recovery 21/21, R1 milestone admission 32/32, daemon HTTP 18/18, R1 jobs 9/9, CLI worker 11/11, process claim 4/4, prompts 10/10, failed work 11/11, R1 mixed-engine E2E 9/9, repository authorization final rerun 5/5. Individual raw outputs are in the durable Ticket 05 verification directory. The previous full native npm test progressed through most suites but exited 1 because the new optional group-termination flag was supplied as an undefined property to a legacy task-service fixture; that was corrected and its targeted test passed 5/5. The new full native npm test uses the VM's installed uv on PATH and writes corrections-native-fullsuite.log and corrections-native-fullsuite.exit.

**Do not claim the full suite, GitHub Actions CI or a final independent review passed until their exact results are verified.**

## Final acceptance gates

- Final source correctness and complete native npm test: PENDING final result.
- Full GitHub Actions CI on exact final head commit: PENDING. Current workflow triggers pull requests targeting main or ralph-dev, while PR #196 must remain stacked on PR #195's branch; satisfy the exact-head CI requirement without mutating the existing stack or merging.
- Fresh independent Opus standards and specification reviews of the exact corrected head: PENDING.
- New real one-start external E2E demonstration, including actual skill invocation evidence when one is used: PENDING SEPARATE OWNER AUTHORIZATION. Ticket 04 E2E does not substitute for post-Ticket 05 proof.
- PR #196 must remain draft and unmerged, based on PR #195; production must remain unchanged and Ticket 06 must not start.

Any failed, skipped, timed-out or unexecuted test is not a pass. No actual raw execution record may be discarded, truncated for owner inspection, or replaced by an invented summary.
