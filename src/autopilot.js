'use strict';

const { loadProjectConfig } = require('./autopilot-config');
const {
  discoverReadyIssues,
  selectReadyIssue,
  observePullRequestCi,
  observePullRequest,
  mergePullRequest,
  reconcileIssueClosure,
  collectCiFailureDiagnostics,
} = require('./autopilot-github');
const { deliverPassedWork, findOpenIssuePullRequests } = require('./autopilot-delivery');
const {
  deriveBranchName,
  deriveWorktreePath,
  prepareIssueWorkspace,
  cleanupIssueWorkspace,
} = require('./autopilot-workspace');
const { readRepositoryInstructions } = require('./autopilot-instructions');
const { prepareRepositoryEnvironment } = require('./autopilot-environment');
const { createClaudeReviewAdapter } = require('./autopilot-review');
const { buildAutopilotTask, buildCorrectiveTask } = require('./autopilot-task');
const { createRalphTaskService } = require('./ralph-task-service');
const storeConfig = require('./store').config;
const {
  ACTIVE_STATUSES,
  DEFAULT_MAX_JOB_RUNS,
  createJob,
  createJobStore,
  isResumable,
  markTerminal,
  recordCorrectiveCycle,
  recordCiState,
  recordFailure,
  recordDelivery,
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
} = require('./autopilot-state');

const USAGE = 'Usage: node src/autopilot.js --project <name> [--dry-run]';

function parseArguments(argv) {
  if (!Array.isArray(argv) || (argv.length !== 2 && argv.length !== 3) || argv[0] !== '--project'
    || typeof argv[1] !== 'string' || !argv[1].trim() || (argv.length === 3 && argv[2] !== '--dry-run')) {
    throw new Error(USAGE);
  }
  return { projectName: argv[1], dryRun: argv[2] === '--dry-run' };
}

// Ralph's deterministic verification is the only authority on success.  The
// task loop reports either `passed` or `needs_planning`; anything else is a
// contract violation and must never be treated as deliverable.
function classifyRalphResult(result) {
  const status = result && result.status;
  if (status === 'passed') return { status, terminal: false, deliverable: true };
  if (status === 'needs_planning') return { status, terminal: true, deliverable: false };
  throw new Error(`Autopilot received an unexpected Ralph result status: ${String(status)}`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// Terminal hand-off for a CI failure the single corrective cycle could not fix.
const READY_FOR_HUMAN = 'ready_for_human';
// One initial review and one review of the bounded correction, including
// interrupted invocations. This budget is never reset for a new commit.
const MAX_REVIEW_ATTEMPTS = 2;
const realReviewAdapter = createClaudeReviewAdapter();

// A verified-but-undelivered change and an already pushed branch are both work
// that workspace cleanup must never delete.
function shouldPreserveBranch(job) {
  return Boolean(job && ((job.ralph && job.ralph.status === 'passed') || (job.delivery && job.delivery.pushed)));
}

function handToHuman(job, phase, message, now) {
  recordFailure(job, phase, message, now);
  job.status = READY_FOR_HUMAN;
  markTerminal(job, READY_FOR_HUMAN);
  if (job.correction && job.correction.status !== 'delivered') job.correction.status = 'failed';
  // Reviewer corrections are an independent bounded operation, but they
  // share the same terminal hand-off.  Do not leave one marked running after
  // deciding that a human must take over: that misleading checkpoint could
  // otherwise make crash recovery look like an in-flight worker.
  if (job.reviewCorrection && job.reviewCorrection.status !== 'delivered') job.reviewCorrection.status = 'failed';
  return job;
}

// The review adapter is intentionally a dependency of the public one-shot
// runner.  This keeps the scheduler independent from a particular reviewer
// implementation and lets a project explicitly opt into the gate.
function hasNoFindings(findings) {
  return findings === undefined || findings === '' || (Array.isArray(findings) && findings.length === 0);
}

function matchingPass(review, commit) {
  if (!review || typeof review !== 'object' || Array.isArray(review)
    || typeof review.reviewer !== 'string' || !review.reviewer.trim()
    || review.verdict !== 'PASS' || review.commit !== commit
    // Injected adapters are untrusted too: a PASS cannot smuggle unresolved
    // findings past the one-shot merge-readiness gate.
    || !hasNoFindings(review.findings)) return null;
  return { reviewer: review.reviewer, verdict: 'PASS', commit, findings: [] };
}

function matchingNeedsChanges(review, commit) {
  if (!review || typeof review !== 'object' || Array.isArray(review)
    || typeof review.reviewer !== 'string' || !review.reviewer.trim()
    || review.verdict !== 'NEEDS_CHANGES' || review.commit !== commit) return null;
  let findings;
  try { findings = normalizeReviewFindings(typeof review.findings === 'string' ? review.findings.trim() : review.findings); } catch { return null; }
  if (findings.length === 0) return null;
  return { reviewer: review.reviewer.trim(), verdict: 'NEEDS_CHANGES', commit, findings };
}

// The corrective worker and the human hand-off read findings as prose.
function findingsText(findings) {
  if (findings.length === 1 && !findings[0].file && !findings[0].severity) return findings[0].summary;
  return findings.map(finding => {
    const location = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ''})` : '';
    return `- ${finding.severity ? `[${finding.severity}] ` : ''}${finding.summary}${location}`;
  }).join('\n');
}

// The recorded path is provisional until preparation reports the real one, so
// an injected workspace preparer need not rely on worktreeRoot being set.
function plannedWorktreePath(project, issue) {
  return typeof project.worktreeRoot === 'string' && project.worktreeRoot.trim()
    && typeof project.checkout === 'string' && project.checkout.trim()
    && typeof project.baseBranch === 'string' && project.baseBranch.trim()
    ? deriveWorktreePath(project, issue)
    : null;
}

// Removes the recorded issue worktree (and with it the repo-local .venv) of
// every terminal job whose prepared workspace was left behind, e.g. by a crash
// or failed cleanup after reaching a terminal state.  Only the job's own
// recorded path and branch are handed to cleanup, which refuses the main
// checkout and any worktree not on this issue's ralph branch.  A job whose
// lock is held by a live process is skipped so running Ralph work is never
// touched.
async function cleanupTerminalWorkspaces(project, store, cleanupWorkspace, write, captureFailedWork) {
  const cleaned = [];
  for (const listed of store.list()) {
    if (!listed.terminal || listed.workspaceState !== 'prepared' || !listed.worktreePath) continue;
    let lock;
    try {
      lock = store.acquire(listed.issue.number);
    } catch (error) {
      write(`Autopilot: skipped workspace cleanup for issue #${listed.issue.number}: ${errorMessage(error)}`);
      continue;
    }
    try {
      const job = store.load(listed.issue.number);
      if (!job || !job.terminal || job.workspaceState !== 'prepared' || !job.worktreePath) continue;
      try {
        if (typeof captureFailedWork === 'function') {
          await captureFailedWork({ job, workspace: { worktreePath: job.worktreePath, branch: job.branch }, store });
        }
        await cleanupWorkspace(project, { worktreePath: job.worktreePath, branch: job.branch }, {
          preserveBranch: shouldPreserveBranch(job),
        });
        job.workspaceState = 'removed';
        cleaned.push(job.issue.number);
      } catch (error) {
        recordFailure(job, 'cleanup', error, store.now);
        write(`Autopilot: unable to clean workspace for issue #${job.issue.number}: ${errorMessage(error)}`);
      }
      store.save(job);
    } finally {
      lock.release();
    }
  }
  return cleaned;
}

