# #75 implementation plan — recoverable failed-child source edits

Status: engineering plan only; no runtime mutations yet. Independent ticket, blocked by none; source: Finance #75 failed child and destroyed dirty worktree.

## Failure and ownership
After the child loop finishes without PASS, R1 currently cleans the owned worktree in its autopilot `finally` stage. Existing protection waits until the child is terminal, but it does not preserve the source delta. The generated PLAN/GUIDELINES/STATE are neither implementation nor recovery artifacts.

## Interface and invariant
Add one deep recovery module that receives the trusted project policy, immutable original implementation Git baseline, exact owner-bound worktree and parent/child attempt identity. It returns a **durable receipt** describing what was saved (artifact ID, owner IDs, baseline, content SHA-256, relative paths) or an explicit refusal reason; it never invokes GitHub or model tools.

The module is invoked after authoritative child terminal confirmation but before worktree cleanup. Its receipt is checkpointed to the durable R1 job before cleanup. A crash before receipt persistence leaves the worktree or an index discoverable without implicitly claiming success; a repeated capture is idempotent for the same identity/hash.

## Safety policy — fail closed
- No automatic snapshot for arbitrary files. Require explicit owner-managed project recovery path allowlist in configuration. Absence = refuse capture and retain the worktree for manual inspection rather than deleting possible useful changes.
- Only copy known tracked-file changes. Detect and reject rename, symlink, submodule, binary, ignored/untracked files, unexpected path and oversize total; do not follow symlinks. Never include `.env`, credentials, financial inputs or generated PLAN/STATE/GUIDELINES.
- Archive using owner-writable, mode 0700 directories / 0600 files outside the project worktree; no public GitHub uploads, no model-readable source injection, no implicit auto-apply. Verify the base SHA matches the expected Git ancestry.
- Never snapshot while an R1 child is pending, running, ambiguous, or its process group is unconfirmed stopped. Do not bypass fail-closed recovery.

## Vertical checks
1. Unit red test: dirty implementation with allowed source and test files, failed terminal child, then simulate cleanup; artifact survives and matches original bytes/digest, generated instruction files excluded.
2. Negative tests: missing allowlist, secrets, symlink, binary, untracked, oversized, false owner ID, changed baseline, concurrent child and interrupted write; all fail closed.
3. Lifecycle E2E: R1 job failure checkpoints receipt before workspace removal; replay preserves identity; no new writer or false delivery. One-shot behavior remains unchanged.
4. Full suite, independent Opus security review, GitHub CI and merge before #76.

## Design guardrail
Do not solve this by blindly changing `preserveBranch` to true for every failure: that conflates a managed temporary worktree with a safe recovery artifact and risks leaving secrets accessible indefinitely. No force flags or public HTTP recovery interface.
