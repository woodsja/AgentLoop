const fs = require('node:fs');
const path = require('node:path');
const { findOnPath } = require('./engines');
const { readContract, blocked } = require('./project-preflight');
const { preparationCommands } = require('./project-preflight-command');

async function preparePython(root, project, options = {}) {
  const contract = readContract(root, project.runtime || 'python');
  const metadata = path.join(root, 'pyproject.toml'), lockPath = path.join(root, contract.lockfile);
  if (!fs.existsSync(metadata)) throw blocked('package_invalid', 'Python setup requires pyproject.toml; restore project metadata before retrying.');
  if (!fs.existsSync(lockPath)) throw blocked('lockfile_missing', 'Python setup requires committed uv.lock; run uv lock and commit it before retrying.');
  const original = fs.readFileSync(lockPath);
  const uv = findOnPath('uv');
  if (!uv) throw blocked('runtime_missing', 'Install uv on the ordinary daemon PATH and provide a compatible Python interpreter, then retry Python setup.');
  // Pin the conventional local target even if the daemon has an active venv or
  // UV_PROJECT_ENVIRONMENT. Keep normal indexes, caches and other VM settings.
  const env = { ...process.env, UV_PROJECT_ENVIRONMENT: path.join(root, '.venv'), VIRTUAL_ENV: path.join(root, '.venv') };
  const { command, check } = preparationCommands(root, { ...options, env });
  const committed = await command('git', ['show', 'HEAD:uv.lock'], 'lockfile_uncommitted');
  if (!original.equals(Buffer.from(committed))) throw blocked('lockfile_uncommitted', 'uv.lock must match committed HEAD; commit a compatible lockfile before retrying.');
  await command(uv, ['--version'], 'runtime_missing');
  try { await command(uv, ['sync', '--locked'], 'install_failed'); }
  catch (error) {
    if (error.outcome?.reason === 'install_failed') {
      error.message += '\nRestore source connectivity/cache or install a compatible Python interpreter as indicated above. For invalid/stale uv.lock, run uv lock and commit the compatible lockfile before retrying; setup never repairs it.';
      error.outcome.message = error.message;
    }
    throw error;
  }
  const unchanged = () => {
    if (!fs.existsSync(lockPath) || !original.equals(fs.readFileSync(lockPath))) throw blocked('lockfile_changed', 'Python setup/checks changed uv.lock; restore and commit a compatible lockfile before retrying.');
  };
  unchanged();
  const python = path.join(root, '.venv/bin/python');
  await command(python, ['-c', 'import sys; assert sys.prefix != sys.base_prefix; print(sys.executable)'], 'runtime_missing');
  const verification = `export VIRTUAL_ENV="$PWD/.venv"; export PATH="$PWD/.venv/bin:$PATH"; ${contract.verification}`;
  const baseline = await command('/bin/sh', ['-c', verification], 'verification_unavailable', true);
  unchanged();
  check();
  return { status: 'ready', category: 'infrastructure', runtime: 'python', baseline, verification, at: new Date().toISOString() };
}
module.exports = { preparePython };
