'use strict';

// Internal R1-only seam. Owner configuration selects the working directory;
// callers cannot supply a project, path, or other filesystem authority.
const fs = require('node:fs');
const path = require('node:path');
const { resolveWorkerScope, resolveProject, managesWorktree } = require('./project-registry');
const { deriveWorktreePath } = require('./autopilot-workspace');

const VALID_ID = /^t-[a-f0-9]{8}$/;
const TERMINAL_CHILD_STATUSES = new Set(['passed', 'failed', 'cancelled', 'maxed', 'partial', 'incomplete', 'plan_complete']);

function createR1ChildHandoff({ store, loadProject, configPath = store?.paths?.config }) {
  if (!store || typeof loadProject !== 'function' || !configPath
    || typeof store.enqueueR1ChildLoopOnce !== 'function'
    || typeof store.listR1ChildLoops !== 'function') {
    throw new TypeError('R1 child handoff requires a durable child store, project loader and owner registry.');
  }

  function readEligibleParent(parentJobId) {
    const parent = store.readTask(parentJobId, 'running');
    if (parent.id !== parentJobId || parent.workflow !== 'r1' || parent.status !== 'running'
      || !Number.isSafeInteger(parent.issue) || parent.issue < 1) throw new Error('R1 parent job is not eligible.');
    const job = parent.r1;
    if (!job || job.terminal || job.project !== parent.project || job.issue?.number !== parent.issue
      || job.status !== 'running' || job.workspaceState !== 'prepared'
      || !Number.isSafeInteger(job.runs) || job.runs < 1) throw new Error('R1 implementation attempt is not active.');
    return parent;
  }

  function ensure(parentJobId) {
    if (typeof parentJobId !== 'string' || !VALID_ID.test(parentJobId)) throw new Error('Invalid R1 parent job ID.');
    const parent = readEligibleParent(parentJobId);
    const job = parent.r1;
    const attempt = job.runs;

    const project = loadProject(parent.project);
    if (!project.enabled || project.worker !== 'codex' || !['always', 'risk'].includes(project.reviewPolicy)) {
      throw new Error('R1 project configuration does not authorize the implementation attempt.');
    }
    const owner = store.config.allowedProjects?.[parent.project];
    const projectScope = resolveProject(store.config, parent.project, undefined, configPath);
    if (fs.realpathSync(project.checkout) !== projectScope.cwd) throw new Error('R1 checkout does not match owner registry.');
    const expected = deriveWorktreePath(project, { number: parent.issue, title: job.issue.title });
    if (!managesWorktree(owner, expected) || job.worktreePath !== expected) {
      throw new Error('R1 worktree is not the authorized managed issue worktree.');
    }
    const scope = resolveWorkerScope(store.config, expected, configPath);
    if (!scope.isolatedWorktree || scope.cwd !== expected) throw new Error('R1 child requires an isolated owned Git worktree.');

    const existing = store.listR1ChildLoops(parentJobId);
    for (const child of existing) {
      if (!child.task) throw new Error('R1 child reservation has no queue record; manual recovery required.');
      if (child.attempt !== attempt && !(child.stage === 'done' && TERMINAL_CHILD_STATUSES.has(child.task.status))) {
        throw new Error('An earlier R1 implementation child is still active; refusing overlapping attempt.');
      }
      if (child.attempt === attempt && (child.task.project !== parent.project || child.task.projectPath !== expected
        || child.task.r1Child?.issue !== parent.issue || child.task.workerEngine !== 'codex'
        || child.task.criticEngine !== 'claude')) {
        throw new Error('Persisted R1 child does not match authorized parent.');
      }
    }
    if (parent.childAttempt !== undefined && parent.childAttempt > attempt) {
      throw new Error('R1 parent child checkpoint belongs to a future attempt.');
    }
    if (parent.childAttempt === attempt && parent.childLoopId
      && !existing.some(child => child.attempt === attempt && child.id === parent.childLoopId)) {
      throw new Error('R1 parent child checkpoint does not match durable loop state.');
    }

    if (!existing.some(child => child.attempt === attempt)
      && !fs.statSync(path.join(expected, 'PLAN.md'), { throwIfNoEntry: false })?.isFile()) {
      throw new Error('R1 child requires prepared PLAN.md; no loop queued.');
    }
    // This internal handoff is synchronous under the daemon's single-writer
    // ownership. Nothing can change parent state between this check and the
    // durable queue write in the same call. #67 must revalidate immediately
    // before a queued child is executed, since cancellation can happen later.
    const latest = readEligibleParent(parentJobId);
    if (latest.project !== parent.project || latest.issue !== parent.issue || latest.r1.runs !== attempt
      || latest.r1.worktreePath !== expected || latest.childLoopId !== parent.childLoopId) {
      throw new Error('R1 parent changed while requesting its child loop.');
    }

    const child = store.enqueueR1ChildLoopOnce(parentJobId, attempt, {
      project: parent.project, projectPath: expected, source: 'r1', title: `R1 issue #${parent.issue} implementation`,
      engine: 'codex', workerEngine: 'codex', criticEngine: 'claude', autoCommit: true,
      maxCycles: 3, taskRetries: 2, r1Child: { parentJobId, attempt, issue: parent.issue },
    });
    // Re-read the parent rather than writing back the earlier eligibility
    // snapshot. The durable child index remains authoritative if this last
    // checkpoint fails or power is lost: a retry will find the same child.
    const current = readEligibleParent(parentJobId);
    if (current.r1.runs !== attempt || current.r1.worktreePath !== expected
      || (current.childAttempt === attempt && current.childLoopId && current.childLoopId !== child.id)) {
      throw new Error('R1 parent changed before its child checkpoint.');
    }
    store.writeTask({ ...current, childLoopId: child.id, childAttempt: attempt }, 'running');
    return child;
  }

  return { ensure };
}

module.exports = { createR1ChildHandoff };
