# AgentLoop

Self-improving fresh-context loops for coding work you can watch.

![AgentLoop dashboard showing a worker and critic loop](docs/dashboard.png)

[Watch the demo](https://youtu.be/4zRdMMzh3C8) | [Try the replay](https://agentloop-replay.vercel.app) - a real recorded run in the live dashboard

## Ralph operator trust model

For this repository's Woods-controlled autonomous Ralph deployment, the [accepted owner-visibility and disposable-VM decision](docs/decisions/0001-agentloop-trust-boundary.md) governs work on R1, logging, onboarding, and host boundaries. Complete captured transcripts belong to the owner; protect the physical host rather than disposable VM files. **This is an architecture requirement, not a claim that the live daemon already implements it** (see [#90](https://github.com/woodsja/AgentLoop/issues/90)).

## What it is

AgentLoop coordinates authorized development jobs in registered Git repositories. A single submission through the MCP tool `submit_r1_job` or the corresponding daemon route `POST /api/r1/jobs` advances implementation, deterministic verification, exact-commit GitHub CI, independent Claude review and bounded correction, then leaves an open pull request for an owner to merge separately. The current transport uses the historical `r1` name; the intended public vocabulary is a neutral development job after the coordinator and state are consolidated.

Codex handles implementation; Claude reviews independently. The daemon persists job progress and captured raw execution records so the owner can inspect results, cancel running work, or diagnose a failed or interrupted job. New development jobs use the same coordinator regardless of whether a client submits through the dashboard or MCP.

## Why fresh contexts

Each agent invocation starts with a fresh process. Durable job state and the repository carry forward the authorized task and any reviewer findings; no human must copy intermediate results between conversations. Retries are bounded. Historical task and loop records remain readable, but their old admission interfaces are no longer supported. Pre-upgrade pending legacy tasks and classic loops are moved to a durable failed state without starting a retired worker; any interrupted legacy process is recovered without replay.

## How it works

1. Register and activate a project in owner-controlled configuration and authorize its worktree policy. Supply an exact GitHub issue that has **already** received its separately approved executable release and required ready label; creating or drafting an issue alone does not authorize execution.
2. Submit `{project, issue}` once with `submit_r1_job`, or choose **New job** in the dashboard. The daemon validates project, repository, and worktree authorization before starting work.
3. Codex implements the change in the authorized worktree, and Ralph runs deterministic verification with complete captured output. Failed implementation or verification receives bounded correction attempts.
4. Ralph pushes the delivery branch and opens a PR. Required GitHub Actions workflow results are checked against the *exact delivered commit*, followed by independent read-only Claude review of that same commit. Actionable review findings can trigger bounded correction and a fresh exact-commit check.
5. With `autoMerge: false`, the job ends in a recorded pass/blocked outcome and leaves an approved PR open for owner inspection. Merging and production deployment are separate actions.

The R1-backed delivery coordinator is the currently proven implementation. The internal classic worker/critic loop is still needed for some projects and will be consolidated in a later change; it is not a separately supported submission path. No direct one-shot task or classic-loop submission interface is offered.

Captured raw logs, historical job lookups, cancellation, and owner-decision holds are retained. The system never promises access to model reasoning not exposed by the CLI.

**Agent permissions and host boundary.** The Codex implementation CLI runs with the configured workspace-write sandbox and network access disabled inside that sandbox, using its existing on-request approval policy. Internal Claude critics run in restricted read-only mode with web tools disabled. The independent PR reviewer uses a separate restricted Claude process with no execution tools and a private owner-managed credential. These agent settings do not establish that the Linux VM is isolated from the Windows host; verify actual VM-to-host bridges separately under [ADR 0001](docs/decisions/0001-agentloop-trust-boundary.md).

## The dashboard

The local dashboard at `http://127.0.0.1:5757` offers one **New job** form: select a registered project and enter its already-authorized GitHub issue number. The form submits to `POST /api/r1/jobs`; it cannot create or approve GitHub issues or choose an arbitrary filesystem path. The dashboard also shows job status, queue, historical runs, owner messages and execution evidence, including downloadable complete raw NDJSON logs. Cancellation still uses `POST /api/cancel`.

The existing read-only visualization includes historical loop timelines and checkpoint details. Those remain for inspection while their underlying execution machinery is consolidated into the canonical delivery coordinator.

## How it was built

AgentLoop started as my own bottleneck. I was the relay between ChatGPT planning the architecture and Codex executing the tasks, shuttling plans and results back and forth across multiple projects, and quality slipped whenever I stepped away. A bare retry loop was not the answer: loops without standards rot their context and never improve. The fix was to move the human judgment into the system itself, so I designed the sequential fresh-context loop, the files-as-memory model, the strict critic verdict contract, and the rubric-as-GUIDELINES pattern to mimic a demanding human in the loop. Codex CLI with GPT-5.6 turned that design into working code: the daemon, filesystem store, loop engine, critic, bridge, and dashboard wiring, roughly one focused session per slice.

The engine layer came later. Nothing in the daemon is tied to one CLI: `src/engines.js` takes one entry per engine, and Codex CLI and Claude Code both ship today, either one running as worker and critic. Codex is the default.

## Independent evaluation

The reproducible [query parser evaluation](examples/query-parser) asked for the full repair in one pass. Cycle 1 produced nine passing tests, but a fresh critic found a mixed percent-decoding defect and returned FAIL. Cycle 2 fixed it, added regression coverage, passed 11 tests, and received PASS from a new critic.

[Read the evaluation record](docs/evaluation.md).

## Quickstart

Requirements:

- Node.js 18 or newer
- Git
- At least one engine CLI installed and authenticated, found on `PATH` or through an `enginePaths` override. Codex CLI (`codex`) has no version floor; Claude Code (`claude`) needs 2.1.169 or newer, the release that added the `--safe-mode` flag it is launched with

Windows:

```powershell
git clone https://github.com/aiedwardyi/AgentLoop.git
cd AgentLoop
node src\daemon.js
```

Open `http://127.0.0.1:5757`. Select **+ New loop**, point **Project folder** at a folder containing `PLAN.md`, pick an **Engine**, then select **Start loop**. No dependency install is required.

## Connect a chat client

This is optional: once connected, you can plan and launch real work on your machine from a chat, without opening a terminal.

1. In the dashboard, open **Connector** and select **Start**.
2. Expose the local bridge on port 5758. For example:

   ```powershell
   cloudflared tunnel --url http://127.0.0.1:5758
   ```

3. Copy the authenticated connector URL from the Connector popover. Replace the local host with your tunnel host while preserving `/mcp?key=...`.

   ```text
   https://<your-tunnel-host>/mcp?key=<token-from-Connector>
   ```

   Treat this URL as a secret; the token persists in state/mcp-token - delete that file and restart the bridge to rotate it.

4. Add that URL as a custom connector in Claude or ChatGPT, then describe tasks in plain English.

Claude Code can connect to the local bridge directly, no tunnel needed:

```powershell
claude mcp add --transport http agentloop "http://127.0.0.1:5758/mcp?key=<token-from-Connector>"
```

The bridge listens on `127.0.0.1:5758` with its existing token and exposes `submit_r1_job` as its sole development-job submission tool. It also exposes `get_r1_job_status`, `get_r1_job_result`, `get_job_status`, `get_job_result`, `agentloop_status`, and `send_message`. Generic status/result tools retain access to historical job IDs. The separate opt-in `run_bash` diagnostic tool is not a job-submission interface.

## Submit a development job

With an activated project and an owner-authorized ready-labeled GitHub issue:

1. In the dashboard, select **New job**, choose the registered project, and enter the GitHub issue number. The form does not permit choosing a direct shell command, implementation engine, or arbitrary worktree.
2. Alternatively, use `submit_r1_job({project: "registered-project", issue: 42})` through MCP. The job ID immediately returned is durable and can be used to retrieve status, results, and raw records.
3. Follow the same job through implementation, native tests, PR delivery, exact-head CI, and Claude review. With auto-merge disabled, the resulting PR remains open and unmerged.

Do not relabel or release issues automatically when owner authorization or an immutable ticket manifest is required.

## Configuration

`config.json` contains the local runtime settings:

| Key | Default | Purpose |
| --- | --- | --- |
| `dashboardPort` | `5757` | Local dashboard port. |
| `maxConcurrent` | `2` | Maximum concurrent admitted queue jobs and internal worker sessions. |
| `taskTimeoutMin` | `45` | Timeout in minutes for each worker or critic session. |
| `defaultEngine` | `codex` | Default internal worker engine; the canonical development policy requires Codex implementation and independent Claude review. |
| `mcpBridge.port` | `5758` | Local MCP bridge port. |
| `models` | `{ "claude": "opus", "codex": "gpt-5.6-terra" }` | Default model per engine. |
| `enginePaths` | none | Optional absolute path per engine, for a CLI that is not on `PATH`. |
| `allowedProjects` | none | Admin-owned registered project roots and authorized worktrees used by `/api/r1/jobs`. Missing or invalid entries deny submission. |

The shipped `config.json` includes every key above except the optional `enginePaths` key.

Register the canonical development project in the owner-controlled registry (relative roots are resolved relative to `config.json`):

```json
"allowedProjects": {
  "starter": "examples/starter"
}
```

Requests send the registered project name and an approved GitHub issue number, never a working directory. The daemon resolves the configured root and approved worktree before execution; it refuses unknown projects, path overrides, and unauthorized worktrees. Project policy for GitHub, worker, review and CI is also defined in `autopilot-projects.json`.

Registered project policy specifies the Codex worker and independent Claude reviewer for the canonical workflow.

## Scheduled autopilot (systemd user timer)

`src/autopilot-systemd.js` installs `ralph-finance-autopilot.service` (a oneshot `node src/autopilot.js --project finance-dashboard` pass) and `ralph-finance-autopilot.timer` (`OnCalendar=*:0/5`, `Persistent=true`) into `~/.config/systemd/user`. It does not start the AgentLoop daemon.

```bash
node src/autopilot-systemd.js --root /home/woodsja/tools/ralph-autopilot --run-once
```

It reloads the user manager, runs `systemctl --user enable --now` on the timer, and with `--run-once` starts the service once and fails if that pass fails. It then checks `loginctl show-user <user> --property=Linger`. If lingering is off, it tries `loginctl enable-linger <user>`. If that is refused, it prints the exact error as the permission boundary and leaves the rest of the install in place. Add `--dry-run` to print the units without installing them.

A disabled project, like `finance-dashboard` with `"enabled": false`, makes each scheduled pass exit 0 right away. It does not do issue discovery, cleanup, or workspace preparation.

Worker directories must be authorized by the owner configuration (`AGENTLOOP_CONFIG_PATH` or `--config`). Existing `allowedProjects` entries can still map a project name to its directory. To authorize isolated feature worktrees, a project entry may instead contain `root` and a named `worktrees` map:

```json
{"allowedProjects":{"ralph":{"root":"/path/to/checkout","worktrees":{"review":"/path/to/feature-worktree"}}}}
```

To authorize future linked worktrees once at the project level, an entry may instead (or also) name a managed `worktreeRoot`, such as `{"root":"/path/to/checkout","worktreeRoot":"/path/to/worktrees"}`. After this owner authorization, Ralph can create the approved Git issue worktree without an additional project-registry entry. The canonical submission names the registered project and issue; it cannot select an arbitrary filesystem location. Explicit named aliases take precedence. Selectors must be single directory names, without slashes, absolute paths, or `..`. Projects without a managed root still require an explicit alias. A worker directory under that root is authorized only when its canonical path stays inside the root and it is a registered Git worktree of that same repository, not its main checkout; symlink escapes, plain directories, and other repositories' worktrees are refused.

Keep that authoritative configuration outside every writable worker directory. Requests select an owner-registered project and GitHub issue. An optional authorized worktree alias can be supplied to the canonical submission when configured. The resolver rechecks the canonical directory, Git worktree registration, and repository ownership before execution; `cwd` and `projectPath` remain rejected. Unknown projects, redirected worktrees, and unrelated paths fail closed.

Owner-authorized worktrees use ordinary VM-local subprocesses for preparation and verification. Worker CLIs keep their normal permission settings; registration does not require a per-worktree filesystem sandbox or a particular worker engine. Git worktrees support recovery and scope selection, not host isolation. See [Node project readiness](docs/node-projects.md) and [ADR 0001](docs/decisions/0001-agentloop-trust-boundary.md). This configuration support does not register new live projects or change services.

**Continuous runner.** A project with `"autoMerge": true` (plus `worker: "codex"` and an independent `reviewPolicy`) is developed continuously by the AgentLoop daemon, with no scheduler pass. While no R1 job is queued or running, the daemon checks at most once a minute for the project's next `readyLabel` issue and submits it through the normal R1 path (`source: "runner"`). It then advances the job through implementation, verification, delivery, required CI (watched every 30 seconds, failing after 60 minutes), independent review, bounded correction, the guarded merge, and issue closure. Every job ends in exactly one outcome: `merged` (temporary branch deleted), `needs_specification` (the issue lacks a description; Ralph comments, swaps `readyLabel` for `humanLabel`, and waits until the description changes), or `failed` (retry or review limits exhausted; the PR is closed with the diagnostics, the temporary branch deleted, and the issue relabelled). Evidence stays in the job store and the R1 job result. Projects without `autoMerge` keep the `passed`/`blocked` hand-off.

CI is green only when the latest run of the project's `"ciWorkflow"` (a GitHub Actions workflow name, such as `"CI"`) for the exact delivered commit concluded `success`. Any other workflow, including an advisory review, never satisfies the gate; a missing, queued, or in-progress required run keeps CI pending, any other conclusion is red, and a project without `ciWorkflow` never reaches green.

Projects may opt into a post-green-CI review gate with `"reviewPolicy": "always"` (or `"risk"`). The default reviewer is a separate, read-only Claude Sonnet process; set `"reviewModel": "opus"` to choose Opus. It fetches the PR patch and issue context through `gh`, reads repository `AGENTS.md` guidance from the delivered commit, runs in restricted `dontAsk` mode with its Claude tools explicitly disabled, and accepts only a strict JSON verdict bound to the delivered SHA. An explicitly authorized [review-only successor](docs/review-evidence.md#direct-verdicts-and-review-only-successors-170) can obtain fresh evidence after a blocked review without changing the original job or authorizing merge.

Skipping review with `"reviewPolicy": "none"` (also the default when omitted) requires a `"reviewSkipReason"` explaining the exception, such as `"Documentation-only change covered by documentation checks."` The reason must contain non-whitespace text and be at most 4000 characters after trimming. Without a valid reason, green CI is handed to a human rather than marked merge-ready. The job's `reviewSkip` record persists the `none` policy, exact delivered commit, trimmed reason, and `recordedAt` timestamp before merge readiness. The record survives restarts and is cleared when a new commit is delivered.

The job's `review` record holds the latest completed review of the delivered head: reviewer, verdict (`PASS` or `NEEDS_CHANGES`), exact commit SHA, the `reviewPolicy` that requested it, structured `findings` (`summary`, `file`, `line`, `severity`; empty for `PASS`), and `attempt` metadata (`number`, `startedAt`, `completedAt`). `reviewAttempts` counts every reviewer invocation, including failed ones. Owner project configuration accepts `"maxReviewRounds"` from 1 through 5 (default 2); Ralph alone ships with 5. The authorized total is checkpointed on new jobs and never resets on SHA changes or restart. Each invocation, including an interrupted one, consumes that budget; a persisted PASS for the exact delivered SHA is reused on restart. A new delivered commit clears the record but preserves the attempt count. Older PASS-only records and schema-version-one jobs still load.

Jobs created without a round setting retain the two-round default. A valid NEEDS_CHANGES result may queue one correction when budget remains: up to four distinct corrections with five rounds. Each requires a new commit, passing deterministic verification and required CI for its exact SHA, and fresh independent review. `reviewCorrectionHistory` archives completed earlier cycles; `reviewCorrection` holds the current cycle. The separate single CI correction remains available. Total implementation runs are bounded to the review budget plus one CI correction (at least the backward-compatible three runs); worker-local `maxAttempts` is unchanged. Review failures and uncertain running corrections still stop for owner attention. Verified delivery resumes without another implementation run.

The job's `verification` record retains the actual Ralph verification command, pass flag, exit code, timeout status, and complete captured stdout and stderr. It is checkpointed before delivery and bound to the delivered commit, so it survives restarts. The independent reviewer receives this deterministic evidence alongside CI results. Missing, failed, timed-out, or different-SHA verification blocks both a fresh review and reuse of a persisted PASS. A corrected commit requires fresh verification evidence.

The bounded `reviewHistory` preserves each invocation's attempt number, reviewer, model, policy, exact SHA, start/completion timestamps, status, verdict/findings, and verbatim failure diagnostics. Identity is saved before invocation; statuses are `running`, `completed`, `failed`, `timed_out`, `invalid_verdict`, or `interrupted`. Captured reviewer errors, output and stacks remain available verbatim to the owner. On restart, an unfinished review is recorded as interrupted and handed to a human without another invocation; a checkpointed failure is also reconciled without replay. History survives delivery of a corrected SHA, while only a valid exact-SHA PASS can authorize merge readiness. Injected adapters may declare their `reviewer` and `model` identity properties; otherwise their identity is recorded as `independent-review-adapter` with the configured model. Older jobs without history still load.

## AgentLoop daemon (systemd user service)

The AgentLoop daemon has a separate `agentloop.service`; it is not a timer and does not replace or modify the finance autopilot timer. Before starting it, an owner must explicitly authorize every project that may receive work in an owner configuration file kept outside every worker-writable directory and selected with `AGENTLOOP_CONFIG_PATH` (use absolute project paths, since relative entries resolve from that file's directory):

```json
"allowedProjects": {
  "starter": "/path/to/AgentLoop/examples/starter"
}
```

With no valid `allowedProjects` entries, job and loop submission remains denied. The service installer never registers projects and never supplies a paid-engine fallback; install and authenticate the Codex or Claude CLI you intend to use first.

Preview the exact user unit (the safe default):

```bash
node src/daemon-systemd.js --root "$(pwd)" --dry-run
```

Install and enable it explicitly, then start it when you are ready. Installation reloads the user manager but does not start or restart the daemon.

```bash
node src/daemon-systemd.js --root "$(pwd)" --install
systemctl --user start agentloop.service
systemctl --user status agentloop.service
```

The unit uses this Node executable path, the repository as `WorkingDirectory`, `Restart=on-failure`, and the invoking shell's `PATH` so subscription-authenticated `codex` or `claude` CLIs remain discoverable.

## Supported platforms

Windows is the primary path:

```powershell
node src\daemon.js
```

macOS and Linux use the equivalent command:

```bash
node src/daemon.js
```

On every platform, install and authenticate at least one engine CLI first. The daemon and bridge bind to loopback addresses, so a tunnel is required for a hosted connector.

On Windows, pressing Ctrl-C in the console gracefully finalizes running loops because it raises SIGINT. Scripted process termination (`process.kill` with SIGTERM) on Windows terminates immediately without running shutdown handlers; if terminated this way, restart recovery finalizes interrupted tasks on the next startup.

## Roadmap

- **Research loops.** Cycles that gather sources first, then write against an explicit rubric - reports, docs, briefs.

- **Two-way messages.** The dashboard already receives questions from the chat client; answering from the panel closes the loop.

- **More engines.** Codex CLI and Claude Code ship today. The `src/engines.js` registry takes one entry per engine, so a third is additive rather than a rewrite.

## License

MIT. See [LICENSE](LICENSE).

## Durable asynchronous R1 jobs

With the existing daemon running, `submit_r1_job({project, issue, worktree?})` (or
`POST /api/r1/jobs`) persists a job and immediately returns `{id}`. It selects the
specified ready GitHub issue; implementation and deterministic verification run
in the owner-authorized issue worktree, followed by CI observation and the existing
independent Claude review. The owner must enable the project in
`autopilot-projects.json`, use the Codex worker with `reviewPolicy: "always"` or
`"risk"`, and register its checkout and exact `issue-N` worktree in the existing
project registry before submission. Requests cannot register paths themselves.

The existing dispatcher runs one R1 job at a time, retains the original per-issue
lock, retry/correction limits and review history, and checkpoints phases in the
existing durable queue. `get_r1_job_status({id})`, `get_r1_job_result({id})`, or
`GET /api/r1/jobs/:id` retrieve persisted phases and complete verification/review
evidence, including after daemon
recovery. `passed` requires verification and an
independent PASS for the exact delivered SHA and means ready for human merge.
Failures return `blocked`; interrupted independent reviews are preserved and handed
to a human without replaying the reviewer. Saved exact-SHA approval is reused.
Captured stdout/stderr bytes remain unredacted in `state/logs/<id>.execution.ndjson`
(base64 chunks), available through `/api/log/<id>?raw=1` byte paging and
`/api/log/<id>?download=1`. Canonical task, result and R1 job checkpoints keep
full execution context, including critic fixes and CI diagnostic tails. Only
separate disposable `state/dashboard/{tasks,results}` projections use bounded
previews for `/api/state` and admission metadata. Missing, stale or damaged
projections rebuild once from canonical state; projection write failures use a
bounded memory cache and never fail a canonical checkpoint. Damaged canonical
navigation entries are reported as unreadable, left untouched and never admitted
as fresh tasks. Warm-up cannot prevent startup or running-job recovery.
Preview budgets cover short strings, unknown fields, keys, collection sizes and
nesting, as well as long diagnostics. Changed evidence is journaled before
replacing a checkpoint. `nested-merge-v1` evidence records recursively merge
`changes` into the previous evidence, replace arrays and scalar values, and
delete the key paths listed in `removedPaths`; unchanged nested output is not
copied for status-only checkpoints. Standalone per-issue
checkpoints also name their adjacent `issue-N.execution.ndjson` evidence journal.

Journal writers reuse open descriptors (up to 64 active writers), write bytes
immediately to the kernel, and schedule asynchronous disk synchronization every
100 ms while active. Process exit, exception and recovery records flush
synchronously; per-issue checkpoints flush evidence before saving full checkpoints.
Daemon crashes retain kernel-written bytes. A machine power loss may lose the
current unsynchronized window; terminal records have already crossed the disk
barrier. Restart separates torn records and marks interrupted children with
unknown exit details. The dashboard accepts only local Host headers and matching
local Origins; raw records are never redacted for access control.

No additional scheduler or service is installed or started by submission. Historical
`get_job_status` and `get_job_result` remain available and can inspect previously
created direct-task, loop, and R1 job IDs. Direct-task and classic-loop creation
routes have been retired; preserving historical reads does not authorize legacy execution.

Python projects use the [shared contract and locked readiness preflight](docs/python-preflight.md)
to prepare a local `.venv` with `uv sync --locked` before worker admission.
Infrastructure readiness remains distinct from application test results,
activation, implementation verification and review evidence.

Owner-controlled staged onboarding is available through `ralph project add owner/repository`; see [project registration, readiness and activation](docs/project-registration.md).
