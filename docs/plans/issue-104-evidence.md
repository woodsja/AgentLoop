# Issue 104 implementation evidence

Local implementation and fake-provider validation only. No real GitHub issue was
published, no labels were changed, no job was queued, and no production project
registration or owner configuration was changed.

The behavioral test file was written before implementation; its first execution
failed because the new module did not yet exist. The empty-body compatibility
case was subsequently written and run before its fix: it failed with `Malformed
GitHub issue response`, then passed after the publisher accepted unrelated null
issue bodies. The tests exercise the shared GitHub transport through an injected
fake execFile; no authenticated operations are required.

Validation in the task workspace:

- `node test/planning-drafts.test.js`: 5 passed.
- `node test/autopilot-github.test.js`: 20 passed.
- `node test/r1-dependencies.test.js`: 9 passed.
- `git diff --check`: passed.
- Both JSON examples render successfully with the local preview command.
- `npm test`: failed at the two existing tests in
  `test/project-preflight-runner.test.js`, after the preceding suites passed.
  Both failures also reproduced from an unchanged `git archive HEAD` extracted
  under `/tmp`. Native Python commands exited 1 with empty captured streams,
  including the test expecting SIGTERM. These failures are outside the draft
  publication changes; the full suite is not claimed green.

The complete owner-facing draft is committed as
[planning-ticket-preview.md](../examples/planning-ticket-preview.md), with its
source JSON and a separate dependent example. Draft creation and recovery are
shown by the fake-provider tests rather than a real-account publication.

Independent Claude review, exact-delivered-SHA GitHub CI, and guarded merge remain
pending in the existing Ralph delivery flow. No deployment was attempted or
verified. Do not release the draft batch or apply execution-triggering labels
without the owner's separate authorization.
