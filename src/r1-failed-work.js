'use strict';

// An owner-side recovery boundary. It never runs an agent, changes the
// worktree, commits source, or authorizes replay of a failed child.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('./execution-log');

const SOURCE_FILE = /\.(?:py|js|jsx|ts|tsx)$/i;
const SAFE_PATH = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:py|js|jsx|ts|tsx)$/i;
const FORBIDDEN_PATH = /(?:^|\/)(?:\.env[^/]*|\.git|\.venv|__pycache__|node_modules|plan\.md|state\.md|guidelines\.md|[^/]*(?:secret|password|token|credential|private|bank|finance[_-]?data)[^/]*)$/i;
const SECRET_TEXT = /-----BEGIN [^-\n]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16}|sk-(?:proj-|live-)[^\s'"`]+)\b|\b(?:password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"\n]{8,}['"]/i;
const MAX_PATCH_BYTES = 256 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const PARENT_ID = /^t-[a-f0-9]{8}$/;
const CHILD_ID = /^t-[a-f0-9]{24}$/;

function git(cwd, args, { asBuffer = false } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', ...args], {
    cwd, encoding: asBuffer ? 'buffer' : 'utf8', timeout: 15000,
    maxBuffer: MAX_PATCH_BYTES * 4, env: { ...env, GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
      GIT_CONFIG_PARAMETERS: '' },
  });
}
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function trustedAncestor(file) {
  let ancestor = file;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (ancestor === parent) throw new Error('R1 recovery state path cannot be resolved.');
    ancestor = parent;
  }
  return { ancestor, actual: fs.realpathSync(ancestor) };
}
function rejectActiveGitConfig(dir) {
  // Git's read-only configuration introspection does not run filters, hooks,
  // or fsmonitor. Any local include or filter makes recovery unsafe.
  const config = git(dir, ['config', '--local', '--list', '--null']).split('\0');
  if (config.some(x => /^(?:filter\.|include\.|includeif\.|core\.fsmonitor|core\.worktree|diff\.|core\.attributesfile|core\.hooksPath|core\.sshcommand|credential\.)/i.test(x))) {
    throw new Error('R1 recovery refused: repository can execute or include external Git configuration.');
  }
  const extra = git(dir, ['rev-parse', '--git-path', 'config.worktree']).trim();
  if (fs.existsSync(path.isAbsolute(extra) ? extra : path.join(dir, extra))) {
    throw new Error('R1 recovery refused: worktree-local Git configuration is not trusted.');
  }
  const info = git(dir, ['rev-parse', '--git-path', 'info/attributes']).trim();
  if (fs.existsSync(path.isAbsolute(info) ? info : path.join(dir, info))) {
    throw new Error('R1 recovery refused: repository-local attributes may invoke Git filters.');
  }
}

function fsyncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeDurable(file, contents) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function checkOwner({ project, job, owner, workspace, stateRoot }) {
  if (project?.implementationStrategy !== 'worker-critic-loop' || project.repo !== job?.repo
    || !job?.issue || !Number.isSafeInteger(job.issue.number) || job.issue.number < 1
    || !Number.isSafeInteger(job.runs) || job.runs < 1) {
    throw new Error('R1 recovery requires a matching owner-managed mixed-engine job.');
  }
  if (!PARENT_ID.test(owner?.parentJobId || '')) throw new Error('R1 recovery parent identity is invalid.');
  if (!CHILD_ID.test(owner?.childLoopId || '')) throw new Error('R1 recovery child identity is invalid.');
  if (owner.attempt !== job.runs) throw new Error('R1 recovery child attempt differs from parent attempt.');
  if (!owner.childTerminal || !['failed', 'cancelled', 'maxed', 'incomplete', 'partial'].includes(owner.childStatus)) {
    throw new Error('R1 recovery requires a terminal failed child, not an active or approved one.');
  }
  const dir = path.resolve(workspace?.worktreePath || '');
  const recorded = path.resolve(job.worktreePath || '');
  if (dir !== recorded || path.basename(dir) !== `issue-${job.issue.number}`) {
    throw new Error('R1 recovery worktree does not match the parent job.');
  }
  const managedRoot = fs.realpathSync(project.worktreeRoot);
  if (!dir.startsWith(`${managedRoot}${path.sep}`) || fs.realpathSync(dir) !== dir) {
    throw new Error('R1 recovery requires the authorized real worktree.');
  }
  const checkout = fs.realpathSync(project.checkout);
  const records = git(checkout, ['worktree', 'list', '--porcelain']).split(/\n\n/);
  const match = records.some(record => record.split(/\r?\n/).includes(`worktree ${dir}`)
    && record.split(/\r?\n/).includes(`branch refs/heads/${workspace.branch}`));
  if (!match || !new RegExp(`^ralph/issue-${job.issue.number}-[A-Za-z0-9._-]+$`).test(workspace.branch || '')) {
    throw new Error('R1 recovery refused: worktree is not registered on the authorized issue branch.');
  }
  const baseline = job.ralph?.baselineSha;
  if (!SHA.test(baseline || '')) throw new Error('R1 recovery baseline is absent or invalid.');
  try { git(dir, ['merge-base', '--is-ancestor', baseline, 'HEAD']); }
  catch { throw new Error('R1 recovery baseline is not an ancestor of the current implementation.'); }
  if (!path.isAbsolute(stateRoot) || stateRoot === dir) throw new Error('R1 recovery state directory is not owner managed.');
  const resolvedState = path.resolve(stateRoot);
  const { ancestor, actual } = trustedAncestor(resolvedState);
  if (actual !== ancestor) {
    throw new Error('R1 recovery refused: state directory ancestors contain a symlink.');
  }
  if (resolvedState === dir || resolvedState.startsWith(`${dir}${path.sep}`)
    || resolvedState === checkout || resolvedState.startsWith(`${checkout}${path.sep}`)) {
    throw new Error('R1 recovery must be saved outside the implementation worktree and repository.');
  }
  return { dir, baseline, stateRoot: resolvedState };
}

