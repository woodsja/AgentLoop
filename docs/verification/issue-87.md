# Issue #87 migration rehearsal and boundary evidence

This is direct Codex CLI work on accepted #90/#84/#85/#86, in isolated
AgentLoop and Finance worktrees. No live owner settings, services, Windows
settings, Finance data, remote branches or deployment were changed. Independent
Opus review and exact-head GitHub CI are subsequent gates, not established by
local results. Nothing was merged or deployed.

## Windows host boundary: residual exposure remains

The [baseline](issue-87/host-boundary-baseline.txt),
[actual unsandboxed inventory and bounded TCP checks](issue-87/host-boundary.txt)
and [forwarding/device checks](issue-87/host-extra.txt) record the observations.
The initial command sandbox hid networking/netlink information; conclusions here
use the ordinary guest namespace, not that restricted view.

On 2026-10-17 UTC, `systemd-detect-virt` returned `microsoft`; the kernel was
`6.8.0-142-generic`. Mounts were Linux ext4/vfat and kernel filesystems, with no
drvfs, 9p, CIFS, NFS, Windows disk or host share visible. `/mnt` and `/media` were
empty. No WSL binfmt entry, WSL environment, `cmd.exe`, `/dev/vsock`, `/dev/kvm`,
Docker socket or containerd socket was found. This establishes observations in
the current mount namespace, not proof against future mounts or hypervisor bugs.

`SSH_AUTH_SOCK`/`SSH_AGENT_PID` were unset and `ssh-add -l` could not connect to
an agent. Local GPG sockets, including `S.gpg-agent.ssh`, do exist: `ss -lxnp`
attributed their listeners to guest user systemd. Local Claude and Codex sockets,
D-Bus and system services also exist. They were inventoried without requesting
keys, signing, sending application requests or invoking privileged methods.
`systemctl --user show` failed with “No medium found”; service configuration and
whether any local agent has imported host credentials remain unverified. No
host-mounted socket was observed. Guest credentials can still authorize external
systems: absence of SSH forwarding does not revoke those credentials.

`/dev/vmbus/hv_kvp` and `hv_vss` exist, root-owned mode 0600; the worker user
cannot write either. Hyper-V kernel integration is present. Hypervisor settings,
enhanced-session redirection, integration-service configuration and physical-host
firewall policies cannot be established from these guest observations.

The guest address is `192.168.77.10/24`, gateway `192.168.77.1`. A bounded set of
TCP connects to that gateway gave:

| Port | Actual evidence |
| --- | --- |
| 22 | Connected; banner `SSH-2.0-OpenSSH_for_Windows_9.5` |
| 135 | Connected; no RPC operations sent |
| 2179 | Connected; no management protocol operations sent |
| 5000 | Connected; unauthenticated `HEAD /` returned HTTP/1.0 404 headers |
| 80, 139, 443, 445, 3389, 5985, 5986, 2375, 2376, 3000, 5357, 8080, 9000 | Timed out within the bounded probe; not proof of permanent blocking |

There is a verified path from guest processes to Windows SSH and additional
host services. **The guest is not isolated from the physical host.** TCP reachability
does not establish successful authentication, file access or service exploitation.
Port 2179 is an additional management-interface concern requiring host-side
identification; 135 and 5000 also require owner identification and access review.
No credential trials, RPC enumeration, exploit probes, broad subnet scan or
Windows configuration changes were performed.

The guest also listens on all interfaces for SSH, and on loopback for the
existing dashboard 5757, tunnel-client 8080, Codex 42373 and DNS. The tunnel-client
is a concrete local service whose upstream and forwarding policy were not
inspected. Its relationship to host resources remains a gap. Other host addresses,
IPv6 link-local services, dynamic RPC ports and untested ports remain gaps.

Owner-required follow-up: identify the Windows listeners and tunnel endpoint,
review which host SSH identities and host services the guest is intended to use,
and decide whether host firewall restrictions on the VM subnet or disabling
specific unwanted integrations are appropriate. Any such change requires explicit
owner authorization and a reversible host-side procedure. This rehearsal makes
no host-security change and does not certify complete isolation.

