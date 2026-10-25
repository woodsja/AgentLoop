# ADR 0002: ADE resumes work under its original admission policy

- **Status:** Proposed documentation of an owner-selected decision already implemented
- **Owner choice:** Option B, October 24, 2026
- **Implementation:** [Issue #154](https://github.com/woodsja/AgentLoop/issues/154), guarded [PR #155](https://github.com/woodsja/AgentLoop/pull/155), deployed separately at merge `5057278bc7faf6f6920cc0d4cd68d2cd1b01ef14`
- **Related policy:** [ADR 0001](0001-agentloop-trust-boundary.md), which remains authoritative

## Context

Ralph normally admits an AgentLoop issue when the owner assigns the project's `ready-for-agent` label. Architecture Decision Escalation (ADE) can pause that job when a consequential, unresolved architecture choice needs the owner. The first ADE resume implementation nevertheless required a milestone-grant receipt, even for projects that had not enabled milestone authorization. Such a job could pause successfully but could not resume.

Enabling milestone grants for the entire AgentLoop project would change authorization for unrelated development work. The owner chose **Option B**: support safe ADE resume under the existing ready-label workflow, without treating architecture approval as a new permission grant.

## Decision

**Preserve and revalidate the original admission mode.** An ADE-paused job has one original authorization path; it cannot switch paths to bypass a failed check.

- **Ready-label mode:** Bind the original project, repository, issue identity and revision, configured ready label, initial admission evidence, and dependency requirements to the durable job. On the authenticated owner resume action **and again before resumed execution**, re-read the original open GitHub issue, its unchanged title/body and ready label, active project policy, dependency receipts, and merged ADR. If any identity, label, prerequisite, policy or authority check fails or becomes uncertain, remain paused. The original source issue's `ready-for-agent` label authorizes ordinary work; a separate ADR-delivery issue requires its **own explicit owner ready-label release**.
- **Milestone-grant mode:** Keep every existing grant receipt, scope, revision, expiry, revocation and dependency check. A grant-backed job may never fall back to ready-label mode because a grant is missing, revoked, expired or the project policy changes. A nongrant job cannot acquire grant authority by changing its flags.
- **Owner decisions:** The owner chooses through the authenticated local `ralph decision` CLI using the inspected digest, rationale and explicit confirmation. A GitHub comment, issue closure, model text, proposed ADR, or label on a non-executable `needs-owner-decision` issue is not acceptance. An accepted choice is published through a separate ADR issue, followed by deterministic verification, independent Claude review, exact-head GitHub CI, and guarded merge. The owner then explicitly requests `decision resume`; the ADR merge does **not** automatically resume or deploy the original implementation.
- **Continuity and other permissions:** Preserve the original job ID, worktree, run budget, raw logs, failures, and decision history. Ordinary reversible implementation choices remain autonomous; only affected work/dependents pause. Changes to credentials, external accounts, data access, physical-host boundaries, spending or scope require their independent owner authorization. No new daemon, provider, outbound notification transport or production setting is authorized by this decision.

## Consequences

AgentLoop can retain its normal `ready-for-agent` workflow while escalating only substantive architecture decisions. Resume requires more fresh validation, and an uncertain state remains blocked rather than spending new worker attempts or silently switching authorization paths. Existing milestone-enabled projects retain their stricter safeguards; other projects are not opted into ADE by this ADR.

**This ADR does not decide notification delivery uncertainty.** The live pilot [#156](https://github.com/woodsja/AgentLoop/issues/156) paused at [owner decision #157](https://github.com/woodsja/AgentLoop/issues/157), which separately offers conservative reconciliation, bounded retry and provider-aware hybrid choices. No option in #157 has been accepted by this ADR. Its authenticated owner decision, separate reviewed ADR delivery, and explicit guarded resume remain outstanding.
