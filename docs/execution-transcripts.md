# Owner execution transcripts

The existing Transcript drawer shows lifecycle navigation and a chronological,
expandable **Complete captured execution** journal. Load more records to page
forward, refresh to collect newly appended records, or download the whole raw
journal. Child links download the corresponding child journal. The original
line-based timeline also has a complete download, including for older jobs.
Markup is escaped as inert text. Paths and token-looking values are retained.

Records live under the configured `AGENTLOOP_STATE_DIR/logs`, beside the existing
logs, as `<job-id>.execution.ndjson`. They are independent of project worktrees;
cleanup does not delete them. Appends write immediately and batch disk barriers
at 100 ms; terminal events and orderly exit flush outstanding writes. New file
creation flushes its directory on Linux. Restart reads the same files. There is
no automatic log rotation or retention deletion. Operators must provision disk
space and back up state if they need recovery from loss of the VM itself.
Persistence failures are reported to daemon stderr and the existing timeline
when that sink remains writable; an unavailable disk cannot retain new bytes.

Records include job/parent/child IDs, stage, attempt/cycle, observation timestamp,
command IDs, invocations, stdout/stderr, process exits/signals, exceptions,
verification results, review results and orchestration/state checkpoints.
Worker and critic streams are mirrored into their parent journal as they arrive.
Native Git/GitHub/environment subprocess pipes are captured within the job's
asynchronous context. CLI event streams are retained before summary parsing.
There is no claim to capture non-exported model reasoning or tool events a CLI
does not expose. On daemon termination, a process may die before its exit event
is collected; recovery states that these exit details are unknown rather than
inventing a status. Ordering is the supervisor's observation order across pipes.

`GET /api/log/<id>?raw=1&offset=0&bytes=65536` returns `offset`, `nextOffset`,
`hasMore` and `base64`. Cursors count file bytes, not characters. The maximum page
is 262144 bytes. Concatenate decoded pages to recover the exact journal, including
an incomplete final record from a crash. A subsequent append starts a new line
after a torn record. `?download=1` streams the journal as an attachment.
Add `&legacy=1` for the original line-based log. Existing `?lines=200` clients
keep their response format.

Output records contain `stream` and `base64`: decode and concatenate these bytes
in file order per `commandId` and stream to reproduce the captured pipe exactly,
including invalid UTF-8, CRLF, NUL and terminal controls. Display decoding may
show replacement characters at chunk boundaries; downloads retain the original
bytes. Evidence and result-file records provide complete additional captured
results. Canonical task, result and autopilot job JSON files preserve complete
working state, including critic fixes and corrective diagnostics. Retries and
R1 recovery read these full files; dashboard previews never become agent input.
The dashboard uses separate disposable `state/dashboard/tasks` and
`state/dashboard/results` projections, with bounded diagnostic previews. Each
projection records its canonical file's identity, size and timestamps. Ordinary
`/api/state` polls read these compact files without parsing full task or result
output. Missing or stale projections are rebuilt from canonical state once;
startup also warms them. A crash between writes leaves the canonical state
intact. Deleting projections does not delete working state or journal evidence.
Historical text already discarded by the previous implementation cannot be
reconstructed. This change needs a separate deployment before live jobs produce
these records; a commit or merge does not verify deployment.
