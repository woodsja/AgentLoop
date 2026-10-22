# Owner milestone grants

This staged workflow stores authorization evidence only. It does not publish issues,
apply labels, enqueue jobs, enable enforcement, change project settings, or start a
daemon. Existing ticket admission remains unchanged. Run these commands in the
existing owner operator environment, using the same owner configuration paths and
`AGENTLOOP_STATE_DIR` across restarts. Do not derive activation commands from issue
text or model responses: activation is an explicit owner decision.

Create an input JSON file with exactly these fields:

```json
{
  "project": "ralph",
  "repo": "woodsja/AgentLoop",
  "spec": {
    "identity": "woodsja/AgentLoop#103@owner-approved-revision-1",
    "digest": "<64 lowercase hex characters: SHA-256 of exact specification file bytes>"
  },
  "objective": "Implement the eight approved milestone tickets",
  "allowedCategories": ["implementation", "tests", "documentation"],
  "exclusions": ["production deployment", "owner configuration changes"],
  "revision": 1,
  "ticketLimit": 8,
  "expiresAt": "2026-11-01T00:00:00.000Z",
  "concurrencyLimit": 2
}
```

The project name and exact repository spelling must match a unique registration
in both owner configuration files, including the same canonical checkout. Staged
and active registered projects are eligible. Wildcards and unrestricted category
names are rejected. Category names use lowercase letters, digits and hyphens.
Ticket limits are integers from 1 to 100; concurrency is 1 to 10 and cannot exceed
the ticket limit. Expiration must be a canonical UTC ISO timestamp in the future,
within 366 days. These conservative initial bounds are not scheduler settings.

```sh
ralph grant draft milestone-1 --input grant.json --spec approved-spec.md --config /owner/config.json --projects /owner/projects.json
ralph grant inspect milestone-1 --config /owner/config.json --projects /owner/projects.json
ralph grant activate milestone-1 --digest <digest-from-inspect> --config /owner/config.json --projects /owner/projects.json
```

Activation previews the complete stored grant and prompts in a terminal. An owner
may instead supply `--yes` together with the inspected digest. Specification
identity, digest and exact bytes are retained in the draft; approval covers those
bytes and all grant terms. Changing the source file later cannot change the grant.
The grant digest is SHA-256 over the fixed-order stored terms, including registration
identity and specification bytes. Actor names come from the local operator account.
Revisions are positive integers; changed terms require a new grant ID and approval.
Repeating a draft with identical terms or activating an already active grant with
the matching digest returns the existing result without duplicating authorization.

`inspect` includes all lifecycle timestamps and approval events, including approval
requests and failures. The existing owner diagnostics log also captures complete
command previews, results and errors. The store is
`$AGENTLOOP_STATE_DIR/milestone-grants.json` (default: repository `state/`). Lifecycle
states are `draft`, `active`, `expired`, `paused`, `revoked`, and `completed`.
Inspection/activation persist expiration of draft, active and paused grants;
revoked and completed remain terminal. Pause, revoke and complete commands belong
to ticket 7 and are deliberately unavailable here.

Grant state and approval events are committed together by fsynced temporary-file
replacement and directory fsync. Interrupted approvals never resume automatically.
A crash before publication leaves the prior state; a crash after publication may
leave a fully approved active grant, which an explicit retry can inspect. Writers
share existing project registration locks, preventing concurrent registration or
grant edits. External owner edits are rechecked after approval. As with project
registration, a killed process can leave `.project-lock` directories next to the
configuration files and grant store. Inspect their `owner.json` records and verify
the owning process is stopped before removing those lock directories and retrying.
Unpublished `.tmp` files are never loaded. Preserve failed diagnostics; do not
replace or reset the grant store to recover a lock.

This change is implementation only. Independent review, exact-SHA CI and guarded
merge remain delivery requirements; none establishes a verified deployment.
