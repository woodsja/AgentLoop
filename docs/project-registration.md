# Owner-controlled project onboarding

After installing the repository's `ralph` package executable (for example with
`npm link` in your chosen installation), use:

```sh
ralph project add owner/repository
ralph project check owner/repository
ralph project activate owner/repository
```

Without installing an executable, the same entry point is
`node src/cli.js project add owner/repository`. These commands operate directly;
they never invoke Ralph R1 or start an admission runner, daemon, or service.

`add` clones the GitHub repository into `~/repositories/owner--repository`,
resolves the default origin branch, requires a clean committed checkout, and
creates a detached inspection worktree under `~/worktrees/owner--repository`.
It validates the shared `.ralph/project.json` contract and committed native
lockfile and metadata. It never installs dependencies or runs application code.
Native package managers perform authoritative lock compatibility checks during
explicit readiness. Node requires package-lock.json (npm lock format 1–3);
Python requires pyproject.toml and uv.lock.

The preview includes repository/commit/base, concrete directories, runtime,
resolved tools, exact install/check commands and npm script body, Python's local
venv, CI workflow, worker/reviewer/model configuration, labels, retry limit,
and merge policy. Approval registers **staged**, with admission disabled and
readiness unchecked. `--yes` is explicit approval for scripts; otherwise a
terminal prompt follows the preview. Refusing approval retains inspection
artifacts/logs and leaves both owner stores unchanged.

The two existing stores remain authoritative: `config.json` contains
`allowedProjects`, and `autopilot-projects.json` contains delivery/admission
settings. New projects default to Codex, independent Opus review (`always`),
two attempts, `CI`, `ready-for-agent`, `ready-for-human`, and `autoMerge: false`.
The repository cannot set these policies. Owner flags include `--worker`,
`--ci-workflow`, `--ready-label`, and `--base-branch`; other intended preferences
can be edited in the owner config while staged. Existing entries and merge
preferences are preserved, including on duplicate requests. Conflicting names,
repo aliases, divergent store entries, and mismatched checkout origins require
owner reconciliation instead of replacement. No active project is migrated.

`check` explicitly runs #84/#85 preparation in a new disposable worktree:
`npm ci --foreground-scripts --no-audit --no-fund` then the declared npm script,
or `uv sync --locked` followed by verification with the local `.venv` on PATH.
It persists an independent infrastructure receipt and baseline test results.
Ordinary failing application tests can be **ready**. Missing tools, stale locks,
installer failures, command-not-found, cancellation and timeouts block readiness.
No lock repair, inner sandbox or new permission service is involved. Retries
create a fresh worktree; logs and prior setup contents remain available.

`activate` requires readiness for the current local base commit, previews current
owner settings and asks for separate approval. It changes admission enablement
and registry activation only, preserving merge/review/retry/CI preferences. It
does not submit a job, poll issues, merge, deploy, or reload a running daemon.
The daemon loads authorization at startup; after a separately authorized restart
it will see activation. Application jobs retain fresh-worktree preflight and the
existing deterministic verification, exact-commit CI and independent review gates.

Use `--config path`, `--projects path`, `--checkout-root path`, and
`--worktree-root path` for isolated operation. `AGENTLOOP_CONFIG_PATH`,
`AGENTLOOP_PROJECTS_PATH`, and `AGENTLOOP_STATE_DIR` also select the existing
stores/state. Use the same config and state as the intended daemon for its
owner diagnostics; development/tests must use isolated paths.

Every invocation prints its durable #90 execution ID/path and raw-download URL.
Commands, PATH/tool detection, both output streams, previews, failure stacks,
process claims and outcomes persist in existing `state/logs` execution records.
The dashboard's **Project onboarding diagnostics** section lists registered
facts and all onboarding runs, including failed registrations. Open a run for
the chronological captured records or download the full raw NDJSON. Nothing is
redacted or irreversibly truncated; only actual CLI-exported events are captured.

