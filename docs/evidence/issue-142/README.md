# #142 immutable evidence index

All attachments are complete raw records. Summaries and compressed bytes do not
replace code review. The [manifest](../review/manifest.json) provides exact raw
and gzip SHA-256 values, source commit, original byte length, and historical
verification invocation/tested commit where applicable. The
[provenance snapshot](provenance.json) also identifies original source locations
and protected-file baselines. Both original Claude attempt entries are inside
`original-r1.log`; the full reviewer/worker output is in the execution journals.

Read any attachment with `gzip -dc <archive>`. Recover its exact original Git blob
with `git show <sourceCommit>:<original>` using the manifest fields. The original
six tracked log blobs remain at the pinned corrected #111 commit as well.
Compare restored bytes using `node scripts/verify-issue142-evidence.js`; add
`--live` to verify that original records/configuration remain unchanged on the
source VM. Run `node test/issue-142-evidence.test.js` for corruption, digest,
ancestry, failed-history and dependency-gate regressions.

| Original record | Complete attachment | Original bytes |
| --- | --- | ---: |
| `docs/evidence/issue-111/batch-tests.log` | [issue-111-batch-tests.log.gz](../review/issue-111-batch-tests.log.gz) | 1807 |
| `docs/evidence/issue-111/npm-test-sandbox.log` | [issue-111-npm-test-sandbox.log.gz](../review/issue-111-npm-test-sandbox.log.gz) | 20804 |
| `docs/evidence/issue-111/npm-test.log` | [issue-111-npm-test.log.gz](../review/issue-111-npm-test.log.gz) | 74514 |
| `docs/evidence/issue-111/rehearsal-export.log` | [issue-111-rehearsal-export.log.gz](../review/issue-111-rehearsal-export.log.gz) | 937715 |
| `docs/evidence/issue-111/review-correction-batch-tests.log` | [issue-111-review-correction-batch-tests.log.gz](../review/issue-111-review-correction-batch-tests.log.gz) | 1809 |
| `docs/evidence/issue-111/review-correction-npm-test-unrestricted.log` | [issue-111-review-correction-npm-test-unrestricted.log.gz](../review/issue-111-review-correction-npm-test-unrestricted.log.gz) | 74509 |
| `docs/evidence/issue-111/review-correction-npm-test.log` | [issue-111-review-correction-npm-test.log.gz](../review/issue-111-review-correction-npm-test.log.gz) | 20789 |
| `docs/evidence/issue-142/attempt1-pr135-diff.log` | [issue-142-attempt1-pr135-diff.log.gz](../review/issue-142-attempt1-pr135-diff.log.gz) | 92019 |
| `docs/evidence/issue-142/corrected-pr135-diff.log` | [issue-142-corrected-pr135-diff.log.gz](../review/issue-142-corrected-pr135-diff.log.gz) | 294622 |
| `docs/evidence/issue-142/original-parent.log` | [issue-142-original-parent.log.gz](../review/issue-142-original-parent.log.gz) | 327467 |
| `docs/evidence/issue-142/original-r1.execution.ndjson` | [issue-142-original-r1-execution.ndjson.gz](../review/issue-142-original-r1-execution.ndjson.gz) | 5336793 |
| `docs/evidence/issue-142/original-r1.log` | [issue-142-original-r1.log.gz](../review/issue-142-original-r1.log.gz) | 323368 |
| `docs/evidence/issue-142/original-result.log` | [issue-142-original-result.log.gz](../review/issue-142-original-result.log.gz) | 159164 |
| `docs/evidence/issue-142/original-run.log` | [issue-142-original-run.log.gz](../review/issue-142-original-run.log.gz) | 2888 |
| `docs/evidence/issue-142/original-worker.execution.ndjson` | [issue-142-original-worker-execution.ndjson.gz](../review/issue-142-original-worker-execution.ndjson.gz) | 10186094 |
| `docs/evidence/issue-142/original-worker.ndjson` | [issue-142-original-worker.ndjson.gz](../review/issue-142-original-worker.ndjson.gz) | 497 |
| `docs/evidence/issue-142/pr135.log` | [issue-142-pr135.log.gz](../review/issue-142-pr135.log.gz) | 248 |

The historical original `rehearsal.json.gz` was expanded byte-for-byte into
`rehearsal-export.log` in the snapshot ancestor before being packaged through the
deployed log-only protocol. It contains a JSON inspection export, not executable
source. This records its raw bytes without changing the reviewer protocol.

The PR metadata was read from GitHub during preflight. Both PR revision diffs
are complete `git diff --binary` captures from the intended base; the corrected
commit and prior reviewed objects remain reachable in this worktree history.
Protected original #137 and operator config hashes are comparison baselines,
not claims that this issue deployed anything.
