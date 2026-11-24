# Highlander production deployment and rollback plan — NOT EXECUTED

## Release authority and merge sequence

**This document is a plan only.** No PR merge, automatic merge, production restart, owner-configuration edit, live migration, Windows modification, or new external demonstration is authorized.

1. Confirm the full stack is still open, draft, unmerged, and correctly based: PR #192 on `ralph-dev`; PR #194 on #192 branch; PR #195 on #194 branch; PR #196 on #195 branch; Ticket06 draft PR on #196 branch. Capture the *current* heads and CI evidence and require fresh owner merge authorization.
2. Under a separately approved merge window, merge in that exact order: **#192 → #194 → #195 → #196 → Ticket06 PR**. Recheck each source/head SHA, merge-base, branch protection, conflict resolution and required checks immediately before the merge. The final change must incorporate every upstream merged commit; do not force-push or silently change the owner grant.
3. After each base branch moves, update/restack or retarget downstream PRs only as needed, verify that the resulting tree still contains the full reviewed changes, and rerun tests/CI and independent reviews for **any new resulting source SHA**. A green check on an older SHA, a GitHub synthetic merge commit, or a temporary verification PR does not certify a changed new head. At minimum require full native `npm test` for the final integrated/merge head and exact-head standards and specification reviews; repeat after every substantive conflict-resolution edit.
4. Release production only from a newly pinned, separately reviewed integrated SHA; GitHub merging alone is never deployment. Confirm upstream baseline config and package lock unchanged except intentional reviewed code.

## Production preflight and active work

- Record VM runtime source SHA, service PID, installed Node version, registered projects, current daemon unit, service command/environment, and owners of all live child process groups. Identify pending/running/held jobs from the authoritative checkpoint plus transport queue and process-claim records, never solely the dashboard counters.
- Enter a separately authorized maintenance window and stop new admissions without changing owner approval semantics. Allow active accepted jobs to reach a durable terminal state. A ready-label removal or issue closure **does not cancel** an accepted job. If an active job cannot drain, use explicit authorized cancellation and verify process/descendant termination. Unknown process ownership **fails closed** and requires human reconciliation; never assume that a missing PID or silent daemon permits a re-run.
- Snapshot complete canonical per-issue checkpoints, queue/result metadata, all raw logs and child journals, process-claim evidence, project registry and owner-modified configuration before cutover. Store timestamped immutable checksums and verify the backup can be read. Do not purge old records or overwrite operator-modified config. Inventory historically unfinished direct/classic records: they remain inspectable but are not admitted to retired workers.
- Audit VM-to-Windows bridging (mounts, SSH forwarding, host sockets and credentials) read-only and ensure the deployment does not expand host reachability; no host security-setting changes without explicit owner approval.

## Proposed cutover (requires separate authority)

1. Pin verified source and backup restore point; capture hashes of source/config, active jobs and journal byte sizes. Stop the production `agentloop.service` via its verified existing service-manager invocation only *after* all in-flight jobs have drained or been explicitly reconciled; verify no orphan or uncertain executor remains. Do not use an assumed service name or kill a process without checking its unit.
2. Deploy the reviewed integrated source using the existing documented staging/guarded activation procedure (`docs/deploy-stage.md`, `docs/deploy-update.md`), normal locked Node install (`npm ci`) and the installed configuration. Preserve owner-configured project names, worktrees, tokens, launch args and permissions. Never copy development daemon state into production.
3. Restart only the existing authorized production daemon service and bridge in a coordinated maintenance action. Clients must refresh MCP tools and use `submit_development_job`; `/api/development/jobs` is the sole HTTP admission. A GET for an old job ID through generic `/api/jobs/:id` and full raw download should still work without replay.
4. Perform **read-only smoke tests first**: process and health, single coordinator, queue/issue checkpoint consistency, recovered holds, historical direct/loop/R1 job lookup, byte-identical raw NDJSON, cancellation route availability, owner authorization and no legacy POST admissions. Do not enqueue an external real job unless separately authorized. Confirm no second coordinator or automatic merge/deploy ran; monitor daemon and review errors and CI observations.

## Immediate rollback triggers and procedure

Triggers: unexpected legacy or duplicate admission, competing coordinator, a job executing without owner authorization, old checkpoints/logs unreadable, raw-log byte loss, unsafe recovery/process claims, wrong-repository execution, bypassed deterministic/Claude/CI gate, unplanned merge, or a new VM-to-host exposure. Stop admissions and initiate the agreed rollback; prioritize process safety, evidence preservation and incident capture.

1. Prevent new admissions; inventory active and possibly detached workers. Explicitly cancel or wait for known running jobs under owner policy; uncertain workers remain held and require manual reconciliation before service change. Snapshot **post-cutover state and logs** separately for forensics before restoring code.
2. Stop the changed daemon using its verified service manager and restore the exact pre-cutover application revision and saved service parameters/configuration. Do not blindly restore an old queue/state directory over newer valid job evidence; first reconcile any new-format records with read-only tools. If old binaries cannot safely inspect new records, keep them held and preserve both snapshots for offline reconciliation.
3. Start the prior known-good daemon only when process ownership is certain and compatible state has been verified. Test old historical reads, raw-log checksums and owner authorization. Keep neutral clients from submitting to pre-change R1 endpoints without explicit operator coordination.
4. Record the cutover/rollback SHAs, timestamps, worker PIDs, evidence paths, checksums and outstanding blocked jobs. An owner must separately approve retry or forward-fix; do not automatically re-deploy.

## Pending owner decisions

- Merge authorization for five stacked PRs and whether to use merge/rebase/squash; preserve audited source relationships and test the integrated tree.
- Production maintenance/drain window, backup destination/retention, service-owner responsibility, and approval to restart the VM daemon and bridge.
- Explicit treatment of any still-running or ambiguous pre-upgrade jobs; no automatic re-execution.
- Whether to authorize one new bounded external E2E specifically validating the renamed submission interface before acceptance or deployment.
