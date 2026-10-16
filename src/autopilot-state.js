'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const DEFAULT_STATE_ROOT = path.join(os.homedir(), '.local', 'state', 'ralph-autopilot');
const DEFAULT_MAX_JOB_RUNS = 3;
// A red pull request may be handed back to Ralph once.  Keeping this separate
// from the broader run limit makes the CI feedback loop explicit and prevents
// a persistently red external check from consuming scheduler invocations
// forever.
const DEFAULT_MAX_CORRECTIVE_CYCLES = 1;
const MAX_FAILURES = 20;
const MAX_DIAGNOSTIC_LENGTH = 4000;
// Red CI diagnostics include failed-step log tails, so they get more room
// than a single failure message.
const MAX_CI_DIAGNOSTIC_LENGTH = 16000;
const CORRECTION_STATUSES = new Set(['eligible', 'running', 'passed', 'delivered', 'failed']);
const REVIEW_VERDICTS = new Set(['PASS', 'NEEDS_CHANGES']);
const REVIEW_POLICIES = new Set(['risk', 'always']);
const MAX_REVIEW_FINDINGS = 50;
const MAX_REVIEW_HISTORY = 2;
const REVIEW_ATTEMPT_STATUSES = new Set(['running', 'completed', 'failed', 'timed_out', 'invalid_verdict', 'interrupted']);
const JOB_FILE = /^issue-([1-9][0-9]*)\.json$/;

// `preparing` and `running` are only ever persisted while a process owns the
// job.  Finding one on load means that process was interrupted.
const ACTIVE_STATUSES = new Set(['preparing', 'environment_preflight', 'running']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isVerificationEvidence(value) {
  return isPlainObject(value)
    && typeof value.command === 'string' && value.command.trim().length > 0
    && (value.commit === null || (typeof value.commit === 'string' && value.commit.length > 0))
    && typeof value.passed === 'boolean' && typeof value.timedOut === 'boolean'
    && (value.exitCode === null || Number.isSafeInteger(value.exitCode))
    && typeof value.stdout === 'string' && value.stdout.length <= MAX_DIAGNOSTIC_LENGTH
    && typeof value.stderr === 'string' && value.stderr.length <= MAX_DIAGNOSTIC_LENGTH;
}

function hasPassingVerification(value, commit) {
  return isVerificationEvidence(value) && typeof commit === 'string' && commit.length > 0
    && value.commit === commit && value.passed === true && value.exitCode === 0 && value.timedOut === false;
}

function validateIssueNumber(issueNumber) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new TypeError('Autopilot job state requires a positive integer issue number');
  }
}

function truncate(text, limit = MAX_DIAGNOSTIC_LENGTH) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `…${value.slice(value.length - limit + 1)}`;
}

function resolveStateDir(projectName, project = {}, stateRoot = DEFAULT_STATE_ROOT) {
  if (typeof projectName !== 'string' || !/^[A-Za-z0-9._-]+$/.test(projectName) || /^\.+$/.test(projectName)) {
    throw new TypeError('Autopilot job state requires a simple project name');
  }
  if (isPlainObject(project) && typeof project.stateDir === 'string' && project.stateDir.trim()) {
    return path.resolve(project.stateDir);
  }
  return path.join(path.resolve(stateRoot), projectName);
}

