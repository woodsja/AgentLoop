# Python project contract and readiness

An owner-authorized disposable Python worktree uses the same three-key
`.ralph/project.json` contract as [Node projects](node-projects.md):

```json
{"runtime":"python","verification":"python -m pytest && ruff check","lockfile":"uv.lock"}
```

Commit `pyproject.toml` and a compatible `uv.lock`. Set `runtime: "python"` in
owner configuration to require the contract, including diagnosing its absence.
A present contract also selects its runtime without an owner runtime field.
Only Node and Python are supported; an explicit owner runtime must match.
The contract supplies project verification, while activation, review, delivery
and deployment policy remain in owner configuration. Registration, readiness
and activation remain separate; preparation never changes enabled/autoMerge.

Install uv and a compatible Python interpreter on the daemon's ordinary PATH.
Preparation runs `uv sync --locked`, targeting the worktree's `.venv`, then
probes its Python and invokes the contract's nonempty shell verification command.
Verification exports `.venv/bin` at the front of PATH and VIRTUAL_ENV for the
whole command, including compound commands. The same command is supplied to
workers and subsequent deterministic verification. Python modules and installed
console commands therefore resolve through the project environment. System
Python installations and normal uv interpreter discovery work without a private
tool directory. Normal indexes, caches, proxies and VM permissions are retained.

Missing/uncommitted locks block before install. uv itself validates TOML, lock
format and compatibility with current metadata. `--locked` must succeed; setup
never substitutes `--frozen`, regenerates the lock or silently repairs it.
Lock changes during setup/checks also block. For a stale or invalid lock, run
`uv lock` deliberately and commit the compatible result before retrying. Source,
cache or interpreter errors retain the exact command, stdout, stderr and exit
status with repair guidance. Resolve the reported connectivity/cache/tooling
problem and explicitly retry the existing job using normal recovery procedures.
There is no automatic dependency repair or retry loop.

Readiness concerns infrastructure. An invoked pytest/check command returning a
normal failing status is recorded as a red baseline and admitted to a worker for
repair. Shell exits 126/127, process launch failures, signals, cancellation and
timeout block readiness. Application verification must pass after implementation;
readiness does not bypass exact-head CI, independent review or guarded delivery.

Both runtimes share the process runner and R1 evidence path. Every command uses
a detached process group with a durable Linux PID/start-time claim before start.
Cancellation or the five-minute preparation deadline terminates the group.
Restart reconciles prior ownership before cleanup/retry; an ambiguous claim
blocks replacement. Setup failures consume no worker/critic attempt. Full raw
stdout/stderr are forwarded to #90 owner records without output truncation or
redaction, including setup, verification and failure output. Existing durable job
records and transcripts survive recreation and workspace cleanup.

The obsolete `pythonEnvironment` wheel policy now produces explicit migration
guidance. Legacy prepareVenv/instruction-only R1 projects require the shared
contract before admission. The older non-R1 helper can still create/reuse a bare
venv; that helper is not a readiness receipt. This change edits no live project
configuration or existing VM installation. Finance migration remains #87 work.

The accepted [trust boundary](decisions/0001-agentloop-trust-boundary.md) calls
for ordinary disposable-VM execution. There is no mandatory bubblewrap, nested
filesystem sandbox, custom wheel inventory or approval service. Native lockfile
hashes provide repeatability, not malware detection. Physical Windows host
bridge checks and separately authorized deployment remain #87 work. Local tests,
a commit or a merge do not establish deployment verification.

Run tests with uv on PATH (`npm test`). The disposable fixture suite includes a
small dependency-free repository and a real pinned pytest repository, both with
committed native locks. The pytest fixture uses normal PyPI/cache behavior; a
clean test environment needs source connectivity once. An empty offline cache
is tested as a setup failure, followed by recovery using the normal cache/source.
