// Direct Bash execution for the MCP run_bash tool. It runs as the server's own Linux user;
// the working directory is only a starting point and does not restrict filesystem access.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 60;
const MAX_COMMAND_LENGTH = 16 * 1024;
// Per stream: the last OUTPUT_LIMIT bytes are kept in memory and returned.
const OUTPUT_LIMIT = 32 * 1024;
const KILL_GRACE_MS = 2000;
const CLOSE_GRACE_MS = 2000;
const LOCK_RELEASE_MS = 1000;
const LOCK_BUSY_EXIT = 75;
// Long enough for a stopped command to pass through SIGTERM, SIGKILL, and the close grace.
const SHUTDOWN_LIMIT_MS = KILL_GRACE_MS + CLOSE_GRACE_MS + LOCK_RELEASE_MS + 1000;

// Calls in progress and their running commands, so shutdown() can stop them: each command
// runs in its own detached process group, which would otherwise outlive the server.
const calls = new Set();
const commands = new Set();
let shuttingDown = false;

// Only these variables reach the command: the MCP process environment holds the tunnel's
// control-plane API key, which a command such as `env` would otherwise reveal.
function commandEnv(source = process.env) {
  const env = {
    PATH: source.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: source.HOME || os.homedir(),
    SHELL: '/bin/bash',
    LANG: source.LANG || 'C.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
  };
  for (const name of ['USER', 'LOGNAME']) {
    if (source[name]) env[name] = source[name];
  }
  return env;
}

function validate(args) {
  const { command, timeoutSeconds } = args;
  if (typeof command !== 'string' || !command.trim()) throw new Error('command must be a non-empty string.');
  if (command.length > MAX_COMMAND_LENGTH) throw new Error(`command exceeds ${MAX_COMMAND_LENGTH} characters.`);
  if (command.includes('\0')) throw new Error('command must not contain NUL characters.');
  if (timeoutSeconds !== undefined
    && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS)) {
    throw new Error(`timeoutSeconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}.`);
  }
  for (const field of ['cwd', 'projectPath', 'env']) {
    if (Object.hasOwn(args, field)) throw new Error(`${field} is not accepted; select a registered project instead.`);
  }
  return timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
}

// Keeps the most recent bytes, so memory stays bounded however much a command prints.
function tailBuffer() {
  let chunks = [];
  let kept = 0;
  let total = 0;
  return {
    push(chunk) {
      total += chunk.length;
      chunks.push(chunk);
      kept += chunk.length;
      if (kept > OUTPUT_LIMIT * 2) {
        chunks = [Buffer.concat(chunks).subarray(-OUTPUT_LIMIT)];
        kept = chunks[0].length;
      }
    },
    text() {
      const buffer = Buffer.concat(chunks);
      return buffer.subarray(Math.max(0, buffer.length - OUTPUT_LIMIT)).toString('utf8');
    },
    truncated: () => total > OUTPUT_LIMIT,
    total: () => total,
  };
}

// One command at a time across every MCP server process sharing this state directory.
// A flock(1) helper takes the kernel lock and holds it until its stdin closes. The kernel
// releases it if the helper or this server dies, so there is no stale-lock recovery, and the
// lock file is never deleted, so no caller can remove a lock another process holds.
// Resolves to an async release function, or null when another command holds the lock.
function acquireLock(lockPath, flockPath = 'flock') {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.closeSync(fs.openSync(lockPath, 'a', 0o600));
  return new Promise((resolve, reject) => {
    // detached keeps terminal signals sent to this server's group from dropping the lock early.
    const holder = spawn(flockPath, [
      '--nonblock', '--conflict-exit-code', String(LOCK_BUSY_EXIT), lockPath,
      '/bin/sh', '-c', 'echo locked; exec cat >/dev/null',
    ], { detached: true, stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
    const closed = new Promise(done => holder.on('close', done));
    let acquired = false;
    let output = '';
    holder.stdin.on('error', () => {});
    holder.on('error', error => reject(new Error(`run_bash could not take its lock with flock: ${error.message}`)));
    holder.stdout.on('data', (chunk) => {
      output += chunk;
      if (acquired || !output.includes('locked\n')) return;
      acquired = true;
      resolve(async () => {
        holder.stdin.end();
        const timer = setTimeout(() => holder.kill('SIGKILL'), LOCK_RELEASE_MS);
        await closed;
        clearTimeout(timer);
      });
    });
    holder.on('close', (code) => {
      if (acquired) return;
      if (code === LOCK_BUSY_EXIT) resolve(null);
      else reject(new Error(`run_bash could not take its lock: flock exited with ${code}.`));
    });
  });
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
  }
}

// Metadata only: the command text and its output can contain credentials, so the log
// keeps a hash, the length, and the leading program name.
function audit(logPath, entry) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
  }
}

