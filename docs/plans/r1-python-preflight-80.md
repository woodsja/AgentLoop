# Issue 80 verification record

This slice adds owner-controlled Python readiness at the existing R1 job seam.
No live source, project strategy, pilot label, issue release or job submission
was changed. Deployment and merge approvals remain unchanged.

The red-first regression initially failed with “Missing expected rejection”:
the existing environment hook ignored the dependency policy and allowed a fresh
worktree through despite the simulated index/DNS outage. The regression now
asserts a fixed sanitized infrastructure block before worker/critic admission.

The new tests cover public R1 submission/advance/read with the actual durable
feature-job store and isolated Git worktrees: fresh and cached setup, approved
offline setup, missing interpreter, incompatible dependencies, index/DNS failure,
timeout, corrupt/incomplete/unapproved bundles, cancellation, duplicate and
concurrent admission, worktree/venv/bin symlink escape, interrupted/restarted
preparation, unresolved old-process ownership, legacy prepared/fresh Python
projects, mixed-engine preflight failure and default non-Python compatibility.
A real-pip test builds deterministic fixture wheels with Python's standard
library, then exercises the guarded runner and offline installation; it skips
only when the execution sandbox demonstrably discards child stdin needed by the
runner's durable admission handshake.

Review correction:

The delivered implementation passed full tests and CI and received independent
review. That review identified transport misclassification, retained obsolete
distributions after policy changes, and an unguarded cancellation lookup. The
correction limits index transport classification to online pip install stderr,
rebuilds invalid prepared environments after local path validation, and records
admission lookup errors as cancelled infrastructure preflights. Regression tests
cover these cases through the public R1 job seam.

Validation of the correction is recorded by the delivery checks for its exact
commit. Prior sandbox limitations are historical and do not describe the
current delivered head. Full deterministic verification, exact-head GitHub CI
and independent Opus review remain required delivery gates.
