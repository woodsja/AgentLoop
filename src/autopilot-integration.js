'use strict';

// Synchronization owns Git transitions, never scheduling or review policy.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('./execution-log');
const { unattendedOptions } = require('./autopilot-subprocess');
const { prepareIssueWorkspace, deriveWorktreePath } = require('./autopilot-workspace');
const { observePullRequest } = require('./autopilot-github');
const { runVerification } = require('./verifier');
const { recordDelivery, recordVerification } = require('./autopilot-state');
const MAX_INTEGRATIONS = 3;
const protectedPath = file => /^(?:docs\/decisions\/|docs\/github-issue-tracker\.md$)|(^|\/)(?:\.env(?:\.[^/]+)?|AGENTS\.md|SKILL\.md|package-lock\.json|autopilot-projects\.json)$|(^|\/)\.(?:github|ralph|agents|codex)\//.test(file);

function refused(message) {
  return Object.assign(new Error(`Integration refused: ${message}`), { code: 'AUTOPILOT_INTEGRATION_BLOCKED' });
}

async function observeTargetSha(project, { execFile: execute = execFile } = {}) {
  const result = await new Promise((resolve, reject) => execute('git',
    ['ls-remote', '--exit-code', 'origin', `refs/heads/${project.baseBranch}`],
    unattendedOptions({ cwd: project.checkout, encoding: 'utf8', shell: false }),
    (error, stdout) => error ? reject(error) : resolve(String(stdout))));
  const lines = result.trim().split('\n');
  const match = lines.length === 1 && lines[0].match(/^([a-f0-9]{40,64})\s+refs\/heads\/(.+)$/);
  if (!match || match[2] !== project.baseBranch) throw refused('ambiguous target branch SHA');
  return match[1];
}

/** Durable, resumable synchronization of one published PR branch. Caller owns
 * the issue lock and the shared project/target lock. No force push or rebase. */
