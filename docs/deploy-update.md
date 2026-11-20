# Local Step 14 updater (issue #30)

This is local implementation work, not a deployment or authorization to activate
it. The historical base staging candidate was `1b92ea0`; current branch HEAD is
`c53773f74caa1698bcaeb3d6377e230d2fdd6936` after the guarded native HEAD/index advance. **The source is combined with reviewed #29 c53773f locally. Do not merge or
deploy #30 until the combined producer/consumer variant is independently reviewed
and the native integration gates pass.** No other worktree is modified here. No automatic daemon
integration, unit installation, owner configuration edits or network operations
are part of this correction.

## Combined staging receipt contract

The trusted updater is installed outside the swapped checkout and invoked as an
independent manual process outside `agentloop.service`:

```sh
node /trusted/bootstrap/src/deploy-update.js --receipt /absolute/external-state/deployment-staging/OLD-NEW/checkpoint.json
```

Do not run it during development. It performs real swaps and restarts. Staging
must publish `updaterContract: step14-update-v3`, `state: PREPARED`, exact
`oldSha/newSha`, canonical `installedCheckout`, `configFile`, `ownerConfigHash`,
`issueNumber`, complete `approvedEvidence/evidenceHash`, `attempt/repo` paths,
and `candidateTree` plus `installedHash/installerHash` inventories of bytes, modes, internal links and
Git metadata. Old receipts are refused. Staging and updater must use the same
`deployment.lock` inherited on fd 3; preparation refuses an existing update
journal. A legacy `prepare.lock` causes refusal. Manual bootstrap must drain all
old preparation workers and disable old entry points before migrating locks;
absence of the legacy file alone does not prove that migration happened.

The combined producer/consumer contract and its reconciliation mapping below
remain subject to independent review. The
shared disposable fixture helpers in `test/deploy-*-fixture.js` are explicit
imports; tests never split another test file at a source marker.

## Manual bootstrap and owner data

#31 requires separate owner authorization and verification. The updater refuses
an ordinary owner checkout. Provide a **new dedicated disposable deployment-only
checkout**, leaving the owner checkout, refs, hooks, stash, worktrees and history
untouched. Never reset, stash, delete metadata from, or commit configuration in
the owner checkout to satisfy a gate.

The dedicated checkout must have a real `.git` directory (no linked worktree),
exactly `refs/heads/ralph-dev`, and `.git/deployment-only` containing exactly
`disposable-deployment-v1` followed by a newline. Its only top-level Git metadata
may be HEAD, config, index, objects, refs and this marker. Reflogs, stash,
worktree metadata, packed refs, hooks, excludes and extra refs cause refusal.
Only basic core repository settings and origin URL/fetch settings are accepted;
owner Git settings belong in the retained owner checkout. Disable reflog creation
in the disposable checkout. Staging uses an empty Git template, disables its
private reflogs and copies the deployment marker and permitted Git config after
tests. It does not rewrite any owner refs. Both old and failed candidate trees
are retained indefinitely; there is no cleanup or garbage collector.

Place owner `autopilot-projects.json` **outside** the installation and select it
explicitly when preparing. Existing project configuration inside the installed
tree is refused, including ignored configuration. Place daemon `config.json`
externally and configure the unit with explicit absolute
`AGENTLOOP_CONFIG_PATH`, `AGENTLOOP_STATE_DIR` and `AGENTLOOP_PROJECTS_PATH`.
The projects path must equal the exact canonical external project file sealed
in the receipt. The daemon pins its path and bytes at startup; subsequent loads
refuse drift. On drift, new admission fails closed and `project-config.ndjson`
in external daemon state retains the complete diagnostic. `/api/state` stays
available with `daemon.projectConfig.degraded: true`, an error, null current
hashes and the expected identity. Existing work is not cancelled by detection;
execution authorization still rechecks policy. The owner must reconcile policy
and schedule a drained restart to pin the approved bytes. Restoring the original
bytes restores their attestation; diagnostics remain retained. R1, milestone and ADR authorization use that
external file. `/api/state` reports its content hash and path hash, which the
adapter verifies along with unit Environment and the receipt. This requires a separately
reviewed manual layout migration; this implementation does not perform it.
The same separately authorized bootstrap must cover **every independent
`ralph-*-autopilot` service invoked by a timer**, as well as manual autopilot
entrypoints. Each service needs the same explicit absolute
`AGENTLOOP_PROJECTS_PATH`, `AGENTLOOP_CONFIG_PATH` and external
`AGENTLOOP_STATE_DIR` in its service environment (or its explicitly selected
EnvironmentFile). A timer does not inherit the daemon service's environment.
Review existing unit contents and preserve owner settings; drain scheduled work,
then verify external-only discovery, milestone and ADR resume in disposable
fixtures before activation. This document neither edits nor installs owner units.