async function run(argv, dependencies = {}) {
  const { projectName, dryRun } = parseArguments(argv);
  const loadConfig = dependencies.loadProjectConfig || loadProjectConfig;
  const discover = dependencies.discoverReadyIssues || discoverReadyIssues;
  const choose = dependencies.selectReadyIssue || selectReadyIssue;
  const write = dependencies.write || (line => process.stdout.write(`${line}\n`));
  const project = loadConfig(projectName);
  const store = dependencies.jobStore
    || createJobStore(resolveStateDir(projectName, project, dependencies.stateRoot));
  const cleanupWorkspace = dependencies.cleanupIssueWorkspace || cleanupIssueWorkspace;
  // A scheduled pass over a disabled project is a successful no-op: nothing is
  // discovered, locked, prepared, or cleaned.
  if (!dryRun && !project.enabled) {
    write(`Autopilot: project ${projectName} is disabled; nothing to do.`);
    return null;
  }
  if (!dryRun) await cleanupTerminalWorkspaces(project, store, cleanupWorkspace, write, dependencies.captureFailedWork);
  const selection = selectIssueForJobs(await discover(project), store.list(), choose);

  if (!selection) {
    const prefix = dryRun ? 'Dry run' : 'Autopilot';
    write(`${prefix}: no ${project.readyLabel} issue found for project ${projectName} in ${project.repo}.`);
    return null;
  }
  const candidate = selection.issue;

  if (dryRun) {
    const resume = selection.job ? `; resumes existing job (status ${selection.job.status})` : '';
    write(`Dry run: project ${projectName}; repository ${project.repo}; issue #${candidate.number}: ${candidate.title}; worker ${project.worker}${resume}; action is dry-run only.`);
    return candidate;
  }

  const prepareWorkspace = dependencies.prepareIssueWorkspace || prepareIssueWorkspace;
  const discoverInstructions = dependencies.readRepositoryInstructions || readRepositoryInstructions;
  const prepareEnvironment = dependencies.prepareRepositoryEnvironment || prepareRepositoryEnvironment;
  const buildTask = dependencies.buildAutopilotTask || buildAutopilotTask;
  const createService = dependencies.createRalphTaskService || createRalphTaskService;
  const maxJobRuns = dependencies.maxJobRuns ?? DEFAULT_MAX_JOB_RUNS;

  // The final GitHub identity read is deliberately separate from CI and
  // review.  Both may be true for an old head if the PR was force-pushed or
  // retargeted afterwards, so the merge path always reads the PR immediately
  // before deciding whether to merge or recover a prior merge.
  const finishApprovedMerge = async () => {
    if (!project.autoMerge) {
      job.status = 'ready_for_human_merge';
      markTerminal(job, 'ready_for_human_merge');
      return;
    }
    // Every GitHub call below is merge-phase work, so a transient failure of
    // the first observation is retried (boundedly) rather than treated as a
    // review or worker failure.
    phase = 'merge';
    if (!job.pr || !job.delivery || !job.delivery.commit || !matchingPass(job.review, job.delivery.commit)
      || !Array.isArray(job.review.findings) || job.review.findings.length !== 0
      || !job.review.reviewer.startsWith('claude:')) {
      // Fail closed with durable evidence; throwing here would leave the job
      // awaiting CI and re-enter this gate on every later pass.
      handToHuman(job, 'merge', `Autopilot merge for issue #${candidate.number} requires an exact independent Claude PASS with no findings.`, store.now);
      return;
    }
    const observePr = dependencies.observePullRequest || observePullRequest;
    const remote = await observePr(project, job.pr.number, { execFile: dependencies.execFile });
    const expectedBase = project.baseBranch;
    if (!remote || remote.number !== job.pr.number || remote.headRefName !== job.branch
      || remote.headRefOid !== job.delivery.commit || remote.baseRefName !== expectedBase) {
      handToHuman(job, 'merge', `GitHub PR identity changed or is ambiguous for PR #${job.pr.number}; expected ${job.branch} at ${job.delivery.commit} into ${expectedBase}.`, store.now);
      return;
    }
    const recoverMerged = remoteObservation => {
      const recoveredMerge = remoteObservation.mergeCommit;
      if (!recoveredMerge) {
        handToHuman(job, 'merge', `GitHub reports PR #${job.pr.number} merged without a merge commit SHA; refusing to infer success.`, store.now);
        return false;
      }
      if (job.merge && (job.merge.prNumber !== job.pr.number || job.merge.approvedHead !== job.delivery.commit
        || job.merge.repo !== project.repo || job.merge.commit !== recoveredMerge)) {
        handToHuman(job, 'merge', `Recorded merge evidence for PR #${job.pr.number} does not match GitHub's recovered merge.`, store.now);
        return false;
      }
      if (!job.merge) {
        recordMerge(job, { prNumber: job.pr.number, approvedHead: job.delivery.commit, commit: recoveredMerge, repo: project.repo }, store.now);
        store.save(job);
      }
      return true;
    };
    if (remote.state === 'MERGED') {
      if (!recoverMerged(remote)) return;
    } else if (remote.state === 'OPEN') {
      phase = 'merge';
      const merge = dependencies.mergePullRequest || mergePullRequest;
      let result;
      try {
        result = await merge(project, { number: job.pr.number, headCommit: job.delivery.commit }, { execFile: dependencies.execFile });
      } catch (error) {
        if (error && error.code === 'AUTOPILOT_MERGE_UNCONFIRMED') {
          const observedAfterMerge = await observePr(project, job.pr.number, { execFile: dependencies.execFile });
          if (observedAfterMerge && observedAfterMerge.number === job.pr.number
            && observedAfterMerge.headRefName === job.branch && observedAfterMerge.headRefOid === job.delivery.commit
            && observedAfterMerge.baseRefName === expectedBase && observedAfterMerge.state === 'MERGED'
            && recoverMerged(observedAfterMerge)) {
            result = null;
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
      if (job.terminal) return;
      if (!result && job.merge) {
        // The uncertain PUT was reconciled by a fresh MERGED observation.
      } else if (!result || typeof result.mergeCommit !== 'string' || !result.mergeCommit) {
        const error = new Error(`GitHub merge for PR #${job.pr.number} returned no confirmed merge commit`);
        error.code = 'AUTOPILOT_MERGE_UNCONFIRMED';
        throw error;
      } else recordMerge(job, { prNumber: job.pr.number, approvedHead: job.delivery.commit, commit: result.mergeCommit, repo: project.repo }, store.now);
      // This is the intentional crash checkpoint: a later pass observes the
      // remote MERGED state and will not submit another merge request.
      store.save(job);
    } else {
      handToHuman(job, 'merge', `GitHub PR #${job.pr.number} is ${remote.state}, not open or a valid recovered merge.`, store.now);
      return;
    }
    phase = 'merge';
    const closeIssue = dependencies.reconcileIssueClosure || reconcileIssueClosure;
    await closeIssue(project, candidate.number, { execFile: dependencies.execFile });
    recordIssueReconciled(job);
    job.status = 'merged';
    markTerminal(job, 'merged');
  };

  const lock = store.acquire(candidate.number);
  let job;
  let workspace;
  let phase = 'reconcile';
  try {
    // Re-read under the lock: the selection-time snapshot may be stale.
    job = store.load(candidate.number);
    if (job && !isResumable(job)) {
      const existing = job;
      job = undefined;
      throw new Error(`Autopilot job for issue #${candidate.number} is already ${existing.terminalState || existing.status}`);
    }
    const previousReview = job && job.reviewHistory && job.reviewHistory.at(-1);
    if (previousReview && previousReview.status !== 'completed') {
      // The issue lock is ours now: a running attempt belonged to a dead
      // supervisor. Preserve its original identity rather than replaying it.
      if (previousReview.status === 'running') failReviewAttempt(job, previousReview.number, null, store.now, 'interrupted');
      handToHuman(job, 'review', previousReview.diagnostics, store.now);
      store.save(job);
      write(`Autopilot: project ${projectName}; issue #${candidate.number}; status ${job.terminalState}; autonomous execution stopped.`);
      return { issue: candidate, workspace: null, result: null, outcome: { status: job.terminalState, terminal: true, deliverable: false }, job };
    }
    // Before a new job allocates anything, leave an explicitly-closing PR
    // entirely to its existing owner. Recovered Ralph jobs deliberately skip
    // this guard so their established recovery path remains unchanged.
    if (!job) {
      job = createJob({
        projectName,
        repo: project.repo,
        issue: candidate,
        branch: deriveBranchName(candidate),
        worktreePath: plannedWorktreePath(project, candidate),
        now: store.now,
      });
      const findExistingPullRequests = dependencies.findOpenIssuePullRequests || findOpenIssuePullRequests;
      let existingPullRequests;
      try {
        existingPullRequests = await findExistingPullRequests(project, candidate, project.checkout, dependencies.execFile);
      } catch (error) {
        handToHuman(job, 'existing-pr-lookup', `Could not safely check for open PRs that close issue #${candidate.number}: ${errorMessage(error)}`, store.now);
        store.save(job);
        write(`Autopilot: project ${projectName}; issue #${candidate.number}; status ${job.terminalState}; autonomous execution stopped.`);
        return { issue: candidate, workspace: null, result: null, outcome: { status: job.terminalState, terminal: true, deliverable: false }, job };
      }
      if (existingPullRequests.length > 0) {
        const numbers = existingPullRequests.map(pr => `#${pr.number}`).join(', ');
        handToHuman(job, 'existing-pr', `Open PR${existingPullRequests.length === 1 ? '' : 's'} ${numbers} explicitly close${existingPullRequests.length === 1 ? 's' : ''} issue #${candidate.number}; leaving ${existingPullRequests.length === 1 ? 'it' : 'them'} unchanged for a human.`, store.now);
        store.save(job);
        write(`Autopilot: project ${projectName}; issue #${candidate.number}; status ${job.terminalState}; autonomous execution stopped.`);
        return { issue: candidate, workspace: null, result: null, outcome: { status: job.terminalState, terminal: true, deliverable: false }, job };
      }
    }
    // A successfully delivered PR is observed before any worktree, dependency,
    // or Ralph work is started. This makes polling safe to invoke repeatedly.
    if (job && (job.status === 'awaiting_ci' || (job.status === 'passed' && job.pr && job.delivery && job.delivery.commit))) {
      if (!job.pr || !job.delivery || !job.delivery.commit) {
        throw new Error(`Autopilot job for issue #${candidate.number} awaits CI without a persisted pull request and head commit`);
      }
      phase = 'ci';
      const observeCi = dependencies.observePullRequestCi || observePullRequestCi;
      const observation = await observeCi(project, {
        number: job.pr.number,
        commit: job.delivery.commit,
      }, { execFile: dependencies.execFile });
      if ((observation.headCommit !== undefined && observation.headCommit !== job.delivery.commit)
        || (observation.prNumber !== undefined && observation.prNumber !== job.pr.number)) {
        throw new Error(`Autopilot CI observation for issue #${candidate.number} does not match PR #${job.pr.number} at ${job.delivery.commit}`);
      }
      recordCiState(job, observation);
      if (observation.state === 'green') {
        if (project.reviewPolicy === 'always' || project.reviewPolicy === 'risk') {
          // Recover the durable PASS checkpoint before spending any budget.
          // A review of another delivered SHA can never approve this head.
          if (!hasPassingVerification(job.verification, job.delivery.commit)) {
            handToHuman(job, 'review', 'Independent review requires passing deterministic verification evidence for the exact delivered commit.', store.now);
          } else if (matchingPass(job.review, job.delivery.commit)) {
            await finishApprovedMerge();
          } else if ((job.reviewAttempts ?? 0) >= MAX_REVIEW_ATTEMPTS) {
            handToHuman(job, 'review', `Independent review attempt limit (${MAX_REVIEW_ATTEMPTS}) reached; no further automatic review will run.`, store.now);
          } else {
            // Keep the original injection names working for embedders while the
            // production default is the concrete, read-only Claude adapter.
            const reviewPullRequest = dependencies.reviewPullRequest
              || dependencies.independentReview || dependencies.independentReviewer
              || realReviewAdapter;
            const model = reviewPullRequest.model || project.reviewModel || 'sonnet';
            const reviewer = reviewPullRequest.reviewer === 'claude' || reviewPullRequest === realReviewAdapter
              ? `claude:${model}` : reviewPullRequest.reviewer || 'independent-review-adapter';
            const attempt = beginReviewAttempt(job, store.now, { reviewer, model, policy: project.reviewPolicy, commit: job.delivery.commit });
            // Consume the attempt number durably before the paid reviewer runs.
            store.save(job);
            let review;
            try {
              review = typeof reviewPullRequest === 'function'
                ? await reviewPullRequest({
                  project,
                  issue: candidate,
                  pullRequest: { ...job.pr, headCommit: job.delivery.commit },
                  headCommit: job.delivery.commit,
                  verification: job.verification,
                  ci: job.ci,
                })
                : null;
            } catch (error) {
              const failed = failReviewAttempt(job, attempt.number, error, store.now);
              store.save(job);
              handToHuman(job, 'review', failed.diagnostics, store.now);
            }
            const pass = matchingPass(review, job.delivery.commit);
            const needsChanges = matchingNeedsChanges(review, job.delivery.commit);
            if (!job.terminal && pass) {
              // This write is intentionally separate from the terminal state:
              // an on-disk PASS must exist before the PR becomes merge-ready.
              recordReview(job, { ...pass, policy: project.reviewPolicy, attempt }, store.now);
              store.save(job);
              await finishApprovedMerge();
            } else if (!job.terminal && needsChanges) {
              // Feedback is checkpointed now, but the worker is deliberately
              // deferred to the next timer pass so review observation remains
              // side-effect free and restart-safe.
              recordReview(job, { ...needsChanges, policy: project.reviewPolicy, attempt }, store.now);
              const findings = findingsText(job.review.findings);
              if ((job.reviewCorrectiveCycles ?? 0) === 0) {
                recordReviewCorrectiveCycle(job, {
                  reviewCommit: needsChanges.commit, reviewer: needsChanges.reviewer, findings,
                });
                job.status = 'review_correction_eligible';
                job.ralph = { status: null, attempts: 0, taskId: null };
              } else {
                handToHuman(job, 'review', `Independent review still blocks after ${job.reviewCorrectiveCycles} reviewer corrective cycle(s); no further automatic correction will run.\nReviewer: ${needsChanges.reviewer}\nFindings:\n${findings}`, store.now);
              }
            } else if (!job.terminal) {
              const failed = failReviewAttempt(job, attempt.number, null, store.now, 'invalid_verdict');
              store.save(job);
              handToHuman(job, 'review', failed.diagnostics, store.now);
            }
          }
        } else {
          if (!job.reviewSkip || job.reviewSkip.commit !== job.delivery.commit) {
            try {
              recordReviewSkip(job, { commit: job.delivery.commit, reason: project.reviewSkipReason }, store.now);
            } catch (error) {
              handToHuman(job, 'review', errorMessage(error), store.now);
            }
          }
          if (!job.terminal) {
            // Persist the SHA-bound exception before the terminal transition.
            store.save(job);
            job.status = 'ready_for_human_merge';
            markTerminal(job, 'ready_for_human_merge');
          }
        }
      } else if (observation.state === 'red') {
        // Never launch a worker from the observation pass.  The failed run's
        // jobs and logs are captured and persisted first; a red result is
        // then eligible for one later correction pass, after which it is
        // terminal so a permanently red check cannot loop.  Workflows are
        // never re-run here: only a new commit can produce a new CI result.
        const collectDiagnostics = dependencies.collectCiFailureDiagnostics || collectCiFailureDiagnostics;
        const diagnostics = String(await collectDiagnostics(project, observation, { execFile: dependencies.execFile }) || '').trim()
          || `CI red for ${job.delivery.commit}: ${observation.details || 'no details'}`;
        recordCiState(job, { ...observation, diagnostics });
        // This is deliberately an equality check rather than a configurable
        // retry budget: a CI failure gets one, and only one, corrective task.
        if (job.correctiveCycles === 0) {
          recordCorrectiveCycle(job, { redCommit: job.delivery.commit, diagnostics });
          job.status = 'correction_eligible';
          job.ralph = { status: null, attempts: 0, taskId: null };
        } else {
          handToHuman(job, 'ci', `CI is red after ${job.correctiveCycles} corrective cycle(s); `
            + `no further automatic correction will run.\n${diagnostics}`, store.now);
        }
      }
      store.save(job);
      write(`Autopilot: project ${projectName}; issue #${candidate.number}; CI ${observation.state}.`);
      return { issue: candidate, workspace: null, result: null, outcome: { status: observation.state }, job };
    }
    if (job && ACTIVE_STATUSES.has(job.status)) {
      // The previous owner died mid-run (crash or reboot); its lock was
      // reclaimed above.  Record the interruption for later diagnosis.
      recordFailure(job, job.status, `Run ${job.runs} was interrupted before completion`, store.now);
      job.status = 'interrupted';
      if (job.ralph && job.ralph.status === 'running') job.ralph.status = 'interrupted';
      store.save(job);
    }
    // The one corrective cycle has been spent once Ralph has started on it;
    // an interrupted correction is never started a second time.
    const correctionSpent = job && ((job.correction && job.correction.status === 'running')
      || (job.reviewCorrection && job.reviewCorrection.status === 'running'));
    const legacyCorrection = job && job.status === 'correction_eligible' && !job.correction;
    if (correctionSpent || legacyCorrection) {
      handToHuman(job, 'correction', correctionSpent
        ? 'The corrective cycle was interrupted after Ralph started; it is not retried automatically.'
        : `CI was red but no diagnostics were persisted for a corrective cycle.${job.ci && job.ci.details ? `\n${job.ci.details}` : ''}`,
      store.now);
    }
    if (job && job.workspaceState !== 'removed' && job.worktreePath) {
      // Clear whatever an interrupted or failed run left behind so this
      // issue's workspace can be prepared afresh instead of duplicated.
      await cleanupWorkspace(project, { worktreePath: job.worktreePath, branch: job.branch }, {
        preserveBranch: shouldPreserveBranch(job),
      });
      job.workspaceState = 'removed';
      store.save(job);
    }
    if (job && job.terminal) {
      store.save(job);
      write(`Autopilot: project ${projectName}; issue #${candidate.number}; status ${job.terminalState}; autonomous execution stopped.`);
      return { issue: candidate, workspace: null, result: null, outcome: { status: job.terminalState, terminal: true, deliverable: false }, job };
    }
    const ciCorrection = job && job.correction && ['eligible', 'passed'].includes(job.correction.status) ? job.correction : null;
    const savedReviewCorrection = job && job.reviewCorrection && ['eligible', 'passed'].includes(job.reviewCorrection.status) ? job.reviewCorrection : null;
    const correction = ciCorrection || savedReviewCorrection;
    const reviewCorrection = Boolean(savedReviewCorrection && correction === savedReviewCorrection);
    phase = 'preparing';
    job.issue.title = candidate.title;
    job.runs += 1;
    job.status = 'preparing';
    store.save(job);
    // A verified correction whose delivery was interrupted resumes from its
    // checkpointed corrective commit, whether interruption happened before
    // or after push.  The delivery checkpoint records the local commit before
    // push, and cleanup preserves this branch because Ralph already passed.
    // Resetting to the red head here would discard that verified correction
    // and make a safe delivery retry impossible.
    const correctionHead = correction && correction.status === 'passed' && job.delivery
      && job.delivery.commit ? job.delivery.commit : correction && (reviewCorrection ? correction.reviewCommit : correction.redCommit);
    workspace = await prepareWorkspace(project, candidate, {
      branch: job.branch,
      ...(correction ? { headCommit: correctionHead } : {}),
    });
    job.branch = workspace.branch;
    job.worktreePath = workspace.worktreePath;
    job.baseRef = workspace.baseRef ?? null;
    job.workspaceState = 'prepared';
    store.save(job);

    let result = null;
    let outcome;
    if (job.ralph && job.ralph.status === 'passed') {
      outcome = { status: 'passed', terminal: false, deliverable: true };
    } else {
      const instructions = await discoverInstructions(workspace.worktreePath);
      await prepareEnvironment(workspace.worktreePath, project, { instructions });
      const task = correction
        ? (dependencies.buildCorrectiveTask || buildCorrectiveTask)(project, candidate, instructions, reviewCorrection ? { ...correction, kind: 'review' } : correction)
        : buildTask(project, candidate, instructions);
      const service = createService({ config: storeConfig, ...dependencies.ralphOptions,
        recordBaseline: sha => {
          if (!job.ralph.baselineSha) { job.ralph.baselineSha = sha; store.save(job); }
          return job.ralph.baselineSha;
        },
      });
      phase = 'running';
      job.status = 'running';
      job.ralph = { status: 'running', attempts: 0, taskId: task && task.id ? task.id : null,
        ...(job.ralph?.baselineSha ? { baselineSha: job.ralph.baselineSha } : {}) };
      job.verification = null;
      if (correction) correction.status = 'running';
      store.save(job);
      result = await service.run(workspace.worktreePath, task);
      const attempts = result && Array.isArray(result.attempts) ? result.attempts : [];
      job.ralph = { ...job.ralph, status: result ? result.status ?? null : null, attempts: attempts.length,
        ...(result?.childLoopId ? { childLoopId: result.childLoopId } : {}) };
      outcome = classifyRalphResult(result);
      const lastAttempt = attempts[attempts.length - 1];
      if (outcome.deliverable && lastAttempt && lastAttempt.status === 'passed' && lastAttempt.verification) {
        recordVerification(job, result.task ? result.task.verification : task.verification, lastAttempt.verification);
      } else if (lastAttempt && lastAttempt.status === 'failed' && lastAttempt.verification
        && typeof lastAttempt.verification.passed === 'boolean'
        && (typeof lastAttempt.verification.exitCode === 'number' || lastAttempt.verification.exitCode === null)
        && typeof lastAttempt.verification.timedOut === 'boolean'
        && typeof lastAttempt.verification.stdout === 'string'
        && typeof lastAttempt.verification.stderr === 'string') {
        // A complete failed verifier result is durable evidence too. This
        // lets R1 report its fixed, sanitized verdict without copying output.
        recordVerification(job, result.task ? result.task.verification : task.verification, lastAttempt.verification);
      }
      // `passed` is terminal to the scheduler.  Persisting it before the
      // delivery side effects would create a crash window in which a verified
      // change is never pushed. Keep the job resumable through commit/push.
      job.status = outcome.deliverable ? 'delivering' : outcome.status;
      if (correction && outcome.deliverable) correction.status = 'passed';
      if (outcome.terminal) {
        const diagnostic = summarizeRalphAttempt(attempts[attempts.length - 1]);
        if (correction) {
          // The single corrective cycle could not pass local verification.
          const label = reviewCorrection ? 'Reviewer corrective cycle' : 'CI corrective cycle';
          const diagnostics = reviewCorrection ? `Reviewer: ${correction.reviewer}\nFindings:\n${correction.findings}` : `CI diagnostics:\n${correction.diagnostics}`;
          handToHuman(job, 'correction', `${label} ended with Ralph status ${outcome.status}`
            + `${diagnostic ? `\n${diagnostic}` : ''}\n${diagnostics}`, store.now);
          outcome = { ...outcome, status: READY_FOR_HUMAN };
        } else {
          markTerminal(job, outcome.status);
          if (diagnostic) recordFailure(job, 'ralph', diagnostic, store.now);
        }
      }
      store.save(job);
    }

    if (outcome.deliverable) {
      phase = 'delivery';
      job.status = 'delivering';
      store.save(job);
      const deliver = dependencies.deliverPassedWork || deliverPassedWork;
      const checkpointDelivery = async progress => {
        // Persist each completed Git boundary so a crash after a successful
        // push still records this branch and commit for a safe resume.
        recordDelivery(job, progress);
        if (progress.pr) recordPullRequest(job, progress.pr);
        store.save(job);
      };
      const delivery = await deliver(
        {
          project,
          issue: candidate,
          workspace,
          ralphStatus: job.ralph && job.ralph.status,
          // A correction is pushed to the same branch only as a new commit.
          ...(correction ? {
            previousCommit: reviewCorrection ? correction.reviewCommit : correction.redCommit,
            commitMessage: reviewCorrection ? `ralph: address review for #${candidate.number}` : `ralph: fix CI for #${candidate.number}`,
          } : {}),
        },
        { onProgress: checkpointDelivery },
      );
      recordDelivery(job, delivery);
      // Commit/push is the delivery contract.  PR reconciliation is optional
      // metadata so a git-only delivery adapter can still finish a passed job.
      if (delivery.pr) recordPullRequest(job, delivery.pr);
      if (correction) {
        const previousCommit = reviewCorrection ? correction.reviewCommit : correction.redCommit;
        if (job.delivery.commit === previousCommit) {
          const error = new Error(`Autopilot delivery refused: correction produced no change from ${previousCommit}`);
          error.code = 'AUTOPILOT_NO_CHANGES';
          throw error;
        }
        correction.status = 'delivered';
        correction.commit = job.delivery.commit;
        if (job.pr) {
          recordCiState(job, {
            state: 'pending',
            details: `Awaiting CI for corrective commit ${job.delivery.commit}.`,
            prNumber: job.pr.number,
            headCommit: job.delivery.commit,
          });
        }
      }
      // The PR and exact pushed head are now durable. CI is checked only on a
      // later scheduler invocation, before any worker can be launched again.
      // A git-only delivery adapter has no PR to observe and retains the
      // original completed-delivery state.
      if (job.pr) {
        job.status = 'awaiting_ci';
      } else {
        job.status = 'passed';
        markTerminal(job, 'passed');
      }
      store.save(job);
    }

    const stopped = outcome.terminal ? '; autonomous execution stopped before delivery' : '';
    write(`Autopilot: project ${projectName}; issue #${candidate.number}; status ${outcome.status}${stopped}.`);
    return { issue: candidate, workspace, result, outcome, job };
  } catch (error) {
    if (job) {
      try {
        recordFailure(job, phase, error, store.now);
        if (job.ralph && job.ralph.status === 'running') job.ralph.status = 'error';
        if (phase === 'merge' && error && (error.code === 'AUTOPILOT_MERGE_UNCONFIRMED' || error.code === 'AUTOPILOT_MERGE_REJECTED')) {
          handToHuman(job, 'merge', errorMessage(error), store.now);
        } else if (phase === 'merge' && job.failures.filter(failure => failure.phase === 'merge').length >= 2) {
          // A transport failure is retryable once because GitHub may not have
          // received the request.  It is nevertheless bounded: a broken
          // credential or permanently unavailable endpoint must not spin a
          // scheduled job forever.
          handToHuman(job, 'merge', `Merge retry limit reached: ${errorMessage(error)}`, store.now);
        } else if (phase === 'ci' || phase === 'merge') {
          // An observation failure (gh outage, mismatched head) says nothing
          // about the delivered work; keep polling and never restart Ralph.
          job.status = 'awaiting_ci';
        } else if (((job.correction && job.correction.status !== 'delivered')
          || (job.reviewCorrection && job.reviewCorrection.status !== 'delivered'))
          && (error.code === 'AUTOPILOT_NO_CHANGES' || job.runs >= maxJobRuns)) {
          // A correction that changes nothing (or keeps failing outside
          // Ralph) is handed to a human instead of being pushed or retried.
          const activeCorrection = job.reviewCorrection && job.reviewCorrection.status !== 'delivered'
            ? job.reviewCorrection : job.correction;
          const diagnostics = activeCorrection && activeCorrection.findings
            ? `Reviewer: ${activeCorrection.reviewer}\nFindings:\n${activeCorrection.findings}`
            : `CI diagnostics:\n${activeCorrection && activeCorrection.diagnostics}`;
          handToHuman(job, 'correction', `Corrective cycle could not be delivered: ${errorMessage(error)}\n${diagnostics}`, store.now);
        } else {
          job.status = 'failed';
          // Bound automatic retries of a job that keeps failing outside Ralph.
          if (job.runs >= maxJobRuns) markTerminal(job, 'failed');
        }
        store.save(job);
      } catch (stateError) {
        write(`Autopilot: unable to record failure for issue #${candidate.number}: ${errorMessage(stateError)}`);
      }
    }
    throw error;
  } finally {
    try {
      if (workspace) {
        try {
          if (typeof dependencies.captureFailedWork === 'function') {
            await dependencies.captureFailedWork({ job, workspace, store });
          }
          await cleanupWorkspace(project, workspace, { preserveBranch: shouldPreserveBranch(job) });
          if (job) job.workspaceState = 'removed';
        } catch (error) {
          if (job) recordFailure(job, 'cleanup', error, store.now);
          throw error;
        } finally {
          if (job) {
            try {
              store.save(job);
            } catch (stateError) {
              write(`Autopilot: unable to record cleanup for issue #${candidate.number}: ${errorMessage(stateError)}`);
            }
          }
        }
      }
    } finally {
      lock.release();
    }
  }
}

async function main(argv = process.argv.slice(2), dependencies) {
  try {
    await run(argv, dependencies);
    return 0;
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n${USAGE}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then(exitCode => { process.exitCode = exitCode; });
}

module.exports = { USAGE, parseArguments, classifyRalphResult, cleanupTerminalWorkspaces, run, main };
