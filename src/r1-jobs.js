const { checkMilestoneAdmission } = require('./milestone-admission');
const { snapshotter } = require('./execution-preview');
// R1 phases run under the existing queue dispatcher, not a second scheduler.
const fs = require('node:fs');
const path = require('node:path');
const { recorder, captureProcess, withExecution } = require('./execution-log');
const { verifyTask } = require('./task-runner');
const { spawn } = require('node:child_process');
const { execFile } = require('./execution-log');
const { run } = require('./autopilot');
const { loadProjectConfig } = require('./autopilot-config');
const { discoverReadyIssues, selectReadyIssue } = require('./autopilot-github');
const { deriveWorktreePath, cleanupIssueWorkspace } = require('./autopilot-workspace');
const { createJobStore, resolveStateDir, selectIssueForJobs } = require('./autopilot-state');
const { managesWorktree, resolveProject } = require('./project-registry');
const { createR1ChildHandoff } = require('./r1-child-handoff');
const { authorizeR1Child } = require('./r1-child-admission');
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

function createR1Jobs(store, options = {}) {
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
        for (const stage of ['pending', 'running', 'done']) {
          try {
            const task = store.readTask(existing.r1ParentJobId, stage);
            if (task.project === body.project && task.issue === body.issue && task.autopilotStateDir) return task;
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        throw new Error('Existing delivery history requires owner reconciliation; it cannot be reassigned.');
      }
      if (typeof store.listTasks === 'function') {
        const reserved = ['pending', 'running'].flatMap(stage => store.listTasks(stage))
          .find(task => task.workflow === 'r1' && task.project === body.project && task.issue === body.issue);
        if (reserved) return reserved;
      }
      const task = store.enqueueTask({
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
    if (!job?.terminal || job.agentProcess || (job.architectureDecision && job.architectureDecision.publication !== 'complete')) return;
    store.moveTask(task.id, 'running', 'done');
    logTransition(task, `terminal:${job.terminalState}`, `terminal outcome: ${deliveryStatus(job, task.autonomous)}.`);
  }

  async function execute(task) {
    const record = recorder(store, task.id, { parentId: task.id });
    const spawnForTask = (file, args, options) => {
      const current = original.load(task.issue);
      const stage = deliveryPhase(current);
      return captureProcess((...args) => trackedSpawn(task.id, ...args), file, args, options,
        recorder(store, task.id, { parentId: task.id, role: stage === 'review' ? 'reviewer' : 'worker', attempt: current.runs, stage }));
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
    const saved = original.load(task.issue);
    if (saved && saved.r1ParentJobId !== task.id) {
      throw new Error('Delivery checkpoint belongs to another submission; owner reconciliation required.');
    }
    task.r1LogEvents = saved?.r1LogEvents || task.r1LogEvents || [];
    logTransition(task, 'admitted', 'admitted to the R1 runner.');
    if (saved?.terminal && !saved.agentProcess && (!saved.architectureDecision || saved.architectureDecision.publication === 'complete')) return finish(task, saved);
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
        task.r1LogEvents = job.r1LogEvents || task.r1LogEvents || [];
        transcriptForJob(task, job);
        job.r1LogEvents = task.r1LogEvents;
        original.save(job);
        snapshot(task.id, job, details => store.appendExecution(task.id, { ...details, stage: phaseOf(job), attempt: job.runs }));
        return job;
      },
    };
    try {
      const optionsCancelChild = options.cancelChild;
      const mixedEnabled = project.implementationStrategy === 'worker-critic-loop';
      await run(['--project', task.project], {
        ...dependencies,
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
          const mixed = createR1LoopImplementation({
            ensureChild: () => ensureChildLoop(task.id),
            childState: id => store.listR1ChildLoops(task.id).find(item => item.id === id) || null,
            cancelChild: async id => {
              if (typeof optionsCancelChild !== 'function') throw new Error('Child cancellation unavailable; workspace retained.');
              const outcome = optionsCancelChild(id);
              if (outcome.status !== 200) throw new Error(`R1 child cancellation failed: ${outcome.error || outcome.status}`);
            },
            isCancelled: () => store.readTask(task.id, 'running').cancelRequested === true,
            onChildQueued: id => {
              const current = store.readTask(task.id, 'running');
              if (current.childLoopId !== id) throw new Error('R1 child association changed before implementation.');
            },
            recordBaseline: options.recordBaseline,
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
      if (!original.load(task.issue)) holdSupervision(task, error);
      finish(task, original.load(task.issue));
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
    const reason = String(error.message || error).slice(0, 1000);
    store.writeTask({ ...current, supervisionBlocked: { at: new Date().toISOString(), reason } }, 'running');
    recorder(store, task.id, { parentId: task.id })('supervision_blocked', { message: reason });
  }

  function advance(task) {
    if (active.has(task.id) || closing || Date.now() < (nextAdvance.get(task.id) || 0)) return;
    task = store.readTask(task.id, 'running');
    if (!task.autopilotStateDir || task.supervisionBlocked) return; // inspect-only or operator-held
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
          durable = createJobStore(task.autopilotStateDir).load(task.issue);
          if (durable && durable.r1ParentJobId !== id) throw new Error('Delivery checkpoint ownership mismatch.');
        } else if (task.r1?.architectureDecision || task.r1?.architectureDecisionHistory?.length) {
          const project = load(task.project);
          const current = createJobStore(resolveStateDir(task.project, project)).load(task.issue);
          if (current && current.createdAt === task.r1.createdAt && current.r1ParentJobId === id) durable = current;
        }
        const projected = evidence(durable, task.requiredCiWorkflow);
        const status = task.supervisionBlocked ? 'blocked' : task.autopilotStateDir
          ? (durable ? deliveryStatus(durable, task.autonomous) : task.status || stage)
          : (durable && durable !== task.r1 ? durable.terminalState || durable.status : task.status || stage);
        const phase = task.supervisionBlocked ? 'blocked' : task.autopilotStateDir ? durable ? deliveryPhase(durable) : 'queued' : task.phase;
        return { id, status, project: task.project,
          ...(task.failure ? { failure: task.failure } : {}),
          phase, phases: task.autopilotStateDir ? durable?.phases || [{ phase: 'queued', at: task.createdAt }] : task.phases || [], evidence: projected,
          nextAction: task.supervisionBlocked ? { action: 'owner_decision', reason: task.supervisionBlocked.reason } : nextAction({ ...task, status, phase }, projected),
          executionJournal: { id, raw: `/api/log/${id}?raw=1` },
        };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return null;
  }

  function cancel(id, terminate) {
    for (const [child, parentId] of children) if (parentId === id) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { terminate(child); }
    }
  }

  function stop(terminate) {
    closing = true;
    for (const id of new Set(children.values())) cancel(id, terminate);
    return Promise.allSettled([...active.values()]);
  }

  // Internal-only handoff, deliberately absent from the public R1 submission route.
  // Construct lazily: legacy R1 consumers that never invoke the new internal
  // handoff do not need to implement its optional durable-store interface.
  const ensureChildLoop = id => createR1ChildHandoff({ store, loadProject: load }).ensure(id);
  const authorizeChild = task => {
    const parent = authorizeR1Child(task, { store, loadProject: load });
    const project = load(parent.project);
    if (project.milestoneAuthorization !== true) return parent;
    return authorize(parent.project, project, parent.issue, parent.milestoneAuthorization).then(() =>
      authorizeR1Child(task, { store, loadProject: load }));
  };
  return { submit, advance, admit, recover, read, stop, cancel, ensureChildLoop, authorizeChild };
}

module.exports = { createR1Jobs };
