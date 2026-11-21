# Ralph candidate staging (Step 14, 2/4)

`src/deploy-stage.js` exports one asynchronous interface:

```js
const { prepareDeploymentCandidate } = require('../src/deploy-stage');
const receipt = await prepareDeploymentCandidate(issueNumber);
// receipt.state === 'PREPARED'; receipt.oldSha, receipt.newSha,
// receipt.checkpoint, receipt.repo, receipt.transcript
```

The only candidate selector is the issue number. Optional `{ configPath,
timeoutMs }` is trusted operator input; it cannot supply SHAs, approval objects,
repositories, remote URLs, staging paths, or shell commands. `configPath` has the
same meaning as in [read-only preflight](deploy-preflight.md). Each npm command
defaults to ten minutes and accepts a bound of 100 ms through thirty minutes.
There is no daemon integration or automatic activation in this change.

The dedicated root is `<canonical Ralph stateDir>/deployment-staging`. Staging
and installed checkout must be disjoint, and existing staging ancestors must be
real directories, without symlinks. The module creates no linked worktrees and
never fetches, checks out, resets, changes refs/index/config, or installs packages
in the installed repository. The only installed-repository operation added here
is a read of its object-directory location. Existing preflight reads and its
read-only canonical remote observation still run before and after staging.

A Linux `flock` on a persistent `deployment.lock` serializes all issues and SHA pairs
under that root. Contenders fail immediately. A worker owns the lock; loss of
the API caller does not cancel its work. npm and its external GNU timeout inherit
the locked descriptor, so worker SIGKILL cannot permit another prepare while a
test remains alive. No PID-based stale-lock deletion is used. The lock file must
never be unlinked to recover a job. npm process groups are killed at timeout or
completion; the external timeout also survives worker death.

Each `<oldSha>-<newSha>/checkpoint.json` binds the issue, exact preflight SHAs,
SHA-256 of approval evidence, and the complete selected canonical approval
records (delivery, review, verification, CI, PR, merge, issue and terminal
identity). Evidence must be unchanged across initial preflight and final
preflight. A preexisting checkpoint with conflicting identity/evidence or unknown
state fails closed. Missing or invalid canonical approvals always fail preflight.
The caller cannot replace these checks with an injected validator.

Preparation writes `PREPARING` before populating a new UUID attempt. It copies
the exact candidate commit and recursively hashes every tree/blob into private
Git metadata, checking every object ID against its bytes. Reachable historical
commits/trees/blobs are also privately copied and verified because the full suite
audits retained historical evidence. All reachable objects already must
exist locally. There are no alternates or links to shared Git metadata. Tree
paths must be UTF-8, without traversal or `.git` components; candidate symlinks,
gitlinks and unsupported modes fail closed before checkout. Files are written
directly from verified blob bytes with their executable bits, avoiding
attribute/filter/EOL conversions. The private Git index and HEAD identify the
exact candidate without owner/global Git config or hooks.
Then `npm ci --no-audit --no-fund` and the complete `npm test` script run there.
Failure, timeout, changed tracked bytes/modes, changed Git metadata, or outgoing
artifact symlinks/hardlinks prevents `PREPARED`. The source checkout remains
untouched. Node/npm run in an isolated HOME/cache with a controlled environment.
The controlled PATH starts with the directory of `process.execPath`, followed by
`/usr/bin:/bin:/usr/local/bin:<account HOME>/.local/bin`. Node/npm need not live
in `/usr/bin`: npm's CLI is resolved beside the executing Node first, then from
`/usr/local/bin/npm`, `/usr/bin/npm`, or the account's `.local/bin/npm`. Symlinks
are resolved, and the CLI is explicitly executed with `process.execPath`.
Candidate scripts therefore use the same Node runtime. Neither inherited PATH
nor `npm_execpath` selects executables. The executing account's HOME comes from
the OS account record, independently of isolated npm HOME or caller HOME.
No extra host tool directories are added. The executing runtime and listed tool
directories must be trusted VM-local installations.

