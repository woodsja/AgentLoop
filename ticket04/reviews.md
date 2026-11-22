# Independent code reviews

Two independent read-only agents reviewed the baseline-to-working-tree diff; neither changed files. These are code assessments, not CI or E2E approval.

- `/root/review_correctness`: reviewed standards, process supervision and regression risks. Initial findings covered shutdown/cancellation conflation, stale dashboard/results, retained process-group progression, CI deadline inheritance, and stranded decision publication. Follow-up assessment: no remaining concrete code blockers found; exact-SHA CI, real descendant-process integration and fresh E2E remain outstanding.
- `/root/review_spec`: reviewed Ticket 04, ADRs, authoritative state, historical dispatch and restart. Initial/follow-up findings covered discovery fallback failure/blank requirements, process-claim overwrite, historical reconciliation writers, dashboard/cancellation, decision-publication retry, legacy child dispatch, and terminal process-claim recovery. Final assessment confirmed the terminal claim guard and passing regression; no remaining concrete blockers found. Exact-SHA CI and fresh E2E remain required.

All reported code findings were addressed. The publication regression's first fixture attempts were invalid (registry inside checkout, then incomplete fake GitHub headers); corrected fixture passes, and corrected baseline replay fails. The terminal recovery fixture initially omitted baseBranch; corrected red was captured with only the terminal claim guard removed, followed by restored-source green. Do not count invalid fixture runs as behavioral red evidence.

Reviews were against an uncommitted working tree, not an exact committed SHA. The final cleanup removed redundant local helpers and reused cancellation from shutdown; no review claims deployment readiness.


## Exact-commit reviews of 831f36a (2026-11-22)

Two independent read-only Claude processes (`review-831f36a/standards.json`, `spec.json` in durable VM verification reports) returned **FINDINGS**, not passing verdicts. Common blocking findings: legacy in-flight R1 scheduler starvation, uncertain config-revocation replay, former rearm behavior, owner-facing PR/issue cleanup, cancellation during merged reconciliation and stale asynchronous process-close writes. Targeted corrections were developed after this SHA; these reports are not reviews of the follow-up commit. Remaining decisions / evidence gaps are tracked in the implementation report. Do not claim the original reviews approved the final diff.
