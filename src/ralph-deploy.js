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
  // A oneshot can be killed by a reboot after creating this file.  Its PID is
  // deliberately part of the lock so a later, explicit deployment launch can
  // recover; an unreadable lock fails closed rather than being guessed stale.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); fs.closeSync(descriptor);
      return () => fs.rmSync(file, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Ralph deployment refused: another deployment is underway.'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Ralph deployment refused: another deployment is underway.');
      try { process.kill(owner.pid, 0); throw new Error('Ralph deployment refused: another deployment is underway.'); }
      catch (ownerError) {
        if (ownerError.message === 'Ralph deployment refused: another deployment is underway.' || ownerError.code === 'EPERM') throw ownerError;
        if (ownerError.code !== 'ESRCH') throw new Error('Ralph deployment refused: another deployment is underway.');
        // Atomically move the observed stale inode aside.  Unlinking by name
        // here could otherwise remove a lock another process acquired between
        // our liveness check and the cleanup.
        const stale = `${file}.stale.${process.pid}.${Date.now()}`;
        try { fs.renameSync(file, stale); fs.rmSync(stale, { force: true }); }
        catch (renameError) { if (renameError.code !== 'ENOENT') throw renameError; }
      }
    }
  }
  throw new Error('Ralph deployment refused: another deployment is underway.');
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
  const saved = state.deployments[sha];
  if (saved?.status === 'deployed') return { status: 'noop', commit: sha, previous: saved.previousCommit, health: saved.health };
  cleanCheckout(project.checkout, exec);
  git(project.checkout, ['fetch', '--quiet', 'origin', project.baseBranch], exec);
  const remote = `origin/${project.baseBranch}`;
  // This rejects a stale/rewritten/unrelated merge even when someone has a
  // matching SHA in a local object database.
  git(project.checkout, ['merge-base', '--is-ancestor', sha, remote], exec);
  const head = git(project.checkout, ['rev-parse', 'HEAD'], exec);
  let targetAlreadyInstalled = head === sha;
  if (!targetAlreadyInstalled) {
    try { git(project.checkout, ['merge-base', '--is-ancestor', 'HEAD', sha], exec); }
    catch {
      // An older approved merge contained by a newer deployment is a safe
      // no-op.  It must not be retroactively marked as a failed deployment.
      try { git(project.checkout, ['merge-base', '--is-ancestor', sha, 'HEAD'], exec); }
      catch { throw new Error('Ralph deployment refused: installed branch cannot fast-forward to the approved merge.'); }
      return { status: 'noop', commit: sha, previous: saved?.previousCommit || null, health: saved?.health || null };
    }
  }
  const previous = saved?.previousCommit || head;
  // This is the interrupted window: the fast-forward succeeded but the
  // process died before restart/health persistence.  Restart the candidate,
  // retaining the durable pre-merge rollback target.
  const resuming = targetAlreadyInstalled && saved?.status === 'deploying';
  if (targetAlreadyInstalled && !resuming) return { status: 'noop', commit: sha, previous: saved?.previousCommit || null, health: saved?.health || null };
  // A rollback target is never merely "whatever HEAD was": establish health
  // evidence for the running version first, and reject disagreement with a
  // prior confirmed deployment record.
  if (!resuming) await confirmCurrentHealth(project.checkout, options);
  if (state.knownGood && state.knownGood !== previous) {
    throw new Error('Ralph deployment refused: installed SHA differs from the recorded known-good version.');
  }
  if (!state.knownGood) { state.knownGood = previous; saveState(stateDir, state); }
  const record = saved?.status === 'deploying' ? saved : { status: 'deploying', commit: sha, previousCommit: previous, updatedAt: new Date().toISOString(), error: null, health: null };
  state.deployments[sha] = record; saveState(stateDir, state);
  const temp = resuming ? null : fs.mkdtempSync(path.join(options.tempDir || os.tmpdir(), 'ralph-deploy-'));
  try { if (!resuming) {
    // Test a detached candidate so the currently running daemon stays on its
    // known-good checkout until all validation has succeeded.
    git(project.checkout, ['worktree', 'add', '--detach', temp, sha], exec);
    git(temp, ['diff', '--check'], exec);
    runCommand('npm', ['test'], spawn, temp);
  }
  } catch (error) {
    record.status = 'failed'; record.outcome = 'FAILED_DEPLOYMENT'; record.error = String(error.message); record.updatedAt = new Date().toISOString(); saveState(stateDir, state); error.previousCommit = previous; throw error;
  } finally {
    if (temp) try { git(project.checkout, ['worktree', 'remove', '--force', temp], exec); } catch { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  let oldPid = null;
  try {
    // A checked-clean fast-forward is the only mutation of the installed tree.
    if (!resuming) git(project.checkout, ['merge', '--ff-only', sha], exec);
    oldPid = (() => { try { return JSON.parse(fs.readFileSync(path.join(project.checkout, 'state', 'daemon.json'), 'utf8')).pid; } catch { return null; } })();
    runCommand('systemctl', ['--user', 'restart', SERVICE], spawn);
    const health = await waitForHealth(project.checkout, oldPid, options);
    record.status = 'deployed'; record.health = health; record.updatedAt = new Date().toISOString(); state.knownGood = sha; saveState(stateDir, state);
    return { status: 'deployed', commit: sha, previous, health };
  } catch (error) {
    // The checkout was proven clean before this run, and previous is an exact
    // recorded Git object; this is the only permitted hard reset.
    try {
      git(project.checkout, ['reset', '--hard', previous], exec);
      runCommand('systemctl', ['--user', 'restart', SERVICE], spawn);
      await waitForHealth(project.checkout, oldPid, options);
      record.status = 'rolled_back';
    } catch (rollbackError) {
      record.status = 'rollback_failed'; record.outcome = 'FAILED_DEPLOYMENT';
      error = new Error(`${error.message}; rollback failed or was unhealthy: ${rollbackError.message}`);
    }
    record.error = String(error.message); record.updatedAt = new Date().toISOString(); saveState(stateDir, state);
    error.deploymentStatus = record.status; error.previousCommit = previous;
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
    const job = store.list().filter(value => approved(value, project)
      // Failed deployment is retryable only when this oneshot is explicitly
      // started again; there is no deployment polling loop.
      && (!value.deployment || ['pending', 'deploying', 'failed', 'rolled_back', 'rollback_failed'].includes(value.deployment.status)))
      .sort((a, b) => String(b.merge.mergedAt).localeCompare(String(a.merge.mergedAt)))[0];
    if (!job) return { status: 'noop' };
    try {
      const result = await deploy(project, job, { ...options, stateDir });
      job.deployment = { status: result.status === 'noop' ? 'deployed' : result.status, commit: job.merge.commit,
        previousCommit: result.previous || null, updatedAt: new Date().toISOString(), error: null, health: result.health || null };
      store.save(job); return result;
    } catch (error) {
      // Keep the merge terminal; deployment failures must never re-open or
      // re-merge an approved PR.  The diagnostic is durable and observable.
      job.deployment = { status: error.deploymentStatus || 'failed', outcome: 'FAILED_DEPLOYMENT', commit: job.merge.commit,
        previousCommit: error.previousCommit || job.deployment?.previousCommit || null,
        updatedAt: new Date().toISOString(), error: String(error.message), health: null };
      store.save(job); throw error;
    }
  } finally { release(); }
}

if (require.main === module) run().then(result => process.stdout.write(`Ralph deployment: ${result.status}\n`)).catch(error => { process.stderr.write(`Ralph deployment failed: ${error.message}\n`); process.exitCode = 1; });

module.exports = { PROJECT, SERVICE, approved, cleanCheckout, waitForHealth, confirmCurrentHealth, acquireLock, readState, deploy, run };
