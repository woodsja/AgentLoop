const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-run-bash-'));
process.env.AGENTLOOP_STATE_DIR = path.join(scratch, 'state');
process.env.AGENTLOOP_CONFIG_PATH = path.join(scratch, 'config.json');
fs.writeFileSync(process.env.AGENTLOOP_CONFIG_PATH, '{}\n');

const { runBash, OUTPUT_LIMIT } = require('../src/run-bash');
const tools = require('../src/tools');

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const home = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'home-')));
const project = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'project-')));
spawnSync('git', ['init', '-q', project]);

let counter = 0;
function options(overrides = {}) {
  counter += 1;
  return {
    resolveCwd: (name) => {
      if (name !== 'example') throw new Error('Unknown project.');
      return project;
    },
    lockPath: path.join(scratch, `lock-${counter}`),
    auditPath: path.join(scratch, `audit-${counter}.ndjson`),
    defaultCwd: home,
    ...overrides,
  };
}

function running(marker) {
  return spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
}

function marker() {
  // A distinctive fractional duration makes the sleep process findable with pgrep.
  return `${40 + crypto.randomInt(1, 9)}.${crypto.randomInt(100000, 999999)}`;
}

test('pwd starts in the fixed default directory without a project', async () => {
  const result = await runBash({ command: 'pwd' }, options());
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), home);
  assert.equal(result.cwd, home);
  assert.equal(result.timedOut, false);
  assert.equal(typeof result.durationMs, 'number');
});

test('a registered project sets the starting directory and git status works there', async () => {
  const result = await runBash({ command: 'pwd && git status --short --branch', project: 'example' }, options());
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.split('\n')[0], project);
  assert.match(result.stdout, /^## /m);
});

test('commands run as the current unprivileged user', async () => {
  const result = await runBash({ command: 'whoami; id -u' }, options());
  const [user, uid] = result.stdout.trim().split('\n');
  assert.equal(user, os.userInfo().username);
  assert.equal(Number(uid), process.getuid());
  assert.notEqual(Number(uid), 0);
});

test('printf output is returned exactly', async () => {
  const result = await runBash({ command: "printf 'a\\tb\\n%s' done" }, options());
  assert.equal(result.stdout, 'a\tb\ndone');
  assert.equal(result.stderr, '');
});

test('a failing command reports its exit code and stderr', async () => {
  const result = await runBash({ command: 'echo oops >&2; exit 3' }, options());
  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, 'oops\n');
  assert.equal(result.timedOut, false);
});

test('invalid projects, worktrees, paths, and timeouts are rejected before anything runs', async () => {
  const opts = options();
  await assert.rejects(runBash({ command: 'true', project: 'nope' }, opts), /Unknown project/);
  await assert.rejects(runBash({ command: 'true', worktree: 'w' }, opts), /worktree requires project/);
  await assert.rejects(runBash({ command: 'true', cwd: '/' }, opts), /cwd is not accepted/);
  await assert.rejects(runBash({ command: 'true', env: {} }, opts), /env is not accepted/);
  await assert.rejects(runBash({ command: '' }, opts), /non-empty/);
  await assert.rejects(runBash({ command: 'true', timeoutSeconds: 61 }, opts), /1 to 60/);
  await assert.rejects(runBash({ command: 'true', timeoutSeconds: 0 }, opts), /1 to 60/);
  await assert.rejects(runBash({ command: 'true', timeoutSeconds: 1.5 }, opts), /1 to 60/);
  assert.equal(fs.existsSync(opts.lockPath), false);
  assert.equal(fs.existsSync(opts.auditPath), false);
});

test('a startup failure is reported rather than thrown', async () => {
  const result = await runBash({ command: 'true', project: 'example' }, options({
    resolveCwd: () => path.join(scratch, 'missing-directory'),
  }));
  assert.equal(result.exitCode, null);
  assert.match(result.error, /Failed to start bash/);
});

