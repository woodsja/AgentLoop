'use strict';

// The deployer deliberately has no timer and no user supplied ref/path.  It
// is started by an R1 completion and derives every deployment candidate from
// the durable, independently-approved merge checkpoint.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');
const { loadProjectConfig } = require('./autopilot-config');
const { createJobStore, hasPassingVerification, writeJsonDurably } = require('./autopilot-state');

const PROJECT = 'ralph';
const SERVICE = 'agentloop.service';
const DEPLOY_LOCK = 'deployment.lock';
const DEPLOY_STATE = 'deployment-state.json';
const HEALTH_TIMEOUT_MS = 30000;

function approved(job, project) {
  return Boolean(job && job.project === PROJECT && job.repo === project.repo && job.terminalState === 'merged'
    && job.merge && job.merge.repo === project.repo && job.merge.issueClosed === true
    && job.delivery && job.delivery.commit === job.merge.approvedHead
    && job.review && job.review.verdict === 'PASS' && job.review.commit === job.delivery.commit
    && Array.isArray(job.review.findings) && job.review.findings.length === 0
    && hasPassingVerification(job.verification, job.delivery.commit));
}

function git(cwd, args, exec = execFileSync) {
  try { return String(exec('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim(); }
  catch (error) { throw new Error(`Ralph deployment git ${args.join(' ')} failed: ${(error.stderr || error.message || '').toString().trim()}`); }
}

function cleanCheckout(checkout, exec) {
  if (git(checkout, ['status', '--porcelain'], exec)) throw new Error('Ralph deployment refused: installed checkout is dirty.');
  const branch = git(checkout, ['branch', '--show-current'], exec);
  if (branch !== 'ralph-dev') throw new Error('Ralph deployment refused: installed checkout is not on ralph-dev.');
}

function requestHealth(port, request = http.get) {
  return new Promise(resolve => {
    const req = request(`http://127.0.0.1:${port}/api/state`, res => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitForHealth(checkout, previousPid, options = {}) {
  const timeout = options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(checkout, 'state', 'daemon.json'), 'utf8'));
      if (Number.isSafeInteger(info.pid) && info.pid !== previousPid && Number.isInteger(info.port)
        && await (options.requestHealth || requestHealth)(info.port)) return { pid: info.pid, port: info.port, checkedAt: new Date().toISOString() };
    } catch { /* daemon is still coming up */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Ralph deployment health check timed out.');
}

async function confirmCurrentHealth(checkout, options = {}) {
  const info = JSON.parse(fs.readFileSync(path.join(checkout, 'state', 'daemon.json'), 'utf8'));
  if (!Number.isSafeInteger(info.pid) || !Number.isInteger(info.port)
    || !await (options.requestHealth || requestHealth)(info.port)) {
    throw new Error('Ralph deployment refused: the current daemon is not healthy enough to be a rollback target.');
  }
  return info;
}

function acquireLock(directory) {
  const file = path.join(directory, DEPLOY_LOCK);
  fs.mkdirSync(directory, { recursive: true });
  try {
    const descriptor = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); fs.closeSync(descriptor);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Ralph deployment refused: another deployment is underway.');
    throw error;
  }
  return () => fs.rmSync(file, { force: true });
}

function readState(directory) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, DEPLOY_STATE), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, knownGood: null, deployments: {} }; throw error; }
}
function saveState(directory, value) { writeJsonDurably(path.join(directory, DEPLOY_STATE), value); }

