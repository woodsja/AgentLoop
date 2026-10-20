const fs = require('node:fs');
const path = require('node:path');
const { findOnPath } = require('./engines');

function blocked(reason, message, details = {}) {
  const outcome = { status: 'blocked', category: 'infrastructure', reason, message, ...details, at: new Date().toISOString() };
  return Object.assign(new Error(message), { code: 'PROJECT_PREFLIGHT_BLOCKED', outcome });
}
function readJSON(file, reason) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw blocked(reason, `Unable to read ${file}: ${error.message}`); }
}
function readContract(root, requiredRuntime) {
  const file = path.join(root, '.ralph/project.json');
  const c = readJSON(file, fs.existsSync(file) ? 'contract_invalid' : 'contract_missing');
  if (!c || !['node', 'python'].includes(c.runtime) || (requiredRuntime && requiredRuntime !== c.runtime)) {
    throw blocked('runtime_invalid', 'The project contract must select supported runtime node or python and match owner runtime configuration.');
  }
  if (Object.keys(c).some(key => !['runtime', 'verification', 'lockfile'].includes(key))) throw blocked('contract_invalid', 'Project contract accepts only runtime, verification and lockfile; activation and delivery belong in owner configuration.');
  if (c.runtime === 'node' && c.lockfile !== 'package-lock.json') throw blocked('lockfile_invalid', 'Node contract requires lockfile package-lock.json.');
  if (c.runtime === 'python' && c.lockfile !== 'uv.lock') throw blocked('lockfile_invalid', 'Python contract requires lockfile uv.lock.');
  if (c.runtime === 'python') {
    if (typeof c.verification !== 'string' || !c.verification.trim() || c.verification.includes('\0')) throw blocked('verification_missing', 'Python contract verification must be a nonempty shell command using the project environment.');
    return c;
  }
  if (typeof c.verification !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(c.verification)) throw blocked('verification_missing', 'Contract verification must name an npm script in package.json.');
  return c;
}

async function prepareNode(root, project, options = {}) {
  const contract = readContract(root, project.runtime);
  const pkg = readJSON(path.join(root, 'package.json'), 'package_invalid');
  if (typeof pkg?.scripts?.[contract.verification] !== 'string' || !pkg.scripts[contract.verification].trim()) throw blocked('verification_missing', `package.json must define invocable script ${contract.verification}.`);
  const lockPath = path.join(root, contract.lockfile);
  const lock = readJSON(lockPath, fs.existsSync(lockPath) ? 'lockfile_invalid' : 'lockfile_missing');
  if (![1, 2, 3].includes(lock?.lockfileVersion) || (lock.lockfileVersion >= 2 && !lock.packages?.[''])) throw blocked('lockfile_invalid', 'package-lock.json must be a compatible npm lockfile (version 1, 2 or 3).');
  const original = fs.readFileSync(lockPath);
  const { command, check } = require('./project-preflight-command').preparationCommands(root, options);
  const node = findOnPath('node'), npm = findOnPath('npm');
  if (!node || !npm) throw blocked('runtime_missing', 'Node and npm must be executable on the ordinary daemon PATH, including system locations.');
  const committed = await command('git', ['show', 'HEAD:package-lock.json'], 'lockfile_uncommitted');
  if (!original.equals(Buffer.from(committed))) throw blocked('lockfile_uncommitted', 'package-lock.json must match the committed HEAD lockfile before npm ci.');
  await command(node, ['--version'], 'runtime_missing');
  await command(npm, ['--version'], 'runtime_missing');
  await command(npm, ['ci', '--foreground-scripts', '--no-audit', '--no-fund'], 'install_failed');
  if (!fs.existsSync(lockPath) || !original.equals(fs.readFileSync(lockPath))) throw blocked('lockfile_changed', 'Project setup changed package-lock.json; commit a compatible lockfile before retrying.');
  // Exercise the entry point: ordinary failing tests are application evidence,
  // while shell command-not-found/not-executable exits block tool readiness.
  const baseline = await command(npm, ['run', contract.verification], 'verification_unavailable', true);
  if (!fs.existsSync(lockPath) || !original.equals(fs.readFileSync(lockPath))) throw blocked('lockfile_changed', 'Project checks changed package-lock.json; restore the committed lockfile before retrying.');
  check();
  return { status: 'ready', category: 'infrastructure', runtime: 'node', baseline, verification: `npm run ${contract.verification}`, at: new Date().toISOString() };
}
module.exports = { prepareNode, readContract, blocked };
