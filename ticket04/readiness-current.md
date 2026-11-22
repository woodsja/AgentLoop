# Highlander Ticket 04 — current candidate readiness

**Draft, unmerged, not accepted, not deployed.** PR #195 remains stacked on PR #194, itself stacked on PR #192. This is a source-controlled implementation inventory; it is not a substitute for the final SHA's GitHub CI verdict, two independent reviews, or owner-authorized real E2E.

## Architecture and scope

- One supported development-job submission interface; one authoritative Autopilot delivery coordinator; one active issue checkpoint JSON and state writer. R1 is transport admission/dispatch/cancellation/process supervision, not a second delivery lifecycle.
- Restored owner-facing failed-PR closing, owner issue comments, ready-to-human labels, bounded temporary branch cleanup, and corrected-specification rearm with immutable parent-qualified history, append-only raw execution journals and deduplicated reservations.
- Retired legacy parents are inspection-only; new child admission requires the canonical authorized parent. Process restart, cancellation and shutdown fail closed when ownership cannot be proven. Dashboard degrades per-record with diagnostics and a raw journal link.
- New exact-diff review corrections: an owner cancellation whose remote PR inspection fails three times becomes a **terminal locally cancelled** checkpoint with the **unverified PR and failed attempts retained**. No PR, branch or issue remote cleanup is attempted without confirmed PR state; R1 dispatch releases the completed transport slot. Transient failed inspection checks back off to the CI polling cadence. A correction cannot launch on a discovered-missing issue if the original requirements body is absent; no synthetic title overwrite. The legacy scheduled timer does not select terminal corrected-spec rearm candidates, which are handled by authorized R1 reservations.
- The original three-cycle child critic safety budget remains intact: no additional parent worker when exhausted. Confirmed merges cannot become cancelled. No Ticket 05, new coordinator/queue/store/public command, Finance Dashboard change, production configuration or daemon restart, Windows-host change, merge or deployment.

## Test evidence and review finding matrix

- Read `test/r1-review-recovery.test.js` for durable held cancellations, owner outcomes, unavailable remote state, orphan/initial-discovery recovery, rearm crash/duplicate reservation, missing requirements, confirmed merge, corrected decisions, Node/Python ambiguous process claims, and exhausted cleanup.
- Read `test/autopilot-cli.test.js` for missing-delivered-correction requirements and timer starvation, including original-title preservation; existing process/restart, deterministic verification veto, bounded critic and authorization tests remain.
- Red-before/green-after evidence for the latest three findings is in durable VM storage `ticket04-review-followup/{14-cancel-pr-inspection,15-missing-correction,16-timer-starvation}-{red,green}.log`. Earlier corrections and full evidence remain in `ticket04-corrections-20261122`, `ticket04-review-followup`, and the prior `review-*` directories in the durable verification root.
- Previous exact commit `00910fbf2f55536cfa53cd2e3c7aab0e724f4cbb` had **full GitHub CI PASS** (run 45058952385) but two independent Claude reviews **FINDINGS**. Both later blocking code findings have regression coverage and candidate fixes; the full exact-final-SHA CI and independent PASS verdicts **must be checked again** after committing them.
- Native VM verification of the previous head: all 18 selected focused test-file commands returned zero, including full continuous runner and mixed child execution 9/9; no local complete `npm test`. A further VM regression pass of the new candidate runs before it is committed. GitHub's complete native `npm test` is the full-suite gate.

## Complexity and honest acceptance gaps

Ticket 03 baseline: 79 JavaScript source modules, 16,392 source LOC, 631 LOC in r1-jobs, 2 active lifecycle coordinators and 3 delivery-state copies. Prior corrected commit: 79 modules, 16,814 source LOC (+422), 573 LOC in r1-jobs, 1 active lifecycle coordinator and 1 delivery-state copy. Current candidate: 79 source modules, 16,833 source LOC (+441 against Ticket 03), 575 LOC in r1-jobs; **module count and source LOC reduction criterion remains unmet**. No ungranted waiver is presumed.

Owner decisions before Ticket 04 acceptance: (1) disposition on the literal reduced-LOC/modules acceptance criterion; (2) explicitly authorize a fresh, smallest disposable `woodsja/dev-ralph` issue as drafted below, then separately approve its execution. A confirmed terminal pre-cutover condition is required for legacy in-flight R1 parents; unidentifiable live process ownership requires owner-verified process termination before manual reconciliation, never an unsafe automated retry. These are deployment/readiness dependencies, not authorizations to implement a new migration or coordinator.

## Exact proposed fresh independent E2E task — DRAFT ONLY

Repository `woodsja/dev-ralph`. Title: **Highlander Ticket 04 E2E: safe-integer addition and deterministic tests**.

Create `src/ticket04-e2e-sum.cjs` exporting `sumSafeIntegers(a, b)` using CommonJS. Accept two JavaScript safe integers, throw `TypeError` on non-integers (including numeric strings, fractions, NaN and Infinity), throw `RangeError` for unsafe inputs/results, return their sum, including negative values and zero. Add `test/ticket04-e2e-sum.test.cjs` with Node built-in `node:test`/`node:assert/strict`, covering `2+3=5`, `-2+3=1`, zeros, invalid inputs and overflow. Wire the test into the repository's existing native test command without removing prior tests; no new dependencies, no unrelated production code/config/CI changes. The authorized isolated Highlander job must autonomously create a PR, run deterministic tests, obtain exact-head GitHub CI PASS, independent Claude PASS, preserve all raw worker/critic/recovery logs and require no manually initiated intermediate phases. Leave that PR unmerged.

**Decision A — NOT GRANTED:** Approve publishing exactly the above unlabeled issue only, without ready label or job launch. **Decision B — NOT GRANTED:** Once the issue exists and identity/contents are verified, authorize exactly one R1 submission against an isolated Ticket 04 development coordinator, with owner-specified project and worktree. Do not publish or execute until explicit approval. Existing delivered #3/#5 issues are not reusable.