Never publish owner config or secrets to satisfy a clean-tree check. The adapter
reads the external daemon config for the health port and never writes it.
Unmanaged files in the deployment tree (including ignored owner files) are
refused; only ignored node_modules are allowed. Preserve installed skills,
AGENTS.md, SKILL.md, .agents and .codex contents. No changes to existing owner
configuration, skills or settings are authorized by this document.

Keep installed/staging paths on one VM-local filesystem with canonical real
ancestors, writable parents and no bind-mount aliases. Keep state, workspaces
and logs external. Install the trusted updater and dependencies outside both
swapped trees. Provide an external supervisor/manual recovery process. The
updater enforces refusal inside `agentloop.service` using `/proc/self/cgroup`.
No boot hook, unit enable/reload or live integration is installed here.

The unit must use the exact Node executable, installed `src/daemon.js` and
working directory. Ambiguous paths are refused. Manual bootstrap must configure
systemd `JobTimeoutSec` to an integer 1..60 seconds, start/stop timeouts to integer
1..20 seconds, and `SendSIGKILL=yes`. A read-only guardian `check` verifies these prerequisites before READY or any
terminal journal can be created; a corrected bootstrap can reuse the same
receipt without retry authorization. The updater refuses unbounded/default
90-second configurations. Drain work and verify external durable histories.
Follow [ADR 0001](decisions/0001-agentloop-trust-boundary.md), including separately
verified VM-to-host bridges. No Windows or Finance Dashboard action is included.

## Validation, recovery and service jobs

The updater independently checks canonical terminal merged evidence, Claude
PASS, exact reviewed head, deterministic verification, required workflow success,
PR/merge identity and raw commit parents. It hashes commit/tree/blob objects and
compares tracked bytes, modes, index and inventory seals without executing Git
hooks, candidate scripts, installers or npm during update/rollback. There is no
GitHub fallback. Preparation's existing remote preflight is separate.

The fsync'd `update.json` records intent before filesystem mutations and service
restart. Phases are READY, SWAPPING, RESTARTING, ROLLING_BACK and
ROLLBACK_RESTART; terminal states are DEPLOYED, ROLLED_BACK and FAILED. Terminal
journals are immutable: later recheck refusal never rewrites them, and repeated
invocations do not reseal the running installation or restart again.

The old sealed tree is renamed to a deterministic sibling backup, then the
candidate to the live path. A SWAPPING intent alone does not prove a rename:
with no backup, an observed refusal durably records FAILED and the original
error without entering rollback or restarting the old service. Recovery verifies the live
checkout against the sealed old SHA and inventory; absent, changed or ambiguous
paths are refused without installing or restarting, with verification errors
retained alongside the original refusal. Once the backup exists, observed errors
during swapping, pre-restart checks or restart durably select rollback. On recovery, evidence or
owner-policy changes can refuse forward progress while the durable journal and
unchanged receipt still authorize restoration of the old backup. Crash resume
reconciles each rename and restart. Receipt/journal identity corruption is refused
without rewriting the journal; retain all paths for owner inspection.

Rollback verifies the **old backup**, then quarantines any live rejected entry
with lstat/rename, without following links, reading its contents, validating its
seal, invoking Git on it or executing its bytes. A running candidate may alter
its files or .git; that cannot block quarantine. Rename targets must not exist.
Restoring the old tree and rollback restart are journaled and crash resumable.
FAILED means restoration or rollback verification could not be completed (or a
pre-swap refusal with an existing READY or SWAPPING journal); it never claims recovery.
Nothing deletes a failed tree or its evidence.

Restart uses `systemctl --user --no-block --job-mode=fail restart
agentloop.service`. An independent bounded guardian inherits the flock and
polls authoritative Job and ActiveState until no job remains and the unit is
stable. It survives updater death, including restart jobs lasting longer than
five seconds. Every forward resume settles any pending job before swaps; rollback also
settles it before restoration. The guardian's 105-second outer bound plus two-second kill-after covers
bootstrap queries, submission and required systemd job/start/stop deadlines. No directory is swapped merely because
the no-block submission returned. A missing/misconfigured unit or uncertain job
state fails closed. A crash may repeat a settled restart.

Health requires active/running/success plus a loopback-only `/api/state` response
whose alive PID equals MainPID. Two observations must share a fresh PID within a
15-second health budget. HTTP inactivity is bounded at one second and individual
Git/status/probe commands at five seconds. A rejected candidate is restored and
the old tree restarted and checked for a fresh PID. A merge or PREPARED receipt
is never described as a verified deployment.

