'use strict';

// Run this trusted worker as a separate process outside the daemon's systemd
// cgroup. Nothing here installs units, edits configuration or invokes npm.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadProjectConfig } = require('./autopilot-config');
const { resolveStateDir, createJobStore } = require('./autopilot-state');
const { approved } = require('./r1-dependencies');
const { ciStateForRuns } = require('./autopilot-github');
const { hash, insist, directory, regular, sync, atomic, inventory } = require('./deploy-files');
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const terminal = phase => ['DEPLOYED', 'ROLLED_BACK', 'FAILED'].includes(phase);
function outsideService(text = fs.readFileSync('/proc/self/cgroup', 'utf8')) {
  insist(!text.split('\n').some(line => line.split('/').some(part => part === 'agentloop.service')), 'updater inside agentloop.service cgroup');
}
const exists = file => Boolean(fs.lstatSync(file, { throwIfNoEntry: false }));
const env = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
function settings(checkpoint) {
  regular(checkpoint);
  const receipt = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
  insist(receipt.updaterContract === 'step14-update-v3', 'unsupported staging receipt contract; await corrected #29 sync');
  insist(receipt.state === 'PREPARED' && sha(receipt.oldSha) && sha(receipt.newSha) && sha(receipt.candidateTree), 'requires PREPARED receipt with candidate tree');
  require('./deploy-files').canonicalAbsolute(receipt.installedCheckout);
  require('./deploy-files').canonicalAbsolute(receipt.configFile);
  insist(!receipt.configFile.startsWith(receipt.installedCheckout + path.sep), 'external owner project configuration bootstrap required');
  const configFile = receipt.configFile;
  regular(configFile);
  insist(hash(fs.readFileSync(configFile)) === receipt.ownerConfigHash, 'owner configuration changed');
  const project = loadProjectConfig('ralph', { configPath: configFile });
  insist(project.baseBranch === 'ralph-dev' && project.reviewPolicy === 'always' && project.autoMerge === true, 'owner policy changed');
  const sourceCheckout = directory(path.resolve(project.checkout));
  insist(sourceCheckout === receipt.sourceCheckout, 'source path changed');
  const deployment = require('./deploy-layout').layout(receipt.deployment?.deploymentConfigFile, configFile, sourceCheckout);
  insist(JSON.stringify(deployment) === JSON.stringify(receipt.deployment), 'deployment layout changed');
  const live = deployment.installedCheckout;
  insist(live === receipt.installedCheckout, 'installed path changed');
  const root = directory(path.join(resolveStateDir('ralph', project), 'deployment-staging'));
  insist(root !== sourceCheckout && !root.startsWith(sourceCheckout + path.sep) && !sourceCheckout.startsWith(root + path.sep), 'source/state overlap');
  const key = `${receipt.oldSha}-${receipt.newSha}${receipt.retry ? '-retry-' + receipt.retry.attemptId : ''}`;
  insist(receipt.deploymentKey === key, 'deployment namespace mismatch');
  if (receipt.retry) {
    const retry = require('./deploy-retry').approval(receipt.retry.approvalFile, { root, ...receipt });
    insist(JSON.stringify(retry) === JSON.stringify(receipt.retry), 'retry seal changed');
  }
  const location = path.join(root, key);
  insist(path.resolve(checkpoint) === path.join(location, 'checkpoint.json'), 'noncanonical receipt');
  insist(path.dirname(receipt.attempt) === location && path.basename(receipt.attempt).startsWith('attempt-')
    && receipt.repo === path.join(receipt.attempt, 'repo'), 'unsafe installer candidate');
  insist(!root.startsWith(live + path.sep) && !live.startsWith(root + path.sep) && live !== root, 'overlapping installation/state');
  // Only a trusted local staging receipt is an authority. Canonical evidence is
  // compared verbatim again; there is deliberately no GitHub/network fallback.
  const job = createJobStore(resolveStateDir('ralph', project)).load(receipt.issueNumber);
  const evidence = JSON.parse(JSON.stringify(Object.fromEntries(['project', 'repo', 'issue', 'terminal', 'terminalState',
    'delivery', 'pr', 'review', 'ci', 'merge', 'verification'].map(key => [key, job?.[key]]))));
  insist(hash(JSON.stringify(evidence)) === receipt.evidenceHash
    && JSON.stringify(evidence) === JSON.stringify(receipt.approvedEvidence), 'canonical evidence changed');
  insist(approved(job, receipt.issueNumber, 'ralph', project.repo) && job.merge.commit === receipt.newSha
    && job.review.policy === 'always' && job.pr?.number === job.merge.prNumber
    && job.ci.prNumber === job.pr.number && job.ci.requiredWorkflow === project.ciWorkflow
    && !job.ci.providerError && Array.isArray(job.ci.runs)
    && ciStateForRuns(job.ci.runs, project.ciWorkflow) === 'green', 'independent review/CI evidence invalid');
  return { receipt, live, root, location, project };
}

