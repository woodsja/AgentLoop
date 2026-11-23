# Ticket05 deletion map (before implementation)

Baseline: `9accff6526a47aabc1ab36eea8fed57747fd7865`; clean dedicated branch.
Counts: 79 top-level `src/*.js` modules, 16,835 source lines; 69
`test/*.test.js` files, 975 textual `test(` declarations (parameterized runtime
cases counted separately by Node). Two execution coordinators: Autopilot and
daemon classic cycles. Two active lifecycle representations/writer families:
Autopilot issue checkpoint and classic child task/cycle/result records. One
public development admission: POST /api/r1/jobs (transport aliases submit to
that same interface). Four classic child modules plus the mixed implementation
bridge; classic scheduling itself is embedded in daemon.js (2,846 lines).

## Actual call graph and disposition

1. **Required worker/critic**: POST /api/r1/jobs -> createR1Jobs.execute ->
   Autopilot run -> createR1LoopImplementation.run -> ensureChildLoop ->
   createR1ChildHandoff.ensure -> enqueueR1ChildLoopOnce -> daemon.fillSlots ->
   startLoop -> startLoopCycle -> spawnLoopSession(worker) -> finishLoopWorker ->
   spawnLoopSession(Claude critic) -> finishLoopCritic -> repeat -> polling parent
   -> verifyTask -> canonical commit/PR/CI/final review. Retain Codex, read-only
   independent Claude, full feedback, bounded correction, deterministic veto and
   parent delivery. Execute these as awaited facilities inside the existing
   canonical attempt, with evidence in its issue checkpoint and process ownership
   in its existing agentProcess field. No child queue or second recovery writer.
2. **Duplicated lifecycle/scheduling**: daemon cycle advancement, plan-item
   completion, blocked-item streaks, polish scheduler, pass latch, checkpoint
   commits, loop completion/results and shutdown phase reconstruction disappear
   entirely. Child handoff/admission/reservation modules disappear, rather than
   being relocated. Synthetic instruction protection may remain as worker input
   preparation; it grants neither scheduling nor delivery authority.
3. **Read-only historical inspection**: queue/result GET-by-ID, raw paged/download
   journals, dashboard historical projections and old immutable child index
   reading remain. Existing interrupted processes must still be confirmed stopped
   before archiving; uncertain ownership retains the workspace and blocks work.
   No migration/deletion of historical task, result or transcript files.
4. **Dead/unused**: public classic admissions were removed in Ticket03. Delete
   their remaining source-level enqueueLoop writer and obsolete private mechanic
   tests; fixtures can write historical records explicitly. Delete classic-only
   process spawning, model/role selection and Git checkpoint helpers when their
   last execution caller disappears. Normal agent skill tooling stays installed;
   exported tool/skill events are preserved as raw CLI bytes, not synthesized.

## Test seams

Owner-confirmed seams: canonical submission/status/cancellation, child execution
and review evidence, historical GET-by-ID. Existing mixed-daemon integration tests
exercise actual local Git/worktrees and CLI subprocesses with only external
GitHub/engine behavior substituted. Adapt their evidence assertions from the
removed child queue to canonical status evidence. Retain recovery/authorization,
transcript and deterministic-verification coverage. Private classic cycle tests
are retired only alongside their deleted responsibilities.
