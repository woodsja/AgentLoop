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
no untracked files. Origin must identify the configured GitHub repository. A live
`git ls-remote` observation of `refs/heads/ralph-dev` must equal the recorded merge
SHA exactly; local tracking refs are insufficient. Both installed and candidate
commits must already exist locally. The candidate must be the reviewed head itself
or a two-parent merge whose second parent is exactly that head. Squash/rebase
merges without that proof fail closed. Installed HEAD must be an ancestor, and
`git diff --check <old-sha> <new-sha>` must accept the actual committed delta.

Success returns a frozen `{ oldSha, newSha, noOp }` object. Already installed
candidates still pass all gates and return `noOp: true`. Missing, inconsistent,
unavailable, or invalid evidence and Git failures reject the promise. Git errors
retain their captured `stdout` and `stderr` (including whitespace diagnostics).

This is a point-in-time validation, not a deployment receipt or authorization to
apply changes. Future stages must guard against changes after validation. The
module performs no fetch, ref/index update, checkout, config/state write, service
action, or deployment. Git optional index refreshes and replacement objects are
disabled. Network access is limited to the read-only remote observation; missing
objects require a separate owner-authorized preparation step.

Run `node test/deploy-preflight.test.js` for real disposable checkout/bare-remote
tests. It is also included in `npm test`.
