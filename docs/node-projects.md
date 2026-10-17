# Node project contract and readiness

An owner-authorized disposable repository worktree can commit this entire
`.ralph/project.json` contract:

```json
{"runtime":"node","verification":"check","lockfile":"package-lock.json"}
```

`runtime` is currently `node`; Python contracts follow in #85. `verification`
names a nonempty npm script in `package.json` (for example `check`, `test`, or
`check:all`). It becomes the deterministic `npm run check` entry point after
implementation, including corrective attempts. Only these three contract keys
are accepted. Repository facts cannot set activation, merge or deployment policy.

Set `runtime: "node"` in the existing owner project configuration to require the
contract, including diagnosing its absence. A present contract is always
validated. Existing projects without a runtime selection or contract retain
their legacy behavior for staged migration. The owner's legacy `verification`
field remains required by existing configuration validation; the validated
contract supplies verification for contracted tasks. No live project is migrated
by this change.

Registration, readiness and activation are separate:

- **Registered:** the owner registry authorizes the repository and worktree root.
  Registration alone does not install packages or submit jobs.
- **Ready for development:** on an explicitly admitted job's fresh worktree,
  Node/npm are available through the ordinary daemon PATH (system executables
  and version-manager installations both work), the native lockfile matches
  committed HEAD, `npm ci` succeeds, and the declared check can be invoked.
  This receipt is `environmentPreflight`, independent of application correctness.
- **Active:** the owner separately enables admission using existing `enabled`,
  ready-label and runner settings. Readiness never changes those settings,
  `autoMerge`, CI, review, or deployment policy. Staged registration tooling
  follows in #86.

Preflight invokes the check and retains its baseline result. A pre-existing red
test is coding work and does not prevent worker admission. Shell exits 126/127
(not executable/command not found), command-runner signals and launch failures
block readiness. Other script exits remain visible as failing baseline evidence.
After implementation, deterministic verification must pass; existing exact-commit CI and independent review gates
remain required before guarded delivery/merge.

Preparation accepts native npm lockfile versions 1–3; installed npm performs
the authoritative dependency compatibility check with `npm ci`. Missing,
modified/uncommitted, malformed or incompatible locks block with concrete
infrastructure diagnostics. Preparation never invokes `npm install`, generates
locks, or repairs them silently; lifecycle-induced lock changes also block.
Dependencies provide reproducibility, not a malware-free guarantee. Normal npm
sources and configuration are used. Auditing is optional and outside readiness;
there is no custom approval, egress or package inventory service.

Installer lifecycle scripts run as ordinary VM processes with
`--foreground-scripts` so stdout and stderr reach the complete owner execution
records from #90. Commands, exit status, full failure output and reasons survive
in the existing R1 job store/transcript. Setup failure occurs before worker and
critic attempts. Each command uses a detached process group with a persisted
Linux PID/start-time claim before it starts. Cancellation and the five-minute
preparation deadline terminate the group. Recovery reconciles an old claim
before worktree cleanup/retry; ambiguous ownership blocks replacement. No second
scheduler or environment database is introduced.

There is no bubblewrap dependency, mandatory worktree isolation runner, hostile
VM-file canary, custom PATH allowlist, or dependency security gate. The small
command wrapper exists solely for durable process ownership and startup ordering;
it forwards both streams verbatim. Worker CLIs keep normal permission settings,
without a worktree-specific filesystem profile or engine admission gate. Codex's
existing workspace-write/on-request defaults and read-only critics remain CLI
choices, not evidence of physical-host isolation.

The accepted [trust policy](decisions/0001-agentloop-trust-boundary.md) protects
the physical Windows host. This ticket changes no mounts, interoperability,
forwarded credentials, shared sockets, host services or host configuration, and
makes no claim that the VM is isolated. Actual bridge checks and a reversible,
separately approved deployment remain #87 work. #90 deployment verification,
exact-head GitHub CI and independent review remain release gates; a local commit
or merge is not deployment evidence. Do not rearm or erase prior job history.