function runCommand(command, args, spawn = spawnSync, cwd) {
  const result = spawn(command, args, { encoding: 'utf8', ...(cwd ? { cwd } : {}) });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`);
}

async function deploy(project, job, options = {}) {
  const exec = options.execFileSync || execFileSync;
  const spawn = options.spawnSync || spawnSync;
  const stateDir = options.stateDir;
  const state = readState(stateDir);
  const sha = job.merge.commit;
  if (state.deployments[sha]?.status === 'deployed') return { status: 'noop', commit: sha, health: state.deployments[sha].health };
  cleanCheckout(project.checkout, exec);
  git(project.checkout, ['fetch', '--quiet', 'origin', project.baseBranch], exec);
  const remote = `origin/${project.baseBranch}`;
  // This rejects a stale/rewritten/unrelated merge even when someone has a
  // matching SHA in a local object database.
  git(project.checkout, ['merge-base', '--is-ancestor', sha, remote], exec);
  git(project.checkout, ['merge-base', '--is-ancestor', 'HEAD', sha], exec);
  const previous = git(project.checkout, ['rev-parse', 'HEAD'], exec);
  // A rollback target is never merely "whatever HEAD was": establish health
  // evidence for the running version first, and reject disagreement with a
  // prior confirmed deployment record.
  await confirmCurrentHealth(project.checkout, options);
  if (state.knownGood && state.knownGood !== previous) {
    throw new Error('Ralph deployment refused: installed SHA differs from the recorded known-good version.');
  }
  if (!state.knownGood) { state.knownGood = previous; saveState(stateDir, state); }
  const record = { status: 'deploying', commit: sha, previousCommit: previous, updatedAt: new Date().toISOString(), error: null, health: null };
  state.deployments[sha] = record; saveState(stateDir, state);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-deploy-'));
  try {
    // Test a detached candidate so the currently running daemon stays on its
    // known-good checkout until all validation has succeeded.
    git(project.checkout, ['worktree', 'add', '--detach', temp, sha], exec);
    git(temp, ['diff', '--check'], exec);
    runCommand('npm', ['test'], spawn, temp);
  } catch (error) {
    record.status = 'failed'; record.error = String(error.message); record.updatedAt = new Date().toISOString(); saveState(stateDir, state); throw error;
  } finally {
    try { git(project.checkout, ['worktree', 'remove', '--force', temp], exec); } catch { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  try {
    // A checked-clean fast-forward is the only mutation of the installed tree.
    git(project.checkout, ['merge', '--ff-only', sha], exec);
    const oldPid = (() => { try { return JSON.parse(fs.readFileSync(path.join(project.checkout, 'state', 'daemon.json'), 'utf8')).pid; } catch { return null; } })();
    runCommand('systemctl', ['--user', 'restart', SERVICE], spawn);
    const health = await waitForHealth(project.checkout, oldPid, options);
    record.status = 'deployed'; record.health = health; record.updatedAt = new Date().toISOString(); state.knownGood = sha; saveState(stateDir, state);
    return { status: 'deployed', commit: sha, previous, health };
  } catch (error) {
    // The checkout was proven clean before this run, and previous is an exact
    // recorded Git object; this is the only permitted hard reset.
    try { git(project.checkout, ['reset', '--hard', previous], exec); runCommand('systemctl', ['--user', 'restart', SERVICE], spawn); }
    catch (rollbackError) { error = new Error(`${error.message}; rollback failed: ${rollbackError.message}`); }
    record.status = 'rolled_back'; record.error = String(error.message); record.updatedAt = new Date().toISOString(); saveState(stateDir, state);
    error.deploymentStatus = 'rolled_back';
    throw error;
  }
}

async function run(options = {}) {
  const project = options.project || loadProjectConfig(PROJECT);
  if (project.repo !== 'woodsja/AgentLoop' || project.baseBranch !== 'ralph-dev' || project.autoMerge !== true) throw new Error('Ralph deployment refused: configured Ralph identity is not authorized.');
  const stateDir = options.stateDir || project.stateDir || path.join(require('node:os').homedir(), '.local', 'state', 'ralph-autopilot', PROJECT);
  const release = acquireLock(stateDir);
  try {
    const store = options.jobStore || createJobStore(stateDir);
    const job = store.list().find(value => approved(value, project)
      && (!value.deployment || ['pending', 'deploying'].includes(value.deployment.status)));
    if (!job) return { status: 'noop' };
    try {
      const result = await deploy(project, job, { ...options, stateDir });
      job.deployment = { status: result.status === 'noop' ? 'deployed' : result.status, commit: job.merge.commit,
        previousCommit: result.previous || null, updatedAt: new Date().toISOString(), error: null, health: result.health || null };
      store.save(job); return result;
    } catch (error) {
      // Keep the merge terminal; deployment failures must never re-open or
      // re-merge an approved PR.  The diagnostic is durable and observable.
      job.deployment = { status: error.deploymentStatus || 'failed', commit: job.merge.commit, previousCommit: null,
        updatedAt: new Date().toISOString(), error: String(error.message), health: null };
      store.save(job); throw error;
    }
  } finally { release(); }
}

if (require.main === module) run().then(result => process.stdout.write(`Ralph deployment: ${result.status}\n`)).catch(error => { process.stderr.write(`Ralph deployment failed: ${error.message}\n`); process.exitCode = 1; });

module.exports = { PROJECT, SERVICE, approved, cleanCheckout, waitForHealth, confirmCurrentHealth, acquireLock, readState, deploy, run };
