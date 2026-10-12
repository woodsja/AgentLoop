// R1 phases run under the existing queue dispatcher, not a second scheduler.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { run } = require('./autopilot');
const { loadProjectConfig } = require('./autopilot-config');
const { discoverReadyIssues } = require('./autopilot-github');
const { deriveWorktreePath } = require('./autopilot-workspace');
const { createClaudeReviewAdapter } = require('./autopilot-review');
const { createJobStore, resolveStateDir, hasPassingVerification } = require('./autopilot-state');
const { resolveProject } = require('./project-registry');

function safeText(value, limit = 1000) {
  return String(value ?? '').replace(/\b(?:Bearer\s+\S+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+)/gi, '[redacted]')
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s"']+[\\/])*[^\s"']+/g, '[path]').slice(0, limit);
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
  const active = new Map();
  const children = new Set();
  let closing = false;
  const now = () => new Date().toISOString();

  function checkpoint(task, phase) {
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
    const authorized = entry && typeof entry === 'object' && Object.entries(entry.worktrees)
      .find(([name, candidate]) => candidate === planned && (body.worktree === undefined || name === body.worktree));
    if (!authorized) throw new Error('The issue worktree must be explicitly authorized before R1 submission.');
    return store.enqueueTask({
      workflow: 'r1', project: body.project, issue: body.issue, cwd: scope.cwd,
      worktree: authorized[0], title: body.title || `R1 issue #${body.issue}`,
      phase: 'queued', status: 'queued', phases: [{ phase: 'queued', at: now() }], source: body.source || 'api',
    });
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
    const approved = job && job.terminalState === 'ready_for_human_merge'
      && job.review && job.review.verdict === 'PASS' && job.delivery && job.review.commit === job.delivery.commit
      && hasPassingVerification(job.verification, job.delivery.commit);
    task.status = approved ? 'passed' : 'blocked';
    task.finishedAt = now();
    checkpoint(task, approved ? 'completed' : 'blocked');
    store.writeResult({ id: task.id, status: task.status, project: task.project, finishedAt: task.finishedAt, evidence: evidence(job) });
    store.moveTask(task.id, 'running', 'done');
  }

  async function execute(task) {
    const project = load(task.project);
    const scope = resolveProject(store.config, task.project, undefined, store.paths.config);
    const planned = deriveWorktreePath(project, { number: task.issue, title: task.title });
    if (fs.realpathSync(project.checkout) !== scope.cwd
      || store.config.allowedProjects[task.project]?.worktrees?.[task.worktree] !== planned
      || !project.enabled || project.worker !== 'codex' || !['always', 'risk'].includes(project.reviewPolicy)) {
      task.failure = 'Owner configuration no longer authorizes this R1 job.';
      return finish(task, null);
    }
    const original = createJobStore(resolveStateDir(task.project, project));
    const saved = original.load(task.issue);
    if (saved && saved.terminal) return finish(task, saved);
    const phaseOf = job => job.reviewHistory?.at(-1)?.status === 'running' ? 'review'
      : job.status === 'running' ? 'implementation' : job.status === 'awaiting_ci' ? 'ci' : job.status;
    const jobStore = { ...original,
      list: () => original.list().filter(job => job.issue.number === task.issue),
      save(job) {
        original.save(job);
        task.r1 = structuredClone(job);
        checkpoint(task, phaseOf(job));
        return job;
      },
    };
    const reviewer = dependencies.reviewPullRequest || createClaudeReviewAdapter({ spawn: trackedSpawn });
    const discover = dependencies.discoverReadyIssues || discoverReadyIssues;
    try {
      await run(['--project', task.project], {
        ...dependencies,
        jobStore, loadProjectConfig: () => project,
        discoverReadyIssues: async value => (await discover(value)).filter(issue => issue.number === task.issue),
        reviewPullRequest: reviewer,
        ralphOptions: { ...dependencies.ralphOptions, config: store.config, spawnImpl: trackedSpawn,
          onPhaseChange: phase => {
            if (closing) throw new Error('R1 executor is stopping.');
            checkpoint(task, phase);
          },
        },
        write: () => {},
      });
      task.r1 = original.load(task.issue);
      if (!task.r1) task.failure = 'Issue is not ready and has no resumable R1 checkpoint.';
      if (!task.r1 || task.r1.terminal) finish(task, task.r1);
      else checkpoint(task, phaseOf(task.r1));
    } catch (error) {
      // R1 checkpoints expected retryable failures itself. Unexpected
      // exceptions stop this queue job instead of creating an unbounded retry.
      task.r1 = original.load(task.issue);
      if (!task.r1 || task.r1.terminal) finish(task, task.r1);
      else {
        task.failure = safeText(error.message);
        finish(task, task.r1);
      }
    }
  }

  function advance(task) {
    if (active.has(task.id) || closing) return;
    task.status = 'running';
    const promise = execute(task).catch(error => {
      task.failure = safeText(error.message);
      try { finish(task, task.r1); } catch {
        console.error(`R1 job ${task.id}: checkpoint persistence failed.`);
      }
    }).finally(() => active.delete(task.id));
    active.set(task.id, promise);
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

  return { submit, advance, recover, read, stop };
}

module.exports = { createR1Jobs };