function readBootId() {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch {
    // Directory fsync is unsupported on some platforms; the rename is still atomic.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

// Write to a unique temporary file, flush it to disk, then rename it over the
// destination.  Readers observe either the previous or the new complete
// document, never a truncated one.
function writeJsonDurably(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
    throw new Error(`Autopilot job state write failed for ${filePath}: ${error.message}`);
  }
  fsyncDirectory(directory);
}

function createJob({ projectName, repo, issue, branch, worktreePath, now }) {
  validateIssueNumber(issue && issue.number);
  const timestamp = now();
  return {
    schemaVersion: SCHEMA_VERSION,
    project: projectName,
    repo,
    issue: { number: issue.number, title: issue.title },
    branch,
    worktreePath,
    baseRef: null,
    workspaceState: 'absent',
    status: 'pending',
    ralph: { status: null, attempts: 0, taskId: null },
    delivery: { branch: null, commit: null, pushed: false },
    pr: null,
    merge: null,
    ci: null,
    verification: null,
    review: null,
    reviewSkip: null,
    reviewAttempts: 0,
    reviewHistory: [],
    correction: null,
    reviewCorrection: null,
    runs: 0,
    correctiveCycles: 0,
    reviewCorrectiveCycles: 0,
    terminal: false,
    terminalState: null,
    failures: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function validateJob(job, filePath) {
  const hasValidPullRequest = value => value.pr === null || (isPlainObject(value.pr)
    && Number.isSafeInteger(value.pr.number) && value.pr.number > 0
    && typeof value.pr.url === 'string' && value.pr.url.length > 0);
  const hasValidMerge = value => value.merge === undefined || value.merge === null || (isPlainObject(value.merge)
    && Number.isSafeInteger(value.merge.prNumber) && value.merge.prNumber > 0
    && typeof value.merge.approvedHead === 'string' && value.merge.approvedHead.length > 0
    && typeof value.merge.commit === 'string' && value.merge.commit.length > 0
    && typeof value.merge.repo === 'string' && value.merge.repo.length > 0
    && typeof value.merge.mergedAt === 'string' && value.merge.mergedAt.length > 0
    && typeof value.merge.issueClosed === 'boolean');
  const hasValidCiRun = run => isPlainObject(run)
    && Number.isSafeInteger(run.databaseId) && run.databaseId > 0
    && typeof run.status === 'string' && run.status.length > 0
    && (run.conclusion === null || typeof run.conclusion === 'string')
    && (run.name === null || typeof run.name === 'string')
    && (run.workflowName === null || typeof run.workflowName === 'string')
    && (run.url === null || typeof run.url === 'string')
    && (run.startedAt === null || typeof run.startedAt === 'string')
    && (run.updatedAt === null || typeof run.updatedAt === 'string');
  const hasValidCi = value => value.ci === null || (isPlainObject(value.ci)
    // Earlier state files used provider conclusion strings such as
    // "failure". They remain readable; new observations are always one of
    // the three scheduler states enforced by recordCiState below.
    && typeof value.ci.state === 'string' && value.ci.state.length > 0
    && (value.ci.details === null || typeof value.ci.details === 'string')
    && (value.ci.prNumber === undefined || Number.isSafeInteger(value.ci.prNumber))
    && (value.ci.headCommit === undefined || typeof value.ci.headCommit === 'string')
    && (value.ci.runs === undefined || Array.isArray(value.ci.runs) && value.ci.runs.every(hasValidCiRun))
    && (value.ci.diagnostics === undefined || (typeof value.ci.diagnostics === 'string'
      && value.ci.diagnostics.length <= MAX_CI_DIAGNOSTIC_LENGTH)));
  const hasValidCorrection = value => value.correction === undefined || value.correction === null
    || (isPlainObject(value.correction)
      && value.correction.cycle === 1
      && CORRECTION_STATUSES.has(value.correction.status)
      && typeof value.correction.redCommit === 'string' && value.correction.redCommit.length > 0
      && typeof value.correction.diagnostics === 'string' && value.correction.diagnostics.length > 0
      && value.correction.diagnostics.length <= MAX_CI_DIAGNOSTIC_LENGTH
      && (value.correction.commit === null || typeof value.correction.commit === 'string'));
  const nullableString = text => text === null || typeof text === 'string';
  const hasValidFinding = finding => isPlainObject(finding)
    && typeof finding.summary === 'string' && finding.summary.length > 0
    && finding.summary.length <= MAX_DIAGNOSTIC_LENGTH
    && nullableString(finding.file) && nullableString(finding.severity)
    && (finding.line === null || (Number.isSafeInteger(finding.line) && finding.line > 0));
  const hasValidReviewAttempt = attempt => isPlainObject(attempt)
    && Number.isSafeInteger(attempt.number) && attempt.number > 0
    && typeof attempt.startedAt === 'string' && attempt.startedAt.length > 0
    && typeof attempt.completedAt === 'string' && attempt.completedAt.length > 0;
  // Records written before policy, findings, and attempt metadata were
  // persisted hold only a PASS; they remain readable as such.
  const isLegacyReview = review => review.policy === undefined && review.findings === undefined
    && review.attempt === undefined && review.verdict === 'PASS';
  const hasValidReviewHistory = value => value.reviewHistory === undefined
    || (Array.isArray(value.reviewHistory) && value.reviewHistory.length <= MAX_REVIEW_HISTORY
      && value.reviewHistory.every((entry, index, entries) => isPlainObject(entry)
        && Number.isSafeInteger(entry.number) && entry.number > 0 && entry.number <= (value.reviewAttempts ?? 0)
        && (index === 0 || entries[index - 1].number < entry.number)
        && typeof entry.reviewer === 'string' && entry.reviewer.trim().length > 0
        && typeof entry.model === 'string' && entry.model.trim().length > 0
        && REVIEW_POLICIES.has(entry.policy)
        && typeof entry.commit === 'string' && entry.commit.trim().length > 0
        && typeof entry.startedAt === 'string' && entry.startedAt.length > 0
        && REVIEW_ATTEMPT_STATUSES.has(entry.status)
        && Array.isArray(entry.findings) && entry.findings.length <= MAX_REVIEW_FINDINGS
        && entry.findings.every(hasValidFinding)
        && (entry.status === 'running'
          ? index === entries.length - 1 && entry.completedAt === null && entry.verdict === null
            && entry.findings.length === 0 && entry.diagnostics === null
          : typeof entry.completedAt === 'string' && entry.completedAt.length > 0
            && (entry.status === 'completed'
              ? REVIEW_VERDICTS.has(entry.verdict) && (entry.verdict === 'PASS') === (entry.findings.length === 0)
                && entry.diagnostics === null
              : entry.verdict === null && entry.findings.length === 0
                && typeof entry.diagnostics === 'string' && entry.diagnostics.length > 0
                && entry.diagnostics.length <= MAX_DIAGNOSTIC_LENGTH))));
  const hasValidReview = value => value.review === undefined || value.review === null
    || (isPlainObject(value.review)
      && typeof value.review.reviewer === 'string' && value.review.reviewer.length > 0
      && REVIEW_VERDICTS.has(value.review.verdict)
      && typeof value.review.commit === 'string' && value.review.commit.length > 0
      && (isLegacyReview(value.review) || (REVIEW_POLICIES.has(value.review.policy)
        && Array.isArray(value.review.findings) && value.review.findings.length <= MAX_REVIEW_FINDINGS
        && value.review.findings.every(hasValidFinding)
        && (value.review.verdict === 'PASS') === (value.review.findings.length === 0)
        && hasValidReviewAttempt(value.review.attempt)
        && value.review.attempt.number <= (value.reviewAttempts ?? 0))));
  const hasValidReviewCorrection = value => value.reviewCorrection === undefined || value.reviewCorrection === null
    || (isPlainObject(value.reviewCorrection)
      && value.reviewCorrection.cycle === 1
      && CORRECTION_STATUSES.has(value.reviewCorrection.status)
      && typeof value.reviewCorrection.reviewCommit === 'string' && value.reviewCorrection.reviewCommit.length > 0
      && typeof value.reviewCorrection.reviewer === 'string' && value.reviewCorrection.reviewer.length > 0
      && typeof value.reviewCorrection.findings === 'string' && value.reviewCorrection.findings.length > 0
      && value.reviewCorrection.findings.length <= MAX_DIAGNOSTIC_LENGTH
      && (value.reviewCorrection.commit === null || typeof value.reviewCorrection.commit === 'string'));
  const hasValidReviewSkip = value => value.reviewSkip === undefined || value.reviewSkip === null
    || (isPlainObject(value.reviewSkip) && value.reviewSkip.policy === 'none'
      && typeof value.reviewSkip.commit === 'string' && value.reviewSkip.commit.trim().length > 0
      && typeof value.reviewSkip.reason === 'string' && value.reviewSkip.reason.trim().length > 0
      && value.reviewSkip.reason.length <= MAX_DIAGNOSTIC_LENGTH
      && typeof value.reviewSkip.recordedAt === 'string' && value.reviewSkip.recordedAt.length > 0);
  const hasValidRalph = value => isPlainObject(value.ralph)
    && (value.ralph.status === null || typeof value.ralph.status === 'string')
    && Number.isSafeInteger(value.ralph.attempts) && value.ralph.attempts >= 0
    && (value.ralph.taskId === null || typeof value.ralph.taskId === 'string');
  const hasValidDelivery = value => value.delivery === undefined || (isPlainObject(value.delivery)
    && (value.delivery.branch === undefined || value.delivery.branch === null
      || typeof value.delivery.branch === 'string')
    && (value.delivery.commit === null || typeof value.delivery.commit === 'string')
    && typeof value.delivery.pushed === 'boolean');
  const hasValidFailure = value => isPlainObject(value)
    && typeof value.at === 'string' && value.at.length > 0
    && Number.isSafeInteger(value.run) && value.run >= 0
    && typeof value.phase === 'string' && value.phase.length > 0
    && typeof value.message === 'string' && value.message.length > 0
    && value.message.length <= MAX_DIAGNOSTIC_LENGTH;
  const problem = !isPlainObject(job) ? 'not an object'
    : job.schemaVersion !== SCHEMA_VERSION ? `unsupported schemaVersion ${String(job.schemaVersion)}`
      : typeof job.project !== 'string' || !job.project ? 'missing project identity'
        : typeof job.repo !== 'string' || !job.repo ? 'missing repository identity'
      : !isPlainObject(job.issue) || !Number.isSafeInteger(job.issue.number) || job.issue.number < 1
        || typeof job.issue.title !== 'string' ? 'missing issue identity'
        : typeof job.branch !== 'string' || !job.branch ? 'missing branch'
          : !(job.worktreePath === null || typeof job.worktreePath === 'string') ? 'invalid worktree path'
            : !(job.baseRef === null || typeof job.baseRef === 'string') ? 'invalid base ref'
              : typeof job.workspaceState !== 'string' || !job.workspaceState ? 'missing workspace state'
        : typeof job.status !== 'string' ? 'missing status'
          : !hasValidRalph(job) ? 'invalid Ralph state'
            : !hasValidDelivery(job) ? 'invalid delivery state'
            : !hasValidPullRequest(job) ? 'invalid pull request state'
              : !hasValidMerge(job) ? 'invalid merge state'
              : !hasValidCi(job) ? 'invalid CI state'
                : job.verification != null && !isVerificationEvidence(job.verification) ? 'invalid deterministic verification state'
                : !hasValidReview(job) ? 'invalid independent review state'
                : !hasValidReviewHistory(job) ? 'invalid review attempt history'
                : !hasValidReviewSkip(job) ? 'invalid review skip state'
                : !hasValidReviewCorrection(job) ? 'invalid reviewer corrective cycle state'
                : !hasValidCorrection(job) ? 'invalid corrective cycle state'
          : typeof job.terminal !== 'boolean' ? 'missing terminal flag'
            : !(job.terminalState === null || typeof job.terminalState === 'string') ? 'invalid terminal state'
            : !Array.isArray(job.failures) || job.failures.length > MAX_FAILURES
              || !job.failures.every(hasValidFailure) ? 'invalid failure diagnostics'
              : !Number.isSafeInteger(job.runs) || job.runs < 0
                || !Number.isSafeInteger(job.correctiveCycles) || ![0, 1].includes(job.correctiveCycles) ? 'invalid counters'
                : job.reviewCorrectiveCycles !== undefined && (!Number.isSafeInteger(job.reviewCorrectiveCycles) || ![0, 1].includes(job.reviewCorrectiveCycles)) ? 'invalid review corrective counters'
                : job.reviewAttempts !== undefined && (!Number.isSafeInteger(job.reviewAttempts) || job.reviewAttempts < 0) ? 'invalid review attempt counter'
                : job.reviewCorrection && job.reviewCorrectiveCycles !== 1 ? 'review corrective cycle counter does not match state'
                : typeof job.createdAt !== 'string' || !job.createdAt
                  || typeof job.updatedAt !== 'string' || !job.updatedAt ? 'missing timestamps'
                  : null;
  if (problem) throw new Error(`Autopilot job state at ${filePath} is invalid: ${problem}`);
  return job;
}

function recordFailure(job, phase, error, now = () => new Date().toISOString()) {
  const message = error instanceof Error ? error.message : String(error);
  job.failures.push({ at: now(), run: job.runs, phase, message: truncate(message) });
  if (job.failures.length > MAX_FAILURES) job.failures.splice(0, job.failures.length - MAX_FAILURES);
  return job;
}

function markTerminal(job, terminalState) {
  job.terminal = true;
  job.terminalState = terminalState;
  return job;
}

function recordPullRequest(job, { number, url }) {
  if (!Number.isSafeInteger(number) || number < 1 || typeof url !== 'string' || !url) {
    throw new TypeError('Pull request state requires a positive number and url');
  }
  job.pr = { number, url };
  return job;
}

function recordMerge(job, { prNumber, approvedHead, commit, repo, issueClosed = false }, now = () => new Date().toISOString()) {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1 || typeof approvedHead !== 'string' || !approvedHead
    || typeof commit !== 'string' || !commit || typeof repo !== 'string' || !repo || typeof issueClosed !== 'boolean') {
    throw new TypeError('Merge state requires PR identity, approved head, merge commit, repository, and issue closure state');
  }
  job.merge = { prNumber, approvedHead, commit, repo, mergedAt: now(), issueClosed };
  return job;
}

function recordIssueReconciled(job) {
  if (!job.merge) throw new TypeError('Issue reconciliation requires a recorded merge');
  job.merge.issueClosed = true;
  return job;
}

function recordDelivery(job, { branch = job.branch, commit, pushed = true }) {
  if (typeof commit !== 'string' || !commit || typeof pushed !== 'boolean') {
    throw new TypeError('Delivery state requires a commit and pushed flag');
  }
  // Delivery may only ever publish the job's own deterministic issue branch.
  if (branch !== job.branch) {
    throw new Error(`Delivery branch ${String(branch)} does not match job branch ${job.branch}`);
  }
  // An approval is only meaningful for the exact delivered SHA.  A correction
  // must therefore invalidate an earlier PASS before its new CI is observed.
  if (job.delivery && job.delivery.commit && job.delivery.commit !== commit) {
    job.review = null;
    job.reviewSkip = null;
  }
  job.delivery = { branch, commit, pushed };
  // Bind the freshly checkpointed verifier result once. A later delivery
  // cannot relabel evidence from a different commit as verification of itself.
  if (job.verification && job.verification.commit === null) job.verification.commit = commit;
  else if (job.verification && job.verification.commit !== commit) job.verification = null;
  return job;
}

function recordVerification(job, command, verification) {
  const evidence = {
    command, commit: null, passed: verification.passed, exitCode: verification.exitCode,
    timedOut: verification.timedOut,
    stdout: typeof verification.stdout === 'string' ? truncate(verification.stdout) : undefined,
    stderr: typeof verification.stderr === 'string' ? truncate(verification.stderr) : undefined,
  };
  if (!isVerificationEvidence(evidence)) throw new TypeError('Deterministic verification requires the actual command, exit code, timeout status, and test output');
  job.verification = evidence;
  return job;
}

function recordCiState(job, observation, details = null) {
  // Keep the original small API useful for callers that only have a status,
  // while allowing the observer to persist the individual Actions run IDs.
  const source = isPlainObject(observation) ? observation : { state: observation, details };
  if (!['pending', 'green', 'red'].includes(source.state)) {
    throw new TypeError('CI state must be pending, green, or red');
  }
  if (source.prNumber !== undefined && (!Number.isSafeInteger(source.prNumber) || source.prNumber < 1)) {
    throw new TypeError('CI observation pull request must be a positive integer');
  }
  if (source.headCommit !== undefined && (typeof source.headCommit !== 'string' || !source.headCommit)) {
    throw new TypeError('CI observation head commit must be a non-empty string');
  }
  if (source.runs !== undefined && (!Array.isArray(source.runs) || !source.runs.every(run => isPlainObject(run)
    && Number.isSafeInteger(run.databaseId) && run.databaseId > 0 && typeof run.status === 'string'))) {
    throw new TypeError('CI observation runs must be normalized workflow runs');
  }
  if (source.diagnostics !== undefined && typeof source.diagnostics !== 'string') {
    throw new TypeError('CI observation diagnostics must be a string');
  }
  job.ci = {
    state: source.state,
    details: source.details == null ? null : truncate(source.details),
    ...(source.prNumber === undefined ? {} : { prNumber: source.prNumber }),
    ...(source.headCommit === undefined ? {} : { headCommit: source.headCommit }),
    ...(source.runs === undefined ? {} : { runs: source.runs }),
    ...(source.diagnostics === undefined ? {} : { diagnostics: truncate(source.diagnostics, MAX_CI_DIAGNOSTIC_LENGTH) }),
  };
  return job;
}

// Reviewers may report findings as free text or as structured items.  Both
// are persisted in one bounded shape so later passes and humans can rely on it.
function normalizeReviewFindings(findings) {
  if (findings === undefined || findings === null || findings === '') return [];
  const items = typeof findings === 'string' ? [{ summary: findings }] : findings;
  if (!Array.isArray(items) || items.length > MAX_REVIEW_FINDINGS) {
    throw new TypeError(`Review findings must be text or at most ${MAX_REVIEW_FINDINGS} structured findings`);
  }
  return items.map(item => {
    if (!isPlainObject(item) || typeof item.summary !== 'string' || !item.summary.trim()
      || (item.file != null && typeof item.file !== 'string')
      || (item.severity != null && typeof item.severity !== 'string')
      || (item.line != null && (!Number.isSafeInteger(item.line) || item.line < 1))) {
      throw new TypeError('Each review finding requires a summary and optional file, positive line, and severity');
    }
    return {
      summary: truncate(item.summary.trim()),
      file: item.file || null,
      line: item.line ?? null,
      severity: item.severity || null,
    };
  });
}

// A skipped review is an explicit, durable exception for the delivered SHA.
function recordReviewSkip(job, { commit, reason }, now = () => new Date().toISOString()) {
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > MAX_DIAGNOSTIC_LENGTH) {
    throw new TypeError(`Review skip reason must be a non-empty explanation of at most ${MAX_DIAGNOSTIC_LENGTH} characters`);
  }
  if (typeof commit !== 'string' || !commit.trim() || commit !== job.delivery.commit) {
    throw new TypeError('Review skip requires the exact delivered commit');
  }
  job.reviewSkip = { policy: 'none', commit, reason: reason.trim(), recordedAt: now() };
  return job;
}

// Each reviewer invocation consumes an attempt number before it starts, so a
// crashed or failed review is still counted and never reused for a new record.
function beginReviewAttempt(job, now = () => new Date().toISOString(), identity = null) {
  if (identity && (typeof identity.reviewer !== 'string' || !identity.reviewer.trim()
    || typeof identity.model !== 'string' || !identity.model.trim() || !REVIEW_POLICIES.has(identity.policy)
    || typeof identity.commit !== 'string' || !identity.commit.trim()
    || (job.reviewHistory ?? []).length >= MAX_REVIEW_HISTORY
    || (job.reviewHistory ?? []).some(entry => entry.status === 'running'))) {
    throw new TypeError('Independent review requires valid attempt identity and available history capacity');
  }
  job.reviewAttempts = (job.reviewAttempts ?? 0) + 1;
  const attempt = { number: job.reviewAttempts, startedAt: now() };
  if (identity) {
    job.reviewHistory ??= [];
    job.reviewHistory.push({
      ...attempt, reviewer: identity.reviewer, model: identity.model, policy: identity.policy, commit: identity.commit,
      completedAt: null, status: 'running', verdict: null, findings: [], diagnostics: null,
    });
  }
  return attempt;
}

function failReviewAttempt(job, number, error, now = () => new Date().toISOString(), status = null) {
  const entry = (job.reviewHistory ?? []).find(attempt => attempt.number === number);
  if (!entry || entry.status !== 'running') throw new TypeError('Only a running independent review attempt may fail');
  const message = error instanceof Error ? error.message : String(error ?? '');
  status ??= /timed out|timeout/i.test(message) ? 'timed_out'
    : /malformed|invalid verdict|invalid CLI result|findings do not match/i.test(message) ? 'invalid_verdict' : 'failed';
  if (!['failed', 'timed_out', 'invalid_verdict', 'interrupted'].includes(status)) throw new TypeError('Invalid review failure status');
  // Never persist arbitrary reviewer errors, raw output, stacks, or tokens.
  // Stable categories keep diagnostics useful without copying sensitive text.
  const diagnostics = status === 'interrupted' ? 'Independent review was interrupted before a durable result was recorded.'
    : status === 'timed_out' ? 'Independent reviewer timed out.'
      : status === 'invalid_verdict' ? 'Independent reviewer returned a malformed or invalid verdict.'
        : /auth|credential|unauthorized|forbidden/i.test(message) ? 'Independent reviewer authentication failed.'
          : 'Independent review could not be completed.';
  Object.assign(entry, { status, completedAt: now(), verdict: null, findings: [], diagnostics });
  return entry;
}

// The latest completed review of the delivered head.  Only a PASS for that
// exact commit is a merge-readiness checkpoint; a NEEDS_CHANGES record keeps
// the findings that blocked it.  The caller verifies the reviewed commit
// against the delivered PR head before recording it, so state never
// represents a review of a different change.
function recordReview(job, { reviewer, verdict, commit, policy, findings, attempt }, now = () => new Date().toISOString()) {
  if (typeof reviewer !== 'string' || !reviewer.trim() || !REVIEW_VERDICTS.has(verdict)
    || typeof commit !== 'string' || !commit.trim()) {
    throw new TypeError('Independent review requires reviewer, PASS or NEEDS_CHANGES verdict, and commit');
  }
  if (!REVIEW_POLICIES.has(policy)) throw new TypeError('Independent review requires the risk or always policy that requested it');
  if (!isPlainObject(attempt) || !Number.isSafeInteger(attempt.number) || attempt.number < 1
    || attempt.number > (job.reviewAttempts ?? 0) || typeof attempt.startedAt !== 'string' || !attempt.startedAt) {
    throw new TypeError('Independent review requires attempt metadata from beginReviewAttempt');
  }
  const normalized = normalizeReviewFindings(findings);
  if ((verdict === 'PASS') !== (normalized.length === 0)) {
    throw new TypeError('A PASS review must have no findings and NEEDS_CHANGES must have findings');
  }
  const entry = (job.reviewHistory ?? []).find(value => value.number === attempt.number);
  if (entry && (entry.status !== 'running' || entry.commit !== commit || entry.policy !== policy
    || entry.startedAt !== attempt.startedAt)) throw new TypeError('Review verdict does not match its running attempt');
  job.review = {
    reviewer, verdict, commit, policy, findings: normalized,
    attempt: { number: attempt.number, startedAt: attempt.startedAt, completedAt: attempt.completedAt || now() },
  };
  if (entry) Object.assign(entry, {
    reviewer, status: 'completed', completedAt: job.review.attempt.completedAt,
    verdict, findings: normalized, diagnostics: null,
  });
  return job;
}

// Reviewer feedback has its own one-cycle budget.  It deliberately does not
// share the CI counter: a green build can still need one code-review repair.
function recordReviewCorrectiveCycle(job, { reviewCommit, reviewer, findings } = {}) {
  if ((job.reviewCorrectiveCycles ?? 0) !== 0) {
    throw new Error('Autopilot permits only one reviewer corrective cycle per issue');
  }
  if (typeof reviewCommit !== 'string' || !reviewCommit || typeof reviewer !== 'string' || !reviewer.trim()
    || typeof findings !== 'string' || !findings.trim()) {
    throw new TypeError('A reviewer corrective cycle requires the reviewed commit, reviewer identity, and findings');
  }
  job.reviewCorrectiveCycles = 1;
  job.reviewCorrection = {
    cycle: 1, status: 'eligible', reviewCommit, reviewer: reviewer.trim(),
    findings: truncate(findings), commit: null,
  };
  return job;
}

// Opens the single corrective cycle for a red CI result.  The diagnostics
// and the red head commit are captured here, before any corrective work, so
// the later Ralph pass (and any human) sees exactly what CI reported.
function recordCorrectiveCycle(job, { redCommit, diagnostics } = {}) {
  if (job.correctiveCycles !== 0) {
    throw new Error('Autopilot permits only one CI corrective cycle per issue');
  }
  job.correctiveCycles += 1;
  if (redCommit !== undefined || diagnostics !== undefined) {
    if (typeof redCommit !== 'string' || !redCommit || typeof diagnostics !== 'string' || !diagnostics) {
      throw new TypeError('A corrective cycle requires the red commit and CI diagnostics');
    }
    job.correction = {
      cycle: job.correctiveCycles,
      status: 'eligible',
      redCommit,
      diagnostics: truncate(diagnostics, MAX_CI_DIAGNOSTIC_LENGTH),
      commit: null,
    };
  }
  return job;
}

// A compact account of why Ralph stopped, suitable for a human reviewing the
// job later without access to the (already removed) worktree.
function summarizeRalphAttempt(attempt) {
  if (!isPlainObject(attempt)) return null;
  if (attempt.error) return `attempt ${attempt.number}: ${attempt.status}: ${attempt.error.message}`;
  const verification = attempt.verification || {};
  const output = String(verification.stderr || verification.stdout || '').trim();
  return `attempt ${attempt.number}: ${attempt.status}; verification exit ${String(verification.exitCode)}`
    + `${verification.timedOut ? ' (timed out)' : ''}${output ? `\n${truncate(output, 2000)}` : ''}`;
}

function createJobStore(stateDir, options = {}) {
  if (typeof stateDir !== 'string' || !stateDir.trim()) {
    throw new TypeError('Autopilot job store requires a state directory');
  }
  const directory = path.resolve(stateDir);
  const now = options.now || (() => new Date().toISOString());
  const pid = options.pid ?? process.pid;
  const bootId = options.bootId === undefined ? readBootId() : options.bootId;
  const isAlive = options.isProcessAlive || processIsAlive;

  const jobPath = issueNumber => {
    validateIssueNumber(issueNumber);
    return path.join(directory, `issue-${issueNumber}.json`);
  };
  const lockPath = issueNumber => `${jobPath(issueNumber)}.lock`;

  function readJobFile(filePath) {
    let contents;
    try {
      contents = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`Autopilot job state at ${filePath} cannot be read: ${error.message}`);
    }
    let job;
    try {
      job = JSON.parse(contents);
    } catch (error) {
      // Never treat damaged state as "no job": that would start duplicate work.
      throw new Error(`Autopilot job state at ${filePath} is malformed: ${error.message}`);
    }
    return validateJob(job, filePath);
  }

  function load(issueNumber) {
    return readJobFile(jobPath(issueNumber));
  }

  function list() {
    let entries;
    try {
      entries = fs.readdirSync(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error(`Autopilot job state directory ${directory} cannot be read: ${error.message}`);
    }
    return entries
      .filter(name => JOB_FILE.test(name))
      .map(name => readJobFile(path.join(directory, name)))
      .filter(Boolean)
      .sort((left, right) => left.issue.number - right.issue.number);
  }

  function save(job) {
    validateJob(job, jobPath(job && job.issue && job.issue.number));
    job.updatedAt = now();
    writeJsonDurably(jobPath(job.issue.number), job);
    return job;
  }

  function lockIsStale(owner) {
    if (!isPlainObject(owner) || !Number.isSafeInteger(owner.pid)) return true;
    // A lock from a previous boot cannot belong to a live process, even if
    // the same pid has since been reused.
    if (owner.bootId && bootId && owner.bootId !== bootId) return true;
    return !isAlive(owner.pid);
  }

  // Exclusive per-issue ownership prevents two autopilot processes from
  // working the same issue at once.  Locks left by a crash or reboot are
  // reclaimed once their owner is provably gone.
  function acquire(issueNumber) {
    const filePath = lockPath(issueNumber);
    fs.mkdirSync(directory, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const descriptor = fs.openSync(filePath, 'wx', 0o600);
        try {
          fs.writeFileSync(descriptor, JSON.stringify({ pid, bootId, acquiredAt: now() }));
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        let released = false;
        return {
          release() {
            if (released) return;
            released = true;
            fs.rmSync(filePath, { force: true });
          },
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw new Error(`Autopilot job lock ${filePath} cannot be created: ${error.message}`);
      }
      let owner = null;
      try {
        owner = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        owner = null;
      }
      if (!lockIsStale(owner)) {
        throw new Error(`Autopilot job for issue #${issueNumber} is already owned by running process ${owner.pid}`);
      }
      fs.rmSync(filePath, { force: true });
    }
    throw new Error(`Autopilot job lock ${filePath} could not be acquired`);
  }

  return { directory, jobPath, load, list, save, acquire, now };
}

function isResumable(job) {
  // A terminal outcome always wins over delivery metadata.  In particular, a
  // delivered PR must not accidentally make ready-for-merge or exhausted-CI
  // jobs eligible for another Ralph run.
  if (!job || job.terminal) return !job;
  // CI polling is intentionally resumable after a PR is delivered, but it
  // never re-enters Ralph's worker path (handled before workspace setup).
  const hasDeliveredPullRequest = job && job.pr && Number.isSafeInteger(job.pr.number)
    && job.delivery && typeof job.delivery.commit === 'string' && job.delivery.commit;
  return Boolean(hasDeliveredPullRequest) || job.status === 'awaiting_ci' || job.status !== 'passed';
}

// Chooses the next issue to work on.  Issues with a resumable job are
// preferred so interrupted work finishes before new work begins; issues whose
// job is terminal or already passed are never restarted.
function selectIssueForJobs(issues, jobs, choose) {
  const byIssue = new Map(jobs.map(job => [job.issue.number, job]));
  const eligible = issues.filter(issue => isResumable(byIssue.get(issue.number)));
  const resuming = eligible.filter(issue => byIssue.has(issue.number));
  const issue = choose(resuming.length > 0 ? resuming : eligible);
  return issue ? { issue, job: byIssue.get(issue.number) || null } : null;
}

module.exports = {
  ACTIVE_STATUSES,
  DEFAULT_MAX_CORRECTIVE_CYCLES,
  DEFAULT_MAX_JOB_RUNS,
  DEFAULT_STATE_ROOT,
  MAX_CI_DIAGNOSTIC_LENGTH,
  SCHEMA_VERSION,
  createJob,
  createJobStore,
  isResumable,
  markTerminal,
  recordCiState,
  recordCorrectiveCycle,
  recordDelivery,
  recordFailure,
  recordPullRequest,
  recordMerge,
  recordIssueReconciled,
  beginReviewAttempt,
  failReviewAttempt,
  normalizeReviewFindings,
  recordReview,
  recordVerification,
  hasPassingVerification,
  recordReviewSkip,
  recordReviewCorrectiveCycle,
  resolveStateDir,
  selectIssueForJobs,
  summarizeRalphAttempt,
  writeJsonDurably,
};
