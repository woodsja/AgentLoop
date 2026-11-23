# Ticket 06 deletion and neutral-naming map

Baseline: PR #196 at 6d9dea2e272b8a80ad5485f5ff1ecad92b0d7e87. No new coordinator or state format.

- **Public MCP admission:** `submit_r1_job` -> `submit_development_job` (replace, no alias). Neutralize the paired public status/result tools; retain generic read-only historical job tools.
- **HTTP:** `POST /api/r1/jobs` -> `POST /api/development/jobs`; replace the matching GET without retaining the old route. Preserve generic `GET /api/jobs/:id` for all historical job IDs.
- **Dashboard:** one canonical form and canonical read-only job detail route; no parallel submission forms.
- **Coordinator naming:** rename the admission/dispatch facade `r1-jobs.js` to `development-jobs.js`, and its main constructor. Retain internal historical R1 child, format discriminators, old job IDs, and read-only inspection functions.
- **Dead documentation:** revise active README and current integration docs. Keep archived ticket evidence, historical plans and accepted ADRs as historical records; do not falsify past operation.
- **Tests:** migrate current-interface tests to neutral routes and names; add a negative test rejecting old public entry points. Keep historical inspection, cancellation, owner holds, worktree security and recovery tests.
- **Safety:** preserve ADR 0001 and 0002; no migration or writes to persisted production state, no live daemon changes or E2E starts.
