const { checkMilestoneAdmission } = require('./milestone-admission');
const { snapshotter } = require('./execution-preview');
// R1 phases run under the existing queue dispatcher, not a second scheduler.
const fs = require('node:fs');
const path = require('node:path');
const { recorder, captureProcess, withExecution } = require('./execution-log');
const { verifyTask } = require('./task-runner');
const { spawn } = require('node:child_process');
const { execFile } = require('./execution-log');
const { run, cancelHeldDelivery, rearmCorrectedSpecification } = require('./autopilot');
const { loadProjectConfig } = require('./autopilot-config');
const { discoverReadyIssues, selectReadyIssue } = require('./autopilot-github');
const { deriveWorktreePath, cleanupIssueWorkspace } = require('./autopilot-workspace');
const { createJobStore, resolveStateDir, selectIssueForJobs } = require('./autopilot-state');
const { managesWorktree, resolveProject } = require('./project-registry');
const { createR1LoopImplementation } = require('./r1-loop-implementation');
const { createRalphTaskService } = require('./ralph-task-service');
const { captureFailedR1Job, bindR1Parent } = require('./r1-failed-work');
const { eligibleIssues } = require('./r1-dependencies');
const { verificationFailureSummary } = require('./r1-transcript-summary');

// Continuous runner limits. CI is watched with a bounded poll instead of a
// scheduler pass; admission looks for the next ready issue at most once a
// minute and only while no R1 job is queued or running.
const CI_POLL_MS = 30 * 1000;
const CI_TIMEOUT_MS = 60 * 60 * 1000;
const ADMIT_INTERVAL_MS = 60 * 1000;
const MAX_TRANSCRIPT_LINE = 512;

// Projects that opted into autonomous merging are driven to exactly one of
// merged, needs_specification, or failed. Every other project keeps the
// original passed/blocked hand-off.
function autonomous(project) {
  return Boolean(project && project.enabled && project.autoMerge === true && project.worker === 'codex'
    && ['always', 'risk'].includes(project.reviewPolicy));
}

const { evidence, nextAction, deliveryStatus, deliveryPhase } = require('./r1-status');