## Project path and owner intent

AgentLoop now commits a native npm lock and a Node contract whose `check` script
runs the full suite and whitespace checks. Finance commits a universal uv lock,
a default development dependency group and the Python contract. Its `>=3.11`
compatibility, optional `[dev]` installation and existing Windows 3.11/3.13 CI
checks remain intact. No Financial Data Directory is configured or read; tests
use synthetic temporary fixtures. Only contract, lock, metadata and documentation
are Finance migration changes.

The #86 command now recognizes a unique legacy alias and migrates it only when
explicitly staged. Existing worker/critic/model, retry, labels, base branch,
verification, CI, merge and unknown owner settings survive. Active entries,
divergent roots and ambiguous aliases are refused. Interrupted pair updates
retain the existing exact rollback and conflict handling. Obsolete setup flags
are removed from the approved migrated entry; the contract supplies actual checks.

Rehearsal uses `/tmp/issue87-migration/{repos,worktrees,state}` and copied owner
stores, never the live stores. Source snapshots were built with `git archive`
plus the explicit migration changes and committed only in disposable repositories.
The original repository remotes are retained for the normal CLI origin check;
no remote push is required. AgentLoop's complete checks are run by its declared
contract, not replaced by a trivial fixture check. The third supported repository
is `owner/disposable`, a dependency-free Node project with a real `node check.js`
entry point. It needs no new Ralph code or special authorization file.

For each, the normal entry point is:

```sh
AGENTLOOP_STATE_DIR=/tmp/issue87-migration/state node src/cli.js project add OWNER/REPO --yes --config /tmp/issue87-migration/config.json --projects /tmp/issue87-migration/projects.json --checkout-root /tmp/issue87-migration/repos --worktree-root /tmp/issue87-migration/worktrees --base-branch migration
# Repeat with project check, then project activate; each has separate evidence.
```

