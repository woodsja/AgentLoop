# AgentLoop

Self-improving fresh-context loops for coding work you can watch.

![AgentLoop dashboard showing a worker and critic loop](docs/dashboard.png)

[Watch the demo](https://youtu.be/4zRdMMzh3C8) | [Try the replay](https://agentloop-replay.vercel.app) - a real recorded run in the live dashboard

## What it is

Plan a goal in Claude or ChatGPT, then let it rip. AgentLoop is a local orchestration daemon for coding agents: each cycle starts a fresh worker, work carries forward in project files, a fresh critic enforces your rubric, and the whole run is watchable on a local dashboard.

Codex CLI and Claude Code both run as engines. Pick a worker engine and a critic engine per loop from the dashboard or bridge, or one engine per one-shot task.

AgentLoop is for solo developers who run long agent tasks across multiple projects and cannot supervise every session.

It exists because running coding agents by hand means shuttling plans between a chat and a terminal all day, and quality slips the moment you stop watching.

Your standards live in GUIDELINES.md and the critic enforces them every cycle, so you supervise the work without babysitting it.

## Why sequential fresh-context

Long-running chats collect stale assumptions and irrelevant context. That is context rot. AgentLoop starts a new engine process for every worker and critic session, so no prior chat history follows them. The durable context is the project itself plus concrete critic fixes. That keeps a loop bounded, easier to leave unattended, and less likely to spend tokens re-reading an ever-growing conversation.

A loop is intentionally sequential. Independent queued tasks can run up to `maxConcurrent`, but one loop does not create a parallel swarm that races across the same project.

```text
Claude or ChatGPT -> MCP bridge -> daemon -> worker/critic cycles -> dashboard
```

## How it works

- **Dispatch** sends one one-shot task to `POST /api/dispatch`. Its file moves from pending to running to done, with a transcript and dashboard cancellation.
- **Loop** runs a project cycle by cycle. A worker reads `PLAN.md` and `STATE.md`, makes one increment, updates state, and exits. A fresh critic then reads `PLAN.md`, `GUIDELINES.md`, the worker output, and the project files. The next worker is a new process.
- **Polish mode** is an optional loop flag: after the first PASS, remaining cycles become polish cycles where the critic re-verifies the guidelines and proposes one improvement per cycle until it verdicts SHIP.
- **Critic contract** requires the final line to be exactly `VERDICT: PASS`, `VERDICT: FAIL - <concrete fixes>`, or `VERDICT: CONTINUE - done: <item>; next: <item>`. FAIL becomes injected fix notes for the next worker; CONTINUE records a finished PLAN.md item and starts a fresh worker on the next one; PASS means every unblocked plan item is complete and ends the loop unless polish mode is on. Polish cycles end with `VERDICT: IMPROVE - <one improvement>` or `VERDICT: SHIP`. `maxCycles` is capped at 1 to 50 and defaults to 3.
- **Stuck tasks get skipped.** `taskRetries` (1 to 10, default 3) caps consecutive FAIL cycles per task; at the cap the task is marked blocked, later workers and critics skip it, and the loop ends `partial` if the rest passes or `incomplete` if the cycle budget runs out mid-plan.
- **Auto-checkpoint** is on by default for projects inside a git work tree: the daemon makes a local commit after each completed task, on the final pass, and when a task is blocked. The daemon composes every commit message itself and never touches remotes; a dirty tree at loop start is refused so checkpoints stay clean.
- **Files are memory.** `PLAN.md`, `STATE.md`, and `GUIDELINES.md` carry the goal, progress, and rubric. A loop project needs `PLAN.md`; missing `STATE.md` and `GUIDELINES.md` files are seeded automatically.
- **Messages narrate a run.** A connected chat client can post `info`, `question`, or `results` messages through the bridge. They appear in the dashboard Messages panel.
- **Engines are pluggable.** `src/engines.js` holds one entry per engine: how to find its CLI, what arguments to run it with, and how to read its event stream. The daemon itself is engine-agnostic. Set `defaultEngine` in `config.json`, override it independently for each loop role in the dashboard or bridge, or per one-shot task through the bridge. An engine that is not installed is greyed out rather than offered.
- **Workers start clean and constrained.** Codex sessions use workspace-write sandboxing, disable network access inside the sandbox, and route boundary requests through automatic approval review. Claude Code workers run with `auto` permission mode so a classifier reviews development and test commands without routine approval prompts, `--safe-mode` so a worker ignores your personal `CLAUDE.md`, hooks, skills, and MCP servers, and web, scheduling (`RemoteTrigger`, `Cron*`, `ScheduleWakeup`), cross-session messaging, worktree, `PushNotification`, and `DesignSync` tools disabled. The two are not identical: Codex isolates the network at the sandbox boundary, so a shell command it runs cannot reach out, while a shell command run by Claude Code can.

The daemon is plain Node with no package dependencies. Task state, results, transcripts, events, and messages are stored as JSON or NDJSON files. The dashboard is one local HTML file at `http://127.0.0.1:5757`.

## Multi-task loops

A `PLAN.md` written as a top-level list is walked one item per worker:

```markdown
# Calculator

Users report two bugs in `calculator.html`.

1. Fix the arithmetic.
2. Fix the `%` button.
```

`-`, `*`, `+`, and `1.` all count, up to 100 items. Indented lines are detail for the item above them, not items of their own.

Each cycle takes one item. `VERDICT: CONTINUE - done: <item>; next: <item>` closes that item and starts a fresh worker on the next one. `VERDICT: FAIL` keeps the same item and injects the critic fixes into the next worker. `VERDICT: PASS` ends the loop once every unblocked item is complete.

`taskRetries` caps consecutive FAIL cycles on a single item, 1 to 10, default 3. At the cap that item is marked blocked: later workers take the next item instead, the critic stops grading it, and the loop finishes `partial` if the rest passes or `incomplete` if the cycle budget runs out first. Size `maxCycles` at roughly tasks x retries.

### Checkpoints

Auto-checkpoint is on by default for a project inside a git work tree. The daemon commits after each completed item, when an item is blocked, and on the final pass, so every task boundary is a sha you can read, diff, or reset to. The dashboard shows each one on its task chip.

The daemon writes those commit messages itself from the verdict text. Agents never run git, and the daemon never touches a remote: `git add -A .` then `git commit` inside the project folder, nothing else.

It needs two things. The project must be a git work tree, otherwise the toggle is forced off and the dashboard reads `checkpoints off`. And the project tree must be clean when the loop starts, otherwise the loop is refused, so a checkpoint only ever holds work the loop did.

## The dashboard

A left rail navigates the page - waiting on you, active run, recent runs, queue, messages, event log - and holds the loop launcher, live daemon status, and a theme picker with fifteen editor themes remembered locally.

- **Cycle timeline.** The active run shows one card per cycle: verdict, critic summary, duration, and cost. A card working a plan task carries a try tag like `T02 · try 1/3`, and a task that hits its retry budget is marked blocked on the card itself.
- **Task rail.** A loop with a parsed `PLAN.md` gets a chip per plan task: done chips show their checkpoint sha, the active chip shows its try count, blocked chips show the spent retry budget.
- **Waiting on you.** Tasks blocked on an answer pin to the top of the page with a rail badge; the block stays hidden while nothing is blocked.
- **End states.** Recent runs keep loop endings distinct: `passed`, `partial` (passed with blocked tasks), `incomplete` (cycle budget ran out mid-plan), and `maxed` (no passing verdict), plus counts of tasks done and blocked.
- **Launcher.** The loop form takes a project folder, max cycles, task retries, worker and critic engine pickers that preselect `defaultEngine` and disable engines that are not installed, an auto-checkpoint toggle (on by default), and polish mode.

The page polls `GET /api/state`, a whitelisted read-only payload: optional metrics like cost and duration are omitted when unknown rather than zero-filled, and project paths are reduced to folder basenames, so absolute paths never leave the daemon.

## How it was built

AgentLoop started as my own bottleneck. I was the relay between ChatGPT planning the architecture and Codex executing the tasks, shuttling plans and results back and forth across multiple projects, and quality slipped whenever I stepped away. A bare retry loop was not the answer: loops without standards rot their context and never improve. The fix was to move the human judgment into the system itself, so I designed the sequential fresh-context loop, the files-as-memory model, the strict critic verdict contract, and the rubric-as-GUIDELINES pattern to mimic a demanding human in the loop. Codex CLI with GPT-5.6 turned that design into working code: the daemon, filesystem store, loop engine, critic, bridge, and dashboard wiring, roughly one focused session per slice.

The engine layer came later. Nothing in the daemon is tied to one CLI: `src/engines.js` takes one entry per engine, and Codex CLI and Claude Code both ship today, either one running as worker or critic. Codex is the default.

## Independent evaluation

The reproducible [query parser evaluation](examples/query-parser) asked for the full repair in one pass. Cycle 1 produced nine passing tests, but a fresh critic found a mixed percent-decoding defect and returned FAIL. Cycle 2 fixed it, added regression coverage, passed 11 tests, and received PASS from a new critic.

[Read the evaluation record](docs/evaluation.md).

## Quickstart

Requirements:

- Node.js 18 or newer
- Git
- At least one engine CLI installed and authenticated, found on `PATH` or through an `enginePaths` override. Claude Code (`claude`) needs 2.1.169 or newer, the release that added the `--safe-mode` flag it is launched with. Critics also use Claude Code's `--restricted`, `--tools`, and `dontAsk`, and Codex CLI's `--ignore-user-config` and `--ignore-rules`; these were verified with Claude Code 2.1.296 and Codex CLI 0.162.1. A CLI that rejects a critic flag fails the critic run, and the cycle is recorded as an invalid FAIL; AgentLoop never retries with broader permissions

Windows:

```powershell
git clone https://github.com/aiedwardyi/AgentLoop.git
cd AgentLoop
node src\daemon.js
```

Open `http://127.0.0.1:5757`. Select **+ New loop**, point **Project folder** at a folder containing `PLAN.md`, pick a **Worker engine** and **Critic engine**, then select **Start loop**. No dependency install is required.

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

The bridge listens only on `127.0.0.1:5758`, uses a token, and exposes `agentloop_status`, `dispatch_task`, `start_loop`, and `send_message`. `dispatch_task` and `start_loop` both take an optional `engine`. `start_loop` also takes optional `workerEngine` and `criticEngine` fields.

## Try the demo loop

With the daemon running, select **+ New loop**:

- **Project folder:** `examples/starter`
- **Max cycles:** `3`
- **Worker engine** and **Critic engine:** whichever you have installed
- Select **Start loop**

Cycle 1 deliberately implements only the normal input path. The critic reads `GUIDELINES.md`, rejects the missing hardening and command-line requirements, and emits a FAIL verdict. A later cycle receives those fixes, completes the utility, and passes.

Watch the cycle timeline in **Active run** and critic verdicts in the **Event log**. Open the completed task to see its transcript. Messages posted through the bridge appear in **Messages**.

## Configuration

`config.json` contains the local runtime settings:

| Key | Default | Purpose |
| --- | --- | --- |
| `dashboardPort` | `5757` | Local dashboard port. |
| `maxConcurrent` | `2` | Maximum concurrent queued tasks or loops. |
| `taskTimeoutMin` | `45` | Timeout in minutes for each worker or critic session. |
| `defaultEngine` | `codex` | Engine used when a task or loop does not name one. `codex` or `claude`. |
| `mcpBridge.port` | `5758` | Local MCP bridge port. |
| `models` | `{ "claude": "opus", "codex": "gpt-5.6-terra" }` | Default model per engine. |
| `enginePaths` | none | Optional absolute path per engine, for a CLI that is not on `PATH`. |

The shipped `config.json` includes every key above except the optional `enginePaths` key.

A model named on the task or loop itself wins over `models`.

`POST /api/loop` and the MCP `start_loop` tool accept `workerEngine` and `criticEngine` (`codex` or `claude`). Each omitted role falls back to `engine`, then `defaultEngine`; an existing request with only `engine` still uses that engine for both roles. Both resolved choices are persisted in the loop JSON and exposed in `/api/state`. Unknown, empty, or unavailable role selections are rejected before queueing. No separate role model settings are needed: each session uses `models` for its selected engine. When the two roles use different engines, the engine-agnostic `model` key and a loop-level `model` are ignored, since one model name cannot fit both CLIs; set `models.codex` and `models.claude` instead.

For example, submit a Codex worker with a Claude critic:

```json
{
  "project": "examples/starter",
  "workerEngine": "codex",
  "criticEngine": "claude",
  "maxCycles": 3,
  "taskRetries": 3,
  "autoCommit": false
}
```

Claude workers use session-local `--permission-mode auto`, retaining permission checks without broadly pre-approving Bash. The previous `acceptEdits` mode approved file edits but denied unattended `node --test` commands. Auto mode depends on a supported model, CLI, and account/policy availability; explicit ask/deny rules still apply, and AgentLoop does not retry with bypass permissions. It is classifier-based review, not filesystem or network isolation. Use a disposable checkout for unattended acceptance runs. See [Claude permission modes](https://code.claude.com/docs/en/permission-modes).

The isolated reverse acceptance run with Claude Code 2.1.299 (subscription Opus) and Codex CLI 0.162.1 passed in one cycle: Claude executed `node --test acceptance.test.js` without permission denials, all four tests passed, and the unchanged read-only Codex critic returned PASS. An independent harness confirmed the four tests, unchanged fixed plan/guidelines/tests, and no project-file changes by the critic. This observation does not establish OS-level confinement of Claude workers.

Critics run read-only, enforced by the CLIs as well as the prompt:

- **Claude Code critics** add `--restricted` to the worker's `--safe-mode` and `--strict-mcp-config`, and run with `--permission-mode dontAsk` and a closed `--tools Read,Glob,Grep` list ([Claude CLI reference](https://code.claude.com/docs/en/cli-reference)). They have no write, edit, shell, web, or MCP tools.
- **Codex critics** run with `--sandbox read-only` and `approval_policy="never"`, so a blocked action is never escalated ([Codex security documentation](https://developers.openai.com/codex/agent-approvals-security)), plus `--ignore-user-config` and `--ignore-rules`. Codex critics can still run shell commands and read files outside the project: the sandbox blocks their writes and network access, not their execution or reads.

**Previously recorded real-CLI observations** from the opt-in suite (`test/cli-integration.test.js`) with Claude Code 2.1.296 and Codex CLI 0.162.1, subscription logins, in temporary folders. These cover project-level configuration, not user-level configuration. A critic was asked to edit project files, write outside the project, run a command that writes a marker, call a local HTTP listener, read a file outside the project, and use a planted MCP tool, while the project held worker-planted `.claude/settings.json` and `settings.local.json` (allow-all permissions, `bypassPermissions`, `additionalDirectories`, hooks, `apiKeyHelper`), `.mcp.json`, `.codex/config.toml`, and `.codex/rules`. Observed:

- Both critics left every file unchanged, made no network request, activated none of the planted project settings, hooks, `apiKeyHelper`, MCP servers, or rules, and could still read `PLAN.md`. A worker control run could create and edit files.
- The Claude critic was refused a read outside the project, and also refused reads through a project file symlink and a project directory symlink pointing outside it.
- The Codex critic ran sandboxed shell commands and read the file outside the project.

**No-cost symlink probe:** Claude Code 2.1.299 was also tested with the exact critic arguments, a temporary project inside this checkout, and a harmless file under `/tmp` outside the checkout. Its real `Read` tool successfully read the project control file and refused both a file symlink and a directory symlink to the outside file, explicitly reporting that `--restricted` confines file tools to the working directory. Responses requesting those tool calls came from a loopback-only scripted API with dummy credentials, not a paid model. This tests CLI file permissions, not model judgment or user-level configuration isolation. Reproduce with `AGENTLOOP_LOCAL_CLI_TEST=1 node --test --test-name-pattern='local scripted' test/cli-integration.test.js`; Claude must be installed, but authentication is unnecessary.

**Documented by the CLIs but not tested here:**

- That critics ignore *user-level* configuration: for Claude, `~/.claude` settings (via `--restricted`), user MCP servers (via `--strict-mcp-config`), and plugins (via `--safe-mode`); for Codex, `$CODEX_HOME/config.toml` MCP servers, hooks, profiles, and project trust (via `--ignore-user-config`) and user `.rules` files (via `--ignore-rules`). The suite has tests for this, but they need a temporary config home, so they run only with `ANTHROPIC_API_KEY` or `CODEX_API_KEY` set. They have not been run, and subscription logins are never copied into a temporary home.
- The Codex project-config result above comes from an untrusted temporary folder. Codex records project trust in `config.toml`, which `--ignore-user-config` skips, so critics should always see projects as untrusted; that inference is not separately tested.

`npm test` checks emitted permission/configuration flags and runs mock-engine regressions; passing it does not verify user-level configuration isolation. The dedicated user-config integration tests above remain unrun. Treat that isolation as CLI-documented behavior, not an experimentally verified AgentLoop guarantee.

Limitations:

- **Reading outside the project is an isolation limit, not a read-only breach.** Codex's read-only sandbox can read any file the operator's account can read, and that text can reach transcripts and the next worker prompt. Claude critics were confined to the project folder, including through symlinks, in the runs above.
- **CLI bookkeeping still writes outside the project**, such as session transcripts under `~/.claude` or `~/.codex`. The agent does not control these writes.
- This is CLI enforcement. AgentLoop adds no sandbox of its own, so these guarantees hold only for CLIs that support and correctly enforce the flags.

To run the real-CLI suite, authenticate the CLIs and run `AGENTLOOP_CLI_INTEGRATION=1 node test/cli-integration.test.js`. It makes a few model calls per engine, never starts AgentLoop, and deletes its temporary folders. `AGENTLOOP_IT_CLAUDE_MODEL`, `AGENTLOOP_IT_CODEX_MODEL`, and `AGENTLOOP_IT_TIMEOUT_MS` (default 240000 per CLI run) override the models from `config.json` and the timeout. It is not part of `npm test`.

To demonstrate manually, install and authenticate both CLIs, start a separate development daemon from this checkout using an unused dashboard port, and open its dashboard. Select `examples/starter`, Worker engine **Codex**, Critic engine **Claude Code**, and three cycles. Turn off auto-checkpoint for an uncommitted checkout, then start the loop. The starter plan is designed to produce an initial FAIL: inspect the transcript for a Codex worker, a Claude critic with concrete findings, and a fresh Codex correction worker. If checkpointing is desired, use a clean project Git tree and leave auto-checkpoint enabled. Results depend on the models' actual verdicts; the mock regression tests reproduce FAIL → correction deterministically.

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
