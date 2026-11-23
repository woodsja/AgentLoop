# Ticket05 implementation and verification

Source base: `9accff6526a47aabc1ab36eea8fed57747fd7865`, branch
`simplify/highlander-retire-classic-20261122`. Development worktree only.
The deletion map was created before source edits.

## Subsequent native-VM verification (supersedes Codex sandbox-only results)

The original Codex workspace-write sandbox blocked synchronous captured
subprocesses and loopback sockets. Retesting through Ralph's normal
unprivileged Linux VM resolved those environment restrictions.
Exact native commands/results:

| Command | Result |
| --- | --- |
| node test/r1-jobs.test.js | PASS, 9/9; exit 0 |
| node test/r1-failed-work.test.js | PASS, 11/11; exit 0 |
| node test/r1-mixed-e2e.test.js | PASS, 9/9; exit 0 |
| node test/daemon.test.js | PASS, 16/16; no skips; exit 0 |
| node test/r1-runner.test.js | PASS, 1/1; exit 0 |
| git diff --check | PASS; exit 0 |

The native mixed-engine E2E exercised Codex correction, Claude FAIL/PASS
gating, invalid verdict rejection, source-verification veto, interruption
recovery, active cancellation, raw transcript replay, and full feedback
propagation. The HTTP cases previously skipped now pass. Logs are retained
in the VM durable Ticket05 evidence directory as *-native.log (the r1-jobs
and r1-failed-work command outputs were observed and summarized directly
rather than separately persisted); the first execution's raw Codex log also
preserves the original sandbox-failure diagnostics.

These focused/integration passes do NOT replace complete npm test in
GitHub CI or independent Claude review at the precise final commit. No real
post-Ticket05 externally authorized GitHub demonstration has been executed.
This addendum supersedes the earlier environment-blocker assessment below;
the original failed/skipped results remain preserved as historical evidence.

## Result and limits

Implemented deletion; **acceptance remains incomplete**. Local engine/Git/HTTP
integration cannot be verified in this execution environment. No push, PR,
merge, production restart/configuration change, host write or real issue
execution was performed. Ticket06 has not started and is not acceptance-ready.
Final real E2E acceptance gate: **PENDING OWNER AUTHORIZATION**.
Independent Claude review and full native GitHub CI at the final head are pending.

## Responsibilities removed and retained

Removed daemon worker/cycle scheduling, plan advancement, blocked-task streaks,
polish, pass latches, checkpoint commits and loop completion/result handling.
Deleted r1-child-handoff.js and r1-child-admission.js. Removed enqueueLoop,
child reservation publication and the child's separately writable queue state.
Deleted dead polish/blocked-item prompts and unused plan-cursor parsing.
These responsibilities were deleted, not copied to another coordinator.

The existing implementation bridge now awaits Codex and read-only Claude through
createCliWorker inside the canonical attempt. Three implementation/review rounds
remain bounded; FAIL/CONTINUE carry full feedback, malformed/signalled reviews
cannot PASS, and deterministic verification vetoes an incorrect Claude PASS.
Autopilot alone owns process claims, attempt evidence, cancellation, delivery,
GitHub CI and final review. Synthetic instruction/index/history protection stays.
Normal installed skill tooling is unchanged; exported CLI skill events are
retained verbatim. The skill-output regression uses a simulated exported CLI
event: it is **not evidence of a real worker invoking an installed skill**.
The TDD skill was actually read by this development agent in the captured session.

Old task/results/raw logs and cycle-log filenames remain readable by ID. The old
child-index module is now read-only. Explicit offline historical process recovery
remains available; it cannot admit or execute a worker. Legacy archive writes
only close already-existing records and retain captured cycles verbatim.

A restarted canonical implementation with interrupted evidence holds the existing
issue checkpoint and workspace for owner reconciliation. It does not launch a
replacement attempt, create a recovery queue, or infer completion from a partial
critic result. Unknown process ownership uses the pre-existing fail-closed claim
mechanism. This conservative hold needs an owner recovery decision; successful
automatic continuation of an interrupted implementation is not claimed.

## Measurements

