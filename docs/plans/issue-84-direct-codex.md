# Issue 84 implementation record

Implemented directly in `feature/issue-84-direct-codex` from `f375023`, without
Ralph/R1 implementation orchestration. R1 calls in the test suite use disposable
temporary repositories and mock coding services, never live jobs or services.
The complete owner transcript implementation from #90 is preserved and reused.

The bounded implementation steps are:

1. Add red-first Node contract/locked-install fixtures, then common contract
   validation, ordinary Node/npm resolution and `npm ci` preparation.
2. Connect readiness and repository verification to the existing R1 seam,
   preserving independent registration/activation policy and post-edit checks.
   Capture raw lifecycle streams and full failed-command evidence using #90.
3. Reuse detached Linux process identities and the existing restart claim
   reconciliation. Exercise cancellation, timeouts, failed install diagnostics,
   dead claims and ambiguous ownership before replacement.
4. Remove worktree-specific CLI sandbox profiles/engine admission requirements
   and replace the VM filesystem canary test with ordinary worker execution.
   Keep owner registry authorization, CLI approval defaults, independent critics,
   exact-head delivery gates and host integration settings.

Validation commands:

- `node test/node-preflight.test.js` — 22 focused cases.
- `node test/project-registry.test.js` — 8 cases, including both worker engines.
- `node test/sandbox.test.js` — 7 CLI permission regression cases.
- `node test/autopilot-environment.test.js` — 3 legacy environment cases.
- `node test/autopilot-config.test.js` — 10 configuration cases.
- `npm test` — full repository suite, including Node preparation and existing
  Python, cancellation/recovery, exact-commit gates and #90 transcript E2Es.
- `git diff --check` and `git diff --cached --check`.

Final result on Node v24.21.0 / npm 11.19.0: all 515 full-suite tests
passed, zero failures and zero skips. All focused commands above passed.
The final complete test output is in `/tmp/issue-84-npm-test-commit.log`
for this workspace session.

Initial red-first run: all seven new cases failed because preparation ignored
Node contracts. The restricted execution sandbox first returned `spawnSync git
EPERM`; tests were rerun with approved command escalation to use local Git/npm
and HTTP fixtures. No tests were skipped to work around that environment.
Two later fixture failures were corrected: the mock service must return
`needs_planning` for failed verification, and an absent process claim may be
undefined before any command starts. These were test-fixture defects, not waived
production failures.

Release blockers remain separate: #90 still awaits independent review and
verified release; exact-head GitHub CI and independent Opus review for #84 must
run after this implementation handoff. Nothing is pushed, merged, activated or
deployed here. No live `/home/woodsja/tools/ralph`, owner config, services or host
settings were changed. The earlier #84 terminal receipt/history is untouched.
Actual VM-to-host bridge verification remains #87; this implementation does not
claim that a disposable VM is automatically isolated from Windows.