## Resource bounds and evidence

`update.jsonl` retains complete base64 stdout/stderr chunks for ordinary
commands, paths to independent guardian raw stdout/stderr files, commands, exits,
health observations, renames, errors and journal transitions. Nothing captured is
silently truncated or redacted. A command crossing an output limit is terminated;
all bytes actually captured are retained. Keep caller stdout/stderr too,
particularly refusals before an audit can open. Staging logs remain alongside it.

Forward verification has a 120-second aggregate budget, 4,000 commands and
32 MiB captured output; tree walks permit 20,000 entries and depth below 64.
Inventory hashing streams files and permits 50,000 entries, 512 MiB and 30 seconds
per inventory. Tracked files above 32 MiB are refused before reading. Recovery
has a separate verification budget so forward exhaustion cannot consume its
restoration allowance. Receipt-wide audit admission stops at 120 MiB of a
128 MiB quota, reserving space for in-flight output and recovery. Existing logs
are never trimmed or recycled to admit another retry. Exhaustion requires owner
inspection and a separately reviewed fresh staging attempt; it does not authorize
deleting a journal or failed evidence. Service and health deadlines are separate
from raw Git verification work.

Run `npm run test:deploy` only with disposable local Git/bare-remote and fake
service fixtures. No tests execute real systemctl, production restarts or live
configuration changes. The disposable daemon loopback integration skips explicitly on sandbox EPERM.
Run `RALPH_DEPLOY_REQUIRE_NATIVE=1 node test/deploy-runtime.test.js` as a strict
native gate; EPERM fails that gate. Socket-free integration also exercises the
actual daemon R1 route and config loader in a disposable process.
Native tests and independent review remain release gates;
a sandbox EPERM is reported as a limitation, never a successful full suite.

## Correction2: supported source/deployment contract (local proposal)

The current proposal is **`step14-update-v3`**. The earlier v2 proposal and the
reviewed #29 `d4707bd` receipts are refused; they cannot be upgraded by editing a
receipt. Earlier local v3 receipts without `candidateTree` also require fresh
preparation. Prepare again with the reconciled producer after manual bootstrap and
review. No live migration has been performed.

`autopilot-projects.json` continues to point `ralph.checkout` to the canonical
**SOURCE** development repository. Autopilot fetches, remote refs, issue branches,
reflogs and linked worktrees remain there. It must own a real `.git` directory;
a linked source checkout or symlink alias is refused. Routine source activity is
allowed during and after preparation, including fetch metadata, independent
refs/worktrees and ignored owner-state writes. Preflight still requires source
HEAD/branch and tracked bytes to remain stable during each validation. Preparation
seals only the copied candidate material consumed by the updater.
The updater never installs the source's working branch: it installs only the
canonical independently approved merge, verified from raw objects and its exact
parents relative to the **actually installed** HEAD.

An external, owner-controlled file, explicitly selected with
`deploymentConfigPath` during preparation, supplies the deployment identity:

```json
{
  "contract": "step14-layout-v1",
  "lockProtocol": "deployment-lock-v1",
  "sourceCheckout": "/vm/source/AgentLoop",
  "installedCheckout": "/vm/install/agentloop",
  "projectConfigFile": "/vm/owner/autopilot-projects.json"
}
```

These are examples, not configuration to apply. All paths must be absolute,
canonical, with real ancestors. Source, installed checkout and staging must be
disjoint; both config files must be outside source and installation. The layout
is an explicit owner attestation that legacy workers/entry points were drained
and lock migration was completed. Do not manufacture it from candidate input.
The dedicated install is created separately by manual bootstrap; do not strip
metadata from an existing development checkout. If a fresh clone is used, only
that new disposable clone may have its clone-created tracking refs, branch
tracking settings, reflogs and other unwanted metadata removed. The canonical
source and all linked worktrees are left intact. This implementation performs
none of those bootstrap actions.