## Concurrency and recovery

Both config paths are canonicalized and locked in sorted order for the operation.
A concurrent command fails with an actionable retry message. Prior owner fields
are retained; detected external edits abort replacement. Editors should respect
`<config>.project-lock` as well; an arbitrary writer bypassing locks cannot be
made transactional by this CLI. Per-file replacements use fsync/rename, with a
transient `<config>.project-transaction` rollback journal for the pair. It is
recovery material, not another project database. Failed writes roll back exact
original contents. A divergent owner edit is preserved and leaves the journal
for explicit reconciliation.

SIGINT/SIGTERM cancel setup process groups; PID/start-time claims are persisted
before preparation starts. After a hard kill, verify the CLI owner in each
lock's `owner.json` has stopped before removing its abandoned lock directories.
If a pair-update journal remains, use the **same original paths**:

```sh
ralph project recover --config /isolated/config.json --projects /isolated/projects.json
```

Recovery rolls back the interrupted pair, refusing to overwrite divergent owner
edits. Then repeat `check`; it reconciles the prior durable setup process claim
before starting another worktree. Ambiguous ownership blocks retry. Failed job
history and execution records are never erased to rearm work.

This implements [ADR 0001](decisions/0001-agentloop-trust-boundary.md). It changes
no live settings, mounts, host integrations or deployment. Actual VM-to-host
checks and reversible live migration belong to #87. A commit, passing local tests,
or merge does not establish deployment verification.

## Migrating an existing project

Commit the common contract and native lockfile to the project's reviewed base
first. `add owner/repository` recognizes a unique legacy repository alias (such
as `ralph` or `finance-dashboard`) and keeps that name, checkout, worktree root,
base branch, labels, worker/critic/model preferences, retry policy, CI workflow,
unknown owner fields and explicit `autoMerge` choice. The contract supplies
verification during execution; the legacy owner verification field is retained.
Only obsolete `prepareVenv`/`pythonEnvironment` setup fields are retired during
approved migration. Repository facts cannot select delivery policy.

An active legacy entry is refused without changes. The owner must separately
stage it (`enabled: false`, and inactive registry activation if present), after
checking active jobs and taking an exact backup of both owner files and durable
state. Do not stage a live project merely to run a rehearsal: copy its settings
and repositories to isolated locations, then stage those copies. Existing job
history must stay intact. Conflicting aliases, roots or store entries require
reconciliation; `add` never renames or replaces them automatically.

Run `add`, inspect its complete preview, then `check`, inspect the infrastructure
receipt and baseline results, and finally `activate` with separate approval.
Activation changes admission only. `recover` rolls back interrupted paired writes;
it does not undo a completed activation. For a completed rehearsal rollback,
stop the isolated consumer and restore the exact two config backups, retaining
state and raw logs. Live rollback and daemon restart remain separate owner
operations. See [the #87 evidence and open gates](verification/issue-87.md).

## R1 issue prerequisite admission (#27)

For the autonomous `ralph` project only, an issue may declare a dedicated line,
`Depends on: #12, #15`. List one to eight unique, **smaller-numbered** issues
in the same repository. Use a plain line with a colon, without Markdown
heading, list marker, or bold formatting. Lines starting with the Depend*
family are reserved: malformed forms block admission rather than becoming prose.
Dependencies are not inferred from unrelated prose; malformed
metadata and self/forward references block admission with a diagnostic. This
smaller-number rule prevents cycles without a separate graph scheduler.

A labelled issue is admitted only when all its prerequisites have durable
successful merge evidence in the same project's existing R1 job store: exact
verified commit, green CI, independent Claude PASS without findings, and a
recorded merge and issue reconciliation. Merely closing the GitHub issue is
insufficient. Blocked labelled issues remain labelled; independent ready issues
can proceed, and a later ordinary admission scan rechecks dependencies. This
mechanism does not apply to Household Purchases' separate autopilot yet.
