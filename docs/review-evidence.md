# R1 review preparation and lossless evidence packaging

R1 prepares the complete exact-head review context before reserving a paid
Claude attempt. Preparation validates GitHub repository/issue/PR identity,
head, complete diff, committed AGENTS.md guidance, deterministic verification,
CI evidence, packaged evidence and the final encoded prompt budget. Claude
receives a single immutable prepared prompt with tools disabled. Its verdict
is accepted only after another remote identity/head check. Injected reviewers
without `.prepare` retain the original callable interface.

A preparation failure is separate from model review history. The durable job's
`reviewPreparationHistory` includes the exact head, status, classification,
source child error code, configured content/buffer limits, captured byte count,
and owner execution-journal reference. A maxBuffer byte count is explicitly a
lower bound: Node may kill the child and limit callback output. It is never
reported as the original complete diff's length. Full captured command pipes,
errors, stacks and causes remain in owner execution records. No captured
worker, reviewer or verifier records are removed by preparation.

`review_input_over_budget` is deterministic and requires owner correction; it
never consumes a Claude attempt. Malformed context, missing diff, authentication,
identity and integrity failures stop immediately. Recognized transient GitHub
transport failures get at most three preparations for a head, separated by 30
seconds, with each counter/deadline and earlier failure retained on disk. An
interrupted preparation stops on restart without another context fetch or
model invocation. There are at most 24 preparation checkpoints per job. These
limits do not reset or remove earlier `NEEDS_CHANGES` findings. Model timeouts,
invalid verdicts and genuine `NEEDS_CHANGES` still use the existing paid-attempt
policy. Fixing a terminal job requires a separate owner-authorized recovery;
this protocol does not rearm it.

## Packaging a large evidence-only log patch

The owner can explicitly replace newly added review-evidence logs with gzip
archives and a visible manifest. This is a repository patch made before R1
review, not automatic truncation or an approval substitute. Keep all source,
tests, configuration, policy, and instructions as complete ordinary text diffs.
Arbitrary binary changes are blocked. Never rename source code into evidence.

1. Commit the complete original logs under `docs/evidence/` with `.log` or
   `.ndjson` suffixes on the PR branch. Record that commit SHA. It must be an
   ancestor of the packaged head and a descendant of the PR merge base.
2. Compress each file losslessly with gzip. Put archives in
   `docs/evidence/review/<name>.log.gz` or `<name>.ndjson.gz` (simple ASCII names).
   Remove the original uncompressed files from the packaged head. The complete
   originals remain readable in ancestor Git history and by gunzipping the
   committed archives. Keep existing owner job journals and failed PRs intact.
3. Commit `docs/evidence/review/manifest.json`, for example:

   ```json
   {
     "version": 1,
     "entries": [{
       "original": "docs/evidence/verification.log",
       "sourceCommit": "<full original-log commit SHA>",
       "archive": "docs/evidence/review/verification.log.gz",
       "bytes": 258218,
       "sha256": "<SHA-256 of original bytes>",
       "gzip_sha256": "<SHA-256 of compressed bytes>"
     }]
   }
   ```

4. Verify the original and decompressed files compare byte-for-byte, and both
   SHA-256 values and original byte count match. R1 independently repeats these
   checks against exact committed Git blobs, verifies ancestry and PR base/head,
   and rejects duplicates, extra archive files, malformed/corrupt gzip, changed
   originals, missing originals and non-log source paths. It supports at most
   32 logs, 16 MiB per original/archive and a 48 KiB manifest.
5. Review the complete base-to-head patch. Packaging logs first added on the PR
   removes their large text additions from this patch while retaining the full
   original Git blobs. Packaging a pre-existing base log can leave a large
   deletion patch; R1 does not hide it. All patch sections, the manifest, and
   explicit integrity-check results enter the normal independent review prompt.
   If the complete diff or encoded prompt is still too large, preparation
   fails specifically with `review_input_over_budget`.

A verified manifest proves byte preservation, not implementation correctness or
that a log's contents are trustworthy. Reviewers must assess whether the declared
files really are evidence, including suspicious source deletion or relocation.
A manifest cannot turn a blocked review into PASS. Merge and exact-head CI gates
remain in force. A merged repair is not a verified deployment; #111 recovery
requires separate authorization after the repair is reviewed, merged and
explicitly deployed.
