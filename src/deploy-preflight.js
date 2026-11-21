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

const executeFile = promisify(execFile);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
function requireCandidate(condition, message) {
  if (!condition) throw new Error(`Deployment preflight refused: ${message}`);
}

// Only the issue number selects a candidate. Paths and repository identity are
// loaded from owner configuration and the canonical durable R1 store.
async function validateDeploymentCandidate(issueNumber, options) {
  return validateCandidate(issueNumber, options);
}

// The explicit testing namespace can supply local transport. The production
// interface and options cannot override the canonical URL or transport.
async function validateCandidate(issueNumber, { configPath, deploymentConfigPath } = {}, testOnlyCanonicalUrl, observers = {}) {
  const execute = async (...args) => {
    observers.onCommand?.(...args);
    if (args[1].includes('ls-remote') && !args[1].includes('--get-url')) observers.onObservation?.(...args);
    const result = await executeFile(...args);
    observers.onResult?.(result, ...args);
    return result;
  };
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
  const git = async (args, overrides = {}) => (await execute('git', ['--no-replace-objects',
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'core.commitGraph=false', '-C', project.checkout, ...args], {
    env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  })).stdout.trim();
  requireCandidate(fs.realpathSync(await git(['rev-parse', '--show-toplevel'])) === fs.realpathSync(project.checkout), 'configured checkout must be the repository root');
  const sourceHead = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
  const deployment = deploymentConfigPath ? require('./deploy-layout').layout(deploymentConfigPath, require('./autopilot-config').projectConfigPath(configPath), fs.realpathSync(project.checkout)) : null;
  const oldSha = deployment ? (await execute('/usr/bin/git', ['--no-replace-objects', '-C', deployment.installedCheckout, 'rev-parse', '--verify', 'HEAD^{commit}'], { env, encoding: 'utf8', timeout: 5000 })).stdout.trim() : sourceHead;
  requireCandidate(await git(['symbolic-ref', '--quiet', '--short', 'HEAD']) === project.baseBranch, 'checkout is on the wrong branch');
  const newSha = job.merge.commit;
  requireCandidate(sha(oldSha), 'installed HEAD is not a commit SHA');
  // Keep the owner's attribute-specific checks, then independently check the
  // delta without candidate or info attributes. Preserve stricter core rules
  // while enforcing the baseline even if config disables those rules.
  const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--check', oldSha, newSha, '--'];
  const whitespace = await git(['config', '--default', '', '--get', 'core.whitespace']);
  const objects = await git(['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-whitespace-'));
  try {
    // Isolate ancestry from worker-shared grafts, shallow metadata and refs.
    // Read shared objects (including alternates) only to verify and materialize
    // their bytes. Every later gate consumes the private, verified copies.
    fs.mkdirSync(path.join(scratch, 'objects'));
    fs.mkdirSync(path.join(scratch, 'refs'));
    fs.writeFileSync(path.join(scratch, 'HEAD'), 'ref: refs/heads/unused\n');
    const privateObjects = path.join(scratch, 'objects');
    const isolatedGit = async (args, { raw = false, input, source = false } = {}) => {
      const argsWithContext = ['--no-replace-objects', `--git-dir=${scratch}`,
        '-c', 'core.bare=true', '-c', 'core.attributesFile=/dev/null',
        '-c', 'core.commitGraph=false', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
        '-c', `core.whitespace=${whitespace ? `${whitespace},` : ''}blank-at-eol,blank-at-eof,space-before-tab`,
        ...args];
      const options = {
        cwd: scratch, env: { ...env, GIT_OBJECT_DIRECTORY: source ? objects : privateObjects, GIT_ATTR_NOSYSTEM: '1',
          GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null' },
        encoding: raw ? null : 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      };
      const { stdout } = input === undefined ? await execute('git', argsWithContext, options)
        : await new Promise((resolve, reject) => {
          const child = execFile('git', argsWithContext, options, (error, stdout, stderr) => {
            if (error) { Object.assign(error, { stdout, stderr }); reject(error); }
            else resolve({ stdout });
          });
          child.stdin.on('error', reject);
          child.stdin.end(input);
        });
      return raw ? stdout : stdout.trim();
    };
    // cat-file returns the raw object header, never a grafted/cached parent list.
    const verified = new Map();
    const readVerified = async (id, type) => {
      if (verified.has(id)) {
        requireCandidate(verified.get(id).type === type, 'object type mismatch');
        return verified.get(id).bytes;
      }
      const bytes = await isolatedGit(['cat-file', type, id], { raw: true, source: true });
      const actual = await isolatedGit(['hash-object', '-w', '-t', type, '--stdin'], { input: bytes });
      requireCandidate(actual === id, `object hash mismatch for ${type} ${id}`);
      verified.set(id, { type, bytes });
      return bytes;
    };
    // Verify the installed/candidate trees and every commit/tree/blob introduced
    // by the candidate. Read binary trees directly so filenames and blob bytes
    // are never decoded or trimmed. Gitlinks name another repository's objects.
    const trees = new Set();
    const verifyTree = async id => {
      if (trees.has(id)) return;
      trees.add(id);
      const bytes = await readVerified(id, 'tree');
      for (let offset = 0; offset < bytes.length;) {
        const space = bytes.indexOf(32, offset);
        const nul = bytes.indexOf(0, space + 1);
        requireCandidate(space > offset && nul > space && nul + 21 <= bytes.length, 'invalid tree object');
        const mode = bytes.subarray(offset, space).toString('ascii');
        const child = bytes.subarray(nul + 1, nul + 21).toString('hex');
        if (mode === '40000') await verifyTree(child);
        else if (mode !== '160000') await readVerified(child, 'blob');
        offset = nul + 21;
      }
    };
    // Materialize the installed graph before the first status command. No
    // clean gate may consult worker-owned objects, even transiently.
    const installed = await readVerified(oldSha, 'commit');
    const installedTree = /^tree ([a-f0-9]{40})\n/.exec(installed.toString('utf8'))?.[1];
    requireCandidate(sha(installedTree), 'invalid installed commit tree');
    await verifyTree(installedTree);
    const expected = [];
    const collect = (id, prefix = Buffer.alloc(0)) => {
      const bytes = verified.get(id).bytes;
      for (let offset = 0; offset < bytes.length;) {
        const space = bytes.indexOf(32, offset);
        const nul = bytes.indexOf(0, space + 1);
        const mode = bytes.subarray(offset, space).toString('ascii');
        const name = bytes.subarray(space + 1, nul);
        requireCandidate(name.length > 0 && !name.includes(47)
          && !['.', '..', '.git'].includes(name.toString()), 'invalid tree pathname');
        const child = bytes.subarray(nul + 1, nul + 21).toString('hex');
        const relative = Buffer.concat([prefix, name]);
        if (mode === '40000') collect(child, Buffer.concat([relative, Buffer.from('/')]));
        else {
          requireCandidate(mode !== '160000', 'submodule checkouts are unsupported');
          requireCandidate(['100644', '100755', '120000'].includes(mode), 'unsupported tree mode');
          expected.push({ relative, mode, bytes: verified.get(child).bytes });
        }
        offset = nul + 21;
      }
    };
    const sourceCommit = await readVerified(sourceHead, 'commit');
    const sourceTree = /^tree ([a-f0-9]{40})\n/.exec(sourceCommit.toString())?.[1];
    requireCandidate(sha(sourceTree), 'invalid source tree');
    await verifyTree(sourceTree);
    collect(sourceTree);
    requireCandidate(await cleanStatus(project.checkout, sourceHead, git, env, privateObjects, expected, execute) === '', 'checkout is dirty');
    const allowedUrls = [
      `https://github.com/${project.repo}`, `https://github.com/${project.repo}.git`,
      `git@github.com:${project.repo}`, `git@github.com:${project.repo}.git`,
      `ssh://git@github.com/${project.repo}`, `ssh://git@github.com/${project.repo}.git`,
    ];
    const urls = (await git(['config', '--get-all', 'remote.origin.url'])).split('\n');
    requireCandidate(urls.length === 1 && allowedUrls.includes(urls[0])
      && allowedUrls.includes(await git(['ls-remote', '--get-url', 'origin'])),
      'origin does not identify the configured repository');
    const targetRef = `refs/heads/${project.baseBranch}`;
    const canonicalUrl = `https://github.com/${project.repo}.git`;
    const remote = await observeRemote(testOnlyCanonicalUrl ?? canonicalUrl, targetRef,
      testOnlyCanonicalUrl !== undefined, execute);
    requireCandidate(remote === `${newSha}\t${targetRef}`, 'approved merge is not the exact origin/ralph-dev target');
    const header = (await readVerified(newSha, 'commit')).toString('utf8').split('\n\n', 1)[0];
    const parents = header.split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7));
    requireCandidate(parents.every(sha), 'candidate has invalid raw parents');
    requireCandidate(newSha === job.delivery.commit || (parents.length === 2 && parents[1] === job.delivery.commit), 'merge does not contain the exact reviewed head');
    requireCandidate(oldSha === newSha || (parents[0] === oldSha
      && (newSha === job.delivery.commit ? parents.length === 1 : parents.length === 2)),
      'candidate includes unreviewed intermediate commits');
    const range = (await isolatedGit(['rev-list', '--boundary', `${oldSha}..${newSha}`],
      { source: true })).split('\n').filter(Boolean);
    const boundaries = new Set([oldSha]);
    const commits = new Set([oldSha, newSha, job.delivery.commit]);
    for (const entry of range) {
      const boundary = entry.startsWith('-');
      const id = boundary ? entry.slice(1) : entry;
      requireCandidate(sha(id), 'invalid commit range');
      if (boundary) boundaries.add(id);
      else commits.add(id);
    }
    for (const id of commits) {
      const commit = await readVerified(id, 'commit');
      const tree = /^tree ([a-f0-9]{40})\n/.exec(commit.toString('utf8'))?.[1];
      requireCandidate(sha(tree), 'invalid commit tree');
      await verifyTree(tree);
    }
    // A reviewed side branch may fork before installed HEAD. Verify each
    // excluded boundary commit too, then cut only these private walk edges.
    // Their trees/older history are unnecessary for ancestry or the delta.
    // Raw commit bytes and the exact parent checks above remain unchanged.
    for (const id of boundaries) await readVerified(id, 'commit');
    fs.writeFileSync(path.join(scratch, 'shallow'), [...boundaries].join('\n') + '\n');
    await isolatedGit(['merge-base', '--is-ancestor', oldSha, newSha]);
    await git(diffArgs, { GIT_OBJECT_DIRECTORY: privateObjects });
    await isolatedGit(diffArgs);
    requireCandidate(await git(['rev-parse', '--verify', 'HEAD^{commit}']) === sourceHead,
      'checkout HEAD changed during validation');
    requireCandidate(await git(['symbolic-ref', '--quiet', '--short', 'HEAD']) === project.baseBranch,
      'checkout branch changed during validation');
    requireCandidate(await cleanStatus(project.checkout, sourceHead, git, env, privateObjects, expected, execute) === '',
      'checkout became dirty during validation');
    return Object.freeze({ oldSha, newSha, noOp: oldSha === newSha });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// Status must not load checkout filter drivers or recurse into submodule Git
// metadata. Inspect a snapshot for staged changes and unsupported flags, then
// discard its stat cache and build the status index from verified HEAD objects.
async function cleanStatus(checkout, head, git, env, objects, expected, execute) {
  const index = await git(['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-status-'));
  try {
    fs.mkdirSync(path.join(scratch, 'objects'));
    fs.mkdirSync(path.join(scratch, 'refs'));
    fs.writeFileSync(path.join(scratch, 'HEAD'), `${head}\n`);
    const privateIndex = path.join(scratch, 'index');
    fs.copyFileSync(index, privateIndex);
    const read = async args => (await execute('git', ['--no-replace-objects', `--git-dir=${scratch}`,
      `--work-tree=${checkout}`, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      '-c', 'core.commitGraph=false', '-c', 'core.attributesFile=/dev/null', ...args], {
      cwd: scratch, env: { ...env, GIT_INDEX_FILE: privateIndex, GIT_OBJECT_DIRECTORY: objects,
        GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null' },
      encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    })).stdout.trim();
    requireCandidate(!/(^|\x00)[a-zS] /.test(await read(['ls-files', '-v', '-z'])),
      'index assume-unchanged or skip-worktree flags are unsupported');
    requireCandidate(!/(^|\x00)160000 /.test(await read(['ls-files', '--stage', '-z'])),
      'submodule checkouts are unsupported');
    if (await read(['diff-index', '--cached', '--no-ext-diff', '--no-textconv', '--raw', '-z', head, '--'])) return 'staged changes';
    fs.unlinkSync(privateIndex);
    await read(['read-tree', head]); // New entries have zero, uncached stat data.
    const status = await read(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all']);
    if (status) return status;
    return worktreeMatches(checkout, expected) ? '' : 'tracked bytes differ';
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// Compare raw bytes independently of Git's attribute conversions and stat
// shortcuts. Refuse symlink ancestors, special files and changes during reads.
function worktreeMatches(checkout, expected) {
  try {
    for (const { relative, mode, bytes } of expected) {
      const file = Buffer.concat([Buffer.from(checkout + '/'), relative]);
      const ancestors = [];
      for (let i = 0; i < relative.length; i++) {
        if (relative[i] !== 47) continue;
        const directory = Buffer.concat([Buffer.from(checkout + '/'), relative.subarray(0, i)]);
        const stat = fs.lstatSync(directory, { bigint: true });
        if (!stat.isDirectory()) return false;
        ancestors.push({ directory, stat });
      }
      const before = fs.lstatSync(file, { bigint: true });
      const same = after => ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs']
        .every(key => before[key] === after[key]);
      if (mode === '120000') {
        if (!before.isSymbolicLink() || !fs.readlinkSync(file, { encoding: 'buffer' }).equals(bytes)) return false;
      } else {
        if (!before.isFile() || before.size !== BigInt(bytes.length)
          || Boolean(before.mode & 0o111n) !== (mode === '100755')) return false;
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          if (!same(fs.fstatSync(fd, { bigint: true }))) return false;
          const chunk = Buffer.alloc(Math.min(65536, bytes.length + 1));
          for (let offset = 0; offset < bytes.length;) {
            const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, bytes.length - offset), null);
            if (!count || !chunk.subarray(0, count).equals(bytes.subarray(offset, offset + count))) return false;
            offset += count;
          }
          if (fs.readSync(fd, chunk, 0, 1, null) !== 0
            || !same(fs.fstatSync(fd, { bigint: true }))) return false;
        } finally { fs.closeSync(fd); }
      }
      if (!same(fs.lstatSync(file, { bigint: true }))) return false;
      for (const { directory, stat } of ancestors) {
        const after = fs.lstatSync(directory, { bigint: true });
        if (!['dev', 'ino', 'mode', 'mtimeNs', 'ctimeNs'].every(key => stat[key] === after[key])) return false;
      }
    }
    return true;
  } catch { return false; }
}

// Never observe a named remote inside the worker-writable checkout. This bare
// gitdir has no config, and neither inherited Git settings nor proxy/TLS/helper
// environment can affect the request. Only the trusted Git HTTPS transport is
// enabled in production; local transport exists solely for the private tests.
async function observeRemote(url, ref, localForTest, execute) {
  if (localForTest) requireCandidate(path.isAbsolute(url), 'test remote must be an absolute local path');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-remote-'));
  try {
    fs.mkdirSync(path.join(scratch, 'objects'));
    fs.mkdirSync(path.join(scratch, 'refs'));
    fs.mkdirSync(path.join(scratch, 'home'));
    fs.writeFileSync(path.join(scratch, 'HEAD'), 'ref: refs/heads/unused\n');
    const env = {
      PATH: '/usr/bin:/bin', HOME: path.join(scratch, 'home'),
      XDG_CONFIG_HOME: path.join(scratch, 'home'), LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
      GIT_ALLOW_PROTOCOL: localForTest ? 'file' : 'https',
    };
    return (await execute('/usr/bin/git', ['--no-replace-objects', `--git-dir=${scratch}`,
      '-c', 'core.bare=true', 'ls-remote', '--exit-code', '--refs', url, ref], {
      cwd: scratch, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    })).stdout.trim();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { validateDeploymentCandidate, testing: { validateCandidate } };
