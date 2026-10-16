# #76 acceptance and controlled Finance retry — plan before implementation

## Target
Validate merged #74 implementation-only child contract and #75 durable failed-work artifacts together, then deploy the reviewed revision and retry the original woodsja/finance-dashboard#75. Do not touch the separate Finance issue #47 or enable mixed-engine on Ralph self-development.

## Acceptance sequence
1. Extend disposable R1 mixed-engine E2E with issue #75's original blend of coding, testing, local verification, PR/CI and final independent Opus review criteria; assert child PLAN has exactly one implementation obligation, never PR/CI delivery tasks, while the whole issue remains visible as quoted data. Parent owns deterministic verification, one delivered SHA, exact-head CI and final review. Both PASS and repeated critic FAIL paths.
2. Verify failure recovery in an isolated managed worktree with explicit two-file owner `recoveryPaths`, 0700 durable state directory, terminal child, immutable parent ID and baseline. Confirm 0600 digest patch survives worktree cleanup; missing allowlist, secret/untracked content, cross-parent/attempt or active sibling prevents capture/cleanup. Verify restart retries a previously blocked capture safely.
3. Run all focused R1/regression tests plus complete GitHub CI on final commit. Independent restricted Opus standards, spec, security reviews. Merge only after green exact-head CI.
4. Production preflight: stop admission while idle; snapshot live Git SHA, owner config, project policy, service state and durable queue. Confirm Finance's pilot-only label and disabled autoMerge; preserve unrelated ready issue #47 and Ralph one-shot strategy. Ensure recovery-state directory is owner-private (0700) before enabling capture; make no global approval shortcuts.
5. Deploy reviewed release and restart the managed daemon with existing pilot isolation. Configure Finance `recoveryPaths` to exactly `src/finance_dashboard/command_options.py` and `tests/test_command_options.py`; keep Sol worker, Opus implementation/final critic, ready label `optionc-sol-pilot`, autoMerge false. Avoid accidental admission of failed old job: use a deliberate fresh R1 job attempt after verifying old durable parent-child state and issue label.
6. Submit/monitor Finance #75; require exact SHA source/test changes, deterministic checks, green GitHub CI and independent Opus final review. Leave resulting PR open for human merge, never change unrelated issues or agent admission.

## Rollback
At any failed preflight or evidence gate, stop new admission, preserve queue and the previous deployed revision and settings. Do not delete a possibly active worktree, run a second child against it, publish recovery patches, force model verdicts or turn on autoMerge.