// Recovery identity comes from the durable pre-mutation journal, never from
// candidate bytes or a changed owner policy. Refused forward evidence can still
// restore the previously sealed backup on crash resume.
function recoverySettings(checkpoint) {
  regular(checkpoint);
  const receipt = JSON.parse(fs.readFileSync(checkpoint));
  insist(sha(receipt.oldSha) && sha(receipt.newSha) && path.isAbsolute(receipt.installedCheckout), 'invalid recovery receipt');
  const location = directory(path.dirname(checkpoint)), root = directory(path.dirname(location));
  insist(path.basename(location) === receipt.deploymentKey && receipt.deploymentKey === `${receipt.oldSha}-${receipt.newSha}${receipt.retry ? '-retry-' + receipt.retry.attemptId : ''}` && path.basename(checkpoint) === 'checkpoint.json', 'unsafe recovery location');
  regular(path.join(location, 'update.json'));
  const journal = JSON.parse(fs.readFileSync(path.join(location, 'update.json')));
  insist(!terminal(journal.phase) && journal.receiptHash === hash(fs.readFileSync(checkpoint))
    && journal.root === root && journal.live === receipt.installedCheckout, 'no trusted pending recovery');
  return { receipt, live: receipt.installedCheckout, root, location };
}
function resumeSettings(checkpoint) {
  try { return settings(checkpoint); }
  catch (error) {
    if (!exists(path.join(path.dirname(checkpoint), 'update.json'))) throw error;
    return { ...recoverySettings(checkpoint), refusal: error.message, refusalStack: error.stack };
  }
}

