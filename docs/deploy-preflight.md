# Read-only Ralph deployment preflight

`src/deploy-preflight.js` exports one asynchronous interface for a future,
separately authorized deployment stage:

```js
const { validateDeploymentCandidate } = require('../src/deploy-preflight');
const { oldSha, newSha, noOp } = await validateDeploymentCandidate(issueNumber);
```

The optional second argument `{ configPath, deploymentConfigPath }` selects an owner-managed project
configuration file (also used by disposable repository tests). Never obtain that
path from issue or other candidate input. The function loads the `ralph` project
using the existing config loader, then reads the selected issue from its canonical
R1 job store. It does not accept caller-supplied approval objects or checkout paths.

It requires a terminal merged same-repository Ralph job with matching PR identity,
independent Claude PASS at the exact delivered/approved head, zero findings,
passing exact-head deterministic verification, and green configured required CI
with actual successful workflow-run evidence. Ralph must retain `reviewPolicy:
"always"`, `autoMerge: true`, and `baseBranch: "ralph-dev"`.

The configured checkout must be a clean repository root on `ralph-dev`, including
no untracked files. Before the first clean check, installed HEAD and every
reachable tree/blob are hash-verified into a private scratch object store. The
same verified store remains available through the final clean check, with no
alternates. Each check snapshots the checkout index only to reject staged changes,
assume-unchanged, skip-worktree and gitlink entries. It then discards that snapshot
and uses `read-tree <oldSha>` to build a fresh private index with zero stat data
from the verified objects. Status runs in config-free scratch Git metadata;
checkout, system and global filter definitions are not loaded. It ignores
submodules to prevent recursion into their config and commands. An independent
comparison requires actual tracked file bytes (or symlink targets) and executable
modes to match verified installed blobs exactly, including content Git attributes
would normalize. Reads are bounded, refuse special files and symlink ancestors,
and check file/directory identity and metadata around reads; missing files, read
errors and detected concurrent changes fail closed. Both the
literal origin URL and its effective URL after
`insteadOf` rewriting must match an allowed URL for the configured GitHub
repository. The live observation uses the canonical
`https://github.com/<configured-repository>.git` URL directly, never `origin`.
It runs in temporary bare Git metadata without a repository config, with system
and global config disabled, an empty isolated HOME/XDG directory, and a controlled
environment. Git uses the trusted `/usr/bin/git` and `/usr/bin:/bin` executable
paths; only HTTPS transport is permitted. Checkout aliases, includes, helpers,
SSH commands, URL rewrites, HTTP proxy/TLS/resolve settings, and inherited Git,
proxy, certificate, or loader environment cannot redirect this observation,
including config changes after the identity checks. No config blocklist is used.
A live `git ls-remote` observation of `refs/heads/ralph-dev` must equal the recorded merge
SHA exactly; local tracking refs are insufficient. Both installed and candidate
commits must already exist locally. The candidate must be the reviewed head itself
with a sole parent equal to installed HEAD, or a two-parent merge whose first
parent is installed HEAD and whose second parent is exactly the reviewed head.
Intermediate base commits and longer fast-forward paths fail closed. Already
installed candidates retain the reviewed-head identity check. Installed HEAD must
be an ancestor. Parent identities come from raw commit objects via `git cat-file
commit`, and ancestry runs in temporary config-free bare metadata with commit-graph
reads disabled. Shared checkout grafts, replacement refs, shallow metadata, and
cached commit-graph parents cannot supply the reviewed ancestry. After raw parent
and object verification, the private ancestry walk marks verified installed HEAD
and the hash-verified boundary commits reported by `rev-list --boundary
oldSha..newSha` as shallow. A reviewed side branch can fork before installed HEAD;
its excluded fork point must also be materialized and bounded so Git never parses
missing older parents through that branch. Boundary commit bytes are verified,
but their trees and older history are unnecessary for ancestry and the delta.
The installed-HEAD boundary also bounds identical no-op ancestry inputs. These
boundaries only cut private walk edges after the exact raw parent checks; no
checkout shallow metadata is copied.
Before parsing candidate parents, the module reads the raw commit as a Buffer and runs
`git hash-object -w -t commit --stdin`, requiring the result to equal the requested
merge SHA and materializing those exact bytes in a private scratch object store.
Hashing has no path and invokes no attribute filters. It similarly verifies
installed HEAD, the reviewed head (including no-op validation), and commits in `oldSha..newSha`, and recursively verifies their trees and blobs, including
unchanged tree entries. Binary bytes and final newlines are preserved. Objects
from alternates receive the same checks; unrelated unreachable objects and history
before installed HEAD are not audited. Gitlinks reference another repository and
are not traversed. Existing command size/time limits fail closed on large inputs.
`git diff --check <old-sha> <new-sha>` must accept the actual
committed delta. The whitespace gate preserves owner checks and independently
enforces baseline and stricter owner core rules in temporary, attribute-free bare
Git metadata. Both whitespace diffs read only the private store of verified
objects, with no alternates; later changes to shared objects cannot change the
bytes they check. The owner diff retains checkout attributes and core.whitespace
with external diffs and text conversion disabled. Candidate and info attributes
cannot disable the independent check; temporary metadata is removed on success
or failure.
HEAD, branch, and clean status are checked again against the initial snapshot
immediately before returning.