Checkpoint writes use exclusive temporary files, file fsync, atomic rename and
directory fsync. The repository's regular files and directories are flushed
before publishing `PREPARED`; transcript events are flushed on each append.
npm stdout/stderr go directly to separate raw files in the attempt directory,
preserving complete bytes and crash diagnostics without pipe buffering or output
truncation. Output thresholds terminate producers and retain every byte written,
including any bytes written between threshold checks. Raw worker stdout/stderr
(including preflight failures) are also retained under `request-<UUID>` directories in the staging root. Their paths are included
in API failure diagnostics. npm output paths, command, cwd, timeout and exit outcome are in
`transcript.jsonl`; every staging Git command (including the installed object
location lookup) names separate lossless raw stdout/stderr files there, with exit
status and errors. Callback and timer errors reject preparation; failure handling
independently attempts both the FAILED transcript event and FAILED checkpoint.
Storage failure can prevent either write; diagnostics report those errors.
Failures retain attempts and diagnostics. Abrupt death
can leave `PREPARING`, temporary checkpoint files, or incomplete raw outputs.
Only the canonical checkpoint name is authoritative; orphan temporary files
are never promoted during recovery.

Re-entry validates the same identity and rebuilds in a fresh attempt, even for
`PREPARED`. This deliberately conservative reconciliation reruns installation and
tests, preventing altered/partial staging files from being reused as verified
content. The logical outcome is idempotent; attempt paths and timestamps change.
Previous attempts and logs remain available. A later authorized deployment stage
must revalidate approvals, installed SHA and staged contents again; this receipt
does not attest to future mutable filesystem state or authorize activation.

Assumptions and limits: Linux local filesystems with working fsync/atomic rename,
`/usr/bin/git`, `/usr/bin/flock`, GNU `/usr/bin/timeout`, `/bin/sh`, the executing
Node runtime, and npm in one of the trusted locations above are required.
Unsupported platforms fail closed.
The staging/state roots and executing implementation are owner controlled and
must reside on VM-local storage, outside host shares and bind mounts of live
service directories. Symlink checks do not identify mount aliases;
concurrent malicious same-UID directory replacement, deliberate lock-FD closure,
session-escaping descendants, filesystem corruption and hostile test code are
outside this process-coordination guarantee. This is ordinary trusted in-VM
execution under [ADR 0001](decisions/0001-agentloop-trust-boundary.md), not an OS
sandbox: approved npm lifecycle/test scripts can execute arbitrary VM-local
code. npm ci can use ordinary package registries; no network isolation is claimed.
Historical symlinks/gitlinks are retained only as Git objects and never checked
out or traversed into another repository's objects.
Explicit fixed budgets fail closed rather than discarding history or logs:

- At most 100,000 objects and 512 MiB of uncompressed bytes, including **all**
  reachable history. A private Git directory enumerates object IDs without tree
  path text; a bulk size/type check refuses over-budget histories before bulk
  extraction. One `cat-file --batch` process reads loose and packed objects.
  Its binary protocol is parsed by declared size, never blob delimiters. Every
  header/ID/type/size and SHA-1 of Git header plus bytes is verified. Raw commit
  parents and trees are then traversed again from verified objects; missing
  objects or inconsistent types refuse preparation. No fetch, hardlinks,
  alternates, source hooks/config, or silent history truncation are used.
- At most 128 staging Git commands. Copy has a ten-minute deadline, checked
  before commands and during parsing; batch extraction gets the remaining bound.
  Other Git commands have thirty-second timeouts. Seven commands suffice for a
  normal attempt regardless of object count. Loose object writes have no per-object
  subprocess, transcript fsync, or directory fsync. The complete private repo is
  flushed before PREPARED. A crash before publication is rebuilt on retry.
