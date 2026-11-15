'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { spawn } = require('node:child_process');
const { validateDeploymentCandidate } = require('./deploy-preflight');
const { loadProjectConfig } = require('./autopilot-config');
const { createJobStore, resolveStateDir } = require('./autopilot-state');

// Fixed admission/attempt budgets fail closed; retained records are never pruned.
const LIMITS = Object.freeze({ objects: 100000, objectBytes: 512 * 1024 * 1024,
  commands: 128, copyMs: 600000, gitOutputBytes: 768 * 1024 * 1024,
  npmOutputBytes: 64 * 1024 * 1024, retainedBytes: 2 * 1024 * 1024 * 1024, requests: 64 });
function retainedSize(directory) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    // Another same-UID staging worker can atomically rename or finish writing
    // a temporary file while this advisory admission count is in progress.
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  return entries.reduce((size, entry) => {
    const file = path.join(directory, entry.name);
    try { return size + (entry.isDirectory() ? retainedSize(file) : fs.lstatSync(file).size); }
    catch (error) {
      if (error.code === 'ENOENT') return size;
      throw error;
    }
  }, 0);
}
function closeOutputs(descriptors) {
  let failure;
  for (const fd of descriptors) {
    try { fs.fsyncSync(fd); } catch (error) { failure ||= error; }
    try { fs.closeSync(fd); } catch (error) { failure ||= error; }
  }
  if (failure) throw failure;
}
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
// Resolve only from the executing runtime and explicit owner-controlled VM tool
// locations. Never consult the caller's PATH or npm_execpath.
function npmCli() {
  for (const file of [path.join(path.dirname(process.execPath), 'npm'),
    '/usr/local/bin/npm', '/usr/bin/npm', path.join(os.userInfo().homedir, '.local/bin/npm')]) {
    try {
      const resolved = fs.realpathSync(file);
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error('Trusted npm CLI unavailable beside Node or in VM tool directories');
}
function environment(home) {
  return { PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/local/bin', path.join(os.userInfo().homedir, '.local/bin')].join(':'), HOME: home, XDG_CONFIG_HOME: home, LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', npm_config_cache: path.join(home, 'npm-cache') };
}

// The lock belongs to the worker process and survives loss of its API caller.
// flock's inherited descriptor also keeps it held by a still-running test child.
async function runLocked(issueNumber, options = {}, worker = __filename) {
  const { root } = settings(issueNumber, options);
  requireStage(fs.readdirSync(root).filter(name => name.startsWith('request-')).length < LIMITS.requests
    && retainedSize(root) < LIMITS.retainedBytes, 'retained staging budget exhausted; owner archival required');
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
        // Preserve canonical state resolution. npm children use an isolated HOME;
        // the fixed tool path still includes the owner's ordinary VM tools.
        HOME: os.homedir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config') } });
      let settled = false;
      const finish = (code, failure) => {
        if (settled) return;
        settled = true;
        try {
          closeOutputs(descriptors);
          if (failure) throw failure;
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
        } catch (error) { reject(error); }
      };
      child.on('error', error => finish(null, error));
      child.on('close', code => finish(code));
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
  let commandCount = 0, gitOutputBytes = 0;
  const copyStarted = Date.now();
  const git = async (args, { source, cwd = repo, input, commandTimeout = 30000, outputLimit = 64 * 1024 * 1024 } = {}) => {
    requireStage(++commandCount <= LIMITS.commands && Date.now() - copyStarted <= LIMITS.copyMs,
      'Git command/time budget exhausted');
    const gitEnv = source ? { ...env, GIT_OBJECT_DIRECTORY: source } : env;
    const argv = ['--no-replace-objects', '-C', cwd, '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false', '-c', 'core.commitGraph=false', ...args];
    const output = ['stdout', 'stderr'].map(stream => path.join(attempt, `git-${commandCount}.${stream}`));
    const descriptors = output.map(file => fs.openSync(file, 'wx', 0o600));
    const inputFd = input === undefined ? undefined : fs.openSync(input, 'r');
    syncDir(attempt);
    record({ command: ['/usr/bin/git', ...argv], cwd, input, commandTimeout, outputLimit, stdout: output[0], stderr: output[1] });
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/git', argv, { env: gitEnv, timeout: commandTimeout,
        stdio: [inputFd ?? 'ignore', ...descriptors] });
      let failure, settled = false;
      const terminate = () => { try { child.kill('SIGKILL'); } catch (error) { failure ||= error; } };
      const outputTimer = setInterval(() => {
        try {
          const bytes = output.reduce((sum, file) => sum + fs.statSync(file).size, 0);
          if (bytes > outputLimit || gitOutputBytes + bytes > LIMITS.gitOutputBytes) {
            failure ||= new Error('Git output budget exhausted'); terminate();
          }
        } catch (error) { failure ||= error; terminate(); }
      }, 100);
      const finish = (code, signal, error) => {
        if (settled) return;
        settled = true;
        failure ||= error;
        clearInterval(outputTimer);
        try {
          closeOutputs(inputFd === undefined ? descriptors : [...descriptors, inputFd]);
          const commandBytes = output.reduce((sum, file) => sum + fs.statSync(file).size, 0);
          gitOutputBytes += commandBytes;
          record({ commandExit: commandCount, exitCode: code, signal, error: failure?.message });
          requireStage(commandBytes <= outputLimit && gitOutputBytes <= LIMITS.gitOutputBytes, 'Git output budget exhausted');
          if (failure) throw failure;
          requireStage(code === 0, `git ${args.join(' ')} failed (${code}, ${signal}); raw output: ${output.join(', ')}`);
          resolve(fs.readFileSync(output[0]));
        } catch (error) { reject(error); }
      };
      child.on('error', error => finish(null, null, error));
      child.on('close', finish);
    });
  };
  const runNpm = args => new Promise((resolve, reject) => {
    const cli = npmCli();
    const output = ['stdout', 'stderr'].map(stream => path.join(attempt, `npm-${args[0]}.${stream}`));
    const descriptors = output.map(file => fs.openSync(file, 'wx', 0o600));
    syncDir(attempt);
    record({ command: [process.execPath, cli, ...args], cwd: repo, timeoutMs, stdout: output[0], stderr: output[1] });
    // GNU timeout remains alive and enforces the bound even if this worker is
    // killed. Descriptor 3 carries the kernel lock into that process group.
    const child = spawn('/usr/bin/timeout', ['--signal=KILL', `${timeoutMs / 1000}s`, process.execPath, cli, ...args],
      { cwd: repo, env, detached: true, stdio: ['ignore', ...descriptors, 'inherit'] });
    let timedOut = false, failure, settled = false;
    const killGroup = () => {
      if (!Number.isInteger(child.pid)) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure ||= error; }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    const outputTimer = setInterval(() => {
      try {
        if (output.reduce((sum, file) => sum + fs.statSync(file).size, 0) > LIMITS.npmOutputBytes) {
          failure ||= new Error('npm output budget exhausted'); killGroup();
        }
      } catch (error) { failure ||= error; killGroup(); }
    }, 100);
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      failure ||= error;
      clearTimeout(timer);
      clearInterval(outputTimer);
      try {
        killGroup(); // no background descendants may outlive verification
        closeOutputs(descriptors);
        timedOut ||= signal === 'SIGKILL'; // GNU timeout can win the timer race
        record({ exitCode: code, signal, timedOut, error: failure?.message });
        if (failure) throw failure;
        requireStage(output.reduce((sum, file) => sum + fs.statSync(file).size, 0) <= LIMITS.npmOutputBytes, 'npm output budget exhausted');
        if (code === 0 && !timedOut) resolve(); else reject(new Error(`npm ${args.join(' ')} failed: code=${code} signal=${signal} timeout=${timedOut}`));
      } catch (error) { reject(error); }
    };
    child.on('error', error => finish(null, null, error));
    child.on('close', finish);
  });
  let receipt = { ...identity, state: 'PREPARING', attempt, repo, transcript };
  try {
    // PREPARED re-entry is reconciled by rerunning exact-candidate tests. This
    // avoids treating altered staging contents as still-verified bytes.
    atomicJson(checkpoint, receipt);
    record({ environment: env, workerNode: process.execPath, npmNode: process.execPath, limits: LIMITS });
    await git(['init', '--template=', '--initial-branch=staging']);
    const source = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { cwd: live })).toString().trim();
    // Enumerate IDs only: tree names (including embedded newlines) never delimit
    // this protocol. Read from a private empty Git directory, so source shallow
    // files, grafts, refs and configuration cannot truncate reachable history.
    const ids = (await git(['rev-list', '--objects', '--no-object-names', newSha], { source }))
      .toString('utf8').trim().split('\n');
    requireStage(ids.every(id => /^[a-f0-9]{40}$/.test(id)) && new Set(ids).size === ids.length,
      'invalid or duplicate history object IDs');
    requireStage(ids.length <= LIMITS.objects, 'history object count budget exhausted');
    const input = path.join(attempt, 'object-requests.txt');
    fs.writeFileSync(input, ids.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    const plan = (await git(['cat-file', '--batch-check'], { source, input })).toString('utf8').trim().split('\n');
    let plannedBytes = 0;
    requireStage(plan.length === ids.length, 'invalid batch plan');
    for (let i = 0; i < ids.length; i++) {
      const match = /^([a-f0-9]{40}) (commit|tree|blob) (0|[1-9][0-9]*)$/.exec(plan[i]);
      requireStage(match && match[1] === ids[i], 'invalid batch plan identity/type');
      plannedBytes += Number(match[3]);
      requireStage(Number.isSafeInteger(plannedBytes) && plannedBytes <= LIMITS.objectBytes, 'history byte budget exhausted');
    }
    const batch = await git(['cat-file', '--batch'], { source, input, commandTimeout: Math.max(1, LIMITS.copyMs - (Date.now() - copyStarted)),
      outputLimit: LIMITS.objectBytes + LIMITS.objects * 128 });
    const copied = new Map();
    let objectBytes = 0, offset = 0;
    for (const id of ids) {
      requireStage(Date.now() - copyStarted <= LIMITS.copyMs, 'Git command/time budget exhausted');
      const end = batch.indexOf(10, offset);
      requireStage(end >= offset && end - offset < 128, 'invalid batch header');
      const match = /^([a-f0-9]{40}) (commit|tree|blob) (0|[1-9][0-9]*)$/.exec(batch.subarray(offset, end).toString('utf8'));
      requireStage(match && match[1] === id && batch.subarray(offset, end).toString('utf8') === plan[copied.size], 'invalid batch object identity/type');
      const [, , type, length] = match, size = Number(length);
      objectBytes += size;
      requireStage(Number.isSafeInteger(size) && objectBytes <= LIMITS.objectBytes, 'history byte budget exhausted');
      offset = end + 1;
      requireStage(offset + size < batch.length && batch[offset + size] === 10, 'invalid batch object length');
      const bytes = batch.subarray(offset, offset + size);
      offset += size + 1;
      const object = Buffer.concat([Buffer.from(`${type} ${size}\0`), bytes]);
      requireStage(crypto.createHash('sha1').update(object).digest('hex') === id, `object hash mismatch ${id}`);
      const target = path.join(repo, '.git/objects', id.slice(0, 2), id.slice(2));
      // These are fresh private directories. Flush the complete repo once before
      // PREPARED; a crash before that leaves PREPARING and is rebuilt on retry.
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, deflateSync(object), { flag: 'wx', mode: 0o600 });
      copied.set(id, { type, bytes });
    }
    requireStage(offset === batch.length, 'unexpected trailing batch bytes');
    const copy = async (id, type) => {
      const object = copied.get(id);
      requireStage(object && object.type === type, 'missing history object or object type mismatch');
      return object.bytes;
    };
    // Track the *persistent* staging budget as well as per-attempt object
    // headroom: raw batch output, loose Git objects, and older attempt logs all
    // count against the 2-GiB admission gate.
    const retainedBytesAtCopy = retainedSize(root);
    record({ historyCopy: { objects: copied.size, bytes: objectBytes, elapsedMs: Date.now() - copyStarted,
      objectHeadroom: LIMITS.objects - copied.size, byteHeadroom: LIMITS.objectBytes - objectBytes,
      deadlineHeadroomMs: LIMITS.copyMs - (Date.now() - copyStarted),
      retainedBytesAtCopy, retainedHeadroomBytesAtCopy: Math.max(0, LIMITS.retainedBytes - retainedBytesAtCopy),
      retainedBudgetBytes: LIMITS.retainedBytes, verified: true } });
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
    // Report final retained space after npm outputs, checkout materialization
    // and flushing; an admission pass is not a guarantee of future capacity.
    const retainedBytesAfterTests = retainedSize(root);
    record({ state: 'PREPARED', oldSha, newSha, retainedStorage: {
      usedBytes: retainedBytesAfterTests, budgetBytes: LIMITS.retainedBytes,
      remainingBytes: Math.max(0, LIMITS.retainedBytes - retainedBytesAfterTests),
      note: 'measured before final checkpoint and transcript flush; future attempts require fresh admission' } });
    receipt = { ...receipt, state: 'PREPARED', preparedAt: new Date().toISOString() };
    atomicJson(checkpoint, receipt);
    return Object.freeze({ ...receipt, checkpoint });
  } catch (error) {
    // Attempt both durable failure records even if either storage operation fails.
    const failures = [];
    try { record({ state: 'FAILED', error: error.stack }); } catch (failure) { failures.push(failure); }
    try { atomicJson(checkpoint, { ...receipt, state: 'FAILED', error: error.message }); } catch (failure) { failures.push(failure); }
    if (failures.length) throw new AggregateError([error, ...failures],
      `${error.message}; failure recording: ${failures.map(failure => failure.message).join('; ')}`, { cause: error });
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