function createDevelopmentJobs(store, options = {}) {
  const dependencies = options.autopilotDependencies || {};
  const load = dependencies.loadProjectConfig || loadProjectConfig;
  const discover = dependencies.discoverReadyIssues || discoverReadyIssues;
  const ciPollMs = options.ciPollMs ?? CI_POLL_MS;
  const ciTimeoutMs = options.ciTimeoutMs ?? CI_TIMEOUT_MS;
  const admitIntervalMs = options.admitIntervalMs ?? ADMIT_INTERVAL_MS;
  const nextAdvance = new Map();
  let nextAdmission = 0;
  let admitting = null;
  const dependencyDiagnostics = new Map();
  const active = new Map();
  const children = new Map();
  let closing = false;

  // Summaries are navigation; raw events and evidence are persisted separately.
  function logTransition(task, key, summary) {
    const seen = Array.isArray(task.r1LogEvents) ? task.r1LogEvents : [];
    if (seen.includes(key)) return;
    task.r1LogEvents = [...seen, key].slice(-20);
    recorder(store, task.id, { parentId: task.id })('transition', { key, summary });
    // Transcript deduplication is transport metadata, not delivery state.
    if (store.writeTask) for (const stage of ['pending', 'running', 'done']) {
      try {
        const current = store.readTask(task.id, stage);
        store.writeTask({ ...current, r1LogEvents: task.r1LogEvents }, stage);
        break;
      } catch (error) { if (error.code !== 'ENOENT') break; }
    }
    const line = `[${new Date().toISOString()}] R1: ${summary}`.replace(/[\r\n]+/g, ' ').slice(0, MAX_TRANSCRIPT_LINE);
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
    if (job.phase === 'implementation') logTransition(task, 'implementation', 'implementation started.');
    if (['ready', 'blocked'].includes(job.environmentPreflight?.status)) {
      const outcome = job.environmentPreflight.status;
      logTransition(task, `environment:${job.runs}:${outcome}`, outcome === 'ready'
        ? 'Project verification environment ready.' : 'Project verification environment blocked by infrastructure.');
    }
    if (job.verification && typeof job.verification.passed === 'boolean') {
      const verdict = job.verification.passed ? 'passed' : 'failed';
      // Verification is recorded before delivery binds its exact SHA.  The
      // run counter is already durable at that point, so it avoids emitting
      // the same verdict again when delivery later fills in the commit.
      logTransition(task, `verification:${job.runs}:${verdict}`,
        job.verification.passed ? 'deterministic verification passed.' : verificationFailureSummary(job.verification));
    }
  }

  const authorize = (name, project, issue, expectedAuthorization) => project.milestoneAuthorization !== true ? Promise.resolve(null) : checkMilestoneAdmission(name, project, issue, {
    configPath: store.paths.config, projectsPath: options.projectsPath,
    stateDir: store.paths.state, expectedAuthorization, execFile: dependencies.execFile || options.execFile || execFile,
    jobs: () => createJobStore(resolveStateDir(name, project)).list(),
  });

  function submit(body) {
    if (!Number.isSafeInteger(body.issue) || body.issue < 1) throw new Error('Development-job submission requires a positive issue number.');
    if (Object.hasOwn(body, 'cwd') || Object.hasOwn(body, 'projectPath')) throw new Error('R1 paths come from owner configuration.');
    const scope = resolveProject(store.config, body.project, undefined, store.paths.config);
    const project = load(body.project);
    if (!project.enabled || project.worker !== 'codex' || !['always', 'risk'].includes(project.reviewPolicy)) {
      throw new Error('Development jobs require an enabled Codex project with independent review required.');
    }
    if (fs.realpathSync(project.checkout) !== scope.cwd) throw new Error('R1 checkout does not match the registered project.');
    const planned = deriveWorktreePath(project, { number: body.issue, title: body.title || 'Queued issue' });
    const entry = store.config.allowedProjects[body.project];
    const named = entry && typeof entry === 'object' && Object.entries(entry.worktrees)
      .find(([name, candidate]) => candidate === planned && (body.worktree === undefined || name === body.worktree));
    const managed = !named && body.worktree === undefined && managesWorktree(entry, planned);
    if (!named && !managed) throw new Error('The issue worktree must be explicitly authorized before development-job submission.');
    // New jobs may reserve a not-yet-created worktree. If the path already
    // exists, validate the actual Git repository identity before admission;
    // a different repository can occupy an otherwise authorized directory.
    if (fs.existsSync(planned)) {
      if (fs.realpathSync(planned) !== path.resolve(planned)) {
        throw new Error('R1 issue worktree is redirected outside its authorized path.');
      }
      // A removed worktree may leave an empty directory for a new attempt.
      // Only nonempty destinations need existing-worktree identity checks.
      if (fs.readdirSync(planned).length) {
        const existing = resolveProject(store.config, body.project, named ? named[0] : path.basename(planned), store.paths.config);
        if (!existing.isolatedWorktree || existing.cwd !== path.resolve(planned)) {
          throw new Error('R1 issue worktree is not a linked worktree of its registered repository.');
        }
      }
    }
    const enqueue = authorization => {
      const existing = createJobStore(resolveStateDir(body.project, project)).load(body.issue);
      if (existing) {
        const previous = () => {
          const parentId = createJobStore(resolveStateDir(body.project, project)).load(body.issue).r1ParentJobId;
          for (const stage of ['pending', 'running', 'done']) {
            try {
              const task = store.readTask(parentId, stage);
              if (task.project === body.project && task.issue === body.issue && task.autopilotStateDir) return task;
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          throw new Error('Existing delivery history requires owner reconciliation; it cannot be reassigned.');
        };
        if (existing.terminalState === 'needs_specification' || existing.admissionUnavailable === true) {
          return Promise.resolve(discover(project)).then(issues => {
            const issue = issues.find(issue => issue.number === body.issue);
            if (issue) {
              const fresh = rearmCorrectedSpecification(body.project, project,
                createJobStore(resolveStateDir(body.project, project)), issue,
                previous => reserve(authorization, previous.r1ParentJobId));
              if (fresh) return fresh;
            }
            return previous();
          });
        }
        return previous();
      }
      if (typeof store.listTasks === 'function') {
        const reserved = ['pending', 'running'].flatMap(stage => store.listTasks(stage))
          .find(task => task.workflow === 'r1' && task.project === body.project && task.issue === body.issue);
        if (reserved) return reserved;
      }
      return reserve(authorization);
    };
    const reserve = (authorization, rearmFrom) => {
      if (rearmFrom && typeof store.listTasks === 'function') {
        if (store.listTasks('done').some(task => task.workflow === 'r1' && task.project === body.project
          && task.issue === body.issue && task.rearmFrom === rearmFrom)) {
          throw new Error('Rearm reservation mismatch: abandoned terminal reservation requires owner reconciliation.');
        }
        const matches = ['pending', 'running'].flatMap(stage => store.listTasks(stage))
          .filter(task => task.workflow === 'r1' && task.project === body.project && task.issue === body.issue);
        if (matches.length) {
          if (matches.length !== 1 || matches[0].rearmFrom !== rearmFrom
            || matches[0].autopilotStateDir !== resolveStateDir(body.project, project)
            || matches[0].cancelRequested || matches[0].supervisionBlocked
            || JSON.stringify(matches[0].milestoneAuthorization || null) !== JSON.stringify(authorization || null)) {
            throw new Error('Rearm reservation mismatch; owner reconciliation required.');
          }
          return matches[0];
        }
      }
      const task = store.enqueueTask({
        ...(rearmFrom ? { rearmFrom } : {}), repo: project.repo,
        workflow: 'r1', project: body.project, issue: body.issue, cwd: scope.cwd,
        requiredCiWorkflow: project.ciWorkflow || null,
        ...(authorization ? { milestoneAuthorization: authorization } : {}),
        ...(named ? { worktree: named[0] } : {}), title: body.title || `R1 issue #${body.issue}`,
        status: 'queued', autopilotStateDir: resolveStateDir(body.project, project), source: body.source || 'api',
        ...(autonomous(project) ? { autonomous: true } : {}),
      });
      logTransition(task, 'queued', 'queued for admission.');
      return task;
    };
    return project.milestoneAuthorization === true ? authorize(body.project, project, body.issue).then(enqueue) : enqueue();
  }

  function trackedSpawn(parentId, ...args) {
    if (closing) throw new Error('R1 executor is stopping.');
    const child = spawn(...args);
    children.set(child, parentId);
    child.once('close', () => children.delete(child));
    return child;
  }

  // Queue movement releases the dispatch slot; all delivery outcomes remain
  // in the existing Autopilot issue checkpoint. No result/evidence copy.
  function finish(task, job) {
    // A confirmed terminal infrastructure block may retain an unidentifiable
    // setup-process claim. Release only its queue slot; keep the claim and the
    // fail-closed canonical verdict for owner inspection. Never relaunch it.
    const blockedSetupClaim = job?.terminalState === 'blocked_infrastructure'
      && job.environmentPreflight?.reason === 'prior_process_unresolved'
      && job.environmentProcess && !job.agentProcess;
    if (!job?.terminal || Object.values(job.outcomeActions || {}).some(action => !action.ok && action.attempts < 3)
      || job.agentProcess || (job.environmentProcess && !blockedSetupClaim)
      || (job.architectureDecision && job.architectureDecision.publication !== 'complete')) return;
    store.moveTask(task.id, 'running', 'done');
    logTransition(task, `terminal:${job.terminalState}`, `terminal outcome: ${deliveryStatus(job, task.autonomous)}.`);
  }

  async function execute(task) {
    const record = recorder(store, task.id, { parentId: task.id });
    const spawnForTask = (file, args, options, execution) => {
      const current = original.load(task.issue);
      const stage = deliveryPhase(current);
      return captureProcess((...args) => trackedSpawn(task.id, ...args), file, args, options,
        recorder(store, task.id, { parentId: task.id, role: execution?.role || (stage === 'review' ? 'reviewer' : 'worker'), attempt: current.runs, stage }));
    };
    const project = load(task.project);
    const scope = resolveProject(store.config, task.project, undefined, store.paths.config);
    const planned = deriveWorktreePath(project, { number: task.issue, title: task.title });
    if (fs.realpathSync(project.checkout) !== scope.cwd
      || (task.worktree !== undefined
        ? store.config.allowedProjects[task.project]?.worktrees?.[task.worktree] !== planned
        : !managesWorktree(store.config.allowedProjects[task.project], planned))
      || !project.enabled || project.worker !== 'codex' || !['always', 'risk'].includes(project.reviewPolicy)) {
      task.failure = 'Owner configuration no longer authorizes this R1 job.';
      throw new Error(task.failure);
    }
    if (!task.autopilotStateDir || task.autopilotStateDir !== resolveStateDir(task.project, project)) {
      throw new Error('Delivery state location changed or legacy job is read-only; owner reconciliation required.');
    }
    const original = createJobStore(task.autopilotStateDir);
    const attached = store.listR1ChildLoops?.(task.id) || [];
    if (attached.some(child => child.stage !== 'done')) return;
    let saved = original.load(task.issue);
    if (saved && saved.r1ParentJobId !== task.id && task.rearmFrom === saved.r1ParentJobId) {
      const issue = (await discover(project)).find(issue => issue.number === task.issue);
      if (issue) rearmCorrectedSpecification(task.project, project, original, issue, () => task);
      saved = original.load(task.issue);
    }
    if (saved && saved.r1ParentJobId !== task.id) {
      throw new Error('Delivery checkpoint belongs to another submission; owner reconciliation required.');
    }
    task.r1LogEvents = saved?.r1LogEvents || task.r1LogEvents || [];
    logTransition(task, 'admitted', 'admitted to the R1 runner.');

    const phaseOf = deliveryPhase;
    const snapshot = snapshotter();
    const jobStore = { ...original,
      dependencyJobs: () => original.list(),
      appendIntegrationEvent(job, record) {
        original.appendIntegrationEvent(job, record);
        store.appendExecution(task.id, { stage: phaseOf(job), implementationAttempt: job.runs, ...record });
      },
      list: () => original.list().filter(job => job.issue.number === task.issue),
      save(job) {
        bindR1Parent(job, task.id);
        task.r1LogEvents ||= job.r1LogEvents || [];
        transcriptForJob(task, job);
        delete job.r1LogEvents;
        original.save(job);
        snapshot(task.id, job, details => store.appendExecution(task.id, { ...details, stage: phaseOf(job), attempt: job.runs }));
        return job;
      },
    };
    try {
      const mixedEnabled = project.implementationStrategy === 'worker-critic-loop';
      await run(['--project', task.project], {
        ...dependencies, outcomeExecFile: dependencies.outcomeExecFile || options.execFile,
        jobStore, loadProjectConfig: () => project,
        requestedIssue: { number: task.issue, title: task.title },
        parentJobId: task.id, isStopping: () => closing,
        deliveryTimeoutMs: ciTimeoutMs,
        milestoneOptions: { stateDir: store.paths.state, configPath: store.paths.config, projectsPath: options.projectsPath },
        checkMilestoneAuthorization: () => authorize(task.project, load(task.project), task.issue, task.milestoneAuthorization),
        environmentIsCancelled: () => store.readTask(task.id, 'running').cancelRequested === true,
        // A completed implementation child cannot resolve a later integration.
        // Use the existing scoped CLI-worker service and tracked parent process
        // lifecycle, only after every authorized implementation child has ended.
        createIntegrationTaskService: serviceOptions => {
          const attached = store.listR1ChildLoops ? store.listR1ChildLoops(task.id) : [];
          if (closing || store.readTask(task.id, 'running').cancelRequested
            || attached.some(child => child.stage !== 'done')) {
            throw new Error('Integration worker refused while another child is active or the parent is stopping.');
          }
          return (dependencies.createIntegrationTaskService || createRalphTaskService)(serviceOptions);
        },
        ...(mixedEnabled ? { createRalphTaskService: options => {
          const attempt = original.load(task.issue)?.runs;
          const mixed = createR1LoopImplementation({
            ...options,
            beforeAttempt: async () => {
              await options.beforeAttempt?.();
              const current = store.readTask(task.id, 'running');
              const checkpoint = original.load(task.issue);
              const latestProject = load(task.project);
              const latestScope = resolveProject(store.config, task.project, undefined, store.paths.config);
              const worktree = deriveWorktreePath(latestProject, { number: task.issue, title: task.title });
              if (closing || current.cancelRequested || !latestProject.enabled || latestProject.worker !== 'codex'
                || current.workflow !== 'r1' || current.project !== task.project || current.issue !== task.issue
                || checkpoint?.r1ParentJobId !== task.id || checkpoint?.runs !== attempt || checkpoint?.terminal
                || checkpoint?.project !== task.project || latestProject.repo !== checkpoint?.repo || current.repo !== checkpoint?.repo
                || !['always', 'risk'].includes(latestProject.reviewPolicy)
                || fs.realpathSync(latestProject.checkout) !== latestScope.cwd
                || worktree !== checkpoint?.worktreePath
                || (task.worktree !== undefined
                  ? store.config.allowedProjects[task.project]?.worktrees?.[task.worktree] !== worktree
                  : !managesWorktree(store.config.allowedProjects[task.project], worktree))) {
                throw new Error('Canonical worker authorization changed; workspace retained.');
              }
              const actual = resolveProject(store.config, task.project, task.worktree ?? path.basename(worktree), store.paths.config);
              if (!actual.isolatedWorktree || actual.cwd !== worktree) {
                throw new Error('Canonical worker worktree is not linked to the registered repository.');
              }
            },
            verify: (cwd, inputTask) => verifyTask(cwd, inputTask, undefined, recorder(store, task.id, { parentId: task.id, role: 'verification', attempt: original.load(task.issue)?.runs ?? 1, stage: 'verification' })),
          });
          return mixed;
        } } : {}),
        captureFailedWork: ({ job, workspace, store: jobState }) => {
          if (!mixedEnabled || (job?.environmentPreflight && !job.ralph?.status)) return null;
          if (!job?.r1ParentJobId || job.r1ParentJobId !== task.id) {
            throw new Error('R1 cleanup refused: retained workspace belongs to a different or unknown parent.');
          }
          const receipt = captureFailedR1Job({ project, job, workspace,
            stateRoot: jobState.directory, queueStore: store });
          if (receipt && JSON.stringify(job.recovery) !== JSON.stringify(receipt)) {
            job.recovery = receipt;
            jobState.save(job);
          }
          return receipt;
        },
        cleanupIssueWorkspace: async (...args) => {
          const attached = store.listR1ChildLoops ? store.listR1ChildLoops(task.id) : [];
          if (attached.some(child => child.stage !== 'done'
            || !['passed', 'failed', 'cancelled', 'maxed', 'partial', 'incomplete'].includes(child.task?.status))) {
            throw new Error('R1 workspace cleanup refused while a child loop remains active or ambiguous.');
          }
          return (dependencies.cleanupIssueWorkspace || cleanupIssueWorkspace)(...args);
        },
        discoverReadyIssues: async value => (await discover(value)).filter(issue => issue.number === task.issue),
        ralphOptions: { ...dependencies.ralphOptions, config: store.config, spawnImpl: spawnForTask,
          recordExecution: (event, details) => recorder(store, task.id, { parentId: task.id, role: 'verification', stage: 'verification', attempt: original.load(task.issue)?.runs ?? 1 })(event, details),

        },
        write: text => record('orchestration', { text }),
      });
      finish(task, original.load(task.issue));
    } catch (error) {
      record('exception', { name: error.name, message: error.message, stack: error.stack });
      // Autopilot owns bounded retries and terminal outcomes. An unavailable
      // checkpoint or uncertain process owner leaves dispatch held, never a
      // fabricated terminal result or another worker.
      const current = original.load(task.issue);
      if (!current || (!current.terminal && !['failed', 'awaiting_ci'].includes(current.status))) holdSupervision(task, error);
      finish(task, current);
    }
  }

  // Supervisor admission failures are not delivery outcomes. Hold the
  // reservation, expose a durable operator diagnostic and never poll-retry an
  // unauthorised executor. Autopilot remains the sole delivery-state owner.
  function holdSupervision(task, error) {
    let current;
    try { current = store.readTask(task.id, 'running'); }
    catch (missing) { if (missing.code === 'ENOENT') return; throw missing; }
    if (current.supervisionBlocked) return;
    const reason = String(error.message || error);
    store.writeTask({ ...current, supervisionBlocked: { at: new Date().toISOString(), reason } }, 'running');
    recorder(store, task.id, { parentId: task.id })('supervision_blocked', { message: reason, stack: error.stack, code: error.code });
  }

  function advance(task) {
    if (active.has(task.id) || closing || Date.now() < (nextAdvance.get(task.id) || 0)) return;
    task = store.readTask(task.id, 'running');
    if (!task.autopilotStateDir) return; // historical records are inspect-only
    const canonical = createJobStore(task.autopilotStateDir);
    let saved;
    try { saved = canonical.load(task.issue); }
    catch (error) { holdSupervision(task, error); return; }
    if (task.cancelRequested && !saved?.merge && saved?.outcomePrState !== 'MERGED' && !(store.listR1ChildLoops?.(task.id) || []).some(child => child.stage !== 'done')) {
      const promise = withExecution((event, details) => recorder(store, task.id, { parentId: task.id })(event, details),
        () => cancelHeldDelivery(task, canonical, load, { ...dependencies, outcomeExecFile: dependencies.outcomeExecFile || options.execFile }))
        .then(cancelled => {
          finish(task, cancelled);
          if (!cancelled.terminal && cancelled.ownershipBlocked) nextAdvance.set(task.id, Infinity);
          else if (!cancelled.terminal && cancelled.outcomeActions?.['inspect-pr']?.ok === false)
            nextAdvance.set(task.id, Date.now() + ciPollMs);
        })
        .catch(error => holdSupervision(task, error))
        .finally(() => active.delete(task.id));
      active.set(task.id, promise);
      return;
    }
    if (saved?.terminal && saved.r1ParentJobId === task.id && Object.values(saved.outcomeActions || {}).some(action => !action.ok && action.attempts >= 3)
      && Object.values(saved.outcomeActions || {}).every(action => action.ok || action.attempts >= 3)) {
      finish(task, saved);
      return;
    }
    if (task.supervisionBlocked || (saved?.ownershipBlocked && saved.ownershipBlockSource !== 'discovery')) return;
    if (task.status !== 'running') {
      task.status = 'running';
      store.writeTask(task, 'running');
    }
    const promise = withExecution((event, details) => recorder(store, task.id, { parentId: task.id })(event, details), () => execute(task))
      .catch(error => holdSupervision(task, error))
      .finally(() => {
        active.delete(task.id);
        nextAdvance.set(task.id, Date.now() + ciPollMs);
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
      if (['pending', 'running'].some(stage => store.listTasks(stage).some(task => task.workflow === 'r1' && task.autopilotStateDir))) return null;
      for (const name of Object.keys(store.config.allowedProjects || {}).sort()) {
        let project;
        try { project = load(name); } catch (error) {
          // Config loads can fail before a job exists. Retain the complete reason
          // in the service journal as well as the runtime drift audit.
          console.error(`R1 admission configuration refused for ${name}: ${error.stack || error}`);
          continue;
        }
        // Keep Household issue admission exclusive to its scheduled autopilot;
        // racing this scanner would prematurely fail and unlabel blocked issues.
        if (!autonomous(project) || project.dependencyFormat === 'household-blocked-by') continue;
        const projectStore = createJobStore(resolveStateDir(name, project));
        await require('./architecture-decisions').reconcile(project, projectStore, {
          execFile: dependencies.execFile || options.execFile,
          withJobExecution: (job, work) => withExecution((event, details) => {
            projectStore.appendIntegrationEvent(job, { event, ...details });
            if (job.r1ParentJobId) recorder(store, job.r1ParentJobId)(event, details);
          }, work),
        });
        const jobs = projectStore.list();
        const issues = await discover(project);
        const authorized = [];
        for (const issue of issues) {
          try { await authorize(name, project, issue.number); authorized.push(issue); }
          catch (error) { console.error(error.message); }
        }
        const blockedInScan = new Set();
        const admitted = name === 'ralph'
          ? eligibleIssues(authorized, jobs, name, project.repo, (issueNumber, message) => {
            blockedInScan.add(issueNumber);
            const issue = authorized.find(issue => issue.number === issueNumber);
            const diagnosticKey = JSON.stringify({ repo: project.repo, issue, message });
            if (dependencyDiagnostics.get(issueNumber) === diagnosticKey) return;
            // Persist before deduplicating: admission also runs outside systemd.
            // Reuse the existing per-issue raw journal without inventing a job.
            try {
              projectStore.appendIntegrationEvent({ issue: { number: issueNumber } }, {
                event: 'dependency_admission_blocked', project: name, repo: project.repo,
                issue, message,
              });
              dependencyDiagnostics.set(issueNumber, diagnosticKey);
            } catch (error) {
              // The issue stays blocked; retry its evidence without starving other work.
              dependencyDiagnostics.delete(issueNumber);
              console.error(`R1 ${name} issue #${issueNumber}: dependency diagnostic journal write/flush failed:`,
                error, JSON.stringify({ project: name, repo: project.repo, issue, message }));
            }
            console.error(message); // Captured by the owner-visible systemd service journal.
          }) : authorized;
        if (name === 'ralph') {
          for (const issueNumber of dependencyDiagnostics.keys()) {
            if (!blockedInScan.has(issueNumber)) dependencyDiagnostics.delete(issueNumber);
          }
        }
        const selection = selectIssueForJobs(admitted, jobs, selectReadyIssue);
        if (!selection) continue;
        return submit({ project: name, issue: selection.issue.number, title: selection.issue.title, source: 'runner' });
      }
      return null;
    })().catch(error => {
      console.error(`R1 admission failed: ${String(error.message)}`);
      return null;
    }).finally(() => { admitting = null; });
    return admitting;
  }

  function recover(task) {
    if (!task.autopilotStateDir) return;
    recorder(store, task.id, { parentId: task.id })('recovery', { stage: task.phase, previousStatus: task.status, message: 'Daemon restarted; previously captured output retained. Interrupted process exit details are unknown unless recorded by the CLI or process supervisor.' });
    store.moveTask(task.id, 'running', 'pending');
    // Recovery changes queue ownership only; delivery remains untouched.
    store.writeTask({ ...task, status: 'queued' }, 'pending');
  }

  function read(id) {
    if (typeof id !== 'string' || !/^t-[a-f0-9]{8}$/.test(id)) return null;
    for (const stage of ['pending', 'running', 'done']) {
      try {
        const task = store.readTask(id, stage);
        if (task.workflow !== 'r1') return null;
        // Owner CLI actions update the canonical project job under its issue lock.
        // Recover those records even when the queue checkpoint predates the action.
        let durable = task.r1;
        if (task.autopilotStateDir) {
          try {
            durable = createJobStore(task.autopilotStateDir).load(task.issue, id);
          } catch (error) {
            if (stage === 'pending' && task.status === 'queued'
              && !fs.existsSync(path.join(task.autopilotStateDir, `issue-${task.issue}.json`))) {
              durable = null; // admitted reservation has not started yet
            } else {
              return { id, project: task.project, status: 'blocked', phase: 'blocked',
                diagnostic: error.message, evidence: null, phases: [],
                nextAction: { action: 'owner_decision', reason: error.message },
                executionJournal: { id, raw: `/api/log/${id}?raw=1` } };
            }
          }
        } else if (task.r1?.architectureDecision || task.r1?.architectureDecisionHistory?.length) {
          const project = load(task.project);
          const current = createJobStore(resolveStateDir(task.project, project)).load(task.issue);
          if (current && current.createdAt === task.r1.createdAt && current.r1ParentJobId === id) durable = current;
        }
        const projected = evidence(durable, task.requiredCiWorkflow);
        const supervisionBlocked = task.supervisionBlocked && !durable?.terminal;
        const status = supervisionBlocked ? 'blocked' : task.autopilotStateDir
          ? (durable ? deliveryStatus(durable, task.autonomous) : task.status || stage)
          : (durable && durable !== task.r1 ? durable.terminalState || durable.status : task.status || stage);
        const phase = supervisionBlocked ? 'blocked' : task.autopilotStateDir ? durable ? deliveryPhase(durable) : 'queued' : task.phase;
        return { id, status, project: task.project,
          ...(task.failure ? { failure: task.failure } : {}),
          phase, phases: task.autopilotStateDir ? durable?.phases || [{ phase: 'queued', at: task.createdAt }] : task.phases || [], evidence: projected,
          nextAction: supervisionBlocked ? { action: 'owner_decision', reason: task.supervisionBlocked.reason } : nextAction({ ...task, status, phase }, projected),
          executionJournal: { id, raw: `/api/log/${id}?raw=1` },
        };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return null;
  }

  function cancel(id, terminate) {
    nextAdvance.delete(id); // an explicit owner retry may reconcile an unresolved cancellation
    for (const [child, parentId] of children) if (parentId === id) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { terminate(child); }
    }
  }

  function stop(terminate) {
    closing = true;
    for (const id of new Set(children.values())) cancel(id, terminate);
    return Promise.allSettled([...active.values()]);
  }

  return { submit, advance, admit, recover, read, stop, cancel };
}

module.exports = { createDevelopmentJobs };