- Git output termination thresholds are 64 MiB per ordinary command, 512 MiB plus
  128 bytes per allowed object for the binary batch, and 768 MiB per attempt.
  Each npm command triggers termination at 64 MiB combined stdout/stderr.
  Checks run every 100 ms and at completion. These are termination thresholds,
  not hard disk quotas; scheduling and termination can overshoot. All written
  bytes remain in raw audit files. npm's independent GNU timeout survives worker
  death; output monitoring does not. Batch bytes stay in bounded process memory.
- `historyCopy` in the transcript reports verified object count, bytes, elapsed
  milliseconds, and remaining count/byte/deadline budgets. The explicit local
  benchmark (`npm run test:deploy:copy-benchmark`) retains real reachable history
  with fixture package scripts; it is **not** the real-worker full-suite gate.
  On this VM, 2,076 objects / 43,434,241 bytes copied in 2,405–2,964 ms (prior copy:
  148–188 seconds). Remaining budgets: 97,924 objects, 493,436,671 bytes, and
  at least 597,036 ms. This gives about 48x object and 12x byte capacity relative to that
  snapshot; slower disks and future growth must be checked using these metrics.
  Limits are explicit refusal points requiring owner maintenance, never pruning.
- New requests are refused when 64 retained request directories or 2 GiB of
  retained staging data already exist. The current attempt may exceed the
  admission threshold; owner archival is required before further staging. No
  automatic deletion or garbage collection occurs. This persistent limit may
  bind *before* the 100,000-object or 512-MiB copy limits: each attempt keeps
  the uncompressed raw batch (currently about 43.5 MB), compressed verified
  loose objects, a staged checkout, npm logs and prior retained attempts.
  Accordingly the 48x-object and 12x-byte headroom figures above describe only
  the individual copy operation, **not** the lifetime of unattended attempts.
  At present size, the 2-GiB retained gate might permit only a few dozen
  attempts, fewer as the repository and test output grow; this is not a
  guaranteed count. Each `historyCopy` record now includes measured
  `retainedBytesAtCopy`, `retainedHeadroomBytesAtCopy` and
  `retainedBudgetBytes`. A final `PREPARED` transcript entry reports
  `retainedStorage.usedBytes` and `remainingBytes` after tests and flushing.
  These are observed byte counts, not an allowance for an additional attempt;
  the next admission remeasures the entire state directory. Concurrent
  atomic checkpoint renames or temporary npm-file removal are tolerated
  during that advisory count: vanished entries contribute zero bytes rather
  than causing an uncaptured filesystem exception. The count does not weaken
  the separate exact-candidate integrity checks or authorize removal of logs.

Object bytes remain cached within the object-byte/count budgets. Filesystem
materialization and flushing have no fixed overall wall-clock deadline; these
controls are resource limits for trusted VM-local code, not hostile-code quotas.
No service restart, merge, production configuration, owner settings, or Windows
host changes occur. A prepared candidate is not a verified deployment.

`node test/deploy-stage.test.js` runs focused staging tests using disposable local
Git remotes, canonical approval records, real fixture npm commands, packed and
binary objects, output/resource faults, and worker crash/retry. It remains in
normal `npm test`; the slow VM-only work is excluded to preserve the unchanged
20-minute CI budget. It has no recursive full-suite staging and requires neither uv nor fixed `/usr/bin/node`/npm.

The VM uv regression is explicitly gated: `npm run test:deploy:vm-uv` runs real
npm/uv with isolated HOME and an untrusted inherited PATH. Default runs document
its skip. The fixed VM tool search deliberately does not include CI's
`$RUNNER_TEMP/uv-bin`; the VM-only gate is not a CI test.

