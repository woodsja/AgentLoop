# Issue 80 verification record

This slice adds owner-controlled Python readiness at the existing R1 job seam.
No live source, project strategy, pilot label, issue release or job submission
was changed. Deployment and merge approvals remain unchanged.

The red-first regression initially failed with “Missing expected rejection”:
the existing environment hook ignored the dependency policy and allowed a fresh
worktree through despite the simulated index/DNS outage. The regression now
asserts a fixed sanitized infrastructure block before worker/critic admission.

The new tests cover public R1 submission/advance/read with the actual durable
feature-job store and isolated Git worktrees: fresh and cached setup, approved
offline setup, missing interpreter, incompatible dependencies, index/DNS failure,
timeout, corrupt/incomplete/unapproved bundles, cancellation, duplicate and
concurrent admission, worktree/venv/bin symlink escape, interrupted/restarted
preparation, unresolved old-process ownership, legacy prepared/fresh Python
projects, mixed-engine preflight failure and default non-Python compatibility.
A real-pip test builds deterministic fixture wheels with Python's standard
library, then exercises the guarded runner and offline installation; it skips
only when the execution sandbox demonstrably discards child stdin needed by the
runner's durable admission handshake.

Validation in the managed worker sandbox (2026-10-16):

- New regression suite: 21 passing tests, with the real-pip case skipped because child
  stdin writes are discarded by this sandbox. The guard correctly fails closed.
- Existing environment/configuration tests and JavaScript syntax checks pass.
- `git diff --check` passes.
- Full `npm test` attempted. It stops in the existing autopilot CLI verification
  evidence test because captured subprocess stdout/stderr are empty. A separate
  run of all 43 test files completed with 31 passing; affected integration tests
  also encounter synchronous Git `spawnSync EPERM` in this sandbox. This is not
  a passing full-suite claim; the external deterministic gate remains required.
- Exact-head GitHub CI lookup attempted: api.github.com was unreachable. These
  working-tree edits have not been published, so no exact-head green CI result
  is claimed.
- Independent `claude --print --model opus --permission-mode plan` review of the
  changes attempted: failed with API connectivity/DNS `EAI_AGAIN`. No independent
  review approval is claimed and no alternate paid provider was selected.

The final full deterministic, exact delivered-head GitHub CI and independent
Opus review gates must pass in the authorized delivery environment.
