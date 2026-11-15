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

A Linux `flock` on a persistent `prepare.lock` serializes all issues and SHA pairs
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

Checkpoint writes use exclusive temporary files, file fsync, atomic rename and
directory fsync. The repository's regular files and directories are flushed
before publishing `PREPARED`; transcript events are flushed on each append.
npm stdout/stderr go directly to separate raw files in the attempt directory,
preserving complete bytes and crash diagnostics without pipe buffering or output
limits. Raw worker stdout/stderr (including preflight failures) are also retained
under `request-<UUID>` directories in the staging root. Their paths are included
in API failure diagnostics. npm output paths, command, cwd, timeout and exit outcome are in
`transcript.jsonl`; Git stdout/stderr are recorded losslessly as base64. Failures
retain attempts and diagnostics and ordinarily record `FAILED`. Abrupt death
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
`/usr/bin/git`, `/usr/bin/npm`, `/usr/bin/flock`, GNU `/usr/bin/timeout`, `/bin/sh`,
and the current Node executable are required. Unsupported platforms fail closed.
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
The bound applies separately to ci/test (plus bounded Git commands), not to a
fixed overall wall-clock limit for arbitrary filesystem sizes. Large Git objects
fail closed at 64 MiB command output; preflight retains its stricter limits.
Copied objects are cached in memory during preparation; very large histories
can exhaust resources and cannot produce a successful receipt. Attempts are
retained without automatic garbage collection or disk quotas.
No service restart, merge, production configuration, owner settings, or Windows
host changes occur. A prepared candidate is not a verified deployment.

`node test/deploy-stage.test.js` uses real disposable Git repositories, local
bare remote observations, canonical approval records, actual npm commands, and
worker SIGKILL/retry. Tests also run in `npm test`.
