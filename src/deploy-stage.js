'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validateDeploymentCandidate } = require('./deploy-preflight');
const { loadProjectConfig } = require('./autopilot-config');
const { createJobStore, resolveStateDir } = require('./autopilot-state');

const execute = promisify(execFile);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
function requireStage(ok, reason) {
  if (!ok) throw new Error(`Deployment staging refused: ${reason}`);
}
function syncDir(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
// Every ancestor is checked before creating anything. The state root is an
// owner-controlled directory, not writable by concurrently hostile processes.
function safeDirectory(directory) {
  directory = path.resolve(directory);
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    const parent = current;
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      try { fs.mkdirSync(current, { mode: 0o700 }); syncDir(parent); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const stat = fs.lstatSync(current);
    requireStage(stat.isDirectory() && !stat.isSymbolicLink(), `unsafe directory ${current}`);
  }
  return directory;
}
function regular(file) {
  const stat = fs.lstatSync(file);
  requireStage(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `unsafe file ${file}`);
}
function atomicJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  syncDir(path.dirname(file));
}
function settings(issueNumber, options = {}) {
  requireStage(Number.isSafeInteger(issueNumber) && issueNumber > 0, 'invalid issue number');
  requireStage(Object.keys(options).every(key => ['configPath', 'timeoutMs'].includes(key)), 'unknown option');
  const timeoutMs = options.timeoutMs ?? 600000;
  requireStage(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 1800000, 'invalid timeout');
  const project = loadProjectConfig('ralph', options.configPath === undefined ? {} : { configPath: options.configPath });
  const live = fs.realpathSync(project.checkout);
  const root = path.resolve(resolveStateDir('ralph', project), 'deployment-staging');
  requireStage(!inside(live, root) && !inside(root, live), 'staging and installed checkout overlap');
  safeDirectory(root);
  return { project, live, root, timeoutMs };
}
function evidence(project, issueNumber) {
  const job = createJobStore(resolveStateDir('ralph', project)).load(issueNumber);
  requireStage(job, 'missing canonical evidence');
  // Preserve all approval inputs verbatim; incidental orchestration timestamps
  // outside these records do not invalidate an otherwise identical approval.
  return JSON.parse(JSON.stringify(Object.fromEntries(['project', 'repo', 'issue', 'terminal', 'terminalState',
    'delivery', 'pr', 'review', 'ci', 'merge', 'verification'].map(key => [key, job[key]]))));
}
function environment(home) {
  return { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home, LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', npm_config_cache: path.join(home, 'npm-cache') };
}

// The lock belongs to the worker process and survives loss of its API caller.
// flock's inherited descriptor also keeps it held by a still-running test child.
async function runLocked(issueNumber, options = {}, worker = __filename) {
  const { root } = settings(issueNumber, options);
  const file = path.join(root, 'prepare.lock');
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  try {
    regular(file);
    syncDir(root);
    const request = safeDirectory(path.join(root, `request-${crypto.randomUUID()}`));
    const stdoutFile = path.join(request, 'worker.stdout');
    const stderrFile = path.join(request, 'worker.stderr');
    const descriptors = [stdoutFile, stderrFile].map(output => fs.openSync(output, 'wx', 0o600));
    syncDir(request);
    return await new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', '/usr/bin/flock --nonblock 3 || exit 75\nexec "$@"',
        'stage-lock', process.execPath, worker, '--stage-worker', JSON.stringify({ issueNumber, options })],
      { stdio: ['ignore', ...descriptors, fd], env: { ...environment(root),
        // Preserve canonical state resolution and the owner's preflight Git
        // settings. Only npm children receive the attempt's isolated HOME.
        HOME: os.homedir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config') } });
      child.on('error', reject);
      child.on('close', code => {
        for (const output of descriptors) { fs.fsyncSync(output); fs.closeSync(output); }
        const stdout = fs.readFileSync(stdoutFile, 'utf8'), stderr = fs.readFileSync(stderrFile, 'utf8');
        if (code !== 0) reject(new Error(`Deployment prepare worker failed (${code}); lock busy or staging refused (logs: ${request}): ${stderr}`));
        else {
          try {
            const { checkpoint } = JSON.parse(stdout);
            requireStage(inside(root, checkpoint), 'worker returned an unsafe checkpoint');
            regular(checkpoint);
            resolve(Object.freeze({ ...JSON.parse(fs.readFileSync(checkpoint, 'utf8')), checkpoint }));
          } catch (error) { reject(error); }
        }
      });
    });
  } finally { fs.closeSync(fd); }
}

