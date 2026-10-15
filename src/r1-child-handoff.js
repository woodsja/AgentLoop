'use strict';

// Internal R1-only seam. No HTTP or MCP route accepts a filesystem path here.
const fs = require('node:fs');
const path = require('node:path');
const { resolveWorkerScope, resolveProject, managesWorktree } = require('./project-registry');
const { deriveWorktreePath } = require('./autopilot-workspace');

const VALID_ID = /^t-[a-f0-9]{8}$/;

function createR1ChildHandoff({ store, loadProject, configPath = store?.paths?.config }) {
  if (!store || typeof loadProject !== 'function' || !configPath) throw new TypeError('R1 child handoff requires an owner store, project loader and config path.');

  function ensure(parentJobId) {
    if (typeof parentJobId !== 'string' || !VALID_ID.test(parentJobId)) throw new Error('Invalid R1 parent job ID.');
    // Parent must be actively executing. A caller cannot manufacture a new
    // authorized path by providing an arbitrary project or worktree string.
    const parent = store.readTask(parentJobId, 'running');
    if (parent.id !== parentJobId || parent.workflow !== 'r1' || parent.status !== 'running'
      || !Number.isSafeInteger(parent.issue) || parent.issue < 1) throw new Error('R1 parent job is not eligible.');
    const job = parent.r1;
    if (!job || job.terminal || job.project !== parent.project || job.issue?.number !== parent.issue
      || job.status !== 'running' || job.workspaceState !== 'prepared'
      || !Number.isSafeInteger(job.runs) || job.runs < 1) throw new Error('R1 implementation attempt is not active.');

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
    const attempt = job.runs;
    if (parent.childAttempt !== undefined && parent.childAttempt !== attempt) {
      throw new Error('R1 parent child checkpoint belongs to another attempt.');
    }

    // Scan the authoritative queue before writing anything. If enqueue
    // succeeded but a subsequent parent checkpoint failed, this discovers the
    // already durable child. Reject competing children rather than guessing.
    const children = ['pending', 'running', 'done'].flatMap(stage =>
      store.listTasks(stage).filter(task => task.type === 'loop' && task.r1Child?.parentJobId === parentJobId
        && task.r1Child?.attempt === attempt));
    if (children.length > 1) throw new Error('Duplicate R1 child loops detected; refusing further execution.');
    if (parent.childLoopId && (!children.length || children[0].id !== parent.childLoopId)) {
      throw new Error('R1 parent child checkpoint does not match durable loop state.');
    }
    if (children.length) {
      const child = children[0];
      if (child.project !== parent.project || child.projectPath !== expected || child.workerEngine !== 'codex'
        || child.criticEngine !== 'claude' || child.r1Child.issue !== parent.issue) {
        throw new Error('Persisted R1 child does not match authorized parent.');
      }
      return { id: child.id, created: false };
    }

    if (!fs.statSync(path.join(expected, 'PLAN.md'), { throwIfNoEntry: false })?.isFile()) {
      throw new Error('R1 child requires prepared PLAN.md; no loop queued.');
    }
    const child = store.enqueueLoop({
      project: parent.project, projectPath: expected, source: 'r1', title: `R1 issue #${parent.issue} implementation`,
      engine: 'codex', workerEngine: 'codex', criticEngine: 'claude', autoCommit: true,
      maxCycles: 3, taskRetries: 2, r1Child: { parentJobId, attempt, issue: parent.issue },
    });
    // This is a helpful checkpoint, not the authority: child records remain
    // discoverable after a crash before this update is written.
    store.writeTask({ ...parent, childLoopId: child.id, childAttempt: attempt }, 'running');
    return { id: child.id, created: true };
  }

  return { ensure };
}

module.exports = { createR1ChildHandoff };
