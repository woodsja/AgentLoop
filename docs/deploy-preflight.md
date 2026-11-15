# Read-only Ralph deployment preflight

`src/deploy-preflight.js` exports one asynchronous interface for a future,
separately authorized deployment stage:

```js
const { validateDeploymentCandidate } = require('../src/deploy-preflight');
const { oldSha, newSha, noOp } = await validateDeploymentCandidate(issueNumber);
```

The optional second argument `{ configPath }` selects an owner-managed project
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
no untracked files. Both the literal origin URL and its effective URL after
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
cached commit-graph parents cannot supply the reviewed ancestry.
`git diff --check <old-sha> <new-sha>` must accept the actual
committed delta. The whitespace gate preserves owner checks and independently
enforces baseline and stricter owner core rules in temporary, attribute-free bare
Git metadata pointing at existing objects. Candidate and info attributes cannot
disable that independent check; temporary metadata is removed on success or failure.
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
tests. It is also included in `npm test`. The source-loaded test harness supplies
only a private test-only canonical local bare path; it runs the actual Git
observation code, enabling file transport exclusively for that dependency.
The public module exports only `validateDeploymentCandidate`; neither its
options nor additional arguments can choose a production URL or observer.
Tests exercise real helper-alias forgery, HTTP config isolation, inherited config
and environment isolation, graft-hidden intermediate commits, marker-writing
fsmonitor programs, exact remote results and failures, and scratch cleanup.
