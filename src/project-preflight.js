const fs = require('node:fs');
const path = require('node:path');
const { spawn: nativeSpawn } = require('node:child_process');
const { captureProcess, currentRecorder } = require('./execution-log');
const { StringDecoder } = require('node:string_decoder');
const { findOnPath } = require('./engines');
const { startTime, terminatePriorR1Worker } = require('./r1-process-claim');

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
  if (!c || c.runtime !== 'node' || (requiredRuntime && requiredRuntime !== c.runtime)) {
    throw blocked('runtime_invalid', 'The project contract must select supported runtime node and match owner runtime configuration.');
  }
  if (Object.keys(c).some(key => !['runtime', 'verification', 'lockfile'].includes(key))) throw blocked('contract_invalid', 'Project contract accepts only runtime, verification and lockfile; activation and delivery belong in owner configuration.');
  if (c.lockfile !== 'package-lock.json') throw blocked('lockfile_invalid', 'Node contract requires lockfile package-lock.json.');
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
  const deadline = Date.now() + (options.timeoutMs ?? 300000);
  const cancelled = () => { try { return options.isCancelled?.() === true; } catch { return true; } };
  const check = () => {
    if (cancelled()) throw blocked('cancelled', 'Project preparation cancelled before worker admission.');
    if (Date.now() >= deadline) throw blocked('timeout', 'Project preparation exceeded its time limit.');
  };
  const record = options.recordExecution || currentRecorder() || (() => {});
  const command = (file, args, reason, applicationCheck = false) => new Promise((resolve, reject) => {
    try { check(); } catch (error) { reject(error); return; }
    let child, claim, timer, failure, stdout = '', stderr = '';
    const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure ||= error; } };
    record('command', { command: file, args, cwd: root, role: 'environment' });
    try {
      child = captureProcess(options.spawn || nativeSpawn, process.execPath, [path.join(__dirname, 'project-preflight-runner.js'), file, ...args], {
        cwd: root, env: process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      }, record);
      child.stdout.on('data', bytes => { stdout += outDecoder.write(bytes); });
      child.stderr.on('data', bytes => { stderr += errDecoder.write(bytes); });
      child.on('error', error => { failure ||= error; });
      child.stdin.on('error', error => { failure ||= error; stop(); });
      child.on('close', (exitCode, signal) => {
        clearInterval(timer);
        stdout += outDecoder.end();
        stderr += errDecoder.end();
        // Do not erase a durable claim if descendants cannot be confirmed gone.
        if (claim && !terminatePriorR1Worker({ r1Child: true, workerPid: claim.pid, workerStartTime: claim.startTime })) {
          reject(blocked('prior_process_unresolved', 'Project setup process group could not be terminated; preserve its claim before retry.')); return;
        }
        try {
          options.onProcess?.(null);
          check();
          if (failure || (exitCode !== 0 && (!applicationCheck || signal !== null || exitCode === null || [126, 127].includes(exitCode)))) throw blocked(reason, `Project command failed: ${file} ${args.join(' ')}\n${failure?.stack || ''}\n${stdout}\n${stderr}`, { command: file, args, exitCode, signal, stdout, stderr });
          resolve(applicationCheck ? { passed: exitCode === 0, exitCode, signal, stdout, stderr } : stdout);
        } catch (error) { reject(error); }
      });
      claim = { pid: child.pid, startTime: startTime(child.pid) };
      if (!claim.startTime) throw blocked('prior_process_unresolved', 'Cannot establish Linux process identity for project preparation.');
      options.onProcess?.(claim);
      child.stdin.end('start\n');
      timer = setInterval(() => { if (cancelled() || Date.now() >= deadline) stop(); }, 50);
    } catch (error) {
      if (child?.pid) { failure = error; stop(); }
      else reject(error);
    }
  });
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
