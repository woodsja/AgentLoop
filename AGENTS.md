# AgentLoop agent instructions

Before changing AgentLoop/Ralph R1 transcripts, execution logs, project onboarding, CLI/sandbox rules, VM/host access, or deployment, **read** [ADR 0001: Owner visibility and disposable-VM trust boundary](docs/decisions/0001-agentloop-trust-boundary.md). This is an accepted owner policy, not a pending security-review proposal. Implement complete owner-visible captured logs and protect the physical Windows host rather than disposable VM contents.

Follow the linked ADR and the active GitHub issue's acceptance criteria; never treat a merged change as a verified deployment.

For Pocock `to-spec` / `to-tickets` planning, follow the committed [GitHub issue-tracker convention](docs/github-issue-tracker.md). Draft publication creates an unlabeled planning artifact and suppresses ready-label behavior, including retries. Explicit executable release requires separate owner authorization; publishing a draft does not authorize Ralph execution or production configuration changes. Preserve existing instructions, installed skills, and owner settings.
