# #142 recovery and delivery gates

## Provenance and implementation

This successor reuses corrected #111 commit
`78f2ab235d9f25e9a765bfa1905ef1519e5b17e2`, retained at
`refs/backup/issue111-corrected-pr135-20261023`, through a normal `--no-ff` merge
inside the assigned issue-142 worktree. The assigned worktree initially matched
verified reviewer deployment `0055c5d9ad8fd7f1f136de90f9eb91ed45131143`.
Both histories share intended #111 base `e7caf791e59127639f3f946755b98b33a4cf9046`.
The merge was conflict-free; ancestry is rechecked by the recovery regression.
Source and test additions were inspected before recovery edits.

Original R1 JSON, both Claude attempt entries, raw R1 and worker journals, parent
job/result/run records, closed PR metadata and both reviewed revision diffs were
snapshotted into an attributable ancestor commit before packaging. See the
[evidence index](evidence/issue-142/README.md). The original terminal records,
closed PR #135, failed #137 history and owner configuration remain untouched.
No failed job is rearmed, rewritten or declared merged. PR #139 remains historical
failed work; deployed #140 is the actual prerequisite.

Packaging follows the existing deployed reviewer protocol without raising its
240 KiB patch cap or filtering patch sections. Six giant text logs and the full
rehearsal export become gzip attachments, alongside original raw recovery
snapshots. Every archive is checked against a retained ancestor Git blob, byte
length, original SHA-256 and compressed SHA-256. All source, tests, configuration,
policy and instructions remain ordinary complete review diffs. A compressed
archive is evidence, never a substitute for executable code review.

`node scripts/verify-issue142-evidence.js` validates archives, historical/current
source digests and ancestry. Add `--live` on the original VM to compare retained
source files and protected failed #137/config baselines read-only. It fails on
mismatch and never repairs or mutates anything. The regression first failed on
missing packaging, then passes after packaging; corruption and mismatched digest
cases fail closed. The normal suite checks the complete retained packaging revision against the
cap. R1 independently checks the complete current PR diff and every patch section
through its deployed validator during delivery. The retained revision is a
post-commit local packaging receipt, not an independent delivery approval.

## Guarded delivery checklist — remaining external gates

1. Ralph must commit the final contents, synchronize safely if `ralph-dev`
   advances, and run complete deterministic verification for that exact head,
   including `git diff --check`. Working-tree tests are preliminary evidence.
2. Fresh GitHub Actions CI must be green for that same head. Independent Claude
   review must return PASS with zero findings on the complete bounded patch.
   Neither older PR CI nor the synthetic adapter can satisfy these gates.
   A rejected review must be corrected within the existing policy; never force
   merge or reuse an old verdict. Retain the complete raw execution records.
3. Existing guarded merge must close successor #142 and produce a durable receipt
   naming implementation head, verification, CI run, reviewer verdict and merge
   SHA. This worker does not start another parent reviewer/PR job.
4. Independently inspect the merged implementation against #111's original
   acceptance criteria, including summary, synthetic authorization/denial,
   dependency unlock, lifecycle changes and crash/restart coverage. Only then
   reconcile/close original #111 with explicit successor PR and durable proof.
   Do not close #111 based merely on this successor's existence.
5. Original #111 still has a failed R1 receipt. GitHub closure cannot authorize
   ADE #114-#116. Their dependency gate must remain blocked. Migrate to successful
   #142 with newly numbered dependent issues greater than 142 when needed, or
   deliver a separately independently reviewed canonical lineage feature.
   Never weaken the smaller-prerequisite rule or relabel an old job merged.

## Unified MGA deployment preparation — not executed

Prepare a single deployment of merged #104-#110 plus recovered #111 only after
verified delivery. A merge does not establish deployment. No automatic deployment,
service restart, config update or live milestone activation belongs to this issue.

1. Record the reviewed release SHA including all eight MGA implementations and
   obtain separate explicit owner deployment authorization. In an approved
   maintenance window, stop new admission using the existing operator procedure;
   settle active jobs or durably pause grants. Record baseline health, service
   version, configuration paths/permissions and pending jobs.
2. Back up owner config, project registration, grant/batch journals, durable clock,
   queue, jobs and full execution logs together. Verify checksums and readability.
   Preserve installed skills, instructions and owner modifications; never replace
   the registry with repository defaults. Prepare the exact reviewed artifact and
   prior service artifact for rollback.
3. Deploy the unified reviewed version using the existing operator procedure.
   Preserve every operator setting and job. Live `milestoneAuthorization` opt-in
   must remain disabled pending separate explicit owner activation. Resolve an
   unexpected existing opt-in with the owner before deploying; do not silently
   alter their settings. Registration/readiness alone grants no execution scope.
4. Health-check service readiness, existing non-opted-in projects, read-only grant
   summaries, retained full logs across restart, dependency holds, single scheduler
   ownership and zero live milestone admissions. Rehearse MGA paths only against
   temporary registered projects. Record actual deployed SHA and health results
   separately from the merge receipt.
5. On health regression, unexpected admission, duplicate scheduling or missing
   evidence, stop new admissions, retain current diagnostics/in-flight jobs, and
   restore the previous reviewed service artifact. Reconcile config edits before
   restoring any backup. Never overwrite newer grant/clock/job history with an
   older database, resurrect authority or erase failed executions. Keep admission
   stopped until evidence is reconciled.

Later live activation requires a distinct owner authorization for the project,
exact grant revision/digest, scope, expiry and quotas, plus its reversible
activation/rollback checks. Household retains its standalone scheduler and R1
must yield. This recovery grants none of that operational authority.