test('output keeps only the most recent bytes and reports truncation', async () => {
  const result = await runBash({ command: "head -c 300000 /dev/zero | tr '\\0' x; printf END" }, options());
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stdoutBytes, 300003);
  assert.ok(Buffer.byteLength(result.stdout) <= OUTPUT_LIMIT);
  assert.ok(result.stdout.endsWith('END'));
  assert.equal(result.stderrTruncated, false);
});

test('a timeout kills the whole process group', async () => {
  const duration = marker();
  const started = Date.now();
  const result = await runBash({ command: `sleep ${duration} & sleep ${duration}; echo unreachable`, timeoutSeconds: 1 }, options());
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 6000, 'timeout was not enforced promptly');
  assert.ok(!result.stdout.includes('unreachable'));
  assert.deepEqual(running(`sleep ${duration}`), []);
});

test('background jobs left by a finished command are cleaned up', async () => {
  const duration = marker();
  const result = await runBash({ command: `(sleep ${duration} &); sleep ${duration} & echo started` }, options());
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'started\n');
  assert.ok(result.durationMs < 5000, 'a background job kept the call open');
  assert.deepEqual(running(`sleep ${duration}`), []);
});

// Reads /proc/locks rather than probing with flock, which would briefly take the lock and
// make a concurrent acquisition under test fail.
function lockFree(lockPath) {
  if (!fs.existsSync(lockPath)) return true;
  const inode = fs.statSync(lockPath).ino;
  return !fs.readFileSync('/proc/locks', 'utf8').split('\n')
    .some(line => /\bFLOCK\b/.test(line) && line.split(/\s+/).some(field => field.endsWith(`:${inode}`)));
}

test('only one command runs at a time and the lock is free afterwards', async () => {
  const opts = options();
  const first = runBash({ command: 'sleep 1; echo first' }, opts);
  await new Promise(resolve => setTimeout(resolve, 200));
  await assert.rejects(runBash({ command: 'echo second' }, opts), /still running/);
  assert.equal(lockFree(opts.lockPath), false);
  assert.equal((await first).stdout, 'first\n');
  assert.equal(lockFree(opts.lockPath), true);
  assert.equal((await runBash({ command: 'echo next' }, opts)).stdout, 'next\n');
});

test('leftover lock file contents never block or grant the lock', async () => {
  const opts = options();
  fs.writeFileSync(opts.lockPath, String(process.pid));
  assert.equal((await runBash({ command: 'echo live-pid' }, opts)).stdout, 'live-pid\n');
  fs.writeFileSync(opts.lockPath, String(spawnSync('true').pid));
  assert.equal((await runBash({ command: 'echo dead-pid' }, opts)).stdout, 'dead-pid\n');
  assert.equal(fs.existsSync(opts.lockPath), true);
});

test('a lock held by another process blocks the call and is recovered when that process dies', async () => {
  const opts = options();
  const duration = marker();
  const holder = spawn('flock', ['--nonblock', opts.lockPath, 'sleep', duration], { stdio: 'ignore' });
  try {
    await waitFor(() => !lockFree(opts.lockPath));
    await assert.rejects(runBash({ command: 'echo blocked' }, opts), /still running/);
    // The original defect: an owner's lock file was briefly empty and looked stale.
    fs.writeFileSync(opts.lockPath, '');
    await assert.rejects(runBash({ command: 'echo blocked' }, opts), /still running/);
    // The rejected call must not have deleted or released the other process's lock.
    assert.equal(fs.existsSync(opts.lockPath), true);
    assert.equal(lockFree(opts.lockPath), false);
  } finally {
    holder.kill('SIGKILL');
    await new Promise(resolve => holder.on('close', resolve));
    spawnSync('pkill', ['-f', `sleep ${duration}`]);
  }
  assert.equal((await runBash({ command: 'echo recovered' }, opts)).stdout, 'recovered\n');
});

test('a server that dies holding the lock does not leave it held', async () => {
  const opts = options();
  const script = `
    const { runBash } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'run-bash.js'))});
    runBash({ command: 'echo ready; sleep 30' }, { lockPath: ${JSON.stringify(opts.lockPath)}, auditPath: ${JSON.stringify(opts.auditPath)} });
  `;
  const server = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  await waitFor(() => !lockFree(opts.lockPath));
  server.kill('SIGKILL');
  await new Promise(resolve => server.on('close', resolve));
  await waitFor(() => lockFree(opts.lockPath));
  assert.equal((await runBash({ command: 'echo after-crash' }, opts)).stdout, 'after-crash\n');
  // Abandoned by the SIGKILLed server, which is the documented limitation.
  spawnSync('pkill', ['-f', '^sleep 30$']);
});

