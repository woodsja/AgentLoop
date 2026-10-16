# Owner-controlled Python verification preflight

R1 projects can declare `pythonEnvironment` in the owner-managed autopilot
project configuration. The registry, issue worktree, feature-job lock, queue,
worker sandbox, critic, exact-head CI, final review and merge approval gates
remain the existing authorities. Issue text and repository instructions cannot
select setup commands or dependency sources. This change does not release #80,
change live project labels, submit a job, enable a source, or change one-shot
implementation policy.

The owner supplies the complete wheel-only dependency closure (including the
project wheel when its installed commands are required), exact versions and one
approved wheel SHA-256 per distribution. Both pytest and Ruff are required.
For example, the shape of a policy is:

```json
{
  "pythonEnvironment": {
    "interpreter": "/usr/bin/python3",
    "timeoutMs": 120000,
    "wheelhouse": "/owner/approved/project-python-wheels",
    "dependencies": [
      {"name": "pytest", "version": "OWNER_PIN", "wheel": "OWNER_APPROVED.whl", "sha256": "OWNER_SHA256"},
      {"name": "ruff", "version": "OWNER_PIN", "wheel": "OWNER_APPROVED.whl", "sha256": "OWNER_SHA256"}
    ],
    "commands": ["finance-dashboard"]
  }
}
```

This illustrates fields, not an installable bundle. The owner must supply real,
compatible versions, wheel names and digests and every transitive dependency.
The wheelhouse must be canonical, outside the worktree, and contain exactly the
approved wheels, without extra files or symlinks. Missing, stale, altered,
unapproved or inconsistent bundles block admission. pip uses `--no-index`,
`--no-deps`, `--require-hashes` and no download cache. It never builds source
packages or falls back to another source. An owner may instead explicitly
configure `indexUrl` as an HTTPS URL without credentials; it is mutually
exclusive with `wheelhouse`. That option uses exact pins and hashes, binary
wheels only, and zero transport retries. No default index is enabled by this
feature. Credentials and new sources require an owner decision outside the job.

Preparation uses the configured interpreter only to create `.venv`. All pip,
readiness and dependency checks use `.venv/bin/python` with Python isolation.
System-site packages and escaping paths are rejected. The environment excludes
ambient Python/pip configuration, proxy variables, credentials and household
data settings. Installed distribution versions, console executable locations,
local shebangs (or wheel binaries), and `pip check` must pass. List all project
installed commands in `commands`; this checks command availability without
running application checks or accessing application data. Deterministic project
verification still runs separately after implementation.

A successful installation records the policy digest in the worktree's `.venv`.
Matching environments are checked and reused without reinstalling. An owner
policy change invalidates reuse and rebuilds the validated local environment
from scratch so removed distributions cannot survive the old policy. The existing
workspace cleanup lifecycle is unchanged; a removed worktree requires preparation again. Existing `prepareVenv` Python projects can reuse an environment that passes
local pytest, Ruff, installed-command and dependency readiness checks. A fresh
or incomplete legacy Python environment blocks before the worker, asking the
owner to provide this policy; it cannot trigger dependency installation from an
unapproved source. Repository instructions can require readiness but cannot
authorize installation. Non-Python/default projects retain their prior behavior. No live project policy is enabled by this patch.

The feature job records `environmentPreflight` and R1 exposes it through existing
job status/evidence. It is `preparing`, `ready`, or `blocked` with category
`infrastructure`, a fixed reason and actionable message. Reasons distinguish
policy/path problems, missing interpreter or venv support, incompatible/missing
dependencies or commands, invalid offline bundles, index/DNS transport errors,
timeout and cancellation. Raw subprocess output, URLs, secrets and local paths
are never persisted in preflight evidence. A failed preflight is terminal as
`blocked_infrastructure`; it consumes no worker or critic cycle and creates no
verification or review verdict. There are no automatic install retries. Owner
repair and explicit feature-job recovery are required after a terminal block.

The existing feature lock serializes duplicate admissions. A detached setup
runner waits for its PID/start-time claim to be saved before executing Python.
On restart, the old process group must be conclusively terminated before
worktree cleanup or a new setup. Cancellation and shutdown kill that group;
the single owner time limit covers all subprocesses in a preparation attempt.
Interrupted requirements files are replaced safely and unreceipted installs
are revalidated and reinstalled using the same approved policy on recovery.
