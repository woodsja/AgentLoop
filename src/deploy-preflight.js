'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { loadProjectConfig } = require('./autopilot-config');
const { createJobStore, resolveStateDir } = require('./autopilot-state');
const { approved } = require('./r1-dependencies');
const { ciStateForRuns } = require('./autopilot-github');

const execute = promisify(execFile);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
function requireCandidate(condition, message) {
  if (!condition) throw new Error(`Deployment preflight refused: ${message}`);
}

// Only the issue number selects a candidate. Paths and repository identity are
// loaded from owner configuration and the canonical durable R1 store.
// Dependency injection is for trusted callers testing read-only observations;
// candidate data cannot select an observer or bypass the identity/config gates.
function createDeploymentValidator({ observeRemote } = {}) {
  return (issueNumber, options) => validateCandidate(issueNumber, options, observeRemote);
}

async function validateCandidate(issueNumber, { configPath } = {}, observeRemote) {
  const project = loadProjectConfig('ralph', configPath === undefined ? {} : { configPath });
  requireCandidate(project.baseBranch === 'ralph-dev' && project.reviewPolicy === 'always'
    && project.autoMerge === true && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project.repo), 'owner Ralph policy or repository is invalid');
  const job = createJobStore(resolveStateDir('ralph', project)).load(issueNumber);
  requireCandidate(approved(job, issueNumber, 'ralph', project.repo), 'missing or stale independently approved MERGED evidence');
  requireCandidate(sha(job.merge.commit) && sha(job.delivery.commit) && job.review.policy === 'always'
    && job.pr?.number === job.merge.prNumber && job.ci.prNumber === job.pr.number
    && job.ci.requiredWorkflow === project.ciWorkflow
    && !job.ci.providerError && Array.isArray(job.ci.runs)
    && ciStateForRuns(job.ci.runs, project.ciWorkflow) === 'green', 'missing exact-head required CI or merge identity');

  // Git environment overrides must not redirect reads away from the configured
  // checkout. Optional index refresh writes are disabled as well.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  const git = async args => (await execute('git', ['--no-replace-objects', '-C', project.checkout, ...args], {
    env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  })).stdout.trim();
  requireCandidate(fs.realpathSync(await git(['rev-parse', '--show-toplevel'])) === fs.realpathSync(project.checkout), 'configured checkout must be the repository root');
  const oldSha = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
  requireCandidate(await git(['symbolic-ref', '--quiet', '--short', 'HEAD']) === project.baseBranch, 'checkout is on the wrong branch');
  requireCandidate(await git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']) === '', 'checkout is dirty');
  const allowedUrls = [
    `https://github.com/${project.repo}`, `https://github.com/${project.repo}.git`,
    `git@github.com:${project.repo}`, `git@github.com:${project.repo}.git`,
    `ssh://git@github.com/${project.repo}`, `ssh://git@github.com/${project.repo}.git`,
  ];
  const urls = (await git(['config', '--get-all', 'remote.origin.url'])).split('\n');
  requireCandidate(urls.length === 1 && allowedUrls.includes(urls[0])
    && allowedUrls.includes(await git(['ls-remote', '--get-url', 'origin'])),
    'origin does not identify the configured repository');
  const transportKeys = (await git(['config', '--null', '--name-only', '--list'])).split('\0');
  requireCandidate(!transportKeys.some(key => [
    'core.sshcommand', 'ssh.variant', 'remote.origin.uploadpack',
  ].includes(key)), 'unsafe origin transport configuration');
  const targetRef = `refs/heads/${project.baseBranch}`;
  const remote = observeRemote
    ? await observeRemote(Object.freeze({ url: urls[0], ref: targetRef }))
    : await git(['-c', 'core.sshCommand=ssh', '-c', 'ssh.variant=ssh',
      '-c', 'remote.origin.uploadpack=git-upload-pack',
      'ls-remote', '--exit-code', '--refs', 'origin', targetRef]);
  const newSha = job.merge.commit;
  requireCandidate(remote === `${newSha}\t${targetRef}`, 'approved merge is not the exact origin/ralph-dev target');
  requireCandidate(sha(oldSha) && await git(['rev-parse', '--verify', `${newSha}^{commit}`]) === newSha, 'candidate is not a local commit');
  const parents = (await git(['rev-list', '--parents', '-n', '1', newSha])).split(' ').slice(1);
  requireCandidate(newSha === job.delivery.commit || (parents.length === 2 && parents[1] === job.delivery.commit), 'merge does not contain the exact reviewed head');
  requireCandidate(oldSha === newSha || (parents[0] === oldSha
    && (newSha === job.delivery.commit ? parents.length === 1 : parents.length === 2)),
    'candidate includes unreviewed intermediate commits');
  await git(['merge-base', '--is-ancestor', oldSha, newSha]);

  // Keep the owner's attribute-specific checks, then independently check the
  // delta without candidate or info attributes. Preserve stricter core rules
  // while enforcing the baseline even if config disables those rules.
  const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--check', oldSha, newSha, '--'];
  await git(diffArgs);
  const whitespace = await git(['config', '--default', '', '--get', 'core.whitespace']);
  const objects = await git(['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-whitespace-'));
  try {
    // A config-free bare context reads existing objects (including alternates)
    // without writing to the checkout, its index, refs, config, or object store.
    fs.mkdirSync(path.join(scratch, 'objects'));
    fs.mkdirSync(path.join(scratch, 'refs'));
    fs.writeFileSync(path.join(scratch, 'HEAD'), 'ref: refs/heads/unused\n');
    await execute('git', ['--no-replace-objects', `--git-dir=${scratch}`,
      '-c', 'core.bare=true', '-c', 'core.attributesFile=/dev/null',
      '-c', `core.whitespace=${whitespace ? `${whitespace},` : ''}blank-at-eol,blank-at-eof,space-before-tab`,
      ...diffArgs], {
      cwd: scratch, env: { ...env, GIT_OBJECT_DIRECTORY: objects, GIT_ATTR_NOSYSTEM: '1' },
      encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  requireCandidate(await git(['rev-parse', '--verify', 'HEAD^{commit}']) === oldSha,
    'checkout HEAD changed during validation');
  requireCandidate(await git(['symbolic-ref', '--quiet', '--short', 'HEAD']) === project.baseBranch,
    'checkout branch changed during validation');
  requireCandidate(await git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']) === '',
    'checkout became dirty during validation');
  return Object.freeze({ oldSha, newSha, noOp: oldSha === newSha });
}

const validateDeploymentCandidate = createDeploymentValidator();
module.exports = { validateDeploymentCandidate, createDeploymentValidator };