test('separate processes racing for the lock never both run a command', async () => {
  const opts = options();
  const overlap = path.join(scratch, `overlap-${counter}`);
  // A second concurrent owner would find the marker directory already present.
  const command = `mkdir '${overlap}.active' || echo OVERLAP >> '${overlap}'; sleep 1; rmdir '${overlap}.active'`;
  const startAt = Date.now() + 1500;
  const script = `
    const { runBash } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'run-bash.js'))});
    setTimeout(async () => {
      try {
        const result = await runBash({ command: process.argv[1] }, { lockPath: process.argv[2], auditPath: process.argv[3] });
        console.log(JSON.stringify({ ran: true, exitCode: result.exitCode }));
      } catch (error) {
        console.log(JSON.stringify({ ran: false, message: error.message }));
      }
    }, ${startAt} - Date.now());
  `;
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, command, opts.lockPath, opts.auditPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(JSON.parse(out)));
  })));
  const ran = outcomes.filter(outcome => outcome.ran);
  assert.equal(ran.length, 1, JSON.stringify(outcomes));
  assert.equal(ran[0].exitCode, 0);
  for (const outcome of outcomes.filter(o => !o.ran)) assert.match(outcome.message, /still running/);
  assert.equal(fs.existsSync(overlap), false, 'two commands held the lock at once');
  assert.equal(lockFree(opts.lockPath), true);
});

test('the command environment excludes the server credentials', async () => {
  process.env.CONTROL_PLANE_API_KEY = 'tunnel-secret-value';
  try {
    const result = await runBash({ command: 'env' }, options());
    assert.ok(!result.stdout.includes('tunnel-secret-value'));
    assert.ok(!result.stdout.includes('CONTROL_PLANE_API_KEY'));
    assert.match(result.stdout, /^PATH=/m);
    assert.match(result.stdout, /^HOME=/m);
  } finally {
    delete process.env.CONTROL_PLANE_API_KEY;
  }
});

test('the audit log records metadata but not the command text or output', async () => {
  const opts = options();
  const secret = 'sk-test-not-a-real-credential';
  const result = await runBash({ command: `printf ${secret}; exit 2`, project: 'example' }, opts);
  assert.equal(result.exitCode, 2);
  const log = fs.readFileSync(opts.auditPath, 'utf8');
  assert.ok(!log.includes(secret));
  const [start, end] = log.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(start.event, 'run_bash_start');
  assert.equal(start.project, 'example');
  assert.equal(start.cwd, project);
  assert.equal(start.program, 'printf');
  assert.match(start.commandSha256, /^[0-9a-f]{64}$/);
  assert.equal(start.uid, process.getuid());
  assert.equal(end.event, 'run_bash_end');
  assert.equal(end.id, start.id);
  assert.equal(end.exitCode, 2);
  assert.equal(end.stdoutBytes, secret.length);
  assert.equal((fs.statSync(opts.auditPath).mode & 0o777), 0o600);
});

test('run_bash is not in the shared tool list and is refused unless enabled', async () => {
  assert.equal(tools.tools.some(tool => tool.name === 'run_bash'), false);
  const refused = await tools.callTool({ name: 'run_bash', arguments: { command: 'echo hi' } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /Unknown tool/);

  const opts = options();
  const allowed = await tools.callTool({ name: 'run_bash', arguments: { command: 'echo hi' } }, {
    runBash: true,
    runBashLockPath: opts.lockPath,
    runBashAuditPath: opts.auditPath,
    runBashDefaultCwd: home,
  });
  assert.equal(allowed.isError, undefined);
  assert.equal(allowed.structuredContent.stdout, 'hi\n');
  assert.equal(allowed.structuredContent.exitCode, 0);
});

test('run_bash is advertised as state-changing and destructive', () => {
  const { annotations, description, inputSchema } = tools.runBashTool;
  assert.equal(annotations.readOnlyHint, false);
  assert.equal(annotations.destructiveHint, true);
  assert.equal(annotations.openWorldHint, true);
  assert.match(description, /does not restrict filesystem access/);
  assert.equal(inputSchema.properties.timeoutSeconds.maximum, 60);
  assert.equal(inputSchema.additionalProperties, false);
  assert.ok(!Object.hasOwn(inputSchema.properties, 'cwd'));
});

function listTools(extraArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp-server.js'), ...extraArgs], {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      const response = out.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(message => message.id === 1);
      resolve(response.result.tools.map(tool => tool.name));
    });
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
  });
}