Staging reads old HEAD from the dedicated install, verifies source HEAD/clean
bytes separately, and copies future candidate objects **from source into private
staging only**. Missing source objects refuse preparation. Nothing fetches or
writes new objects into the installed checkout. A receipt binds `sourceCheckout`,
`candidateTree`, `installedCheckout`, `installedHash`, `installerHash`, `oldSha`,
`newSha`, the external project file/hash and the complete layout file/hash.
`installerHash` inventories the private candidate's bytes, modes, links, HEAD,
index and complete private Git object database. Updater checks that seal before
use and each forward rename, verifies expected HEAD and the sealed tree against
raw hash-verified commit/tree/blob objects, and compares tracked bytes and modes.
The copied reachable history was verified object by object during preparation;
its bytes remain covered by the private inventory seal. There is no development
source inventory or source-byte dependency after PREPARED; canonical layout and
real-directory identity checks still apply. Unrelated development
state has no inventory budget and cannot invalidate a deployment. Source object
changes after copying cannot change the private candidate. Altered candidate
objects, HEAD, tree, files or index refuse forward use. Rollback independently
verifies the sealed old deployment. The existing inventory bounds apply only to
private candidate and dedicated deployment trees. Stage-only preparation omits
the installed inventory rather than hashing the owner's development repository.

Without `deploymentConfigPath`, staging still supports preparation-only callers,
but emits `step14-stage-only-v1`, which this updater always refuses. Merely passing
staging tests without a deployment layout does not verify updater compatibility.
The adapter and unit must use the dedicated installed path; project source
configuration stays pointed at SOURCE. External daemon state/config remain
required, with no live owner-config edits authorized here.

## Local reconciliation with reviewed #29

The local #29 commit `c53773f74caa1698bcaeb3d6377e230d2fdd6936` was read without
changing its worktree or branch. This worktree contains the combined producer pending
independent review. The reviewed bulk history copy, trusted npm resolution,
resource admission, raw Git/npm files and failure-recording safeguards have been
carried into this local variant. No merge is claimed.

| Reviewed #29 field/behavior | Local #30 producer and consumer mapping |
| --- | --- |
| `prepare.lock`, including worker fd 3 and npm/timeout inheritance | `deployment.lock` at the same root and fd 3 throughout; both producer and consumer refuse any legacy `prepare.lock` |
| `issueNumber`, `oldSha/newSha`, `evidenceHash/approvedEvidence` | Retained; `oldSha` now comes from DEPLOYMENT and source validation stays independent |
| `state`, `attempt/repo/transcript`, `preparedAt` | Retained, including fresh preparation attempts and unchanged raw logs |
| No updater version or owner-path seal | Require v3 plus `configFile/ownerConfigHash`, `sourceCheckout/candidateTree`, `installedCheckout`, `deployment` containing layout identity/hash |
| No filesystem seals | Require `installedHash/installerHash` with exact bytes, modes, links and Git metadata |
| Private staging HEAD | Explicit sole `refs/heads/ralph-dev`, reflogs disabled, dedicated deployment marker and permitted installed Git config copied after tests |
| Deterministic `OLD-NEW` directory | `deploymentKey` remains `OLD-NEW` initially; explicit sealed retry creates `OLD-NEW-retry-UUID` |
| `test/helpers/deploy-stage-fixture.js` source-marker loader | Shared explicit `test/deploy-preflight-fixture.js` supplies both staging fixtures; #29's fault injection helper and benchmark/native/uv suites are retained, with shared-lock and command-ordinal adaptations |

Manual lock migration must disable old launchers, drain callers, workers and
inherited npm/timeout descendants, verify neither lock has a holder, and archive
legacy evidence without deleting it. Only then may the owner separately provision
the new layout and persistent deployment lock. Never rename/unlink a lock while
an old holder may exist. Neither absence of a legacy file nor this code proves
that operational procedure happened. Old receipts stay immutable and are not
accepted as v3. The combined scripts retain #29's specialized benchmark/native
integration tests and adapted helper imports. Review the complete combined diff
and rerun those native gates before release. This branch's scoped
fixture tests do not substitute for those gates.

## Explicit retry after FAILED or ROLLED_BACK

Do not delete or edit the prior journal. First inspect the complete audit, restore
and verify the old deployment manually if recovery failed, correct the transient
cause, and verify canonical review/CI evidence is still unchanged. A retry does
not authorize another SHA or bypass approval gates. The owner creates a separate
external approval file with these fields:

```json
{
  "contract": "step14-retry-v1",
  "ownerApproved": true,
  "attemptId": "NEW-OWNER-GENERATED-UUID",
  "priorCheckpoint": "/external/state/deployment-staging/OLD-NEW/checkpoint.json",
  "priorJournalHash": "SHA256-OF-EXACT-PRIOR-update.json-BYTES",
  "oldSha": "EXACT-OLD-SHA",
  "newSha": "EXACT-APPROVED-MERGE",
  "sourceCheckout": "/vm/source/AgentLoop",
  "installedCheckout": "/vm/install/agentloop",
  "evidenceHash": "UNCHANGED-CANONICAL-EVIDENCE-SHA256"
}
```