function approvedPaths(project) {
  const paths = project.recoveryPaths;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 24 || paths.some(p => typeof p !== 'string'
    || !SAFE_PATH.test(p) || FORBIDDEN_PATH.test(p) || !SOURCE_FILE.test(p))) {
    throw new Error('R1 recovery requires an exact, safe project recoveryPaths allowlist.');
  }
  if (new Set(paths).size !== paths.length) throw new Error('R1 recoveryPaths contains duplicate file names.');
  return new Set(paths);
}

function changedTrackedPaths(dir, baseline) {
  const bytes = git(dir, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '--no-renames', '-z', baseline, '--'], { asBuffer: true });
  const fields = bytes.toString('utf8').split('\0').filter(Boolean);
  if (fields.length % 2 !== 0) throw new Error('Malformed Git tracked-file change status; recovery refused.');
  const changes = [];
  for (let i = 0; i < fields.length; i += 2) {
    const [status, filename] = fields.slice(i, i + 2);
    if (status !== 'M' || filename.includes('\n') || filename.includes('\r') || filename.includes('\\')) {
      throw new Error('R1 recovery contains unsupported tracked-file changes.');
    }
    changes.push(filename);
  }
  return changes;
}

function captureFailedWork({ project, job, owner, workspace, stateRoot }) {
  const { dir, baseline, stateRoot: root } = checkOwner({ project, job, owner, workspace, stateRoot });
  rejectActiveGitConfig(dir);
  const changes = changedTrackedPaths(dir, baseline);
  const untracked = git(dir, ['ls-files', '--others', '--exclude-standard', '-z'], { asBuffer: true })
    .toString('utf8').split('\0').filter(Boolean)
    .filter(p => !['PLAN.md', 'STATE.md', 'GUIDELINES.md'].includes(p));
  if (untracked.length) throw new Error('R1 recovery refused: unexpected untracked files may contain sensitive data.');
  if (!changes.length) return null;
  const allowlist = approvedPaths(project);
  for (const filename of changes) {
    if (!allowlist.has(filename) || !SAFE_PATH.test(filename) || FORBIDDEN_PATH.test(filename)) {
      throw new Error('R1 recovery refused: modified source is outside the owner recoveryPaths allowlist.');
    }
    const full = path.join(dir, filename);
    const actual = fs.realpathSync(full);
    if (actual !== full || !actual.startsWith(`${dir}${path.sep}`)) {
      throw new Error('R1 recovery refused: source path traverses a symlink or leaves the worktree.');
    }
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('R1 recovery refused: source is a symlink or not a regular file.');
    const original = git(dir, ['ls-tree', baseline, '--', filename]);
    if (!original.startsWith('100644 blob ') && !original.startsWith('100755 blob ')) {
      throw new Error('R1 recovery refused: source was not tracked as a regular file at baseline.');
    }
    const summary = git(dir, ['diff', '--summary', baseline, '--', filename]);
    if (summary.trim()) throw new Error('R1 recovery refused: source mode or file type changed.');
  }
  const paths = changes.sort();
  const patch = git(dir, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--full-index', '--binary', baseline, '--', ...paths], { asBuffer: true });
  if (!patch.length || patch.length > MAX_PATCH_BYTES || patch.includes(Buffer.from([0]))
    || /GIT binary patch|Binary files .* differ|^literal \d+$/m.test(patch.toString('utf8'))) {
    throw new Error('R1 recovery refuses empty, oversized or binary source patches.');
  }
  const raw = patch.toString('utf8');
  if (SECRET_TEXT.test(raw)) throw new Error('R1 recovery refused: potential secret or credential in source patch.');
  const patchHash = sha(patch);
  const relative = path.join('recovery', `issue-${job.issue.number}`, owner.parentJobId,
    `attempt-${owner.attempt}`);
  const directory = path.join(root, relative);
  const receipt = Object.freeze({ status: 'captured', project: job.project, issue: job.issue.number,
    parentJobId: owner.parentJobId, childLoopId: owner.childLoopId, attempt: owner.attempt,
    baselineSha: baseline, headSha: git(dir, ['rev-parse', 'HEAD']).trim(),
    sha256: patchHash, paths, patchRelativePath: path.join(relative, 'changes.patch') });
  const manifest = path.join(directory, 'receipt.json');
  const changesFile = path.join(directory, 'changes.patch');
  if (fs.existsSync(directory)) {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(manifest, 'utf8')); }
    catch { throw new Error('R1 recovery has incomplete or corrupt prior artifact; worktree retained.'); }
    if (JSON.stringify(saved) !== JSON.stringify(receipt) || !fs.existsSync(changesFile)
      || sha(fs.readFileSync(changesFile)) !== receipt.sha256) {
      throw new Error('R1 recovery artifact digest or ownership mismatch; worktree retained.');
    }
    return receipt;
  }
  // Treat owner state as sensitive; snapshot path is not exposed on GitHub.
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stateStats = fs.lstatSync(root);
  if (!stateStats.isDirectory() || stateStats.isSymbolicLink()
    || (stateStats.mode & 0o077) !== 0 || stateStats.uid !== process.getuid()) {
    throw new Error('R1 recovery requires an owner-private state directory (0700).');
  }
  let parent = root;
  for (const name of relative.split(path.sep)) {
    parent = path.join(parent, name);
    fs.mkdirSync(parent, { mode: 0o700 });
    const details = fs.lstatSync(parent);
    if (!details.isDirectory() || details.isSymbolicLink()
      || details.uid !== process.getuid() || (details.mode & 0o077) !== 0) {
      throw new Error('R1 recovery path has an unsafe directory or permissions.');
    }
    fsyncDirectory(path.dirname(parent));
  }
  writeDurable(changesFile, patch);
  writeDurable(manifest, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`));
  fsyncDirectory(directory);
  return receipt;
}

function bindR1Parent(job, parentId) {
  if (!PARENT_ID.test(parentId || '') || !job || !job.ralph || typeof job.ralph !== 'object') {
    throw new Error('R1 checkpoint missing valid parent or Ralph state.');
  }
  if (job.r1ParentJobId && job.r1ParentJobId !== parentId) {
    throw new Error('R1 checkpoint refused to overwrite durable parent ownership.');
  }
  if (!job.r1ParentJobId) {
    if (job.terminal || job.runs > 0) {
      throw new Error('R1 checkpoint refused to adopt previously running or terminal job without owner identity.');
    }
    job.r1ParentJobId = parentId;
  }
  return job;
}

function captureFailedR1Job({ project, job, workspace, queueStore, stateRoot }) {
  if (project?.implementationStrategy !== 'worker-critic-loop' || !job?.ralph) return null;
  if (job.delivery?.pushed || job.ralph.status === 'passed') return null;
  const parentJobId = job.r1ParentJobId;
  if (!PARENT_ID.test(parentJobId || '') || typeof queueStore?.listR1ChildLoops !== 'function') {
    throw new Error('R1 failed-work recovery parent identity is missing or invalid.');
  }
  const children = queueStore.listR1ChildLoops(parentJobId);
  if (children.some(child => child.stage !== 'done' || !child.task
    || !['passed', 'failed', 'cancelled', 'maxed', 'partial', 'incomplete'].includes(child.task.status))) {
    throw new Error('R1 failed-work recovery refused: active or ambiguous child still attached.');
  }
  const matching = children.filter(child => child.attempt === job.runs);
  if (matching.length !== 1) throw new Error('R1 recovery requires exactly one terminal child for this attempt.');
  const [selected] = matching;
  if (selected.task.status === 'passed') return null;
  return captureFailedWork({ project, job, workspace, stateRoot,
    owner: { parentJobId, childLoopId: selected.id, attempt: selected.attempt,
      childTerminal: true, childStatus: selected.task.status } });
}

module.exports = { captureFailedWork, captureFailedR1Job, bindR1Parent };