Counts use top-level src/*.js and test/*.test.js, including blank/comment lines.
Lifecycle counts concern the canonical worker/critic development path; generic
transport reservation writes and historical archival are not active coordinators.

| Measure | Before | After |
| --- | ---: | ---: |
| Delivery + competing classic execution coordinators | 2 | 1 |
| Active lifecycle writer families | 2 | 1 |
| Active authoritative job-state representations | 2 | 1 |
| Supported public development submission interfaces | 1 | 1 |
| Public classic admissions | 0 | 0 |
| Modules containing active classic lifecycle/bridge logic, excluding mixed daemon | 4 | 0 |
| JS source modules | 79 | 77 |
| JS source LOC | 16,835 | 14,787 |
| Top-level test files | 69 | 65 |
| Textual test( occurrences, including parameterized declarations | 975 | 916 |

Test call sites retained/added/removed: **902 / 14 / 73** (textual occurrences,
not expanded runtime cases). Four removed files exclusively exercised deleted
child queue/reservation/handoff/admission mechanics. Other private daemon cycle,
checkpoint and polish tests were retired with their deleted code. Public recovery,
HTTP inspection, authorization, raw evidence and mixed-engine integration tests
remain; mixed integration assertions now inspect canonical evidence.

## Test evidence

Each row is the exact command `node test/<name>.test.js`, with native Node and
without a preload or test-output normalization. These are focused suites, not
full native npm test. No timed-out run is counted as passing.

| Name | Exit | Passed / failed / skipped |
| --- | ---: | --- |
| r1-loop-implementation | 0 | 16 / 0 / 0 |
| r1-review-recovery | 0 | 21 / 0 / 0 |
| daemon | 0 | 11 / 0 / 5 |
| r1-process-claim | 0 | 4 / 0 / 0 |
| r1-child-recover | 0 | 3 / 0 / 0 |
| cli-worker | 0 | 11 / 0 / 0 |
| autopilot-state | 0 | 30 / 0 / 0 |
| r1-milestone-admission | 0 | 30 / 0 / 0 |
| tools | 0 | 6 / 0 / 0 |
| ui | 0 | 4 / 0 / 0 |
| prompts | 0 | 10 / 0 / 0 |
| r1-mixed-requirements | 0 | 1 / 0 / 0 |
| r1-jobs | 1 | 7 / 2 / 0 |
| r1-failed-work | 1 | 0 / 11 / 0 |
| r1-mixed-e2e | 1 | 0 / 9 / 0 |

`node --test-name-pattern='eight critic retry cycles' test/execution-log.test.js`:
exit 0, one passed. Full diagnostic bytes survive reload and reach the worker.
`node --check` on changed coordinator/facility source and `git diff --check`:
exit 0.

Red-to-green slices (exact command prefix `node --test-name-pattern='<pattern>'`):

- `pending cancellation`, test/r1-loop-implementation.test.js: exit 1, then 0;
  cancellation now precedes filesystem preparation and child evidence.
- `canonical authorization denial`, same file: exit 1, then 0; authorization
  precedes preparation and launch.
- `signalled critic`, same file: exit 1, then 0; an interrupted PASS cannot deliver.
- `canonical restart holds`, test/r1-review-recovery.test.js: exit 1, then 0;
  interrupted implementation preserves the workspace without another worker.

Raw development check outputs are in /tmp/ticket05-final-*.log and red/green
slice outputs in /tmp/ticket05-*-red.log /tmp/ticket05-*-green.log for this session.
The source suite retains regression coverage; /tmp is not production job history.

## Environment blockers and remaining gates

Native Node synchronous captured subprocesses report `spawnSync git EPERM`
(and even `spawnSync true EPERM`) here. All 22 failed integration/Git cases hit
this boundary before their assertions; they are failures, not passes. Five socket-based HTTP
cases explicitly skip because loopback listen is unavailable. Additional real HTTP
request-listener tests run without sockets and prove pending/running cancellation,
historical direct/loop/R1 GET-by-ID, full raw cycle records, and closed admissions. An exploratory
/tmp-only file-stdio preload avoided the first Git capture error but the daemon
fixture then timed out at startup; that attempt is not validation and no preload
is committed. No repository sandbox/CLI policy was weakened.

Remaining: rerun all failed/skipped suites on an authorized normal Linux runner,
then full native npm test in GitHub CI, real installed-skill invocation evidence
when used, independent Claude review and exact-final-head CI. Large raw transcript
paging/restart, active process-group cancellation and real Git/worktree isolation
remain unverified end-to-end for this patch despite retained regression cases.

After those gates pass, the only authorized publication is a DRAFT stacked PR
against `simplify/highlander-one-coordinator-20261122` (#195), never main or
release/auth190. No merge/deployment or additional E2E is authorized.

## Local commit blocker and operator commands

`git add package.json src test docs/highlander-ticket05-deletion-map.md docs/highlander-ticket05-verification.md`
exited **128**: `Unable to create '/home/woodsja/tools/ralph/.git/worktrees/highlander-retire-classic-20261122/index.lock': Read-only file system`.
The sandbox permits source writes here but mounts the linked Git metadata outside
its writable roots. Approval escalation is unavailable. No index/commit write,
branch update or push succeeded. HEAD remains the required Ticket04 base.

From an owner-authorized shell with writable metadata, after reviewing the diff:

```bash
cd /home/woodsja/worktrees/ralph/highlander-retire-classic-20261122
git diff --check
git add package.json src test docs/highlander-ticket05-deletion-map.md docs/highlander-ticket05-verification.md
git commit -m "Retire classic loop scheduling from canonical development jobs"
```

After the failed/skipped focused suites pass, publication commands are:

```bash
git push -u origin simplify/highlander-retire-classic-20261122
gh pr create --draft --base simplify/highlander-one-coordinator-20261122 --head simplify/highlander-retire-classic-20261122 --title "Retire classic loop scheduling" --body-file docs/highlander-ticket05-verification.md
```

The full native GitHub CI and independent review must then be verified on the
precise resulting head. The commands above do not authorize merge or deployment.
