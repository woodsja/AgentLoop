# ADR 0001: Owner visibility and disposable-VM trust boundary

- **Status:** Accepted by the operator, 2026-10-16 (America/New_York)
- **Scope:** Woods-controlled Ralph / AgentLoop autonomous development and project onboarding
- **Decision authority:** Owner-approved operator policy, not a finding of an autonomous security reviewer
- **Issue sequence:** #90 (complete transcripts) -> #84 (Node) -> #85 (Python) -> #86 (registration) -> #87 (migration and host checks)

## Context

Ralph is an operator-controlled agent orchestrator running in a disposable Linux VM. Its agents implement code and operate on VM-local repositories, which may be destroyed and restored. The owner wants autonomy and direct visibility, rather than a multitenant security boundary that hides the system's work from its operator.

Prior R1 transcript changes (#36, #39, PR #89) attempted to prevent information disclosure to the owner by emitting only sanitized, highly compressed lifecycle messages. That design made actual failures difficult to diagnose. Likewise, onboarding #84/#85 introduced mandatory per-project filesystem isolation inside the disposable VM, even when that isolation prevented normal installed tools from being found. These policies protect low-value VM contents at the expense of development and observability.

## Decision

### 1. Protect the physical host, not the disposable VM

**High-value boundary:** the Windows physical host and any host-only files, credentials, private services, or privileges. Verify and constrain paths by which processes in the VM could affect the host. In WSL2 or other VM environments, explicitly check mounts, Windows executable interoperability, forwarded credentials and SSH agents, shared sockets, hypervisor/management interfaces, and network-reachable host services. A VM is not assumed isolated simply because it is called a VM.

**Accepted disposable assets:** the Linux VM installation, VM-local files and credentials, project worktrees, code, local Git history, and repositories the owner explicitly assigns to the agents. Data loss or destructive mistakes in that scope are operational recovery problems, not the primary security boundary. External systems or accounts outside the owner's authorized project scope are not implicitly disposable.

Do not change the Windows host's security settings or disable user-required host integrations without an explicit owner decision. Flag any discovered bridge into high-value host resources with a concrete non-destructive verification and recommended mitigation.

### 2. Owner observability is mandatory

Everything that AgentLoop actually captures about a job must be available **verbatim** to the owner: worker/critic output, stdout and stderr, commands, tool events made available by the engine, verification results, traces, errors, review findings, retry decisions, and orchestration events. Preserve execution records after failures, restarts and worktree cleanup.

Present a readable chronological timeline with access to **complete raw records**. Rendering may escape markup, neutralize terminal controls, page results or offer full-log downloads, but must not hide or irreversibly truncate captured content. A concise summary is navigation, never the only record. Do not redact or suppress captured content to protect the owner from seeing it. The dashboard remains controlled by the operator; who may access it is an access-control issue, not a reason to censor it for the owner.

Only expose what the actual engine makes available. Do not claim to capture or reconstruct model reasoning that the model or CLI does not expose.

### 3. Prefer ordinary in-VM execution and reliable recovery

Use conventional locked builds: Node with committed package-lock.json and npm ci; Python with pyproject.toml, committed uv.lock and uv sync --locked. Use ordinary VM-local commands and system executables. **Do not require an additional bubblewrap/per-worktree command sandbox or secret-canary tests protecting only VM contents**, and do not block work merely because that internal sandbox is unavailable. Optional isolation may be used for a concrete engineering purpose, but is not a hard onboarding gate.

Keep independent implementation review, deterministic tests, exact-commit GitHub CI, bounded retries, process cancellation, durable jobs, staged registration, owner activation decisions and deployment rollback. These controls serve correctness, recoverability and operator intent. They must not become a reason to conceal the associated logs.

Lockfiles are for repeatability. Familiar package managers, routine vulnerability advisories and normal dependency sources suffice; do not add a bespoke network/egress scanner, package approval service, wheel-hash inventory or alternate high-assurance build mode.

### 4. Preserve the existing delivery boundaries

Registration, readiness and activation remain separate operational facts. Failing application tests are work for coding agents, not automatically an infrastructure failure. An issue merge is not a live deployment. Live config changes and host-boundary changes require their own verified, reversible procedures; do not overwrite operator-modified configuration or erase failed R1 job history just to rearm an issue.

## Consequences and implementation order

1. **#90 first:** replace sanitized-only transcripts (including the policy implemented in PR #89) with complete owner-facing execution records. The old implementation may remain until this successor is tested and deployed; the architectural decision is effective now.
2. **#84:** retain common project contract, Node lockfile setup, preflight/readiness separation and deterministic verification; remove the mandatory internal OS filesystem sandbox and its canary/fail-closed tests.
3. **#85:** use the same execution model for Python and uv --locked; remove old wheel inventory and nested isolation requirements.
4. **#86:** implement staged project registration and owner approval for activation, with full setup diagnostics; do not create a new security-permission service.
5. **#87:** migrate Finance and AgentLoop, prove full job logs and recovery, and check the **actual** VM-to-host boundary non-destructively before a separately reviewed deployment.

## Acceptance rule for future changes

If a proposed change hides captured job data from its owner, makes a VM-internal filesystem sandbox or isolation layer a hard gate for project execution, or overlooks an actual path to physical-host exposure, it conflicts with this accepted decision. Correctness, safety of the physical host, operator visibility and recoverability should determine implementation and review criteria.