test('the stdio MCP server lists run_bash only with --enable-run-bash', async () => {
  assert.equal((await listTools([])).includes('run_bash'), false);
  assert.equal((await listTools(['--enable-run-bash'])).includes('run_bash'), true);
});

async function waitFor(predicate, limitMs = 5000) {
  const deadline = Date.now() + limitMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const stateDir = process.env.AGENTLOOP_STATE_DIR;

function auditEntries() {
  const file = path.join(stateDir, 'logs', 'run-bash.ndjson');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
}

// Starts the real stdio server with run_bash enabled and a command that keeps a foreground
// and a background sleep running, then waits until both are visible.
async function serverWithActiveCommand(command) {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp-server.js'), '--enable-run-bash'], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let out = '';
  server.stdout.on('data', chunk => { out += chunk; });
  const closed = new Promise(resolve => server.on('close', (code, signal) => resolve({ code, signal })));
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_bash', arguments: { command, timeoutSeconds: 60 } } })}\n`);
  // A failed assertion must not leave the server, and the test run, waiting on stdin.
  test.after(() => server.kill('SIGKILL'));
  return { server, closed, output: () => out };
}

for (const [label, end, expectedCode] of [
  ['stdin EOF', server => server.stdin.end(), 0],
  ['SIGTERM', server => server.kill('SIGTERM'), 143],
  ['SIGINT', server => server.kill('SIGINT'), 130],
]) {
  test(`MCP ${label} during an active command stops its whole process group before exiting`, async () => {
    const duration = marker();
    const before = auditEntries().length;
    const { server, closed, output } = await serverWithActiveCommand(`sleep ${duration} & sleep ${duration}`);
    await waitFor(() => running(`^sleep ${duration}$`).length === 2);
    const started = Date.now();
    end(server);
    const { code } = await closed;
    assert.equal(code, expectedCode);
    assert.ok(Date.now() - started < 8000, 'shutdown was not bounded');
    assert.deepEqual(running(`sleep ${duration}`), [], 'command processes were orphaned');
    assert.equal(lockFree(path.join(stateDir, 'run-bash.lock')), true);
    const [, ended] = auditEntries().slice(before);
    assert.equal(ended.event, 'run_bash_end');
    assert.equal(ended.stoppedByShutdown, true);
    if (label !== 'stdin EOF') {
      const response = output().split('\n').filter(Boolean).map(line => JSON.parse(line)).find(message => message.id === 1);
      assert.equal(response.result.structuredContent.stoppedByShutdown, true);
    }
  });
}

test('MCP shutdown escalates to SIGKILL for a command that ignores SIGTERM', async () => {
  const duration = marker();
  const { server, closed } = await serverWithActiveCommand(`trap '' TERM; sleep ${duration} & sleep ${duration}`);
  await waitFor(() => running(`^sleep ${duration}$`).length === 2);
  const started = Date.now();
  server.stdin.end();
  assert.equal((await closed).code, 0);
  assert.ok(Date.now() - started < 8000, 'shutdown was not bounded');
  assert.deepEqual(running(`sleep ${duration}`), [], 'command processes were orphaned');
});

test('MCP stdin EOF with no active command exits promptly', async () => {
  const started = Date.now();
  assert.equal((await listTools(['--enable-run-bash'])).includes('run_bash'), true);
  assert.ok(Date.now() - started < 3000);
});