Only copied entries were staged and activated. Finance's explicit `autoMerge:
false` and AgentLoop's `autoMerge: true` survive; no policy was inferred or reset.
Rollback restores exact saved copies of both isolated owner stores while retaining
execution history. No consumer of those copied active settings is started.

## Execution records and recovery

A direct CLI harness invokes `codex exec --json --ephemeral` with workspace-write
workers and read-only Codex critics in disposable worktrees. It uses the existing
#90 `captureProcess`, recorder, store and deterministic verifier. It does not run
Ralph R1 or autopilot. Codex critic results here are functional transcript evidence;
they are **not** the pending independent Opus review of this implementation.

Task `t-87878787` writes an intentionally wrong answer, fails deterministic
verification with exit 7, receives critic FAIL, then writes 42 and passes both.
The raw journal contains worker/critic CLI-exported events, both streams,
verification outcomes and commands, prompts and cleanup events. Each verification
emits more than 30,000 stdout characters plus stderr. Both worktrees are removed.
The existing dashboard HTTP server (without its scheduler) serves the UI, raw
pages and byte-identical downloads before and after SIGKILL/restart:
160,855 bytes, SHA-256
`64591e072a016819f75c2bd445e96caae7c348c7e1bf23f9824667928fd22148`.

The isolated state is `/tmp/issue87-direct-cycle/state`; exact invocations and
full output are under `/tmp/issue87-evidence`. Logs stay outside cleaned worker
worktrees. These files survive process restarts but are disposable local evidence,
not a deployed durable history or off-VM backup. Only events exported by the CLI
are captured; no unavailable model thoughts are reconstructed.

The existing full tests also exercise durable issue identity/deduplication,
failed-attempt recovery, cancellation, process-group termination and restart.
Their worker/critic engines are fixtures; they are deterministic regression
coverage, not live model or deployment evidence.

## Validation and remaining gates

Results and final commit references are recorded below after verification.
Independent Opus review, remote exact-head GitHub CI, live staging/activation,
installed-SHA checks, live dashboard smoke/health checks and deployment rollback
are unverified. The owner explicitly deferred review/CI and prohibited deployment
and Windows security changes in this task. Do not mark issue #87 fully accepted
or claim a deployed migration on these local results alone.

The first two real Finance onboarding checks failed with `uv sync --locked`
SIGABRT while emitting the installed-package summary. Neither failure was erased.
Native descriptor inspection reproduced that the predecessor runner inherited
nonblocking stderr. A native tool can abort on an output burst in that condition.
The runner now gives commands blocking pipe endpoints and forwards both streams
with backpressure. A regression verifies descriptor blocking and every byte of
20,000 writes to each stream (160,000 bytes). It fails against the predecessor
runner (`stderr blocking False`) and passes after the fix. Finance's subsequent
fresh-worktree install and full baseline check passed on Python 3.13.16.

The completed rehearsal receipts were:

| Repository | Disposable snapshot | Readiness | Explicit activation | autoMerge |
| --- | --- | --- | --- | --- |
| woodsja/AgentLoop | `ecb51404f0e5f5b8f77ff36e4cfa287f4e37cbda` | ready, full baseline passed | active | true, preserved |
| woodsja/finance-dashboard | `3722f04a734f442be2d9bebf7e7d75b49594357b` | ready, 539 passed / 4 platform skips | active | false, preserved |
| owner/disposable | `46ee2686e4c2ec195130f734fb13363c34ee2340` | ready, real check passed | active | false |

These are local disposable snapshot commits, **not** remote project heads or CI
proof. All three paths were proved before bare-venv fallback retirement. The
final code is checked by the subsequent focused/full suites. Exact isolated
rollback hashes were config
`cb6e0db89bc844070dd6c5baf1a32b1d74204c19be70ca0639f91ca88678e3cb`
and projects
`e44501c6520796b6c1a51b850efb12ec62bcb8c23c1e33387ea823d95212a983`.
Activated receipts remain in `config.activated.json`/`projects.activated.json`,
with originals restored as the current copied stores. Third-repository CLI logs
used this worktree's ignored `state/logs`; other rehearsal logs use the isolated
state above. Neither location is live installed state.

A second real direct CLI task, `t-87878788`, was marked terminal failed and saved
to `done` after its first worker/verification/critic cycle. Two isolated HTTP
processes served its complete 80,418-byte failure journal across SIGKILL/restart
(SHA-256 `70680fd5cf27c502e082b498ebac4611cd074afa55922ba853bd494e5f1807d7`).
A separate harness invocation explicitly retried that same durable ID, retaining
the failed attempt and adding a successful second attempt. Its complete final
journal is 160,938 bytes, SHA-256
`74e9a706d7a6fa5981336316e5efd1bebc27f6e59bf547f1855781a2e82ed010`;
both post-retry HTTP processes again returned byte-identical downloads. The task
exists once, in `done`, with both attempts; cleaned worktrees remain absent.
This is a direct-harness retry through the existing store, not an assertion that
a live R1 scheduler was exercised. The full suite separately covers scheduler
recovery with fixture engines, respecting the prohibition on R1/autopilot runs.

Finance's isolated implementation commit is
`75d6532` (`feat: add locked Finance setup and AgentLoop project contract`).
Changed files: `.ralph/project.json`, `uv.lock`, `pyproject.toml`, `README.md`.
No private financial files were staged. `.venv`, real data and installed tools
are outside that commit.

A further native signal check exposed queued stderr loss when the wrapper
immediately mirrored a child's SIGTERM: stdout was 200,000 bytes but stderr only
131,072 of 200,000. The wrapper now waits for both forwarded output queues to
flush before mirroring the signal. Both 200,000-byte streams survive verbatim;
the deterministic regression covers this failure as well as normal burst output.
This is an execution-record correctness fix, not a sandbox or runtime change.

Legacy policy preservation includes omission: the old review implementation's
omitted model means Sonnet, whereas new registrations default to Opus. Migration
must not inject new-project defaults into an existing entry. The final migration
implementation copies legacy policy fields exactly, adding runtime/onboarding
facts and deleting only obsolete setup fields; it preserves omitted worker,
review, retry and CI fields as omitted. A dedicated regression tests that case.
The three-repository rehearsal is repeated against final snapshots with exact
policy-object comparisons; final receipts below supersede the initial expansion
rehearsal receipts above.