async function prepare(issueNumber, options = {}) {
  const { project, live, root, timeoutMs } = settings(issueNumber, options);
  // The internal worker entry point is not an unlocked alternate API. Require
  // the exact persistent lock descriptor and acquire it on this shared open
  // file description before reading evidence or publishing a checkpoint.
  const inheritedLock = fs.fstatSync(3), namedLock = fs.lstatSync(path.join(root, 'prepare.lock'));
  requireStage(inheritedLock.isFile() && namedLock.isFile() && namedLock.nlink === 1
    && inheritedLock.dev === namedLock.dev && inheritedLock.ino === namedLock.ino, 'worker lock descriptor mismatch');
  await new Promise((resolve, reject) => {
    const lock = spawn('/usr/bin/flock', ['--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', 3] });
    lock.on('error', reject);
    lock.on('close', code => code === 0 ? resolve() : reject(new Error('Deployment prepare lock busy')));
  });
  const approvedEvidence = evidence(project, issueNumber);
  const candidate = await validateDeploymentCandidate(issueNumber, { configPath: options.configPath });
  const { oldSha, newSha } = candidate;
  requireStage([oldSha, newSha].every(value => /^[a-f0-9]{40}$/.test(value)), 'invalid candidate SHA');
  const evidenceHash = digest(JSON.stringify(approvedEvidence));
  requireStage(evidenceHash === digest(JSON.stringify(evidence(project, issueNumber))), 'approval changed during validation');
  requireStage(approvedEvidence.merge?.commit === newSha, 'approval/candidate SHA mismatch');
  const key = `${oldSha}-${newSha}`;
  const directory = safeDirectory(path.join(root, key));
  const checkpoint = path.join(directory, 'checkpoint.json');
  const identity = { issueNumber, oldSha, newSha, evidenceHash, approvedEvidence };
  let previous;
  if (fs.lstatSync(checkpoint, { throwIfNoEntry: false })) {
    regular(checkpoint);
    previous = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
    for (const [key, value] of Object.entries(identity)) {
      requireStage(JSON.stringify(previous[key]) === JSON.stringify(value), `checkpoint ${key} mismatch`);
    }
    requireStage(['PREPARING', 'PREPARED', 'FAILED'].includes(previous.state), 'unknown checkpoint state');
  }
  // Always build a fresh attempt after an interrupted run. Never delete an old
  // attempt or its diagnostics, and never trust a partially populated checkout.
  const attempt = safeDirectory(path.join(directory, `attempt-${crypto.randomUUID()}`));
  const repo = safeDirectory(path.join(attempt, 'repo'));
  const home = safeDirectory(path.join(attempt, 'home'));
  const env = environment(home);
  const transcript = path.join(attempt, 'transcript.jsonl');
  const logFd = fs.openSync(transcript, 'wx', 0o600);
  syncDir(attempt);
  const record = event => { fs.writeFileSync(logFd, `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`); fs.fsyncSync(logFd); };
  const git = async (args, { source, input } = {}) => {
    const gitEnv = source ? { ...env, GIT_OBJECT_DIRECTORY: source } : env;
    const argv = ['--no-replace-objects', '-C', repo, '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false', '-c', 'core.commitGraph=false', ...args];
    return new Promise((resolve, reject) => {
      const child = execFile('/usr/bin/git', argv, { env: gitEnv, encoding: null, timeout: 30000,
        maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        record({ command: ['/usr/bin/git', ...argv], stdout: stdout.toString('base64'), stderr: stderr.toString('base64'), encoding: 'base64', error: error?.message });
        if (error) reject(error); else resolve(stdout);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  };
  const runNpm = args => new Promise((resolve, reject) => {
    const output = ['stdout', 'stderr'].map(stream => path.join(attempt, `npm-${args[0]}.${stream}`));
    const descriptors = output.map(file => fs.openSync(file, 'wx', 0o600));
    syncDir(attempt);
    record({ command: ['/usr/bin/npm', ...args], cwd: repo, timeoutMs, stdout: output[0], stderr: output[1] });
    // GNU timeout remains alive and enforces the bound even if this worker is
    // killed. Descriptor 3 carries the kernel lock into that process group.
    const child = spawn('/usr/bin/timeout', ['--signal=KILL', `${timeoutMs / 1000}s`, '/usr/bin/npm', ...args],
      { cwd: repo, env, detached: true, stdio: ['ignore', ...descriptors, 'inherit'] });
    let timedOut = false;
    const killGroup = () => {
      if (!Number.isInteger(child.pid)) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      killGroup(); // no background descendants may outlive verification
      for (const fd of descriptors) { fs.fsyncSync(fd); fs.closeSync(fd); }
      timedOut ||= signal === 'SIGKILL'; // GNU timeout can win the timer race
      record({ exitCode: code, signal, timedOut });
      if (code === 0 && !timedOut) resolve(); else reject(new Error(`npm ${args.join(' ')} failed: code=${code} signal=${signal} timeout=${timedOut}`));
    });
  });
  let receipt = { ...identity, state: 'PREPARING', attempt, repo, transcript };
  try {
    // PREPARED re-entry is reconciled by rerunning exact-candidate tests. This
    // avoids treating altered staging contents as still-verified bytes.
    atomicJson(checkpoint, receipt);
    await git(['init', '--template=', '--initial-branch=staging']);
    const source = (await execute('/usr/bin/git', ['--no-replace-objects', '-C', live,
      'rev-parse', '--path-format=absolute', '--git-path', 'objects'], { env, timeout: 30000 })).stdout.trim();
    const copied = new Map();
    const copy = async (id, type) => {
      if (copied.has(id)) {
        requireStage(copied.get(id).type === type, 'object type mismatch');
        return copied.get(id).bytes;
      }
      const bytes = await git(['cat-file', type, id], { source });
      const actual = (await git(['hash-object', '-w', '-t', type, '--stdin'], { input: bytes })).toString().trim();
      requireStage(actual === id, `object hash mismatch ${id}`);
      copied.set(id, { type, bytes });
      return bytes;
    };
    const commit = await copy(newSha, 'commit');
    const tree = /^tree ([a-f0-9]{40})\n/.exec(commit.toString())?.[1];
    requireStage(tree, 'invalid candidate tree');
    const files = [];
    const trees = new Set();
    const copyTree = async (id, prefix = '', collect = true) => {
      if (!collect && trees.has(id)) return;
      trees.add(id);
      const bytes = await copy(id, 'tree');
      for (let offset = 0; offset < bytes.length;) {
        const space = bytes.indexOf(32, offset), nul = bytes.indexOf(0, space + 1);
        requireStage(space > offset && nul > space && nul + 21 <= bytes.length, 'invalid tree');
        const mode = bytes.subarray(offset, space).toString();
        const nameBytes = bytes.subarray(space + 1, nul);
        const name = nameBytes.toString('utf8');
        requireStage(!collect || (name.length > 0 && Buffer.from(name).equals(nameBytes) && name !== '.' && name !== '..'
          && name.toLowerCase() !== '.git' && !/[\\/]/.test(name)), 'unsafe tree path');
        const child = bytes.subarray(nul + 1, nul + 21).toString('hex');
        requireStage((collect ? ['40000', '100644', '100755']
          : ['40000', '100644', '100755', '120000', '160000']).includes(mode), 'symlinks and gitlinks are unsupported');
        if (mode === '40000') await copyTree(child, `${prefix}${name}/`, collect);
        else if (mode !== '160000') {
          const contents = await copy(child, 'blob');
          if (collect) files.push({ name: `${prefix}${name}`, object: child, hash: digest(contents), executable: mode === '100755' });
        }
        offset = nul + 21;
      }
    };
    await copyTree(tree);
    // The full suite audits retained historical evidence. Preserve reachable
    // history as verified private objects too, without fetching or linking the
    // installed object database. Raw parents ignore shared grafts/shallow refs.
    const pending = [newSha], commits = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (commits.has(id)) continue;
      commits.add(id);
      const header = (await copy(id, 'commit')).toString('utf8').split('\n\n', 1)[0];
      const ancestorTree = /^tree ([a-f0-9]{40})\n/.exec(header)?.[1];
      requireStage(ancestorTree, 'invalid historical commit tree');
      await copyTree(ancestorTree, '', false);
      const parents = header.split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7));
      requireStage(parents.every(parent => /^[a-f0-9]{40}$/.test(parent)), 'invalid historical parent');
      pending.push(...parents);
    }
    await git(['update-ref', 'HEAD', newSha]);
    await git(['read-tree', newSha]);
    // Write the verified bytes directly, avoiding even built-in attribute/EOL
    // conversions before executing the candidate's package scripts.
    for (const file of files) {
      const target = path.join(repo, file.name);
      safeDirectory(path.dirname(target));
      fs.writeFileSync(target, copied.get(file.object).bytes, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 });
    }
    for (const file of ['package.json', 'package-lock.json']) regular(path.join(repo, file));
    function metadata(directory) {
      const stat = fs.lstatSync(directory);
      requireStage(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe Git metadata directory');
      return fs.readdirSync(directory).sort().flatMap(name => {
        const file = path.join(directory, name), stat = fs.lstatSync(file);
        if (stat.isDirectory()) return metadata(file);
        regular(file);
        return [[file, digest(fs.readFileSync(file))]];
      });
    }
    const gitMetadata = JSON.stringify(metadata(path.join(repo, '.git')));
    await runNpm(['ci', '--no-audit', '--no-fund']);
    await runNpm(['test']);
    safeDirectory(repo);
    requireStage(JSON.stringify(metadata(path.join(repo, '.git'))) === gitMetadata, 'staging Git metadata changed');
    for (const file of files) {
      let parent = repo;
      for (const part of file.name.split('/').slice(0, -1)) {
        parent = path.join(parent, part);
        requireStage(fs.lstatSync(parent).isDirectory() && !fs.lstatSync(parent).isSymbolicLink(), 'tracked parent changed');
      }
      const target = path.join(repo, file.name);
      regular(target);
      requireStage(digest(fs.readFileSync(target)) === file.hash
        && Boolean(fs.statSync(target).mode & 0o111) === file.executable, `tracked file changed: ${file.name}`);
    }
    // Tests can create files. Reject outgoing symlinks/hardlinks before exposing
    // the prepared directory to a later deployment stage.
    function flush(directory) {
      requireStage(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink(), 'unsafe staging directory');
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name), stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) requireStage(inside(repo, fs.realpathSync(file)), 'outgoing staging symlink');
        else if (stat.isDirectory()) flush(file);
        else { regular(file); const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
      }
      syncDir(directory);
    }
    flush(repo);
    const again = await validateDeploymentCandidate(issueNumber, { configPath: options.configPath });
    requireStage(again.oldSha === oldSha && again.newSha === newSha
      && digest(JSON.stringify(evidence(project, issueNumber))) === evidenceHash, 'candidate or evidence changed during staging');
    record({ state: 'PREPARED', oldSha, newSha });
    receipt = { ...receipt, state: 'PREPARED', preparedAt: new Date().toISOString() };
    atomicJson(checkpoint, receipt);
    return Object.freeze({ ...receipt, checkpoint });
  } catch (error) {
    record({ state: 'FAILED', error: error.stack });
    atomicJson(checkpoint, { ...receipt, state: 'FAILED', error: error.message });
    throw error;
  } finally { fs.closeSync(logFd); }
}

async function prepareDeploymentCandidate(issueNumber, options) {
  return runLocked(issueNumber, options);
}

if (require.main === module && process.argv[2] === '--stage-worker') {
  const { issueNumber, options } = JSON.parse(process.argv[3]);
  prepare(issueNumber, options).then(result => fs.writeFileSync(1, JSON.stringify({ checkpoint: result.checkpoint })))
    .catch(error => {
      const raw = value => Buffer.isBuffer(value) ? { encoding: 'base64', bytes: value.toString('base64') } : value;
      fs.writeFileSync(2, `${JSON.stringify({ error: error.stack, stdout: raw(error.stdout), stderr: raw(error.stderr) })}\n`);
      process.exitCode = 1;
    });
}

module.exports = { prepareDeploymentCandidate };
