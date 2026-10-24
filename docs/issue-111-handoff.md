# MGA #111 corrected implementation, recovered by #142

The recovered implementation adds read-only `grant summary` and a fully
synthetic registered-project regression. It preserves the MGA status summary,
first-task authorization, second-task dependency hold until verified merge,
out-of-scope ready issue denial, exact approvals and captured raw evidence.
Existing full-suite tests cover edited tickets, pause/revoke/expiry, abrupt exits
and restart. Tests use temporary registries and fake GitHub/model/CI adapters;
they never edit the operator's registration or activate production milestones.

Run `node test/milestone-batches.test.js`, `node test/issue-142-evidence.test.js`
and `npm test`. Reproduce the synthetic inspection export with:

```sh
AGENTLOOP_REHEARSAL_EVIDENCE=/tmp/rehearsal.json node test/milestone-batches.test.js
```

The calculator and dependent report execute real local product assertions. Their
Claude PASS, GitHub CI, SHA identities and merges are explicitly synthetic. These
observations establish the admission/summary regression, not external product
acceptance, independent implementation review or deployment.

## Immutable historical evidence

PR #135 is closed unmerged at `78f2ab235d9f25e9a765bfa1905ef1519e5b17e2`.
Original R1 job `t-127b307a` remains terminal `ready_for_human`. Attempt 1 at
`9661ba43033e761db512dc011326639372287951` legitimately returned
`NEEDS_CHANGES`; its findings remain actionable historical review. Attempt 2
failed before the model with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`; it is no PASS.
The retained [historical CI response](evidence/issue-111/delivered-ci.json)
applies only to that earlier revision. It does not prove delivery of the
corrected commit or this recovery.

The old `implementation.sha256` is now explicitly named
[earlier-revision-9661ba4.sha256](evidence/issue-111/earlier-revision-9661ba4.sha256).
It matches source bytes at that earlier revision, not the corrected source.
[review-correction.sha256](evidence/issue-111/review-correction.sha256) matches
the pinned corrected commit. The recovery's
[current source digest](evidence/issue-142/current-source.sha256) matches current
source/test/script bytes and is checked by the normal suite. None substitutes
for exact-head verification, CI or independent review.

All six original test logs are preserved byte-for-byte as compressed attachments.
The historical first full run recorded 723 passing tests across 56 files; the
sandbox attempts recorded failures in two native preflight tests. The correction
also recorded 723 passing tests outside that sandbox. These are historical
results, not test claims for the recovery head. Local Claude attempts failed to
produce a PASS. See the [browsable evidence index](evidence/issue-142/README.md)
and [review manifest](evidence/review/manifest.json) for original lengths, SHA-256,
invocations, tested revisions and complete retrievable bytes.

The historical [acceptance summary](evidence/issue-111/rehearsal-acceptance.json)
is navigation. Its complete inspection export is now packaged as
[rehearsal-export.log.gz](evidence/review/issue-111-rehearsal-export.log.gz).
The original gzip remains in the pinned commit. That historical export labels
out-of-scope #202 `waiting`, although its admission was `NEEDS_APPROVAL` and no
job ran. Corrected source and its regression report `denied`; the historical
export remains unmodified.

## Delivery and later operator work

The separate [#142 recovery handoff](issue-142-recovery.md) records provenance,
remaining exact-head delivery gates, original-issue reconciliation, ADE migration,
and the unified deployment plan. This document deliberately contains no predicted
final commit SHA. A post-commit receipt must bind the actual delivery head to
fresh deterministic verification, Actions CI and independent Claude PASS with
zero findings. A rejected review remains actionable and blocks guarded merge.
No deployment or live activation is performed by this implementation.