async function update(checkpoint, service = systemd, hook = () => {}, limits = {}) {
  outsideService();
  const { receipt: r, live, root, location, refusal, refusalStack } = resumeSettings(checkpoint);
  const serviceAction = action => service(action, command, live, undefined, { path: r.configFile, hash: r.ownerConfigHash });
  const lock = path.join(root, 'deployment.lock');
  insist(!exists(path.join(root, 'prepare.lock')), 'legacy preparation lock present; drain old workers and review lock migration');
  regular(lock);
  const named = fs.statSync(lock), inherited = fs.fstatSync(3);
  insist(named.ino === inherited.ino && named.dev === inherited.dev, 'deployment lock descriptor mismatch');
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/flock', ['--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', 3] });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('deployment lock busy')));
  });
  const journalFile = path.join(location, 'update.json');
  const transcript = path.join(location, 'update.jsonl');
  if (exists(transcript)) regular(transcript);
  // A finite receipt-wide audit quota bounds retries without discarding records.
  const auditLimit = 128 * 1024 * 1024;
  let auditBytes = exists(transcript) ? fs.statSync(transcript).size : 0;
  const auditRecovery = auditBytes >= auditLimit - 8 * 1024 * 1024 && exists(journalFile);
  insist(auditBytes < auditLimit - (auditRecovery ? 2 * 1024 * 1024 : 8 * 1024 * 1024), 'audit budget exhausted; retain evidence for owner inspection');
  let deadline = Date.now() + 120000;
  let workBytes = 0, commands = 0;
  const log = fs.openSync(transcript, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  sync(location);
  const record = event => { const line = JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n';
    auditBytes += Buffer.byteLength(line); fs.writeSync(log, line); fs.fsyncSync(log); };
  const budget = () => insist(Date.now() < deadline && commands < 4000 && workBytes < (limits.workBytes ?? 32 * 1024 * 1024)
    && auditBytes < auditLimit - (recovery ? 1024 * 1024 : 4 * 1024 * 1024), 'aggregate verification/audit budget exhausted');
  const command = require('./deploy-command').createCommand({ location, env, record, budget,
    output: bytes => { workBytes += bytes; return workBytes <= (limits.workBytes ?? 32 * 1024 * 1024) && auditBytes < auditLimit - (recovery ? 1024 * 1024 : 4 * 1024 * 1024); },
    started: () => { commands++; }, completed: (file, elapsed) => { if (file !== '/usr/bin/git') deadline += elapsed; } });
  const git = async (repo, args) => command('/usr/bin/git', ['--no-replace-objects', '-C', repo,
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.commitGraph=false', ...args]);
  let journal, trustedJournal = false;
  let recovery = false;
  function save(phase, extra = {}) {
    insist(!terminal(journal?.phase), 'terminal journal is immutable');
    journal = { ...journal, ...extra, phase };
    atomic(journalFile, journal); record({ journal }); hook(phase);
  }
  function rename(from, to) {
    if (!recovery) {
      settings(checkpoint);
      insist(hash(fs.readFileSync(checkpoint)) === journal.receiptHash, 'receipt changed');
    }
    // lstat and rename only: rejected bytes may include altered .git or links.
    directory(path.dirname(from)); fs.lstatSync(from);
    insist(!exists(to), 'rename target already exists');
    fs.renameSync(from, to); sync(path.dirname(from)); sync(path.dirname(to));
    record({ rename: { from, to } }); hook(`rename:${path.basename(from)}`);
  }
  const verifiedSnapshots = new Set();
  async function checkRepo(repo, expected, seal) {
    budget();
    directory(repo); directory(path.join(repo, '.git'));
    insist(inventory(repo) === seal, 'installation modified or dirty checkout');
    insist((await git(repo, ['rev-parse', 'HEAD'])).toString().trim() === expected, 'unexpected installed SHA');
    const key = `${expected}:${seal}`;
    if (verifiedSnapshots.has(key)) return;
    const read = async (type, id) => {
      const bytes = await git(repo, ['cat-file', type, id]);
      const actual = require('node:crypto').createHash('sha1').update(Buffer.concat([
        Buffer.from(`${type} ${bytes.length}\0`), bytes])).digest('hex');
      insist(actual === id, `invalid ${type} object`);
      return bytes;
    };
    const commit = await read('commit', expected);
    const tree = /^tree ([a-f0-9]{40})\n/.exec(commit.toString())?.[1];
    insist(tree && (expected !== r.newSha || tree === r.candidateTree), 'invalid candidate commit tree');
    let entries = 0;
    async function walk(id, parent = '', depth = 0) {
      budget(); insist(depth < 64, 'tree depth budget exceeded');
      const bytes = await read('tree', id);
      for (let offset = 0; offset < bytes.length;) {
        insist(++entries <= 20000, 'tree entry budget exceeded');
        const space = bytes.indexOf(32, offset), nul = bytes.indexOf(0, space + 1);
        insist(space > offset && nul > space && nul + 21 <= bytes.length, 'invalid tree');
        const mode = bytes.subarray(offset, space).toString();
        const nameBytes = bytes.subarray(space + 1, nul), name = nameBytes.toString();
        insist(name && Buffer.from(name).equals(nameBytes) && !['.', '..', '.git'].includes(name.toLowerCase())
          && !/[\\/]/.test(name), 'unsafe tracked pathname');
        const object = bytes.subarray(nul + 1, nul + 21).toString('hex');
        const relative = path.join(parent, name), file = path.join(repo, relative);
        if (mode === '40000') { directory(file); await walk(object, relative, depth + 1); }
        else {
          insist(['100644', '100755'].includes(mode), 'unsupported installed tree mode');
          regular(file); insist(fs.statSync(file).size <= 32 * 1024 * 1024, 'tracked file byte budget exceeded');
          insist(fs.readFileSync(file).equals(await read('blob', object))
            && Boolean(fs.statSync(file).mode & 0o111) === (mode === '100755'), 'dirty tracked bytes');
        }
        offset = nul + 21;
      }
    }
    await walk(tree);
    insist(!/(^|\x00)[a-zS] /.test((await git(repo, ['ls-files', '-v', '-z'])).toString()), 'unsafe index flags');
    insist(!(await git(repo, ['diff-index', '--cached', '--no-ext-diff', '--no-textconv', '--raw', expected, '--'])).length,
      'dirty staged index');
    verifiedSnapshots.add(key);
  }
  async function deploymentCheckout(repo) {
    directory(path.join(repo, '.git'));
    regular(path.join(repo, '.git/deployment-only'));
    insist(fs.readFileSync(path.join(repo, '.git/deployment-only'), 'utf8') === 'disposable-deployment-v1\n', 'dedicated deployment checkout required');
    const refs = (await git(repo, ['for-each-ref', '--format=%(refname)'])).toString().trim().split('\n');
    insist(refs.length === 1 && refs[0] === 'refs/heads/ralph-dev', 'owner Git refs require separate deployment checkout');
    const allowed = new Set(['HEAD', 'config', 'index', 'objects', 'refs', 'deployment-only']);
    insist(fs.readdirSync(path.join(repo, '.git')).every(name => allowed.has(name)), 'owner Git metadata/history requires separate deployment checkout');
    const config = (await git(repo, ['config', '--local', '--list'])).toString().trim().split('\n');
    insist(config.every(line => /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates)|remote\.origin\.(url|fetch))=/.test(line)), 'owner Git settings require separate deployment checkout');
  }
  async function healthy(previous) {
    const deadline = Date.now() + (limits.healthMs ?? 15000);
    let consecutive = 0, pid;
    do {
      try {
        const result = await serviceAction('status');
        record({ health: result, previousPid: previous });
        if (Date.now() <= deadline && Number.isSafeInteger(result.pid) && result.pid > 0 && result.pid !== previous
          && result.active === true && result.healthy === true) {
          consecutive = pid === result.pid ? consecutive + 1 : 1;
          pid = result.pid;
          if (consecutive >= 2) return pid;
        } else consecutive = 0;
      } catch (error) { record({ healthError: error.stack }); consecutive = 0; }
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error('bounded service health/fresh PID check failed');
  }
  async function rollback() {
    const { backup, rejected } = journal;
    recovery = true;
    deadline = Date.now() + 120000;
    // Never let a forward verification quota prevent restoration of the backup.
    commands = 0; workBytes = 0;
    await serviceAction('settle');
    if (journal.phase === 'ROLLING_BACK') {
      if (exists(backup)) {
        await checkRepo(backup, r.oldSha, r.installedHash);
        if (exists(live)) rename(live, rejected);
        rename(backup, live);
      }
      await checkRepo(live, r.oldSha, r.installedHash);
      save('ROLLBACK_RESTART');
    }
    if (journal.phase === 'ROLLBACK_RESTART') {
      await checkRepo(live, r.oldSha, r.installedHash);
      const before = await serviceAction('status');
      await serviceAction('restart');
      hook('ROLLBACK_RESTARTED');
      save('ROLLED_BACK', { rollbackPid: await healthy(before.pid), state: 'ROLLED_BACK' });
    }
    return journal;
  }
  try {
    if (exists(journalFile)) {
      regular(journalFile); journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
      insist(journal.receiptHash === hash(fs.readFileSync(checkpoint)) && journal.live === live
        && journal.backup === `${live}.rollback-${r.deploymentKey}`
        && journal.rejected === `${live}.rejected-${r.deploymentKey}`, 'journal identity mismatch');
      insist(['READY', 'SWAPPING', 'RESTARTING', 'ROLLING_BACK', 'ROLLBACK_RESTART', 'DEPLOYED', 'ROLLED_BACK', 'FAILED'].includes(journal.phase), 'invalid journal phase');
      trustedJournal = true;
      if (terminal(journal.phase)) return journal;
      if ((refusal || auditRecovery) && !['ROLLING_BACK', 'ROLLBACK_RESTART'].includes(journal.phase)) {
        const reason = refusal || 'forward audit admission exhausted';
        if (refusal) record({ forwardRefusal: refusalStack });
        // READY precedes every rename. A refusal here must not interrupt the
        // untouched old service; retain the terminal evidence for owner review.
        if (journal.phase === 'READY') {
          save('FAILED', { state: 'FAILED', error: reason });
          throw new Error(reason);
        }
        // SWAPPING is intent, not proof of the first rename. Let the catch
        // verify the old live checkout before selecting an immutable refusal.
        if (journal.phase === 'SWAPPING' && !exists(journal.backup)) throw new Error(reason);
        save('ROLLING_BACK', { reason });
      }
    } else {
      await deploymentCheckout(live);
      await checkRepo(live, r.oldSha, r.installedHash);
      await checkRepo(r.repo, r.newSha, r.installerHash);
      insist(fs.statSync(path.dirname(live)).dev === fs.statSync(live).dev
        && fs.statSync(live).dev === fs.statSync(r.repo).dev, 'installation/staging must share a filesystem');
      const bytes = await git(r.repo, ['cat-file', 'commit', r.newSha]);
      insist(require('node:crypto').createHash('sha1').update(Buffer.concat([
        Buffer.from(`commit ${bytes.length}\0`), bytes])).digest('hex') === r.newSha, 'candidate object hash mismatch');
      const parents = bytes.toString().split('\n\n')[0].split('\n').filter(s => s.startsWith('parent ')).map(s => s.slice(7));
      insist(r.oldSha !== r.newSha && parents[0] === r.oldSha
        && (r.newSha === r.approvedEvidence.delivery.commit ? parents.length === 1
          : parents.length === 2 && parents[1] === r.approvedEvidence.delivery.commit), 'unexpected deployment ancestry');
      // Configuration and owner instructions cannot be replaced by deployment.
      // Ignored owner files also require manual reconciliation before staging.
      const names = (await git(live, ['ls-files', '-z'])).toString().split('\0').filter(Boolean);
      if (r.configFile.startsWith(live + path.sep)) names.push(path.relative(live, r.configFile));
      for (const name of names.filter(name => /(^|\/)(config[^/]*\.json|autopilot-projects\.json|AGENTS\.md|SKILL\.md)$/.test(name)
        || /(^|\/)(\.agents|\.codex)\//.test(name) || name === path.relative(live, r.configFile))) {
        regular(path.join(live, name)); regular(path.join(r.repo, name));
        insist(fs.readFileSync(path.join(live, name)).equals(fs.readFileSync(path.join(r.repo, name))), `owner file changed: ${name}`);
      }
      const extra = (await git(live, ['ls-files', '--others', '--exclude-standard', '-z'])).toString();
      const ignored = (await git(live, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).toString().split('\0').filter(Boolean);
      insist(!extra && ignored.every(name => name.startsWith('node_modules/')), 'unmanaged owner files in installation');
      await serviceAction('check');
      const before = await serviceAction('status');
      insist(Number.isSafeInteger(before.pid) && before.pid > 0 && before.active && before.healthy, 'old service is unhealthy');
      journal = { receiptHash: hash(fs.readFileSync(checkpoint)), live, root,
        backup: `${live}.rollback-${r.deploymentKey}`, rejected: `${live}.rejected-${r.deploymentKey}`, oldPid: before.pid };
      insist(!exists(journal.backup) && !exists(journal.rejected), 'unexpected deployment backup');
      trustedJournal = true;
      save('READY');
    }
    const { backup, rejected } = journal;
    await serviceAction('settle');
    if (['READY', 'SWAPPING'].includes(journal.phase)) {
      save('SWAPPING');
      if (!exists(backup)) {
        insist(!exists(rejected), 'unexpected rejected path before first rename');
        await deploymentCheckout(live);
        await checkRepo(live, r.oldSha, r.installedHash);
        await checkRepo(r.repo, r.newSha, r.installerHash);
        rename(live, backup);
      }
      await checkRepo(backup, r.oldSha, r.installedHash);
      if (!exists(live)) { await checkRepo(r.repo, r.newSha, r.installerHash); rename(r.repo, live); }
      await checkRepo(live, r.newSha, r.installerHash);
      save('RESTARTING');
    }
    if (journal.phase === 'RESTARTING') {
      await checkRepo(live, r.newSha, r.installerHash);
      try {
        const before = await serviceAction('status');
        save('RESTARTING', { restartPreviousPid: before.pid });
        settings(checkpoint);
        await serviceAction('restart');
        hook('RESTARTED');
        save('DEPLOYED', { newPid: await healthy(before.pid), state: 'DEPLOYED' });
        return journal;
      } catch (error) {
        record({ updateError: error.stack });
        // Persist rollback intent BEFORE any rollback filesystem mutation.
        save('ROLLING_BACK', { reason: error.message });
      }
    }
    return await rollback();
  } catch (error) {
    record({ error: error.stack });
    // A crash leaves its intent resumable; an observed refusal/failure is terminal
    // and requires owner inspection, never execution of uncertain bytes.
    if (trustedJournal && !terminal(journal.phase)) {
      if (recovery) { save('FAILED', { state: 'FAILED', error: error.message }); throw error; }
      if (journal.phase === 'SWAPPING' && !exists(journal.backup)) {
        // No backup authorizes restoration. Verify without forward settings or
        // service actions; ambiguous/mutated paths also fail closed in place.
        let verificationError;
        try {
          insist(!exists(journal.rejected), 'unexpected rejected path before first rename');
          await checkRepo(live, r.oldSha, r.installedHash);
          insist(!exists(journal.backup) && !exists(journal.rejected), 'swap paths changed during refusal verification');
        } catch (failure) {
          verificationError = failure.message;
          record({ refusalVerificationError: failure.stack });
        }
        save('FAILED', { state: 'FAILED', error: error.message,
          oldCheckoutVerified: !verificationError, ...(verificationError ? { verificationError } : {}) });
        throw error;
      }
      if (['SWAPPING', 'RESTARTING', 'ROLLING_BACK', 'ROLLBACK_RESTART'].includes(journal.phase)) {
        try {
          if (!['ROLLING_BACK', 'ROLLBACK_RESTART'].includes(journal.phase)) save('ROLLING_BACK', { reason: error.message });
          return await rollback();
        } catch (rollbackError) {
          record({ rollbackError: rollbackError.stack });
          save('FAILED', { state: 'FAILED', error: rollbackError.message });
          throw rollbackError;
        }
      }
      save('FAILED', { state: 'FAILED', error: error.message });
    }
    throw error;
  } finally { fs.closeSync(log); }
}

async function systemd(action, command, live, guardianPath = require.resolve('./deploy-systemd-guardian'), projectConfig) {
  if (action === 'restart' || action === 'settle' || action === 'check') {
    // This independent guardian inherits flock fd 3. It survives updater death.
    // Require a systemd-enforced total job lifetime before queuing anything.
    await command(process.execPath, [guardianPath, action], '105s', { persistent: true }); return;
  }
  insist(action === 'status', 'unsupported service action');
  const text = (await command('/usr/bin/systemctl', ['--user', 'show', 'agentloop.service',
    '--property=MainPID,ActiveState,SubState,Result,WorkingDirectory,ExecStart,Environment'])).toString();
  const fields = Object.fromEntries(text.trim().split('\n').map(line => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
  }));
  insist(fields.WorkingDirectory === live && !/[\s;{}\\]/.test(live)
    && fields.ExecStart?.includes(`path=${process.execPath} ; argv[]=${process.execPath} ${path.join(live, 'src/daemon.js')} ;`)
    && (fields.ExecStart.match(/argv\[\]=/g) || []).length === 1, 'unexpected agentloop service command; manual bootstrap required');
  const environment = fields.Environment || '';
  const stateRoot = /(?:^|[ "])AGENTLOOP_STATE_DIR=([^ "]+)(?:[ "]|$)/.exec(environment)?.[1];
  const { canonicalAbsolute } = require('./deploy-files');
  canonicalAbsolute(stateRoot);
  insist(stateRoot && path.isAbsolute(stateRoot) && path.resolve(stateRoot) !== live && !path.resolve(stateRoot).startsWith(live + path.sep), 'external daemon state bootstrap required');
  const configFile = /(?:^|[ "])AGENTLOOP_CONFIG_PATH=([^ "]+)(?:[ "]|$)/.exec(environment)?.[1];
  canonicalAbsolute(configFile);
  insist(configFile && path.isAbsolute(configFile) && !path.resolve(configFile).startsWith(live + path.sep), 'external owner config bootstrap required');
  insist((environment.match(/AGENTLOOP_CONFIG_PATH=/g) || []).length === 1
    && (environment.match(/AGENTLOOP_STATE_DIR=/g) || []).length === 1, 'ambiguous external configuration');
  insist(configFile !== live, 'external owner config bootstrap required');
  const projectsPath = /(?:^|[ "])AGENTLOOP_PROJECTS_PATH=([^ "]+)(?:[ "]|$)/.exec(environment)?.[1];
  canonicalAbsolute(projectsPath);
  insist(projectConfig && projectsPath === projectConfig.path
    && (environment.match(/AGENTLOOP_PROJECTS_PATH=/g) || []).length === 1, 'external project configuration identity mismatch');
  regular(projectsPath);
  insist(hash(fs.readFileSync(projectsPath)) === projectConfig.hash, 'owner project configuration changed');
  directory(stateRoot); regular(configFile);
  const pid = Number(fields.MainPID);
  let healthy = fields.SubState === 'running' && fields.Result === 'success';
  if (healthy && fields.ActiveState === 'active' && pid > 0) {
    const port = JSON.parse(fs.readFileSync(configFile, 'utf8')).dashboardPort ?? 5757;
    insist(Number.isSafeInteger(port) && port > 0 && port <= 65535, 'invalid dashboard port');
    // Loopback only. Raw response chunks are captured verbatim by command().
    const probe = `const http=require('node:http'),fs=require('node:fs');
      const request=http.get({host:'127.0.0.1',port:Number(process.argv[1]),path:'/api/state'},response=>{
        if(response.statusCode!==200)process.exitCode=1;
        response.on('data',bytes=>fs.writeSync(1,bytes));
      });
      request.setTimeout(1000,()=>request.destroy(new Error('health timeout')));
      request.on('error',error=>{fs.writeSync(2,error.stack);process.exitCode=1;});`;
    try {
      const response = JSON.parse((await command(process.execPath, ['-e', probe, String(port)])).toString());
      healthy = response.daemon?.alive === true && response.daemon.pid === pid
        && response.daemon.projectConfig?.pathHash === hash(projectConfig.path)
        && response.daemon.projectConfig?.hash === projectConfig.hash;
    } catch {
      // An unresponsive new API must still permit the rollback restart. The
      // command transcript retains the complete probe failure and raw response.
      healthy = false;
    }
  }
  return { pid, active: fields.ActiveState === 'active', healthy, raw: text };
}

// flock is held by this independent worker and inherited by bounded service
// commands, so killing the caller or worker cannot overlap a pending restart.
function launch(checkpoint) {
  outsideService();
  const { root } = resumeSettings(checkpoint);
  const lock = path.join(root, 'deployment.lock');
  const fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  regular(lock); sync(root);
  const child = spawn('/bin/sh', ['-c', '/usr/bin/flock -n 3 || exit 75\nexec "$@"', 'update-lock',
    process.execPath, __filename, '--worker', path.resolve(checkpoint)], { stdio: ['ignore', 'inherit', 'inherit', fd] });
  fs.closeSync(fd);
  child.on('error', error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
  child.on('close', code => { process.exitCode = code ?? 1; });
}
if (require.main === module) {
  if (process.argv.length !== 4 || !['--receipt', '--worker'].includes(process.argv[2])) {
    process.stderr.write('Usage: node deploy-update.js --receipt /absolute/canonical/checkpoint.json\n'); process.exitCode = 1;
  } else if (process.argv[2] === '--worker') {
    update(process.argv[3]).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
      .catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
  } else {
    try { launch(process.argv[3]); } catch (error) { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }
  }
}
// Explicit in-process test seams; the shipping CLI accepts only a receipt.
// No CLI/environment option can select a service, executable or candidate.
module.exports = { testing: { update, systemd, outsideService } };