async function synchronizeIssueBranch({ project, issue, job, store }, options = {}) {
  const now = store.now || (() => new Date().toISOString());
  const save = () => store.save(job);
  let attempt = job.integrationActive;
  const execute = options.execFile || execFile;
  const git = async (cwd, args, allowFailure = false) => {
    const result = await new Promise(resolve => execute('git', args,
      unattendedOptions({ cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: false }),
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })));
    if (attempt) {
      attempt.logs.push({ at: now(), command: ['git', ...args], cwd, ...result });
      save();
    } else {
      job.integrationObservations ||= [];
      job.integrationObservations.push({ at: now(), command: ['git', ...args], cwd, ...result });
      save();
    }
    if (result.code !== 0 && !allowFailure) {
      const error = refused(`git ${args[0]} failed: ${result.stderr}`);
      if (args[0] === 'push') error.code = 'AUTOPILOT_INTEGRATION_RETRY';
      throw error;
    }
    return result;
  };
  const out = async (cwd, args) => (await git(cwd, args)).stdout.trim();
  const cwd = deriveWorktreePath(project, issue);
  const checkpoint = phase => { attempt.phase = phase; attempt.updatedAt = now(); save(); };
  const finish = outcome => {
    attempt.outcome = outcome; attempt.finishedAt = now();
    job.integrationHistory ||= [];
    job.integrationHistory.push(structuredClone(attempt));
    if (outcome === 'integrated' || outcome === 'up_to_date') {
      job.integration = { headSha: attempt.finalHead, targetSha: attempt.targetSha, attempt: attempt.number };
    }
    job.integrationActive = null;
    save();
  };
  try {
    if (job.repo !== project.repo || !job.pr || !job.delivery?.pushed || job.branch !== job.delivery.branch
      || !new RegExp(`^ralph/issue-${issue.number}-[a-z0-9-]+$`).test(job.branch)
      || (job.worktreePath && path.resolve(job.worktreePath) !== cwd)) throw refused('issue/branch/worktree identity mismatch');
    const remote = await (options.observePullRequest || observePullRequest)(project, job.pr.number, { execFile: execute });
    if (!remote || remote.isCrossRepository !== false || remote.number !== job.pr.number || remote.headRefName !== job.branch
      || remote.baseRefName !== project.baseBranch || !['OPEN', 'MERGED'].includes(remote.state)) throw refused('PR identity mismatch');
    // A persisted push intent is the only authorization for a changed PR head.
    const expected = attempt?.phase === 'push' ? [attempt.oldHead, attempt.finalHead] : [job.delivery.commit];
    if (!expected.includes(remote.headRefOid)) throw refused('unexpected PR head');
    if (remote.state === 'MERGED') return { changed: false, merged: true };
    if (!attempt) {
      await git(project.checkout, ['fetch', '--no-tags', 'origin', `+refs/heads/${project.baseBranch}:refs/remotes/origin/${project.baseBranch}`]);
      const targetSha = await out(project.checkout, ['rev-parse', `refs/remotes/origin/${project.baseBranch}^{commit}`]);
      if (!/^[a-f0-9]{40,64}$/.test(targetSha)) throw refused('invalid target SHA');
      if (job.integration?.headSha === job.delivery.commit && job.integration.targetSha === targetSha) return { changed: false };
      if ((job.integrationHistory?.length || 0) >= MAX_INTEGRATIONS) throw refused(`total synchronization limit (${MAX_INTEGRATIONS}) exhausted`);
      attempt = job.integrationActive = { number: (job.integrationHistory?.length || 0) + 1,
        project: job.project, repo: project.repo, issue: issue.number, pr: job.pr.number,
        branch: job.branch, oldHead: job.delivery.commit, targetSha, finalHead: null,
        priorEvidence: structuredClone({ verification: job.verification, ci: job.ci, delivery: job.delivery, review: job.review }),
        phase: 'prepare', startedAt: now(), logs: [], affectedFiles: [], workers: [] };
      save();
    }
    // Reattach a removed delivery worktree, but never clear a resumed merge.
    const registered = await out(project.checkout, ['worktree', 'list', '--porcelain']);
    const entries = registered.split('\n\n');
    const own = entries.find(entry => entry.split('\n').includes(`worktree ${cwd}`));
    if (!own) {
      if (fs.existsSync(cwd) && fs.readdirSync(cwd).length) throw refused('unregistered nonempty worktree');
      await (options.prepareIssueWorkspace || prepareIssueWorkspace)(project, issue, { branch: job.branch,
        headCommit: attempt.finalHead || attempt.oldHead, execFile: execute });
    } else if (!own.split('\n').includes(`branch refs/heads/${job.branch}`)) throw refused('registered worktree branch mismatch');
    job.worktreePath = cwd; job.workspaceState = 'prepared'; save();
    const head = await out(cwd, ['rev-parse', 'HEAD']);
    if (attempt.phase === 'prepare') {
      if (head !== attempt.oldHead || await out(cwd, ['status', '--porcelain'])) throw refused('worktree is dirty or head changed');
      const contained = await git(cwd, ['merge-base', '--is-ancestor', attempt.targetSha, head], true);
      if (contained.code === 0) {
        attempt.finalHead = head;
        finish('up_to_date');
        return { changed: false };
      }
      if (contained.code !== 1) throw refused('cannot establish target ancestry');
      checkpoint('merge');
    }
    if (attempt.phase === 'merge') {
      if (head === attempt.oldHead) {
        const merging = await git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true);
        if (merging.code !== 0) await git(cwd, ['merge', '--no-ff', '--no-commit', attempt.targetSha], true);
        const mergeHead = await out(cwd, ['rev-parse', 'MERGE_HEAD']);
        if (mergeHead !== attempt.targetSha) throw refused('merge target changed');
        attempt.stages = (await git(cwd, ['ls-files', '--unmerged'])).stdout;
        attempt.conflictFiles = (await out(cwd, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
        checkpoint(attempt.conflictFiles.length ? 'resolve' : 'commit');
      } else {
        const parents = await out(cwd, ['show', '-s', '--format=%P', 'HEAD']);
        if (parents !== `${attempt.oldHead} ${attempt.targetSha}`) throw refused('unexpected commit during merge recovery');
        attempt.finalHead = head; checkpoint('verify');
      }
    }
    const snapshotOtherWorktrees = async () => {
      const result = [];
      for (const entry of entries) {
        const location = entry.split('\n').find(line => line.startsWith('worktree '))?.slice(9);
        if (location && location !== cwd) {
          const untracked = (await git(location, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
          const contents = untracked.map(file => {
            const fullPath = path.join(location, file);
            const stat = fs.lstatSync(fullPath);
            const bytes = stat.isSymbolicLink() ? fs.readlinkSync(fullPath) : fs.readFileSync(fullPath);
            return [file, stat.mode, require('node:crypto').createHash('sha256').update(bytes).digest('hex')];
          });
          result.push([location, await out(location, ['rev-parse', 'HEAD']), await out(location, ['status', '--porcelain']),
            await out(location, ['diff', '--binary']), await out(location, ['diff', '--cached', '--binary']), contents]);
        }
      }
      return JSON.stringify(result);
    };
    const policySnapshot = async () => {
      const files = (await out(cwd, ['ls-files', '--cached', '--others', '--exclude-standard'])).split('\n').filter(protectedPath);
      return JSON.stringify([...new Set(files)].sort().map(file => {
        const location = path.join(cwd, file);
        return [file, fs.existsSync(location) ? require('node:crypto').createHash('sha256').update(fs.readFileSync(location)).digest('hex') : null];
      }));
    };
    const worker = async (kind, context) => {
      if (!options.resolveConflict) throw refused('conflict/repair resolution agent unavailable');
      const priorWorker = attempt.workers.find(w => w.kind === kind);
      if (priorWorker) {
        if (priorWorker.status !== 'passed' || priorWorker.before !== await snapshotOtherWorktrees()
          || priorWorker.policy !== await policySnapshot()) throw refused(`${kind} resolution interrupted or budget exhausted`);
        return;
      }
      const before = await snapshotOtherWorktrees();
      const claim = { kind, before, policy: await policySnapshot(), startedAt: now(), status: 'running' };
      attempt.workers.push(claim); save();
      const result = await options.resolveConflict({ ...context, kind, cwd, oldHead: attempt.oldHead,
        targetSha: attempt.targetSha, stages: attempt.stages, files: attempt.conflictFiles, attempt: attempt.number });
      claim.result = result; claim.finishedAt = now(); claim.status = result?.status || 'invalid'; save();
      if (before !== await snapshotOtherWorktrees()) throw refused('resolution edited another worktree');
      if (claim.policy !== await policySnapshot()) throw refused('resolution edited protected policy/configuration files');
      if (result?.status !== 'passed') throw refused(`${kind} resolution did not pass`);
    };
    const checkFiles = async () => {
      if (await out(cwd, ['ls-files', '--unmerged'])) throw refused('unresolved index entries');
      const changed = (await git(cwd, ['diff', '--name-only', '-z', attempt.oldHead])).stdout;
      const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout;
      const files = [...new Set((changed + untracked).split('\0').filter(Boolean))];
      for (const file of files) {
        const location = path.join(cwd, file);
        if (fs.existsSync(location) && fs.lstatSync(location).isFile()
          && /^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/m.test(fs.readFileSync(location, 'utf8'))) throw refused(`conflict markers in ${file}`);
      }
      attempt.affectedFiles = files;
    };
    if (attempt.phase === 'resolve') {
      if (attempt.conflictFiles.some(file => !/\.(?:js|jsx|ts|tsx|py|json|css|html|md)$/.test(file)
        || protectedPath(file))) throw refused('protected or ambiguous conflict requires owner resolution');
      await worker('conflict', {});
      if (await out(cwd, ['rev-parse', 'HEAD']) !== attempt.oldHead) throw refused('resolution agent committed before merge gate');
      // For ordinary additive test-script collisions, ensure neither side's
      // commands disappeared. Non-additive scripts require an explicit handoff.
      if (attempt.conflictFiles.includes('package.json')) {
        const read = async ref => JSON.parse(await out(cwd, ['show', `${ref}:package.json`])).scripts?.test;
        const ours = await read(attempt.oldHead), theirs = await read(attempt.targetSha);
        const resolved = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).scripts?.test;
        if ([ours, theirs, resolved].some(value => typeof value !== 'string')
          || [...ours.split('&&'), ...theirs.split('&&')].some(command => !resolved.split('&&').map(s => s.trim()).includes(command.trim()))) throw refused('package test resolution must preserve both test commands');
      }
      await checkFiles(); checkpoint('commit');
    }
    if (attempt.phase === 'commit') {
      await checkFiles();
      const current = await out(cwd, ['rev-parse', 'HEAD']);
      if (current === attempt.oldHead) {
        await git(cwd, ['add', '--all']);
        await git(cwd, ['commit', '-m', `Merge ${project.baseBranch} at ${attempt.targetSha} into issue #${issue.number}`]);
      }
      const parents = await out(cwd, ['show', '-s', '--format=%P', 'HEAD']);
      if (parents !== `${attempt.oldHead} ${attempt.targetSha}`) throw refused('integrated commit is not the expected normal merge');
      attempt.finalHead = await out(cwd, ['rev-parse', 'HEAD']); checkpoint('verify');
    }
    if (attempt.phase === 'verify') {
      if (options.prepareEnvironment && attempt.environment?.status !== 'prepared') {
        attempt.environment = { status: 'preparing', startedAt: now() }; save();
        const result = await options.prepareEnvironment(cwd);
        attempt.environment = { ...attempt.environment, status: 'prepared', result, finishedAt: now() }; save();
      }
      const verificationCommand = attempt.environment?.result?.verification || project.verification;
      if (await out(cwd, ['rev-parse', 'HEAD']) !== attempt.finalHead) throw refused('head changed before verification');
      if (!attempt.verifier) {
        // The completion event is durable before the return-value checkpoint.
        const completed = attempt.logs.findLast(entry => entry.event === 'verification'
          && entry.commit === attempt.finalHead);
        if (completed) { attempt.verifier = completed.result; attempt.verifierCommit = attempt.finalHead; }
      }
      if (!attempt.verifier) {
        attempt.verifierStartedAt = now(); save();
        attempt.verifier = await (options.runVerification || runVerification)(cwd, verificationCommand,
          options.verificationTimeoutMs ?? 120000, (event, details) => {
            attempt.logs.push({ at: now(), commit: attempt.finalHead, event, ...details }); save();
          });
        attempt.verifierCommit = attempt.finalHead; save();
      }
      if (!attempt.verifier || typeof attempt.verifier.passed !== 'boolean'
        || typeof attempt.verifier.stdout !== 'string' || typeof attempt.verifier.stderr !== 'string'
        || typeof attempt.verifier.timedOut !== 'boolean'
        || !(attempt.verifier.exitCode === null || Number.isSafeInteger(attempt.verifier.exitCode))) {
        throw refused('malformed deterministic verification evidence');
      }
      if (!attempt.verifier.passed || attempt.verifier.exitCode !== 0 || attempt.verifier.timedOut) {
        if (attempt.workers.some(w => w.kind === 'repair')) throw refused('integration verifier remains red after bounded repair');
        attempt.failedVerification = { commit: attempt.finalHead, result: attempt.verifier };
        checkpoint('repair');
      } else checkpoint('push');
    }
    if (attempt.phase === 'repair') {
      const prior = attempt.finalHead;
      await worker('repair', { diagnostics: attempt.failedVerification });
      if (await out(cwd, ['rev-parse', 'HEAD']) !== prior) throw refused('repair agent unexpectedly committed');
      await checkFiles();
      checkpoint('repair_commit');
    }
    if (attempt.phase === 'repair_commit') {
      if (await out(cwd, ['rev-parse', 'HEAD']) === attempt.finalHead) {
        await git(cwd, ['add', '--all']); await git(cwd, ['commit', '-m', `ralph: repair integration for #${issue.number}`]);
      } else if (await out(cwd, ['rev-parse', 'HEAD^']) !== attempt.finalHead) throw refused('unexpected repair commit');
      attempt.finalHead = await out(cwd, ['rev-parse', 'HEAD']);
      attempt.verifier = null; checkpoint('verify');
      // Continue on a later one-shot pass, without replaying the repair worker.
      return { pending: true, changed: true };
    }
    if (attempt.phase === 'push') {
      if (await out(cwd, ['rev-parse', 'HEAD']) !== attempt.finalHead || await out(cwd, ['status', '--porcelain'])) throw refused('verified tree changed');
      if (attempt.verifierCommit !== attempt.finalHead || !attempt.verifier?.passed) throw refused('missing exact verification');
      const published = await out(cwd, ['ls-remote', '--exit-code', 'origin', `refs/heads/${job.branch}`]);
      const remoteHead = published.split(/\s/)[0];
      if (![attempt.oldHead, attempt.finalHead].includes(remoteHead)) throw refused('remote head changed before push');
      attempt.push = { status: 'intent', commit: attempt.finalHead, at: now() }; save();
      if (remoteHead !== attempt.finalHead) await git(cwd, ['push', 'origin', `HEAD:refs/heads/${job.branch}`]);
      attempt.push = { ...attempt.push, status: 'pushed', finishedAt: now() }; save();
      recordDelivery(job, { commit: attempt.finalHead, pushed: true });
      recordVerification(job, attempt.environment?.result?.verification || project.verification, attempt.verifier);
      job.verification.commit = attempt.finalHead;
      job.status = 'awaiting_ci';
      finish('integrated');
      return { changed: true };
    }
    throw refused(`unknown integration phase ${attempt.phase}`);
  } catch (error) {
    if (attempt && !attempt.finishedAt) {
      attempt.error = { message: error.message, stack: error.stack, at: now() };
      // Transport failures during push retain the intent for remote reconciliation.
      if (error.code !== 'AUTOPILOT_INTEGRATION_BLOCKED') {
        attempt.interruptions = (attempt.interruptions || 0) + 1;
        if (attempt.interruptions > 2) {
          job.workspaceState = 'integration_retained';
          finish('escalated');
          throw refused('integration interruption retry limit exhausted');
        }
        save();
      }
      else { job.workspaceState = 'integration_retained'; finish('escalated'); }
    }
    throw error;
  }
}

module.exports = { synchronizeIssueBranch, observeTargetSha, MAX_INTEGRATIONS };
