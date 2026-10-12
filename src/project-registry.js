// Owner configuration selects worker roots; task text never grants authority.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function directory(value) {
  const resolved = fs.realpathSync(value);
  if (!fs.statSync(resolved).isDirectory()) throw new Error('Registered project folder does not exist.');
  return resolved;
}

function configuredProjects(value, configPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
  const resolve = value => {
    const absolute = path.resolve(path.dirname(configPath), value);
    return fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
  };
  const entries = [];
  for (const [name, entry] of Object.entries(value)) {
    if (!name.trim()) continue;
    if (typeof entry === 'string' && entry.trim()) entries.push([name, resolve(entry)]);
    else if (entry && typeof entry.root === 'string' && entry.root.trim()
      && entry.worktrees && typeof entry.worktrees === 'object' && !Array.isArray(entry.worktrees)) {
      const worktrees = Object.fromEntries(Object.entries(entry.worktrees)
        .filter(([name, value]) => name.trim() && typeof value === 'string' && value.trim())
        .map(([name, value]) => [name, resolve(value)]));
      entries.push([name, Object.freeze({ root: resolve(entry.root), worktrees: Object.freeze(worktrees) })]);
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function worktree(root, checkout = null) {
  if (!fs.statSync(path.join(root, '.git')).isFile()) throw new Error('Authorized worktree must be an isolated Git worktree.');
  const records = git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0\0');
  const paths = records.map(record => record.split('\0').find(line => line.startsWith('worktree ')))
    .filter(Boolean).map(line => path.resolve(line.slice(9)));
  if (paths[0] === root || !paths.includes(root)) throw new Error('Authorized worktree must be registered and isolated.');
  if (checkout && path.resolve(root, git(root, ['rev-parse', '--git-common-dir']))
    !== path.resolve(checkout, git(checkout, ['rev-parse', '--git-common-dir']))) {
    throw new Error('Authorized worktree does not belong to the registered repository.');
  }
}

function checkedScope(root, configPath, checkout = null) {
  const canonical = directory(root);
  if (canonical !== path.resolve(root)) throw new Error('Registered workspace path changed through a symlink.');
  const authority = fs.realpathSync(configPath);
  const relative = path.relative(canonical, authority);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Owner registry must be outside the writable worker workspace.');
  }
  const linked = fs.existsSync(path.join(canonical, '.git')) && fs.statSync(path.join(canonical, '.git')).isFile();
  if (checkout || linked) worktree(canonical, checkout);
  return { cwd: canonical, isolatedWorktree: Boolean(checkout || linked) };
}

function resolveProject(config, project, worktreeName, configPath) {
  const registry = config.allowedProjects || {};
  if (typeof project !== 'string' || !Object.hasOwn(registry, project)) throw new Error('Unknown project.');
  const entry = registry[project];
  if (worktreeName !== undefined) {
    if (!entry || typeof entry !== 'object' || typeof worktreeName !== 'string'
      || !Object.hasOwn(entry.worktrees, worktreeName)) throw new Error('Unknown authorized worktree.');
    return checkedScope(entry.worktrees[worktreeName], configPath, directory(entry.root));
  }
  return checkedScope(typeof entry === 'string' ? entry : entry.root, configPath);
}

function resolveWorkerScope(config, requestedPath, configPath) {
  const requested = directory(requestedPath);
  for (const entry of Object.values(config.allowedProjects || {})) {
    const root = typeof entry === 'string' ? entry : entry.root;
    if (requested === path.resolve(root)) return checkedScope(root, configPath);
    for (const candidate of Object.values(typeof entry === 'object' ? entry.worktrees : {})) {
      if (requested === path.resolve(candidate)) return checkedScope(candidate, configPath, directory(root));
    }
  }
  throw new Error('Worker workspace is not explicitly authorized in the project registry.');
}

module.exports = { configuredProjects, resolveProject, resolveWorkerScope };