Success returns a frozen `{ oldSha, newSha, noOp }` object. Already installed
candidates still pass all gates and return `noOp: true`. Missing, inconsistent,
unavailable, or invalid evidence and Git failures reject the promise. Git errors
retain their captured `stdout` and `stderr` (including whitespace diagnostics).

This is a point-in-time validation, not a deployment receipt or authorization to
apply changes. Future stages must guard against changes after validation. The
module performs no fetch, repository ref/index update, checkout, config/state
write, service action, or deployment. Git optional index refreshes, fsmonitor,
untracked cache, commit-graph reads, and replacement objects are disabled on
checkout commands, including both status checks and the owner-specific diff.
Network access is limited to the read-only remote observation; missing
objects require a separate owner-authorized preparation step.

Run `node test/deploy-preflight.test.js` for real disposable checkout/bare-remote
tests. It is also included in `npm test`. The ordinary imported module exposes a private testing seam for a canonical
local bare path and command-observation callbacks; it runs the actual Git
observation code, enabling file transport exclusively for that dependency.
The production `validateDeploymentCandidate` entry point cannot select a URL
or observer through options or extra arguments. An explicit `testing` namespace
provides the local-transport/observation seam for disposable tests; tests do not patch
implementation text or append exports by internal name.
Callbacks observe actual Git calls and do not replace command results or
child_process. No source evaluation or synthetic module loader is used. Existing
command-boundary mutation tests fail on missing observations or verification
drift. Tests exercise real helper-alias forgery, HTTP config isolation, inherited config
and environment isolation, graft-hidden intermediate commits, marker-writing
fsmonitor programs, forged loose commits/trees/blobs, binary object hashing,
marker-writing clean/process filters and submodule commands, dirty index-flag
attacks and forged stat-cache/checksum attacks at both clean checks, shared
installed commit/tree/blob swaps before and during status, raw-byte normalization
checks, real blob/tree swaps after verification, exact
remote results and failures, and scratch cleanup.

For the local #30 separated layout, `deploymentConfigPath` is an explicitly
selected external owner file as described in [deploy-update](deploy-update.md).
The configured project checkout is SOURCE: its HEAD and clean bytes are verified
against their own snapshot. `oldSha` is independently read from the dedicated
DEPLOYMENT checkout and used for exact reviewed ancestry. All required objects
are read and hash-verified from source into private scratch; no fetch or write
into the installed object database is performed. Final source HEAD/branch/clean
checks remain required. Old SHA and owner layout are rechecked by staging and
sealed into its receipt; updater checks the actual installed bytes independently.
Without the layout argument, preflight retains its original single-checkout
read-only behavior and does not authorize an update.
