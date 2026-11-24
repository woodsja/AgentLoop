# Highlander Ticket 06 — neutral naming and measured readiness

## Scope and evidence

Base: PR #196 at `6d9dea2e272b8a80ad5485f5ff1ecad92b0d7e87`. Isolated `simplify/highlander-neutral-names-20261123` worktree. This is development-only, not an installed daemon change. Prior Ticket05 independent real-repository E2E is baseline evidence **only**; it is not verification of this renamed implementation.

One public MCP submission: `submit_development_job`; one canonical HTTP POST: `/api/development/jobs`. The associated public read-only names are `get_development_job_status`, `get_development_job_result`, and `GET /api/development/jobs/:id`. The old `submit_r1_job` and old R1 HTTP admission are removed, not aliased. Dashboard and replay use the new route. Generic historical read-only `get_job_status`, `get_job_result`, `GET /api/jobs/:id`, raw NDJSON log URLs and cancellation remain. The old internal job ID and historical record format discriminators intentionally remain unchanged: records are not migrated or replayed. The existing admission/dispatch module is renamed `development-jobs.js` and its constructor `createDevelopmentJobs`; it still delegates delivery to the single Autopilot coordinator and preserves old recovery semantics. Remaining `r1-*` child and evidence files are internal historical implementation terminology, not public alternate admission interfaces.

## TDD / regression evidence

- Public tests deliberately changed first and failed (`ticket06/public-red.log`), then passed (`ticket06/public-green.log`): 6 MCP, 4 dashboard, 18 daemon cases.
- `test/r1-mixed-e2e.test.js`: nine Codex/Claude, fail/pass/correction, deterministic-veto, cancellation, SIGKILL recovery, raw-output cases all PASS in `ticket06/mixed-and-runner-green.log`. A combined follow-on runner command timed out at 60 seconds after these nine completed; **do not count runner as verified on that attempt**.
- Additional focused test run `ticket06/additional-focused.log`: deployment-runtime, owner decision actions, review recovery, wrong-worktree and wrong-repo worker authorization passed (exit 0).
- A first extended run exposed stale old HTTP routes in native test fixtures; these were changed to canonical routes before rerun. The first failures are preserved in `ticket06/extended-focused.log` and were not treated as passes.
- `node --check` of changed coordinator/transport source and `git diff --check` succeeded before final publication; exact-head native full suite, two independent Claude reviews and GitHub CI are separate acceptance gates, not asserted here until observed.

## Before/after measurements

Count scope: JavaScript `.js` files under `src`, line counts as physical lines, `*.test.js` under `test`. Approximate test-case declaration count counts literal `test(` / `it(` and excludes dynamically generated cases; it must not be confused with executed assertions. Snapshots and machine-readable measurements are retained as `ticket06/complexity-raw.json` on the Ralph VM.

| Stage | JS source modules | Physical source LOC | Test files | Approximate test declarations |
|---|---:|---:|---:|---:|
| Pre-Highlander, `a225eb4` | 80 | 17,036 | 70 | 887 |
| Ticket01 PR #192 head `b9fd347` | 79 | 17,019 | 69 | 888 |
| Ticket03 PR #194 head `b56ad58` | 79 | 16,392 | 68 | 879 |
| Ticket04 PR #195 head `9accff6` | 79 | 16,835 | 69 | 925 |
| Ticket05 PR #196 head `6d9dea2` | 77 | 14,855 | 66 | 883 |
| Ticket06 implementation | 77 | 14,855 | 66 | 883 |

Measured pre-Highlander to Ticket06 change: **3 fewer source modules, 2,181 fewer physical source lines, 4 fewer test files, ~4 fewer statically declared test cases**. Ticket04 *increased* source LOC +443 vs Ticket03; that safety/recovery expansion is explicitly owner-approved, not a reduction. Ticket06 primarily renames and updates call sites; **no module or LOC reduction** attributable to Ticket06. Module rename is relocation, not deletion. Overall removals include obsolete direct-task facade and retired classic child admission/handoff/scheduler implementation; safety/recovery and tests were also added or relocated. Gross deletion in Git diff must not be confused with net complexity saved.

| Architecture element | Pre-Highlander | Ticket06 intended/current verified source |
|---|---|---|
| Public development MCP admission names | 5 | 1 (`submit_development_job`) |
| HTTP development POST admission routes | 4 | 1 (`/api/development/jobs`) |
| Competing lifecycle coordinators | 2 | 1 (Autopilot delivery coordinator) |
| Actively written delivery-state representations | 3 | 1 canonical per-issue checkpoint |
| Active job state/recovery mechanism | Multiple overlapping copies | 1 canonical mechanism; queue is transport and historical index, not delivery authority |
| Manual intermediate phase calls for one authorized job | Not established for pre-Highlander baseline | 0 observed in Ticket05 E2E; **not retested externally after Ticket06 rename** |

Ticket06 submission/lookup names are a deliberate client-breaking cutover. No compatibility alias is permitted. Installed MCP bridge clients must refresh their tool inventory and use the renamed tool. The formerly public R1 paths should not be used to submit new work.

## Known acceptance boundaries

The renamed public interface is not proven on a fresh external real-GitHub issue by the prior Ticket05 demonstration. If owner requires a fresh live E2E, first create a bounded test issue and obtain separate execution authorization. Do not start it under this ticket's general development authorization. Full exact-head CI and Claude reviews must refer to the final Ticket06 SHA before accepting this document as complete.
