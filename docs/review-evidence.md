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
and owner execution-journal reference. `observedBytesIsLowerBound` is true only
for `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`: Node may kill the child and limit
callback output. That byte count is a lower bound and is never reported as the
original complete diff's length. Ordinary failed commands, authentication
errors, transport errors and Git exit 128 retain their original process codes
and complete captured stdout/stderr with this flag false. Full captured command
pipes, errors, stacks and causes remain in owner execution records. No captured
worker, reviewer or verifier records are removed by preparation.

`review_input_over_budget` is deterministic and requires owner correction; it
never consumes a Claude attempt. This includes `gh pr diff` HTTP 406 or GitHub's
`diff exceeded the maximum number of lines` response: reduce the complete review
patch using the lossless evidence protocol below before an owner-authorized
successor/recovery; retained raw diagnostics identify the GitHub limit.
Authentication and transient network failures remain distinct. Malformed
context, missing diff, authentication, identity and integrity failures stop
immediately. Recognized transient GitHub transport failures get at most three
failed preparations for a head, separated by 30 seconds, with each
counter/deadline and earlier failure retained on disk. An interrupted
preparation stops on restart without another context fetch or model invocation.
Successful `prepared` entries do not consume the failure retry cap; earlier
failures and paid model attempts are never reset. There are at most 24
preparation checkpoints per job. These limits do not reset or remove earlier
`NEEDS_CHANGES` findings. Model timeouts, invalid verdicts and genuine
`NEEDS_CHANGES` still use the existing paid-attempt policy. Fixing a terminal
job requires a separate owner-authorized recovery; this protocol does not rearm
it.

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

## Direct verdicts and review-only successors (#170)

R1 now invokes Claude with `--safe-mode --strict-mcp-config --restricted
--permission-mode dontAsk --permission-prompts none --tools ''`. It retains
fresh sessions, the temporary working directory, stripped GitHub environment
tokens, model-specific dollar limits, output limits and the eight-minute timeout.
There is no fallback to plan mode or broader tools. `Read,Glob,Grep`, already used
by the loop critic, were considered but are unnecessary here: R1 supplies the
complete bounded review material on stdin. The reviewer cannot run commands,
edit files, use MCP or request permission expansion.

The observed 2.1.310 failure is consistent with plan mode's plan-file and
ExitPlanMode workflow competing with a direct final-answer contract. This is a
working diagnosis, not proof of a vendor implementation defect. Installed
`claude --help` documents `dontAsk`, empty `--tools`, and `--restricted` (which
also ignores user/project/local settings). Anthropic's
[permission-mode documentation](https://code.claude.com/docs/en/permission-modes)
describes plan approval and automatic denial of unapproved calls in `dontAsk`.
The parser still requires a successful CLI JSON envelope whose entire `result`
string is a JSON verdict object for the delivered SHA. XML-like Write or
ExitPlanMode markup containing PASS is invalid. No embedded verdict is extracted.
Provider errors, malformed envelopes/verdicts and timeouts remain blocked with
captured owner evidence; they do not automatically retry. Default adapter process
capture now also preserves stdout/stderr when used outside the R1 dispatcher.

After **separate owner authorization**, a blocked R1 result can seed one new,
review-only successor, including the original Finance #48 / PR #83 failure:

```bash
node src/review-successor.js /absolute/owner/autopilot-projects.json \
  finance-dashboard 48 /absolute/evidence/r1-blocked-result.json \
  /absolute/new-evidence-directory
```

The source is the `get_r1_job_result` JSON (with `status: blocked`, `project`,
`id`, and `evidence`), not an editable replacement for the old checkpoint. The
command requires passing source verification for the full delivered SHA and an
earlier failed/interrupted review. It records source bytes' SHA-256 and the
complete parsed source, uses the configured repository/required CI workflow,
forces Opus and `autoMerge=false` in its local context, and fetches fresh GitHub
issue/diff/committed guidance. Both remote PR head and exact-SHA required CI must
still match; CI is checked before and after the review.

The destination directory must not exist. Its exclusive creation reserves a
single paid invocation, bounded to $5 and eight minutes. Synchronously persisted
`execution.ndjson` contains reservation, source identity, commands, raw pipe bytes
(base64), CI observations and the new verdict or failure. The command never
writes the source, job store, project files or owner configuration and has no
worker, delivery, GitHub write or merge path. A valid NEEDS_CHANGES remains
findings for an owner; it cannot launch a correction. A PASS is standalone review
evidence and is never imported into an old job or used to authorize merge.

SIGINT/SIGTERM aborts an active reviewer with SIGTERM followed by bounded SIGKILL.
Reusing any existing successor directory always fails without fetching context
or invoking Claude, including after a crash with only `review_running` recorded.
Such a record means interrupted/unknown outcome, never approval. Inspect its
complete journal before separately authorizing any further successor; do not
erase the directory or rearm the original blocked job.

Deployment remains separate. Require `npm run check`, independent review of the
repair, exact-head GitHub CI, and real-host review smoke evidence before an owner
explicitly authorizes deployment. The Finance pilot remains `autoMerge=false`.
A merged repair or a simulated Opus verdict does not prove live review success.
