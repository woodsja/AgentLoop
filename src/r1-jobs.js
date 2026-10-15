// R1 phases run under the existing queue dispatcher, not a second scheduler.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { run } = require('./autopilot');
const { loadProjectConfig } = require('./autopilot-config');
const { discoverReadyIssues, selectReadyIssue } = require('./autopilot-github');
const { deriveWorktreePath, cleanupIssueWorkspace } = require('./autopilot-workspace');
const { createClaudeReviewAdapter } = require('./autopilot-review');
const { createJobStore, resolveStateDir, hasPassingVerification, selectIssueForJobs, recordFailure, markTerminal } = require('./autopilot-state');
const { managesWorktree, resolveProject } = require('./project-registry');
const { createR1ChildHandoff } = require('./r1-child-handoff');
const { authorizeR1Child } = require('./r1-child-admission');

function safeText(value, limit = 1000) {
  return String(value ?? '').replace(/\b(?:Bearer\s+\S+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+)/gi, '[redacted]')
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s"']+[\\/])*[^\s"']+/g, '[path]').slice(0, limit);
}

// Continuous runner limits. CI is watched with a bounded poll instead of a
// scheduler pass; admission looks for the next ready issue at most once a
// minute and only while no R1 job is queued or running.
const CI_POLL_MS = 30 * 1000;
const CI_TIMEOUT_MS = 60 * 60 * 1000;
const ADMIT_INTERVAL_MS = 60 * 1000;
const MIN_SPECIFICATION_LENGTH = 40;
const TEMPORARY_BRANCH = /^ralph\/issue-\d+-[A-Za-z0-9._-]+$/;
const MAX_TRANSCRIPT_LINE = 512;

// Projects that opted into autonomous merging are driven to exactly one of
// merged, needs_specification, or failed. Every other project keeps the
// original passed/blocked hand-off.
function autonomous(project) {
  return Boolean(project && project.enabled && project.autoMerge === true && project.worker === 'codex'
    && ['always', 'risk'].includes(project.reviewPolicy));
}

const digest = issue => crypto.createHash('sha256').update(String((issue && issue.body) || '')).digest('hex');

function hasSpecification(issue) {
  return Boolean(issue) && String(issue.body || '').replace(/\s+/g, '').length >= MIN_SPECIFICATION_LENGTH;
}

function approvedMerge(job) {
  return Boolean(job && job.terminalState === 'merged' && job.merge && job.delivery
    && job.merge.approvedHead === job.delivery.commit && job.review && job.review.verdict === 'PASS'
    && job.review.commit === job.delivery.commit && Array.isArray(job.review.findings) && job.review.findings.length === 0
    && hasPassingVerification(job.verification, job.delivery.commit));
}

function evidence(job) {
  const review = value => value && ({
    reviewer: safeText(value.reviewer), verdict: value.verdict, commit: value.commit, policy: value.policy,
    findings: (value.findings || []).map(finding => ({ ...finding, summary: safeText(finding.summary), file: safeText(finding.file) || null })),
    ...(value.attempt ? { attempt: value.attempt } : {}),
  });
  return job && {
    outcome: job.terminalState || job.status,
    commit: job.delivery && job.delivery.commit,
    verification: job.verification && { ...job.verification, command: safeText(job.verification.command, 4000), stdout: safeText(job.verification.stdout, 4000), stderr: safeText(job.verification.stderr, 4000) },
    ci: job.ci && { state: job.ci.state, headCommit: job.ci.headCommit },
    review: review(job.review),
    reviewAttempts: job.reviewAttempts,
    reviewHistory: (job.reviewHistory || []).map(entry => ({ ...entry, reviewer: safeText(entry.reviewer), findings: review(entry).findings, diagnostics: entry.diagnostics && safeText(entry.diagnostics) })),
    diagnostics: (job.failures || []).map(failure => ({ phase: failure.phase, at: failure.at, message: safeText(failure.message) })),
  };
}