Select it with `retryApprovalPath` alongside `configPath` and
`deploymentConfigPath` when calling `prepareDeploymentCandidate`. This is trusted
manual input only. Its identity, prior receipt hash, prior terminal journal/hash
and unchanged evidence must match. Staging runs all gates again and binds the
approval file/hash into the new receipt. The updater rechecks that seal. The
new checkpoint, journals, logs, backup and rejected paths all use the UUID suffix.
Reusing that approval cannot overwrite a terminal namespace or replay deployment;
a later attempt needs another explicitly approved UUID and prior terminal seal.
A DEPLOYED journal cannot authorize a retry. Every prior journal, attempt, log,
backup and rejected tree remains in place. No cleanup or automatic retry exists.

## Guardian evidence and limits after correction2

The guardian accepts blank idle `Job` as emitted by systemd 255, legacy `0 /`,
bare positive pending Job integers (systemd 255, for example `7`), and legacy
pending `/org/freedesktop/systemd1/job/N` object paths. It parses systemd
formatted timespans such as `1min`, while enforcing integer job seconds 1..60 and
start/stop seconds 1..20. Infinity and unknown values refuse bootstrap. Restart
still uses no-block/job-mode=fail and polls authoritative unit/job state.

The shipping command runner gives timeout/guardian independent append-only raw
stdout/stderr files, never pipes into the worker. Every systemctl command and exit is recorded alongside its captured streams.
Both captured streams (including stderr on success) are written verbatim and
fsync'd by the guardian before admitting another query, even when the first
stream crosses an output threshold.
The timeout, guardian and bounded systemctl children inherit fd 3. Worker SIGKILL
therefore cannot cause EPIPE or release the pending-job lock. The outer bound is
**105 seconds plus a two-second kill-after**, allowing up to twenty seconds of
bootstrap queries, five seconds of submission, 65 seconds of authoritative job
polling and a final pair of five-second queries. This supersedes the earlier
75-second description. A polling audit failure retains the lock until the job
deadline. Per guardian, command output capture is bounded at 64 KiB per query,
1,500 calls and a 4-MiB output termination threshold; captured bytes, including
threshold overshoot, remain in raw files. No later queries run after budget
exhaustion. Receipt-wide guardian admission stops at 128 raw files or 32 MiB
retained, without trimming any file. Owner inspection and a fresh authorized
attempt are required if capacity is exhausted; disk/fsync failure cannot promise
successful capture. These are trusted VM execution bounds, not hostile-code disk
quotas. No component intentionally closes the inherited flock early.

Tests invoke the shipping command runner, timeout and systemd adapter with an
explicit test guardian entry point that calls the shipping guardian with a fake
systemctl executable. The command runner is not mocked or source-patched. They
kill the worker with piped caller output, hold a fake pending job beyond five
seconds, verify lock retention, completion/deadline release, preserved stdout and
stderr, and guardian process reaping. A separate TERM-ignoring child tests the
kill-after bound. These are realistic disposable **fake-systemctl** integrations,
not real service restarts. The read-only user bus query in this sandbox was denied
(`Failed to connect to bus: Operation not permitted`); native systemd behavior
and the combined #29 real-suite staging gate remain unverified here.


## sync1 combined validation status

The file-level three-way integration retains reviewed #29 c53773f, #28's verified
shallow boundaries and #27's durable dependency diagnostics. The retained backup
and original correction1–5 evidence remain unchanged. Six conflicted files and
their complete three-way inputs are recorded in `state/verification-reports/sync1`.
No local commit, remote write or production action was performed.

At the original sync1 snapshot, HEAD was `1b92ea0` and the sandbox could not
write the external Git metadata. The later guarded native HEAD/index advance
succeeded: current HEAD is `c53773f74caa1698bcaeb3d6377e230d2fdd6936`, verified
again on 2026-11-20. That operation created no commit and preserved the combined
uncommitted files. The original sync1 manifests and test records describe their
snapshot, not the postreview1 corrections. Consult `postreview1` for fresh hashes
and local correction results. The independent combined review1 returned
NEEDS_CHANGES; a new independent PASS and native green gates are still required.

Deployment fixtures, benchmark, native uv, focused suites, the full test command
and native staging were attempted. Consult `sync1/SUMMARY.md` and raw logs for
exact results; sandbox EPERM failures are failures, and native listener skips
remain unverified. The original sync1 independent review launch failed because OAuth expired;
the later combined review1 returned NEEDS_CHANGES. Prior review8 covers only
the original #30 tree. Native verification
and a fresh independent Claude PASS are required before any commit. The prepared
native scripts run only disposable fixtures and do not deploy or install units.
