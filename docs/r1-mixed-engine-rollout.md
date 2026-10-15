# R1 Option C: verification, enablement and rollback

**Status:** implementation merged in #66–#68; isolated acceptance in #69; **not enabled or deployed to production by this change**. This is an opt-in implementation *method*, not an alternative R1 approval policy. See `docs/plans/r1-mixed-engine-option-c.md` and `docs/plans/r1-mixed-engine-acceptance.md`.

## Acceptance evidence (October 15, 2026)

- Real R1 daemon + worktree + queue mock-engine E2E: with `maxConcurrent: 1`, one parent ran an authorized child with **Codex implementation -> Claude critic FAIL -> Codex correction -> Claude critic PASS**. Persisted role models were `gpt-5.6-terra` and `opus`. R1's deterministic verifier passed *after* child PASS; fake GitHub CI and final Opus PR review each observed the same delivered commit SHA. No temporary PLAN/GUIDELINES/STATE file was in delivered commit history. The parent reported `passed` with `ready_for_human_merge` outcome because fixture policy set `autoMerge: false`.
- Negative full-stack case: a child with repeated critic FAIL never delivered, observed CI or recorded an approved final PR review.
- Actual authenticated CLI exercise in a **disposable** Git worktree, without API keys or metered API fallback: Codex created `answer.txt` with `42`; Claude Opus restricted critic returned PASS. The fixture deliberately changed it to `41`; Opus returned `VERDICT: FAIL` with concrete corrective advice; Codex corrected it and another restricted Opus invocation returned PASS. Real CLI roles were tested separately from the mock external-GitHub R1 pipeline; do **not** call this a real GitHub PR end-to-end test.
- Additional suites already verify registered-worktree authorization, reservation idempotency, no concurrent child, restart fail-closed, cancellation, no synthetic-file Git history, exact-head CI and independent final review. The acceptance PR is not considered complete without full GitHub Actions CI and independent code review on its final commit.

## Explicit activation (future separate change)

1. Confirm a reviewed, tested AgentLoop revision is deployed through the project's normal procedure and that no unfinished R1 jobs are running. Do not hot-swap a daemon with active children.
2. In the trusted owner-managed project configuration, add `"implementationStrategy": "worker-critic-loop"` to **one registered, enabled project**. Leave `worker: "codex"`, `reviewPolicy: "always"`, verification commands, CI workflow name, worktreeRoot and `autoMerge` policy untouched. Review that Claude critic model resolves to **Opus** in the owner daemon model configuration; the code's `criticEngine` is `claude` but the model is configured separately.
3. Confirm the owner project registry's checkout and worktreeRoot point to matching canonical Git repositories. Verify the daemon has an isolated, write-protected state directory not writable by model workers. Do not permit an HTTP/MCP caller to choose raw paths.
4. Start with a disposable issue and `autoMerge: false` wherever possible. Confirm the parent references a single child, the child actually enters `running` even with `maxConcurrent:1`, critic verdicts are durable, local deterministic verification runs, CI is green at the pushed SHA and the final independent Claude review matches that SHA.
5. Monitor daemon `/api/r1/jobs/<id>`, `/api/jobs/<child-id>`, the loop transcript, GitHub CI and PR commit identity. A critic PASS by itself is never a delivery authorization.

## Rollback and recovery

- **Do not change the strategy while an active mixed-engine child remains.** Cancel from the R1 parent through the existing cancellation endpoint; wait for the child to become terminal and for the CLI process group to exit before cleaning a worktree.
- Remove `implementationStrategy` (or set `one-shot`) in the trusted project config for **future** jobs. Restore the last reviewed deployment using the normal service deployment procedure. Never edit queue records to coerce a PASS.
- A daemon crash can leave a child with an unconfirmed detached CLI process group. Startup intentionally retains and blocks that child rather than risking a duplicate writer. After stopping the daemon, inspect OS processes and verify the original worker and descendants are gone. Only then use the **offline, audited** `node src/r1-child-recover.js --id <child-id> --confirm-stopped` command with the same owner state/config environment. It marks the old child *failed*, not passed. Do not invoke this merely to clear a red/slow job.
- A reservation without a queue record or an ambiguous process claim requires operator intervention; retrying should never create another child in the same parent attempt. CI failures and final-review rejection follow R1's pre-existing bounded correction/ready-for-human workflow.
- Generated `PLAN.md`, `GUIDELINES.md` and `STATE.md` are workspace coordination files, not project content. Their appearance in a commit or Git history fails the delivery gate; never bypass that check during rollback.

## Known limitations

- Registration and Git worktree containment are not a separate OS-level sandbox. Follow the existing owner and CLI permissions policy. The accepted Codex read-only critic configuration can execute local commands and read outside the workspace; this is **not** stronger isolation and must not be presented as such. The Opus critic uses restricted read/search tools.
- A detached grandchild that escapes the POSIX group or a missing PID/start-time claim cannot be assumed gone. Failing closed may require manual recovery. Offline operator confirmation is a sensitive administrative action; its audit event is authoritative for that action, not proof a model passed.
- The real-agent exercise validated model authentication, restrictions and review/correction interaction but did not exercise remote GitHub Actions using a live project repository. Full-stack GitHub gates are verified with deterministic mocks plus the separate actual repository CI for this PR.
