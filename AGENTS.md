# AgentLoop agent instructions

Before changing AgentLoop/Ralph R1 transcripts, execution logs, project onboarding, CLI/sandbox rules, VM/host access, or deployment, **read** [ADR 0001: Owner visibility and disposable-VM trust boundary](docs/decisions/0001-agentloop-trust-boundary.md). This is an accepted owner policy, not a pending security-review proposal. Implement complete owner-visible captured logs and protect the physical Windows host rather than disposable VM contents.

Follow the linked ADR and the active GitHub issue's acceptance criteria; never treat a merged change as a verified deployment.