`npm run test:deploy:integration` separately invokes the shipping worker with
unchanged production package scripts/lockfile and the complete Ralph suite. Only
canonical remote observation is redirected to a disposable local bare repository.
Run it in the ordinary disposable VM, not CI or the Codex sandbox. Its explicit
40-minute test bound and thirty-minute npm bound do not affect `npm test`.
The staged suite does not invoke this separate test, so no branch-based recursion
skip is necessary. Worker/Git/npm raw streams and checkpoints are archived under
`state/verification-reports/deploy-stage-integration-records` even on failure.
Other focused/benchmark runs can set `RALPH_STAGE_TEST_AUDIT_DIR` to archive the
same records before disposable fixture cleanup.

**Native staging verification completed November 20, 2026:** earlier attempts
failed, and sandbox adaptations/skips were not counted as passes. The later
`step14-30-native-final2.deploy-integration.stdout` and `.exit` record the real
shipping worker staging the complete Ralph `npm test` in a disposable fixture:
`state=PREPARED`, one integration test passed, zero failed, exit 0. The native
`npm run test:deploy` and full `npm test` also exited 0 (the latter after fixing
the test runner PATH for installed `uv`). All raw evidence and prior failures
remain retained. **PREPARED is not DEPLOYED**: no production systemd restart,
bootstrap, or real unattended rollout has occurred.


The local #30 receipt-contract proposal (`step14-update-v3`) adds installed/candidate
filesystem seals and pins owner project config
to the PREPARED receipt. The lock is shared with the independent updater; a
receipt with an update journal cannot be re-prepared. See
[local updater and #31 bootstrap](deploy-update.md).

The combined #30 implementation incorporates reviewed #29 feature tip c53773f
and the #30 receipt contract; the implementation was subsequently committed for
PR #180. Native staging gates passed. Independent zero-finding review and GitHub
CI must apply to the exact current PR head before merge.
The updater additionally requires a dedicated disposable deployment checkout and
external owner config/state; never commit owner configuration to satisfy a gate.

The source/deployment separation and explicit owner-sealed retry namespace are
specified in [correction2's contract and mapping](deploy-update.md#correction2-supported-sourcedeployment-contract-local-proposal).
Project `checkout` stays pointed at SOURCE. `deploymentConfigPath` selects the
external layout and its lock-protocol attestation; without it the producer emits
`step14-stage-only-v1`, which cannot be consumed by the updater. `retryApprovalPath`
never changes canonical candidate/review selection: it authorizes only a fresh
namespace after a sealed FAILED/ROLLED_BACK journal. Existing journals and all
backup/rejected trees remain immutable and retained.

This variant retains the original #29 (c53773f) bounded bulk copy (100,000 objects, 512 MiB raw
objects, 128 Git commands, ten-minute copy deadline, 768 MiB Git output), raw
Git/npm streams, trusted Node/npm resolution, 64 MiB npm output termination
thresholds, 64-request/2-GiB retained admission and independent failure recording.
Thresholds retain all written bytes including overshoot. No automatic pruning
occurs. Filesystem seals additionally impose 512 MiB, 50,000 entries and thirty
seconds per private candidate/dedicated installation inventory; SOURCE is never
inventoried. Stage-only receipts omit the installed inventory. The specialized #29 native, uv and copy-benchmark scripts remain available.
See state/verification-reports/sync1 for combined gate outcomes and limitations.

Correction3 restores the reviewed environment/Node/limits record and exact
retained-storage note. Worker error records retain nested AggregateError errors,
original causes, full stacks and captured raw stdout/stderr. Recording failures
attempt both durable records independently and preserve all errors.

A pre-existing legacy `prepare.lock` refuses staging and updating. Migration requires
a separately coordinated owner procedure with no old staging workers active; never
unlink a live lock. Both current workers share `deployment.lock`.

Before either npm gate, staging now counts the complete materialized private
candidate tree (root, files, directories, loose objects and Git metadata) against
the same 50,000-entry seal ceiling, reserving one entry for the later owner
`deployment-only` marker. Admission and remaining entries are recorded in the
raw transcript. This preserves the history copy ceiling without a blanket
40,000-object restriction. npm and tests can add entries after admission; the
final full inventory still refuses any resulting overflow and seals all bytes.
