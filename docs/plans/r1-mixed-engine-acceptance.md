# R1 Option C isolated acceptance plan (#69)

## Preconditions
Merged #66-#68 on origin/ralph-dev; owner-only managed worktrees; no live daemon/service mutation; no ready-for-agent label; no change to autoMerge. Use an isolated state directory and ephemeral local Git origin with independent fake GitHub providers. Real authenticated Codex/Opus evaluation must use existing CLIs without API-key spend.

## Required evidence and phases
1. **Mock full-stack E2E:** submit one R1 parent through the existing R1 endpoint; validate active registered worktree under owner config; at maxConcurrent=1 it runs a child with Codex worker -> Claude critic FAIL -> fresh Codex correction -> Claude critic PASS. Assert 4 model invocations, exact role models and read-only critic permissions; unrelated task stays queued. Verify child terminal with durable parent relation, no duplicate attempt and no synthetic files in index, history or delivered branch.
2. **R1 gates:** local verification must run only after final child PASS; exact delivered SHA is used for CI and final independent Claude PR review. A negative critic, malformed verdict, denied scope, stale head, failed verification, red or missing CI, or final review NEEDS_CHANGES must never be merged. Default one-shot remains green in existing suite.
3. **Failure injection:** cancel pending/running child and verify process group exit before cleanup; SIGKILL daemon while child running and restart with old group still active: no duplicate writer. If uncertain, require explicit audited offline recovery rather than guess. Snapshot parent-child IDs, logs and exact SHAs to document failures.
4. **Real-agent smoke (separate):** registered disposable Git worktree, mock origin/GitHub, real locally authenticated Codex CLI implementation and Claude Opus critic, bounded cycles. No subscriptions bypass, no production mutation or PR autoMerge. Avoid changing project/daemon service configuration.
5. **Reviews and publication:** full test suite, independent Opus code and spec reviews, GitHub CI on final delivery SHA. Commit documentation for activation (explicit project strategy only after review), monitoring, rollback to one-shot, removal of synthetic files and process-recovery limitations. Merge #69 after checks; leave production unchanged.

## Hard stop conditions
No completed child final Claude PASS; no actual test verification; any synthetic instruction file in Git history; unconfirmed process termination; conflicting parent/worktree authorizations; missing/stale CI; incomplete final review. Stop with durable evidence, never infer pass from a model's prose.
