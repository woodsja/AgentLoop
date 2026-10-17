# Issue #86: direct Codex implementation

Read AGENTS.md, ADR 0001 and the owner-provided issue criteria before work.
Implemented directly in the isolated issue worktree, without Ralph R1 execution,
live configuration changes, service changes, host changes, deployment or merge.

The `ralph` package entry point supplies owner-only `project add`, `check`,
`activate` and interrupted-pair `recover` commands. It reuses the two existing
owner JSON stores, #84/#85 preparation, process ownership and #90 execution logs.
Registration stays staged and cannot admit jobs. Explicit readiness retains red
application baselines. Activation separately approves current owner delivery
preferences after checking the readiness commit. No automatic merge preference
is changed. Existing project settings remain untouched.

The dashboard exposes registered lifecycle facts plus complete raw execution
records for every onboarding run, including failed registrations. Pair updates
use sorted file locks, durable replacements, a transient recovery journal,
exact rollback and conflict detection for owner edits. See
[operator usage and recovery](../project-registration.md).

Validation includes Node and real uv/Python happy paths, missing/stale locks,
missing runtime, failing application tests, duplicate registration, same-process
and cross-process contention, cancellation/retry, prior dead setup claims,
faults after either owner-store write, interrupted-pair recovery, preservation of
divergent owner edits, stale-base activation refusal, and real HTTP dashboard
raw-log retrieval. A signal test verifies that 30,000 output characters survive
SIGTERM cancellation with process ownership released and retry succeeding.

Test environment: the command sandbox rejects Node spawning Git with EPERM, so
integration tests/full npm tests run with approved test escalation. The ordinary
shell PATH lacks uv; prepend the predecessor's temporary `/tmp/issue85-tools`
for real locked Python fixtures. No installed tool or live PATH is modified.

Exact-head remote GitHub CI and independent Opus review are release gates that
remain unverified by local tests. This task does not push, merge or deploy.
Passing tests and a local commit are not deployment evidence. VM-to-host bridge
verification and reversible live migration remain #87.

Local results:

- Focused onboarding suite: 14 passed, zero failures.
- Activation regression (runtime/base freshness and owner merge preference): passed.
- Final full `PATH=/tmp/issue85-tools:$PATH npm test`: 516 passed, zero failures.
- Dashboard UI source/render regression tests: two passed.
- `git diff --check` and staged diff check: clean.
- `config.json` and `autopilot-projects.json`: unchanged.

Detailed local test output is retained under `/tmp/issue86-final-focused.log`,
`/tmp/issue86-activation.log`, `/tmp/issue86-final-full.log` and
`/tmp/issue86-ui.log` (temporary validation artifacts, not deployed job history).
