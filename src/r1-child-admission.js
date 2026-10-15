'use strict';

const fs = require('node:fs');
const { resolveProject, resolveWorkerScope } = require('./project-registry');
const { deriveWorktreePath } = require('./autopilot-workspace');
const { loadProjectConfig } = require('./autopilot-config');

// Reauthorize the exact parent, attempt and owned Git worktree immediately
// before execution. A durable child reservation is identity, not permission.
function authorizeR1Child(child, {
  store,
  resolveScope = resolveWorkerScope,
  resolveRoot = resolveProject,
  loadProject = loadProjectConfig,
  derivePath = deriveWorktreePath,
} = {}) {
  const claim = child?.r1Child;
  if (child?.type !== 'loop' || child.source !== 'r1'
    || !claim || typeof claim.parentJobId !== 'string'
    || !Number.isSafeInteger(claim.attempt) || claim.attempt < 1) {
    throw new Error('Invalid R1 child execution claim.');
  }
  const parent = store.readTask(claim.parentJobId, 'running');
  const job = parent.r1;
  if (parent.id !== claim.parentJobId || parent.workflow !== 'r1' || parent.status !== 'running'
    || parent.cancelRequested || parent.issue !== claim.issue || parent.project !== child.project
    || !job || job.terminal || job.status !== 'running' || job.workspaceState !== 'prepared'
    || job.project !== parent.project || job.issue?.number !== parent.issue
    || job.runs !== claim.attempt) throw new Error('R1 parent is not active for this child attempt.');
  const project = loadProject(parent.project);
  if (!project.enabled || project.worker !== 'codex' || !['risk', 'always'].includes(project.reviewPolicy)) {
    throw new Error('R1 project is not authorized for child execution.');
  }
  const ownerRoot = resolveRoot(store.config, parent.project, undefined, store.paths.config);
  if (fs.realpathSync(project.checkout) !== ownerRoot.cwd) {
    throw new Error('R1 project checkout differs from owner registry.');
  }
  const derived = derivePath(project, { number: parent.issue, title: job.issue.title });
  if (child.projectPath !== derived || job.worktreePath !== derived) {
    throw new Error('R1 child worktree does not match its parent.');
  }
  const scope = resolveScope(store.config, derived, store.paths.config);
  if (!scope.isolatedWorktree || scope.cwd !== derived) throw new Error('R1 child worktree scope is unauthorized.');
  const owned = store.listR1ChildLoops(parent.id).filter(item => item.attempt === claim.attempt);
  if (owned.length !== 1 || owned[0].id !== child.id || owned[0].stage !== 'pending'
    || owned[0].task?.id !== child.id) throw new Error('R1 child reservation does not authorize this pending loop.');
  if (child.workerEngine !== 'codex' || child.criticEngine !== 'claude' || child.engine !== 'codex') {
    throw new Error('R1 child engine roles are unauthorized.');
  }
  return parent;
}

module.exports = { authorizeR1Child };
