Repository: woodsja/AgentLoop
Labels: none

# [DRAFT] MGA 1/8 — Create non-executable ChatGPT planning drafts

**DRAFT — UNAUTHORIZED. Planning artifact only. Owner review and separate explicit executable release required.**

<!-- agentloop-planning-draft:mga-104-planning-drafts -->

Kind: ticket
Source spec: #103
Planning source: ChatGPT planning conversation: autopilot:woodsja/AgentLoop#104, owner-supplied issue body and acceptance criteria

## Proposal

Allow the owner to preview and publish a specification or implementation ticket from a planning conversation as an unlabeled GitHub issue. Use repository-local Pocock conventions and existing GitHub operations.

## Acceptance criteria

- [ ] AGENTS.md links the committed draft publication convention and preserves the existing trust-boundary instructions.
- [ ] The owner preview includes the repository, no-label policy, full title, source specification, planning source, proposal, acceptance criteria, blockers and release boundary.
- [ ] Fake GitHub tests show creation without labels, metadata validation, rejection of unexpected labels, and read-only reconciliation after failure.
- [ ] The focused tests and full npm test pass without changing production project registration.

## Blockers

None.

## Release boundary

Publication grants no execution authorization. Do not apply execution-ready labels, enqueue Ralph jobs, or change production project registration. The owner must separately authorize release of the complete batch.