function commandMetadata(command) {
  const program = command.trim().split(/\s+/)[0];
  return {
    commandSha256: crypto.createHash('sha256').update(command).digest('hex'),
    commandLength: command.length,
    ...(/^[A-Za-z0-9._/-]{1,64}$/.test(program) ? { program } : {}),
  };
}

function execute(commandText, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const stdout = tailBuffer();
    const stderr = tailBuffer();
    let timedOut = false;
    let stopped = false;
    let exit = null;
    let settled = false;
    let killTimer = null;
    let closeTimer = null;
    let child;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      commands.delete(command);
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      resolve({
        exitCode: exit ? exit.code : null,
        ...(exit && exit.signal ? { signal: exit.signal } : {}),
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        ...(stopped ? { stoppedByShutdown: true } : {}),
        durationMs: Date.now() - started,
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
        stdoutBytes: stdout.total(),
        stderrBytes: stderr.total(),
        ...(error ? { error } : {}),
      });
    };

    // SIGTERM to the whole group, then SIGKILL after the grace period.
    const terminate = () => {
      if (killTimer || !child?.pid) return;
      killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const command = {
      stop() {
        stopped = true;
        terminate();
      },
      kill() {
        if (child?.pid) killGroup(child.pid, 'SIGKILL');
      },
    };
    commands.add(command);

    try {
      // detached puts bash in its own process group, so the whole group can be signalled.
      child = spawn('/bin/bash', ['-c', commandText], {
        cwd,
        env: commandEnv(),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(`Failed to start bash: ${error.message}`);
      return;
    }

    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => finish(`Failed to start bash: ${error.message}`));
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      // Background jobs left in the group would outlive the call and hold the pipes open.
      if (child.pid) killGroup(child.pid, 'SIGKILL');
      closeTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish();
      }, CLOSE_GRACE_MS);
    });
    child.on('close', () => finish());
  });
}

async function runBash(args, { resolveCwd, lockPath, auditPath, defaultCwd = os.homedir(), flockPath }) {
  if (shuttingDown) throw new Error('run_bash is shutting down.');
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('run_bash refuses to run as root.');
  }
  const timeoutSeconds = validate(args);
  if (args.project === undefined && args.worktree !== undefined) throw new Error('worktree requires project.');
  const cwd = args.project === undefined ? defaultCwd : resolveCwd(args.project, args.worktree);

  const call = runLocked(args, { cwd, timeoutSeconds, lockPath, auditPath, flockPath });
  calls.add(call);
  call.finally(() => calls.delete(call)).catch(() => {});
  return call;
}

async function runLocked(args, { cwd, timeoutSeconds, lockPath, auditPath, flockPath }) {
  const release = await acquireLock(lockPath, flockPath);
  if (!release) throw new Error('Another run_bash command is still running.');
  try {
    // Shutdown may have begun while the lock was being taken.
    if (shuttingDown) throw new Error('run_bash is shutting down.');
    const id = crypto.randomBytes(6).toString('hex');
    const scope = {
      id,
      ...(args.project !== undefined ? { project: args.project } : {}),
      ...(args.worktree !== undefined ? { worktree: args.worktree } : {}),
      cwd,
      uid: process.getuid ? process.getuid() : null,
      ...commandMetadata(args.command),
      timeoutSeconds,
    };
    audit(auditPath, { event: 'run_bash_start', ...scope });
    const result = await execute(args.command, cwd, timeoutSeconds * 1000);
    audit(auditPath, {
      event: 'run_bash_end', id,
      exitCode: result.exitCode,
      ...(result.signal ? { signal: result.signal } : {}),
      timedOut: result.timedOut,
      ...(result.stoppedByShutdown ? { stoppedByShutdown: true } : {}),
      durationMs: result.durationMs,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      ...(result.error ? { error: result.error } : {}),
    });
    return { cwd, ...result };
  } finally {
    await release();
  }
}

// For server shutdown: refuses new calls, stops every running command (SIGTERM, then SIGKILL),
// and waits for each call to finish and release the lock. Any process group still present at
// the limit is SIGKILLed. A server killed with SIGKILL, or one that crashes, never gets here:
// its commands keep running without a timeout, and the kernel drops the lock immediately.
async function shutdown(limitMs = SHUTDOWN_LIMIT_MS) {
  shuttingDown = true;
  for (const command of commands) command.stop();
  let timer;
  await Promise.race([
    Promise.allSettled([...calls]),
    new Promise((resolve) => { timer = setTimeout(resolve, limitMs); }),
  ]);
  clearTimeout(timer);
  for (const command of commands) command.kill();
}

module.exports = {
  runBash,
  shutdown,
  commandEnv,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  OUTPUT_LIMIT,
};