function createR1Jobs(store, options = {}) {
  const dependencies = options.autopilotDependencies || {};
  const load = dependencies.loadProjectConfig || loadProjectConfig;
  const discover = dependencies.discoverReadyIssues || discoverReadyIssues;
  const runFile = options.execFile || execFile;
  const ciPollMs = options.ciPollMs ?? CI_POLL_MS;
  const ciTimeoutMs = options.ciTimeoutMs ?? CI_TIMEOUT_MS;
  const admitIntervalMs = options.admitIntervalMs ?? ADMIT_INTERVAL_MS;
  const nextAdvance = new Map();
  let nextAdmission = 0;
  let admitting = null;
  const active = new Map();
  const children = new Set();
  let closing = false;
  const now = () => new Date().toISOString();

  // R1's durable job state contains useful diagnostics, but it can also
  // contain worker, reviewer, and CI text.  The dashboard transcript is a
  // deliberately smaller boundary: only these fixed lifecycle summaries are
  // eligible for it.  Keep the dedupe key on the queue task so a daemon
  // restart or a CI poll cannot turn one persisted transition into a flood.
  function logTransition(task, key, summary) {
    const seen = Array.isArray(task.r1LogEvents) ? task.r1LogEvents : [];
    if (seen.includes(key)) return;
    task.r1LogEvents = [...seen, key].slice(-20);
    const line = `[${now()}] R1: ${summary}`.replace(/[\r\n]+/g, ' ').slice(0, MAX_TRANSCRIPT_LINE);
    try {
      store.appendLogLine(task.id, line);
    } catch (error) {
      // Transcript availability must never affect implementation, verification,
      // review, or merge eligibility.
      console.error(`R1 job ${task.id}: transcript append failed.`);
    }
  }

  function transcriptForJob(task, job) {
    if (!job || typeof job !== 'object') return;
    if (job.verification && typeof job.verification.passed === 'boolean') {
      const verdict = job.verification.passed ? 'passed' : 'failed';
      // Verification is recorded before delivery binds its exact SHA.  The
      // run counter is already durable at that point, so it avoids emitting
      // the same verdict again when delivery later fills in the commit.
      logTransition(task, `verification:${job.runs}:${verdict}`,
        `deterministic verification ${verdict}.`);
    }
  }

  function checkpoint(task, phase) {
    // A cancellation can arrive while R1 awaits a child. Never overwrite it
    // with an older in-memory task snapshot or advance delivery after it.
    try {
      if (store.readTask(task.id, 'running').cancelRequested) task.cancelRequested = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (task.cancelRequested && !['blocked', 'failed', 'cancelled', 'completed', 'merged', 'passed'].includes(phase)) {
      throw new Error('R1 job cancellation requested.');
    }
    if (phase !== task.phase) {
      task.phases = [...(task.phases || []), { phase, at: now() }].slice(-50);
      task.phase = phase;
    }
    task.updatedAt = now();
    store.writeTask(task, 'running');
  }

  function submit(body) {
    if (!Number.isSafeInteger(body.issue) || body.issue < 1) throw new Error('R1 submission requires a positive issue number.');
    if (Object.hasOwn(body, 'cwd') || Object.hasOwn(body, 'projectPath')) throw new Error('R1 paths come from owner configuration.');
    const scope = resolveProject(store.config, body.project, undefined, store.paths.config);
    const project = load(body.project);
    if (!project.enabled || project.worker !== 'codex' || !['always', 'risk'].includes(project.reviewPolicy)) {
      throw new Error('R1 async jobs require an enabled Codex project with independent review required.');
    }
    if (fs.realpathSync(project.checkout) !== scope.cwd) throw new Error('R1 checkout does not match the registered project.');
    const planned = deriveWorktreePath(project, { number: body.issue, title: body.title || 'Queued issue' });
    const entry = store.config.allowedProjects[body.project];
    const named = entry && typeof entry === 'object' && Object.entries(entry.worktrees)
      .find(([name, candidate]) => candidate === planned && (body.worktree === undefined || name === body.worktree));
    const managed = !named && body.worktree === undefined && managesWorktree(entry, planned);
    if (!named && !managed) throw new Error('The issue worktree must be explicitly authorized before R1 submission.');
    const task = store.enqueueTask({
      workflow: 'r1', project: body.project, issue: body.issue, cwd: scope.cwd,
      ...(named ? { worktree: named[0] } : {}), title: body.title || `R1 issue #${body.issue}`,
      phase: 'queued', status: 'queued', phases: [{ phase: 'queued', at: now() }], source: body.source || 'api',
      ...(autonomous(project) ? { autonomous: true } : {}),
    });
    logTransition(task, 'queued', 'queued for admission.');
    // enqueueTask has already made the task durable. Persist the dedupe key
    // separately; an unavailable log file remains strictly best effort.
    try {
      store.writeTask(task, 'pending');
    } catch (error) {
      // The queue entry is already durable; failure to persist transcript
      // metadata must not turn an accepted submission into a failed one.
      console.error(`R1 job ${task.id}: transcript checkpoint failed.`);
    }
    return task;
  }

  function trackedSpawn(...args) {
    if (closing) throw new Error('R1 executor is stopping.');
    const child = spawn(...args);
    children.add(child);
    child.once('close', () => children.delete(child));
    return child;
  }

  function finish(task, job) {
    task.r1 = job && structuredClone(job);
    if (task.autonomous) {
      task.status = approvedMerge(job) ? 'merged' : task.specification === 'missing' && !job ? 'needs_specification' : 'failed';
    } else {
      const approved = job && job.terminalState === 'ready_for_human_merge'
        && job.review && job.review.verdict === 'PASS' && job.delivery && job.review.commit === job.delivery.commit
        && hasPassingVerification(job.verification, job.delivery.commit);
      task.status = approved ? 'passed' : 'blocked';
    }
    if (task.cancelRequested) task.status = task.autonomous ? 'failed' : 'blocked';
    task.finishedAt = now();
    const terminal = task.status;
    logTransition(task, `terminal:${terminal}`, `terminal outcome: ${terminal}.`);
    checkpoint(task, ['passed', 'merged'].includes(task.status) ? 'completed' : task.status);
    store.writeResult({ id: task.id, status: task.status, project: task.project, finishedAt: task.finishedAt,
      ...(task.failure ? { failure: task.failure } : {}), ...(task.cleanup ? { cleanup: task.cleanup } : {}), evidence: evidence(job) });
    store.moveTask(task.id, 'running', 'done');
  }

  function command(file, args, cwd) {
    return new Promise((resolve, reject) => {
      runFile(file, args, { cwd, encoding: 'utf8', shell: false, timeout: 60000, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } },
        (error, stdout, stderr) => (error ? reject(new Error(String(stderr || error.message).trim())) : resolve(String(stdout))));
    });
  }

  // Idempotent and best effort: every action is recorded, and a crash before
  // finish() repeats only actions that are safe to repeat.
  async function cleanup(task, job, project) {
    const results = [];
    const attempt = async (action, file, args, cwd) => {
      try { await command(file, args, cwd); results.push({ action, ok: true }); }
      catch (error) { results.push({ action, ok: false, error: safeText(error.message, 300) }); }
    };
    const outcome = approvedMerge(job) ? 'merged' : task.specification === 'missing' && !job ? 'needs_specification' : 'failed';
    const branch = job && job.branch;
    const pr = job && job.pr && job.pr.number;
    if (outcome !== 'merged') {
      const reason = outcome === 'needs_specification'
        ? `Ralph needs a product specification before it can start: describe the required behaviour and acceptance criteria, then re-apply \`${project.readyLabel}\`.`
        : `Ralph could not complete this issue autonomously and stopped with outcome FAILED (job ${task.id}): ${safeText(task.failure || (job && job.failures && job.failures.at(-1) && job.failures.at(-1).message) || job?.terminalState || 'no deliverable result', 600)}`;
      if (pr) {
        try {
          const state = JSON.parse(await command('gh', ['pr', 'view', String(pr), '--repo', project.repo, '--json', 'state'], project.checkout)).state;
          if (state === 'OPEN') await attempt('close-pr', 'gh', ['pr', 'close', String(pr), '--repo', project.repo, '--comment', reason], project.checkout);
        } catch (error) { results.push({ action: 'close-pr', ok: false, error: safeText(error.message, 300) }); }
      }
      await attempt('comment-issue', 'gh', ['issue', 'comment', String(task.issue), '--repo', project.repo, '--body', reason], project.checkout);
      await attempt('relabel-issue', 'gh', ['issue', 'edit', String(task.issue), '--repo', project.repo, '--remove-label', project.readyLabel, '--add-label', project.humanLabel], project.checkout);
    }
    if (branch && TEMPORARY_BRANCH.test(branch) && job.delivery && job.delivery.pushed) {
      await attempt('delete-remote-branch', 'gh', ['api', '--method', 'DELETE', `repos/${project.repo}/git/refs/heads/${branch}`], project.checkout);
    }
    if (branch && TEMPORARY_BRANCH.test(branch)) {
      try {
        await command('git', ['-C', project.checkout, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], project.checkout);
        await attempt('delete-local-branch', 'git', ['-C', project.checkout, 'branch', '-D', branch], project.checkout);
      } catch { /* no local branch */ }
    }
    task.cleanup = results;
  }

  // A job that stops without a terminal checkpoint would otherwise be
  // re-admitted forever; autonomous projects record it as a durable failure.
  function failDurably(task, project, message) {
    const original = createJobStore(resolveStateDir(task.project, project));
    let lock;
    try { lock = original.acquire(task.issue); } catch { return original.load(task.issue); }
    try {
      const job = original.load(task.issue);
      if (job && !job.terminal) {
        recordFailure(job, 'runner', message);
        job.status = 'failed';
        markTerminal(job, 'failed');
        original.save(job);
      }
      return job;
    } finally { lock.release(); }
  }

  async function conclude(task, job, project) {
    if (task.autonomous && project) {
      if (job && !job.terminal) job = failDurably(task, project, task.failure || 'R1 job stopped before a terminal outcome.');
      await cleanup(task, job, project);
    }
    finish(task, job);
  }

  async function execute(task) {
    const project = load(task.project);
    const scope = resolveProject(store.config, task.project, undefined, store.paths.config);
    const planned = deriveWorktreePath(project, { number: task.issue, title: task.title });
    if (fs.realpathSync(project.checkout) !== scope.cwd
      || (task.worktree !== undefined
        ? store.config.allowedProjects[task.project]?.worktrees?.[task.worktree] !== planned
        : !managesWorktree(store.config.allowedProjects[task.project], planned))
      || !project.enabled || project.worker !== 'codex' || !['always', 'risk'].includes(project.reviewPolicy)) {
      task.failure = 'Owner configuration no longer authorizes this R1 job.';
      return conclude(task, null, task.autonomous ? project : null);
    }
    const original = createJobStore(resolveStateDir(task.project, project));
    const saved = original.load(task.issue);
    if (saved && saved.terminal) return conclude(task, saved, project);
    if (task.autonomous && task.phase === 'ci') {
      const waiting = [...(task.phases || [])].reverse().find(entry => entry.phase === 'ci');
      if (waiting && Date.now() - Date.parse(waiting.at) > ciTimeoutMs) {
        task.failure = `Required CI did not reach a final result within ${Math.round(ciTimeoutMs / 60000)} minutes.`;
        return conclude(task, saved, project);
      }
    }
    if (task.autonomous && !saved) {
      const issue = (await discover(project)).find(value => value.number === task.issue);
      if (issue && !hasSpecification(issue)) {
        task.specification = 'missing';
        task.specificationDigest = digest(issue);
        return conclude(task, null, project);
      }
    }
    const phaseOf = job => job.reviewHistory?.at(-1)?.status === 'running' ? 'review'
      : job.status === 'running' ? 'implementation' : job.status === 'awaiting_ci' ? 'ci' : job.status;
    const jobStore = { ...original,
      list: () => original.list().filter(job => job.issue.number === task.issue),
      save(job) {
        original.save(job);
        task.r1 = structuredClone(job);
        transcriptForJob(task, job);
        checkpoint(task, phaseOf(job));
        return job;
      },
    };
    const reviewer = dependencies.reviewPullRequest || createClaudeReviewAdapter({ spawn: trackedSpawn });
    try {
      await run(['--project', task.project], {
        ...dependencies,
        jobStore, loadProjectConfig: () => project,
        cleanupIssueWorkspace: async (...args) => {
          const attached = store.listR1ChildLoops ? store.listR1ChildLoops(task.id) : [];
          if (attached.some(child => child.stage !== 'done'
            || !['passed', 'failed', 'cancelled', 'maxed', 'partial', 'incomplete'].includes(child.task?.status))) {
            throw new Error('R1 workspace cleanup refused while a child loop remains active or ambiguous.');
          }
          return (dependencies.cleanupIssueWorkspace || cleanupIssueWorkspace)(...args);
        },
        discoverReadyIssues: async value => (await discover(value)).filter(issue => issue.number === task.issue),
        reviewPullRequest: reviewer,
        ralphOptions: { ...dependencies.ralphOptions, config: store.config, spawnImpl: trackedSpawn,
          onPhaseChange: phase => {
            if (closing) throw new Error('R1 executor is stopping.');
            if (phase === 'implementation') logTransition(task, 'implementation', 'implementation started.');
            checkpoint(task, phase);
          },
        },
        write: () => {},
      });
      task.r1 = original.load(task.issue);
      if (!task.r1) task.failure = 'Issue is not ready and has no resumable R1 checkpoint.';
      if (!task.r1 || task.r1.terminal) await conclude(task, task.r1, project);
      else checkpoint(task, phaseOf(task.r1));
    } catch (error) {
      // R1 checkpoints expected retryable failures itself. Unexpected
      // exceptions stop this queue job instead of creating an unbounded retry.
      task.r1 = original.load(task.issue);
      if (task.autonomous && task.r1 && !task.r1.terminal && task.r1.status === 'awaiting_ci') {
        // A GitHub outage while watching CI or merging is retried on the next
        // bounded poll; the autopilot's own limits make repeated failure terminal.
        task.lastError = safeText(error.message);
        checkpoint(task, phaseOf(task.r1));
        return;
      }
      if (!task.r1 || task.r1.terminal) await conclude(task, task.r1, project);
      else {
        task.failure = safeText(error.message);
        await conclude(task, task.r1, project);
      }
    }
  }

  function advance(task) {
    if (active.has(task.id) || closing) return;
    if (task.phase === 'ci' && Date.now() < (nextAdvance.get(task.id) || 0)) return;
    task.status = 'running';
    logTransition(task, 'admitted', 'admitted to the R1 runner.');
    const promise = execute(task).catch(error => {
      task.failure = safeText(error.message);
      try { finish(task, task.r1); } catch {
        console.error(`R1 job ${task.id}: checkpoint persistence failed.`);
      }
    }).finally(() => {
      active.delete(task.id);
      if (task.phase === 'ci') nextAdvance.set(task.id, Date.now() + ciPollMs);
      else nextAdvance.delete(task.id);
    });
    active.set(task.id, promise);
  }

  // Continuous intake: submit the next ready issue of an autonomous project
  // through the normal submit() path, one job at a time, never duplicating a
  // queued, running, or terminal issue.
  function admit() {
    if (closing || admitting || Date.now() < nextAdmission) return admitting;
    nextAdmission = Date.now() + admitIntervalMs;
    admitting = (async () => {
      if (['pending', 'running'].some(stage => store.listTasks(stage).some(task => task.workflow === 'r1'))) return null;
      for (const name of Object.keys(store.config.allowedProjects || {}).sort()) {
        let project;
        try { project = load(name); } catch { continue; }
        if (!autonomous(project)) continue;
        const jobs = createJobStore(resolveStateDir(name, project)).list();
        // An issue waiting for a specification is admitted again only after
        // its description changes.
        const waiting = new Map(store.listTasks('done')
          .filter(task => task.workflow === 'r1' && task.project === name && task.status === 'needs_specification')
          .map(task => [task.issue, task.specificationDigest]));
        const issues = (await discover(project)).filter(issue => waiting.get(issue.number) !== digest(issue));
        const selection = selectIssueForJobs(issues, jobs, selectReadyIssue);
        if (!selection) continue;
        return submit({ project: name, issue: selection.issue.number, title: selection.issue.title, source: 'runner' });
      }
      return null;
    })().catch(error => {
      console.error(`R1 admission failed: ${safeText(error.message)}`);
      return null;
    }).finally(() => { admitting = null; });
    return admitting;
  }

  function recover(task) {
    store.moveTask(task.id, 'running', 'pending');
    store.writeTask({ ...task, status: 'queued', phase: 'recovering' }, 'pending');
  }

  function read(id) {
    if (typeof id !== 'string' || !/^t-[a-f0-9]{8}$/.test(id)) return null;
    for (const stage of ['pending', 'running', 'done']) {
      try {
        const task = store.readTask(id, stage);
        if (task.workflow !== 'r1') return null;
        return { id, status: task.status || stage, project: task.project,
          ...(task.failure ? { failure: task.failure } : {}),
          phase: task.phase, phases: task.phases || [], evidence: evidence(task.r1),
        };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return null;
  }

  function stop(terminate) {
    closing = true;
    for (const child of children) terminate(child);
    return Promise.allSettled([...active.values()]);
  }

  // Internal-only handoff, deliberately absent from the public R1 submission route.
  // Construct lazily: legacy R1 consumers that never invoke the new internal
  // handoff do not need to implement its optional durable-store interface.
  const ensureChildLoop = id => createR1ChildHandoff({ store, loadProject: load }).ensure(id);
  const authorizeChild = task => authorizeR1Child(task, { store, loadProject: load });
  return { submit, advance, admit, recover, read, stop, ensureChildLoop, authorizeChild };
}

module.exports = { createR1Jobs };
