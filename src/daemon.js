const { recorder, captureProcess } = require('./execution-log');
// Daemon scheduler, worker runner, and local HTTP API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const store = require('./store');
const { createR1Jobs } = require('./r1-jobs');
const { startTime: r1ProcessStartTime, terminatePriorR1Worker } = require('./r1-process-claim');
let r1Jobs = createR1Jobs(store, { cancelChild: cancelOwnedR1Child });
const engines = require('./engines');
const { resolveProject, resolveWorkerScope } = require('./project-registry');
const state = require('./state');
const {
  taskPrompt,
  loopWorkerPrompt,
  polishWorkerPrompt,
  criticPrompt,
  polishCriticPrompt,
  parseLoopResult,
  parseCriticVerdict,
  parsePlanTasks,
  parsePolishVerdict,
} = require('./prompts');

const pollMs = 1500;
const maxResultText = 20000;
const maxLogLines = 1000;
const maxEventBytes = 16 * 1024;
const maxDigestBytes = 1024 * 1024;
const knownEngines = new Set(engines.ids());
const messageKinds = new Set(['info', 'question', 'results']);
const terminalTaskStatuses = new Set(['done', 'failed', 'cancelled', 'passed', 'maxed', 'partial', 'incomplete', 'plan_complete']);
const dirtyTreeError = 'Auto-checkpoint needs a clean project tree: commit or stash your changes first.';
const defaultLoopCycles = 3;
const defaultTaskRetries = 3;
const shutdownGracePeriodMs = 10000;
const shutdownDeadlineMarginMs = 2000;
const runningActivity = new Map();
const activeWorkers = new Map();

let daemonInfo;
let server;
let ticker;
let stopping = false;
let bridgeChild;

class GitCheckpointError extends Error {
  constructor(message, stderr) {
    super(message);
    this.name = 'GitCheckpointError';
    this.stderr = stderr;
  }
}

function taskTime(task, field) {
  const value = Date.parse(task[field]);
  return Number.isFinite(value) ? value : 0;
}

function taskPriority(task) {
  const value = Number(task.priority);
  return Number.isFinite(value) ? value : 5;
}

function sortPending(tasks) {
  return tasks.sort((left, right) => (
    taskPriority(left) - taskPriority(right)
    || taskTime(left, 'createdAt') - taskTime(right, 'createdAt')
  ));
}

function trimResult(text) {
  const value = String(text || '').trim();
  return value.length > maxResultText ? value.slice(-maxResultText) : value;
}

function recordActivity(id, engine, line) {
  const parsed = engine.parseLine(line) || {};
  const text = String(parsed.text || '').trim();

  if (text) {
    const previous = runningActivity.get(id);
    runningActivity.set(id, {
      ts: new Date().toISOString(),
      text: text.slice(0, 500),
      toolCalls: (previous && previous.toolCalls ? previous.toolCalls : 0) + (parsed.tool ? 1 : 0),
    });
  }

  return parsed;
}

function recordEvent(type, data) {
  try {
    store.appendEvent(type, data);
    if (data?.id && /^[A-Za-z0-9_-]+$/.test(data.id)) {
      recorder(store, data.id)('orchestration', { type, data });
      let task;
      for (const stage of ['running', 'done', 'pending']) {
        try { task = store.readTask(data.id, stage); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (task?.r1Child?.parentJobId) recorder(store, task.r1Child.parentJobId)('orchestration', { type, data, childId: data.id, parentId: task.r1Child.parentJobId });
    }
  } catch (error) {
    console.error(`Failed to append ${type} event: ${error.message}`);
  }
}

function streamLines(stream, onLine) {
  let buffered = '';
  const decoder = new (require('node:string_decoder').StringDecoder)('utf8');

  stream.on('data', (chunk) => {
    buffered += decoder.write(chunk);
    const lines = buffered.split('\n');
    buffered = lines.pop();

    for (const line of lines) {
      onLine(line.replace(/\r$/, ''));
    }
  });

  stream.on('end', () => {
    buffered += decoder.end();
    if (buffered) {
      onLine(buffered.replace(/\r$/, ''));
    }
  });
}

function spawnEngine(engine, args, options) {
  const executable = engines.binary(engine, store.config.enginePaths);

  if (!executable) {
    throw new Error(`${engine.label} CLI not found on PATH. Install it (${engine.installHint}) and restart the daemon.`);
  }

  const settings = engine.env ? { ...options, env: engine.env(process.env) } : options;

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', executable, ...args], settings);
  }

  return spawn(executable, args, settings);
}

function taskkillPath() {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(windowsRoot, 'System32', 'taskkill.exe');
}

function terminateWorker(child) {
  if (!child.pid) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      const killer = spawnSync(taskkillPath(), ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });

      if (killer.status !== 0) {
        child.kill('SIGKILL');
      }
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
      }
    }
    return;
  }

  try {
    child.kill('SIGKILL');
  } catch {
  }
}

function terminateLoopWorker(worker) {
  if (worker.detachedGroup && worker.child?.pid && process.platform !== 'win32') {
    try { process.kill(-worker.child.pid, 'SIGKILL'); return; }
    catch { /* Fallback still targets the known direct child. */ }
  }
  terminateWorker(worker.child);
}

function stopWorker(child) {
  if (!child.pid) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      spawnSync(taskkillPath(), ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
    }
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
  }
}

function bridgePort() {
  const port = Number(store.config.mcpBridge?.port);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 5758;
}

function readBridgeHeartbeat() {
  try {
    return JSON.parse(fs.readFileSync(store.paths.bridge, 'utf8'));
  } catch {
    return null;
  }
}

function clearBridgeHeartbeat(pid) {
  const heartbeat = readBridgeHeartbeat();

  if (pid && heartbeat && heartbeat.pid !== pid) {
    return;
  }

  try {
    fs.unlinkSync(store.paths.bridge);
  } catch {
  }
}

function bridgeRunning() {
  return store.isAlive(readBridgeHeartbeat());
}

function recoverBridgeHeartbeat() {
  const heartbeat = readBridgeHeartbeat();

  if (heartbeat && !store.isAlive(heartbeat)) {
    clearBridgeHeartbeat(heartbeat.pid);
  }
}

function readBridgeToken() {
  try {
    const token = fs.readFileSync(store.paths.mcpToken, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

const quickTunnelPorts = [20241, 20242, 20243, 20244, 20245];
const quickTunnelProbeMs = 400;

function probeQuickTunnelPort(port) {
  return new Promise((resolve) => {
    let settled = false;
    let req;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(wall);
      resolve(value);
    };
    const wall = setTimeout(() => {
      try { req.destroy(); } catch { /* already closed */ }
      done(null);
    }, quickTunnelProbeMs);

    req = http.get({
      host: '127.0.0.1',
      port,
      path: '/quicktunnel',
      timeout: quickTunnelProbeMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) {
          req.destroy();
          done(null);
        }
      });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const raw = typeof data?.hostname === 'string' ? data.hostname.trim() : '';
          if (!raw) {
            done(null);
            return;
          }
          if (raw.includes('://')) {
            done(new URL(raw).hostname || null);
            return;
          }
          done(raw.replace(/\/+$/, '') || null);
        } catch {
          done(null);
        }
      });
    });
    req.on('error', () => done(null));
    req.on('timeout', () => {
      req.destroy();
      done(null);
    });
  });
}

async function detectQuickTunnelHostname() {
  const results = await Promise.all(quickTunnelPorts.map(probeQuickTunnelPort));
  return results.find((hostname) => hostname) || null;
}

async function bridgeDetails() {
  const port = bridgePort();
  const token = readBridgeToken();
  const localEndpoint = `http://127.0.0.1:${port}/mcp`;
  const connectorUrl = token ? `${localEndpoint}?key=${encodeURIComponent(token)}` : localEndpoint;
  const hostname = await detectQuickTunnelHostname();
  const publicUrl = hostname
    ? (token ? `https://${hostname}/mcp?key=${encodeURIComponent(token)}` : `https://${hostname}/mcp`)
    : null;

  return {
    running: bridgeRunning(),
    port,
    localEndpoint,
    connectorUrl,
    publicUrl,
    token,
  };
}

function startBridge() {
  if (bridgeRunning()) {
    return true;
  }

  recoverBridgeHeartbeat();

  if (bridgeChild && bridgeChild.exitCode === null && !bridgeChild.killed) {
    return true;
  }

  try {
    const child = spawn(process.execPath, [path.join(store.paths.root, 'bridge.js')], {
      cwd: store.paths.root,
      stdio: 'ignore',
      windowsHide: true,
    });

    bridgeChild = child;
    child.unref();
    child.once('error', (error) => {
      console.error(`Bridge failed to start: ${error.message}`);
      if (bridgeChild === child) {
        bridgeChild = undefined;
      }
    });
    child.once('exit', () => {
      clearBridgeHeartbeat(child.pid);
      if (bridgeChild === child) {
        bridgeChild = undefined;
      }
    });
    return true;
  } catch (error) {
    console.error(`Bridge failed to start: ${error.message}`);
    return false;
  }
}

function stopBridge() {
  const heartbeat = readBridgeHeartbeat();

  if (!store.isAlive(heartbeat)) {
    recoverBridgeHeartbeat();
    return false;
  }

  const child = bridgeChild && bridgeChild.pid === heartbeat.pid
    ? bridgeChild
    : {
      pid: heartbeat.pid,
      kill(signal) {
        process.kill(this.pid, signal);
      },
    };

  terminateWorker(child);
  clearBridgeHeartbeat(heartbeat.pid);
  if (bridgeChild === child) {
    bridgeChild = undefined;
  }
  return true;
}

function readWorkerOutput(outputPath, fallback, record = () => {}) {
  try {
    const bytes = fs.readFileSync(outputPath);
    record('result-file', { base64: bytes.toString('base64'), path: outputPath });
    const output = bytes.toString('utf8');
    return output.trim() ? output : fallback;
  } catch (error) {
    record('exception', { path: outputPath, name: error.name, message: error.message, stack: error.stack, code: error.code });
    return fallback;
  } finally {
    try {
      fs.unlinkSync(outputPath);
    } catch {
    }
  }
}

function trackTail(tail, parsed) {
  if (!parsed) {
    return;
  }

  if (typeof parsed.costUsd === 'number') {
    tail.costUsd = parsed.costUsd;
  }

  if (typeof parsed.result === 'string' && parsed.result) {
    tail.result = parsed.result;
    return;
  }

  const text = String(parsed.text || '').trim();

  if (!text) {
    return;
  }

  tail.text = text;

  if (parsed.message) {
    tail.message = text;
  }
}

function finalText(engine, outputPath, tail, record) {
  const fallback = tail.message || tail.text;

  return engine.usesOutputFile ? readWorkerOutput(outputPath, fallback, record) : (tail.result || fallback);
}

function timeoutMinutes() {
  const value = Number(store.config.taskTimeoutMin);
  return Number.isFinite(value) ? Math.max(1, value) : 45;
}

function loopCycles(value) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return defaultLoopCycles;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return defaultLoopCycles;
  }

  return Math.min(50, Math.max(1, Math.trunc(parsed)));
}

function loopRetries(value) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return defaultTaskRetries;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return defaultTaskRetries;
  }

  return Math.min(10, Math.max(1, Math.trunc(parsed)));
}

function cycleLogId(loopId, cycleNumber, role) {
  return `${loopId}-cycle-${cycleNumber}-${role}`;
}

function readRunningLoop(id) {
  try {
    const loop = store.readTask(id, 'running');
    return loop && loop.type === 'loop' ? loop : null;
  } catch {
    return null;
  }
}

function updateCycle(loop, cycleNumber, fields) {
  const cycles = Array.isArray(loop.cycles) ? loop.cycles : [];

  return {
    ...loop,
    cycles: cycles.map((cycle) => (
      cycle && cycle.n === cycleNumber ? { ...cycle, ...fields } : cycle
    )),
  };
}

function currentCycle(loop, cycleNumber) {
  const cycles = Array.isArray(loop.cycles) ? loop.cycles : [];
  return cycles.find((cycle) => cycle && cycle.n === cycleNumber) || null;
}

// The pass latch: a loop with blocked tasks is never "passed", whatever its cycles say.
function hasPassedCycle(loop) {
  if (Array.isArray(loop.blocked) && loop.blocked.length) {
    return false;
  }

  const cycles = Array.isArray(loop.cycles) ? loop.cycles : [];

  return cycles.some((cycle) => (
    cycle && (cycle.status === 'passed' || cycle.verdict === 'PASS')
  ));
}

function cyclePhase(cycle, phase) {
  return cycle && cycle.phase === 'polish' ? 'polish' : phase;
}

function incompletePolishSummary() {
  return 'The final polish cycle did not finish cleanly; the working tree may hold partial or unreviewed changes.';
}

function workerFailureReason(details, parsed) {
  if (details.timedOut) {
    return 'timed_out';
  }

  if (details.reason) {
    return details.reason;
  }

  if (details.forceFailed) {
    return 'worker_failed';
  }

  if (details.exitCode !== 0 || details.signal) {
    return 'worker_exited_nonzero';
  }

  if (!parsed) {
    return 'invalid_loop_result';
  }

  return parsed.status === 'failed' ? 'worker_reported_failure' : null;
}

function criticFailureReason(details, verdict) {
  if (details.timedOut) {
    return 'critic_timed_out';
  }

  if (details.reason) {
    return details.reason;
  }

  if (details.forceFailed) {
    return 'critic_failed';
  }

  if (details.exitCode !== 0 || details.signal) {
    return 'critic_exited_nonzero';
  }

  return verdict ? null : 'critic_invalid_verdict';
}

function fallbackSummary(text, status, timedOut) {
  if (timedOut) {
    return `Worker timed out after ${timeoutMinutes()} minutes.`;
  }

  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  const lastLine = lines[lines.length - 1];

  if (lastLine) {
    return lastLine.slice(0, 500);
  }

  return status === 'done' ? 'Worker completed.' : 'Worker failed.';
}

function completeTask(task, details) {
  const finishedAt = new Date().toISOString();
  const startedAt = taskTime(task, 'startedAt');
  const parsed = parseLoopResult(details.resultText);
  const cancelled = details.cancelled === true;
  const workerExitedNonzero = !cancelled && !details.forceFailed && !details.timedOut
    && (details.exitCode !== 0 || details.signal);
  const invalidLoopResult = !cancelled && !details.forceFailed && !details.timedOut
    && !workerExitedNonzero && !parsed;
  let reason = null;

  if (cancelled) {
    reason = 'cancelled';
  } else if (details.timedOut) {
    reason = 'timed_out';
  } else if (details.reason) {
    reason = details.reason;
  } else if (details.forceFailed) {
    reason = 'worker_failed';
  } else if (workerExitedNonzero) {
    reason = 'worker_exited_nonzero';
  } else if (invalidLoopResult) {
    reason = 'invalid_loop_result';
  } else if (parsed.status === 'failed') {
    reason = 'worker_reported_failure';
  }

  const status = cancelled ? 'cancelled' : reason ? 'failed' : parsed.status;
  const result = {
    id: task.id,
    status,
    summary: cancelled
      ? 'Cancelled.'
      : details.timedOut
      ? fallbackSummary(details.resultText, status, true)
      : invalidLoopResult
      ? 'worker exited without a valid LOOP_RESULT'
      : parsed && parsed.summary
        ? parsed.summary
        : fallbackSummary(details.resultText, status, details.timedOut),
    resultText: trimResult(details.resultText),
    exitCode: details.exitCode,
    ...(typeof details.costUsd === 'number' ? { costUsd: details.costUsd } : {}),
    ...(reason ? { reason } : {}),
    durationMs: startedAt ? Math.max(0, Date.now() - startedAt) : 0,
    finishedAt,
  };
  const completedTask = {
    ...task,
    status,
    finishedAt,
    ...(reason ? { reason } : {}),
  };

  try {
    store.writeResult(result);
    store.writeTask(completedTask, 'running');
    store.moveTask(task.id, 'running', 'done');
    if (status === 'cancelled') {
      recordEvent('cancel', { id: task.id, reason });
    } else if (status === 'failed') {
      recordEvent('fail', { id: task.id, reason, ...(workerExitedNonzero ? { code: details.exitCode } : {}) });
    } else {
      recordEvent('done', { id: task.id, status });
    }
  } catch (error) {
    console.error(`Failed to finish ${task.id}: ${error.message}`);
  } finally {
    runningActivity.delete(task.id);
  }
}

function completeLoop(loop, status, summary, reason) {
  const finishedAt = new Date().toISOString();
  const startedAt = taskTime(loop, 'startedAt');
  const completedLoop = {
    ...loop,
    status,
    summary,
    finishedAt,
    ...(reason ? { reason } : {}),
  };
  let completed = completedLoop;

  try {
    store.writeTask(completed, 'running');
    store.moveTask(loop.id, 'running', 'done');
  } catch (error) {
    console.error(`Failed to finish ${loop.id}: ${error.message}`);
    completed = {
      ...loop,
      status: 'failed',
      summary: 'Loop completion failed.',
      finishedAt,
      reason: 'loop_completion_failed',
    };

    try {
      store.writeTask(completed, 'running');
      store.moveTask(loop.id, 'running', 'done');
    } catch (fallbackError) {
      console.error(`Failed to mark ${loop.id} as failed: ${fallbackError.message}`);
    }
  }

  try {
    const costUsd = state.sumCycleCosts(completed.cycles);

    store.writeResult({
      id: loop.id,
      status: completed.status,
      summary: completed.summary,
      ...(costUsd !== null ? { costUsd } : {}),
      durationMs: startedAt ? Math.max(0, Date.now() - startedAt) : 0,
      finishedAt,
      ...(completed.reason ? { reason: completed.reason } : {}),
    });
  } catch (error) {
    console.error(`Failed to write result for ${loop.id}: ${error.message}`);
  }

  recordEvent('loop_ended', {
    id: loop.id,
    status: completed.status,
    ...(completed.reason ? { reason: completed.reason } : {}),
  });

  runningActivity.delete(loop.id);

  return completed;
}

function appendLoopLog(loop, line) {
  try {
    store.appendLogLine(loop.id, line);
  } catch (error) {
    console.error(`Failed to write loop log for ${loop.id}: ${error.message}`);
  }
}

function appendSessionLog(loop, cycle, role, line) {
  const logId = role === 'worker' ? cycle.workerLogId : cycle.criticLogId;

  if (logId) {
    try {
      store.appendLogLine(logId, line);
    } catch (error) {
      console.error(`Failed to write ${role} log for cycle ${cycle.n}: ${error.message}`);
    }
  }

  appendLoopLog(loop, line);
}

function appendSessionResult(loop, cycle, role, resultText) {
  const text = String(resultText || '');
  if (text) {
    const metadata = { childId: loop.id, parentId: loop.r1ParentJobId || loop.r1Child?.parentJobId, role, attempt: cycle.n };
    recorder(store, loop.id, metadata)('result', { text });
    if (metadata.parentId) recorder(store, metadata.parentId, metadata)('result', { text });
  }

  if (text) {
    appendSessionLog(loop, cycle, role, text);
  }
}

function failLoopTransition(loop, cycleNumber, error) {
  const details = { childId: loop.id, parentId: loop.r1Child?.parentJobId, cycle: cycleNumber, name: error.name, message: error.message, stack: error.stack, code: error.code };
  recorder(store, loop.id)('exception', details);
  if (details.parentId) recorder(store, details.parentId)('exception', details);
  const current = readRunningLoop(loop.id) || loop;
  const cycle = currentCycle(current, cycleNumber);
  const passed = hasPassedCycle(current);
  const finishedAt = new Date().toISOString();
  const startedAt = cycle ? taskTime(cycle, 'startedAt') : taskTime(current, 'startedAt');
  const failed = updateCycle(current, cycleNumber, {
    status: 'failed',
    summary: `Cycle ${cycleNumber} transition failed.`,
    finishedAt,
    durationMs: startedAt ? Math.max(0, Date.now() - startedAt) : 0,
    reason: 'cycle_transition_failed',
  });

  completeLoop(
    failed,
    passed ? 'passed' : 'failed',
    passed ? `Passed before polish cycle ${cycleNumber} could finish.` : `Cycle ${cycleNumber} transition failed.`,
    passed ? undefined : 'cycle_transition_failed',
  );
  console.error(`Failed to transition cycle ${cycleNumber} for ${loop.id}: ${error.message}`);
}

function finishLoopSession(loop, cycle, onFinish, details) {
  try {
    onFinish(details);
  } catch (error) {
    failLoopTransition(loop, cycle.n, error);
  }
}

// Persist explicit engine roles; pre-existing loops fall back to their original engine.
function loopEngines(input = {}) {
  input = input && typeof input === 'object' ? input : {};
  function selected(field, fallback) {
    const value = input[field] === undefined ? fallback : input[field];
    if (typeof value !== 'string' || !knownEngines.has(value.trim())) {
      throw new Error(`Unsupported ${field}: ${String(value)}.`);
    }
    return value.trim();
  }
  const engine = input.engine === undefined && input.workerEngine !== undefined && input.criticEngine !== undefined
    ? selected('workerEngine') : selected('engine', store.config.defaultEngine);
  return {
    engine,
    workerEngine: selected('workerEngine', engine),
    criticEngine: selected('criticEngine', engine),
  };
}

function sessionModel(loop, engine) {
  const mixed = (loop.workerEngine ?? loop.engine) !== (loop.criticEngine ?? loop.engine);
  return mixed ? engines.modelFor(engine, { models: store.config.models })
    : engines.modelFor(engine, store.config, loop.model);
}

function spawnLoopSession(loop, cycle, role, prompt, onFinish) {
  const id = loop[`${role}Engine`] ?? loop.engine ?? store.config.defaultEngine;
  const cwd = loop.projectPath;
  let child;
  let engine;
  let model;
  let outputPath;

  const record = (event, details) => {
    const metadata = { childId: loop.id, parentId: loop.r1ParentJobId || loop.r1Child?.parentJobId, role, attempt: loop.r1Child?.attempt || 1, cycle: cycle.n, stage: role };
    recorder(store, loop.id, metadata)(event, details);
    if (metadata.parentId) recorder(store, metadata.parentId, metadata)(event, details);
  };

  try {
    engine = engines.get(id);
    if (!engine) throw new Error(`Unsupported ${role} engine: ${id}.`);
    model = sessionModel(loop, engine);
    outputPath = engine.usesOutputFile
      ? path.join(store.paths.results, `.${loop.id}.cycle-${cycle.n}.${role}.${Date.now()}.last-message.tmp`)
      : null;
    appendLoopLog(loop, `=== cycle ${cycle.n} - ${role} (${engine.label}) ===`);
    const scope = resolveWorkerScope(store.config, cwd, store.paths.config);
    const args = engine.args({ model, outputPath, role, workspaceRoot: scope.isolatedWorktree ? scope.cwd : null });
    child = captureProcess((_file, argv, options) => spawnEngine(engine, argv, options), engines.binary(engine, store.config.enginePaths) || engine.command, args, {
      cwd: scope.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(loop.r1Child && process.platform !== 'win32' ? { detached: true } : {}),
    }, record);
  } catch (error) {
    record('exception', { name: error.name, message: error.message, stack: error.stack, code: error.code });
    finishLoopSession(loop, cycle, onFinish, {
      exitCode: null,
      forceFailed: true,
      reason: `${role}_start_failed`,
      resultText: `${role} failed to start: ${error.message}`,
      timedOut: false,
      cancelled: false,
    });
    return;
  }

  const tail = { text: '', message: '', result: '' };
  let inputFailed = false;
  let timedOut = false;
  let settled = false;
  let timeout;
  const worker = { child, timeout: null, cancelled: false, type: 'loop', role,
    detachedGroup: Boolean(loop.r1Child && process.platform !== 'win32') };
  activeWorkers.set(loop.id, worker);
  const captureLine = (line) => {
    appendSessionLog(loop, cycle, role, line);
    trackTail(tail, recordActivity(loop.id, engine, line));
  };
  const finish = (exitCode, signal, forceFailed = false, reason) => {
    if (settled || stopping) {
      return;
    }

    settled = true;
    clearTimeout(timeout);

    if (activeWorkers.get(loop.id) === worker) {
      activeWorkers.delete(loop.id);
    }

    finishLoopSession(loop, cycle, onFinish, {
      exitCode,
      signal,
      forceFailed,
      reason: timedOut ? `${role}_timed_out` : reason || (inputFailed ? `${role}_input_failed` : undefined),
      resultText: finalText(engine, outputPath, tail, record),
      timedOut,
      cancelled: worker.cancelled,
      ...(typeof tail.costUsd === 'number' ? { costUsd: tail.costUsd } : {}),
    });
  };

  streamLines(child.stdout, captureLine);
  streamLines(child.stderr, captureLine);
  child.once('error', (error) => {
    captureLine(`${role} error: ${error.message}`);
    finish(null, null, true, `${role}_error`);
  });
  child.once('close', (code, signal) => finish(code, signal));
  child.stdin.on('error', (error) => {
    inputFailed = true;
    captureLine(`${role} input error: ${error.message}`);
  });

  const timeoutMin = timeoutMinutes();
  timeout = setTimeout(() => {
    timedOut = true;
    captureLine(`${role} timed out after ${timeoutMin} minutes.`);
    terminateLoopWorker(worker);
  }, timeoutMin * 60 * 1000);
  worker.timeout = timeout;

  if (loop.r1Child) {
    // The CLI receives its prompt only AFTER we persist the identity of its
    // process group. If we die before the claim, it cannot act on the issue.
    try {
      if (process.platform !== 'linux') throw new Error('R1 detached child recovery currently requires Linux.');
      const identity = r1ProcessStartTime(child.pid);
      if (!identity) throw new Error('Unable to identify the R1 child process before prompt.');
      const current = readRunningLoop(loop.id);
      if (!current || current.r1Child?.parentJobId !== loop.r1Child.parentJobId) {
        throw new Error('R1 child no longer owns its running task record.');
      }
      store.writeTask({ ...current, workerPid: child.pid, workerStartTime: identity }, 'running');
    } catch (error) {
      inputFailed = true;
      captureLine(`R1 process identity checkpoint failed: ${error.message}`);
      terminateLoopWorker(worker);
      return;
    }
  }

  try {
    child.stdin.end(prompt);
  } catch (error) {
    captureLine(`${role} input error: ${error.message}`);
    finish(null, null, true, `${role}_input_failed`);
  }
}

function startNextLoopCycle(loop) {
  setImmediate(() => {
    const next = readRunningLoop(loop.id);

    if (!next) {
      return;
    }

    if (next.cancelRequested) {
      completeLoop(next, 'cancelled', 'Cancelled.', 'cancelled');
      return;
    }

    startLoopCycle(next);
  });
}

function budgetExhaustedEnd(loop) {
  const done = Array.isArray(loop.done) ? loop.done : [];

  if (!done.length) {
    return { status: 'maxed', summary: 'Reached the maximum cycle count without a passing verdict.' };
  }

  return {
    status: 'incomplete',
    summary: `Completed ${done.length} plan item${done.length === 1 ? '' : 's'} before the cycle budget ran out; work remains.`,
  };
}

function startLoopCycle(loop) {
  if (loop.cancelRequested) {
    completeLoop(loop, 'cancelled', 'Cancelled.', 'cancelled');
    return;
  }

  const cycles = Array.isArray(loop.cycles) ? loop.cycles : [];
  const cycleNumber = cycles.length + 1;
  const polishing = hasPassedCycle(loop);

  if (cycleNumber > loop.maxCycles) {
    const exhausted = budgetExhaustedEnd(loop);

    completeLoop(
      loop,
      polishing ? 'passed' : exhausted.status,
      polishing ? `Passed after ${loop.maxCycles} cycles.` : exhausted.summary,
    );
    return;
  }

  const previous = cycles[cycles.length - 1];
  const startedAt = new Date().toISOString();
  // Plan position at cycle start: completed and blocked items each advanced one slot.
  const taskNumber = (Array.isArray(loop.done) ? loop.done.length : 0)
    + (Array.isArray(loop.blocked) ? loop.blocked.length : 0) + 1;
  const gitAtStart = polishing || loop.noGit ? null : gitSnapshot(loop.projectPath);
  const cycle = {
    n: cycleNumber,
    ...(polishing ? {} : { task: taskNumber }),
    status: 'running',
    phase: polishing ? 'polish' : 'worker',
    startedAt,
    ...(gitAtStart ? { gitAtStart } : {}),
    workerLogId: cycleLogId(loop.id, cycleNumber, 'worker'),
    criticLogId: cycleLogId(loop.id, cycleNumber, 'critic'),
  };
  const runningLoop = {
    ...loop,
    status: 'running',
    cycle: cycleNumber,
    cycles: [...cycles, cycle],
    lastActivity: `Cycle ${cycleNumber} worker starting.`,
  };

  try {
    store.writeTask(runningLoop, 'running');
    recordEvent('cycle_started', { id: loop.id, cycle: cycleNumber });
    runningActivity.set(loop.id, { ts: startedAt, text: runningLoop.lastActivity, toolCalls: 0 });
    spawnLoopSession(
      runningLoop,
      cycle,
      'worker',
      polishing
        ? polishWorkerPrompt(runningLoop, previous && previous.fixes)
        : loopWorkerPrompt(runningLoop, previous && previous.status === 'failed' ? previous.fixes : undefined),
      (details) => finishLoopWorker(runningLoop, cycleNumber, details),
    );
  } catch (error) {
    completeLoop(
      runningLoop,
      polishing ? 'passed' : 'failed',
      polishing ? `Passed before polish cycle ${cycleNumber} could start.` : `Cycle ${cycleNumber} failed to start.`,
      polishing ? undefined : 'cycle_start_failed',
    );
    console.error(`Failed to start cycle ${cycleNumber} for ${loop.id}: ${error.message}`);
  }
}

function finishLoopWorker(loop, cycleNumber, details) {
  if (stopping) {
    return;
  }

  const current = readRunningLoop(loop.id);

  if (!current) {
    return;
  }

  try {
    const cycle = currentCycle(current, cycleNumber);

    if (!cycle) {
      if (hasPassedCycle(current)) {
        completeLoop(current, 'passed', `Passed before polish cycle ${cycleNumber} could finish.`);
        return;
      }

      completeLoop(current, 'failed', `Cycle ${cycleNumber} is missing.`, 'cycle_missing');
      return;
    }

    appendSessionResult(loop, cycle, 'worker', details.resultText);
    const finishedAt = new Date().toISOString();
    const durationMs = taskTime(cycle, 'startedAt') ? Math.max(0, Date.now() - taskTime(cycle, 'startedAt')) : 0;

    if (details.cancelled || current.cancelRequested) {
      const cancelled = updateCycle(current, cycleNumber, {
        status: 'cancelled',
        phase: cyclePhase(cycle, 'worker'),
        finishedAt,
        durationMs,
        ...(typeof details.costUsd === 'number' ? { costUsd: details.costUsd } : {}),
      });
      completeLoop(cancelled, 'cancelled', 'Cancelled.', 'cancelled');
      return;
    }

    const parsed = parseLoopResult(details.resultText);
    const reason = workerFailureReason(details, parsed);
    const incompletePolishWorker = cycle.phase === 'polish' && (
      reason === 'timed_out'
      || reason === 'worker_exited_nonzero'
      || reason === 'invalid_loop_result'
      || reason === 'worker_reported_failure'
    );
    const workerFields = {
      workerStatus: reason ? 'failed' : 'done',
      workerSummary: parsed && parsed.summary ? parsed.summary : fallbackSummary(details.resultText, 'failed', details.timedOut),
      workerFinishedAt: finishedAt,
      workerDurationMs: durationMs,
      workerExitCode: details.exitCode,
      ...(typeof details.costUsd === 'number' ? { workerCostUsd: details.costUsd } : {}),
    };

    if (reason) {
      const passed = hasPassedCycle(current);
      if (passed) {
        const failed = updateCycle(current, cycleNumber, {
          ...workerFields,
          status: 'failed',
          phase: cyclePhase(cycle, 'worker'),
          summary: workerFields.workerSummary,
          finishedAt,
          durationMs,
          reason,
        });
        store.writeTask(failed, 'running');
        recordEvent('worker_finished', { id: loop.id, cycle: cycleNumber, status: 'failed', reason });
        completeLoop(
          failed,
          'passed',
          incompletePolishWorker
            ? incompletePolishSummary()
            : `Passed before polish cycle ${cycleNumber} worker could finish.`,
        );
        return;
      }

      registerFailedCycle(current, cycleNumber, {
        ...workerFields,
        status: 'failed',
        phase: 'worker',
        verdict: 'FAIL',
        fixes: workerFields.workerSummary || `Worker failed (${reason}).`,
        summary: workerFields.workerSummary,
        finishedAt,
        durationMs,
        reason,
      }, {
        type: 'worker_finished',
        data: { id: loop.id, cycle: cycleNumber, status: 'failed', reason },
      });
      return;
    }

    const awaitingCritic = updateCycle(current, cycleNumber, {
      ...workerFields,
      status: 'running',
      phase: cyclePhase(cycle, 'critic'),
      summary: workerFields.workerSummary || 'Worker finished.',
    });

    try {
      store.writeTask(awaitingCritic, 'running');
      recordEvent('worker_finished', { id: loop.id, cycle: cycleNumber, status: 'done' });
      runningActivity.set(loop.id, {
        ts: finishedAt,
        text: `Cycle ${cycleNumber} critic starting.`,
        toolCalls: 0,
      });
      spawnLoopSession(
        awaitingCritic,
        currentCycle(awaitingCritic, cycleNumber),
        'critic',
        cycle.phase === 'polish'
          ? polishCriticPrompt(details.resultText)
          : criticPrompt(details.resultText, awaitingCritic.blocked),
        (criticDetails) => finishLoopCritic(awaitingCritic, cycleNumber, criticDetails),
      );
    } catch (error) {
      const passed = hasPassedCycle(awaitingCritic);
      if (passed) {
        const invalid = updateCycle(awaitingCritic, cycleNumber, {
          status: 'critic_invalid',
          phase: cyclePhase(cycle, 'critic'),
          summary: 'Critic failed to start.',
          finishedAt,
          durationMs,
          reason: 'critic_start_failed',
        });
        completeLoop(
          invalid,
          'passed',
          `Passed before polish cycle ${cycleNumber} critic could start.`,
        );
        return;
      }

      registerFailedCycle(awaitingCritic, cycleNumber, {
        status: 'critic_invalid',
        phase: 'critic',
        verdict: 'FAIL',
        fixes: 'Critic failed to start.',
        summary: 'Critic failed to start.',
        finishedAt,
        durationMs,
        reason: 'critic_start_failed',
      }, {
        type: 'critic_invalid',
        data: { id: loop.id, cycle: cycleNumber, reason: 'critic_start_failed' },
      });
      console.error(`Failed to start critic for ${loop.id}: ${error.message}`);
    }
  } catch (error) {
    failLoopTransition(current, cycleNumber, error);
  }
}

// Worker and critic run as separate engine sessions; the cycle's spend is their sum.
function cycleCostUsd(cycle, criticCost) {
  const worker = cycle && typeof cycle.workerCostUsd === 'number' ? cycle.workerCostUsd : null;
  const critic = typeof criticCost === 'number' ? criticCost : null;

  if (worker === null && critic === null) {
    return {};
  }

  return { costUsd: state.roundCost((worker || 0) + (critic || 0)) };
}

// done.length counts CONTINUE verdicts only, so it lags the plan once an item is blocked.
function cycleTaskNumber(cycle, fallback) {
  return cycle && Number.isInteger(cycle.task) ? cycle.task : fallback;
}

// The blocked entry names the plan position this cycle was working: done.length alone misses
// earlier blocks, and nextItem still names the item that came before them.
function blockedEntry(loop, cycle) {
  const done = Array.isArray(loop.done) ? loop.done.length : 0;
  const blocked = Array.isArray(loop.blocked) ? loop.blocked.length : 0;
  const task = cycleTaskNumber(cycle, done + blocked + 1);
  const title = (Array.isArray(loop.planTasks) ? loop.planTasks : [])[task - 1];

  return {
    task,
    item: title || (typeof loop.nextItem === 'string' && loop.nextItem ? loop.nextItem : 'first PLAN.md item'),
  };
}

// Shared by critic FAIL verdicts and no-progress cycles: counts the streak,
// blocks the current task at the retry budget, and picks the end state at the cycle cap.
function registerFailedCycle(current, cycleNumber, cycleFields, event) {
  const streak = Math.max(0, Number(current.failStreak) || 0) + 1;
  const blocking = streak >= loopRetries(current.taskRetries);
  const entry = blocking ? blockedEntry(current, currentCycle(current, cycleNumber)) : null;
  const loop = {
    ...current,
    failStreak: entry ? 0 : streak,
    // nextItem named the item worked before this block; a later block must not reuse it.
    ...(entry ? { blocked: [...(Array.isArray(current.blocked) ? current.blocked : []), entry], nextItem: '' } : {}),
  };
  let updated = updateCycle(loop, cycleNumber, entry
    ? { ...cycleFields, status: 'blocked', summary: `Blocked task ${entry.task}: ${entry.item}` }
    : cycleFields);

  if (entry) {
    try {
      updated = recordCheckpoint(updated, cycleNumber, `wip(loop): task ${entry.task} blocked - ${entry.item}`);
    } catch (error) {
      if (error instanceof GitCheckpointError) {
        updated = updateCycle(updated, cycleNumber, {
          checkpointError: error.stderr,
        });
        recordEvent('checkpoint_failed', { id: current.id, cycle: cycleNumber, task: entry.task, error: error.stderr });
      } else {
        throw error;
      }
    }
  }

  store.writeTask(updated, 'running');
  recordEvent(event.type, event.data);

  if (entry) {
    recordEvent('task_blocked', { id: current.id, cycle: cycleNumber, task: entry.task, item: entry.item });
  }

  if (cycleNumber >= updated.maxCycles) {
    const exhausted = budgetExhaustedEnd(updated);

    completeLoop(updated, exhausted.status, exhausted.summary);
    return;
  }

  startNextLoopCycle(updated);
}

function finishLoopCritic(loop, cycleNumber, details) {
  if (stopping) {
    return;
  }

  const current = readRunningLoop(loop.id);

  if (!current) {
    return;
  }

  try {
    const cycle = currentCycle(current, cycleNumber);

    if (!cycle) {
      if (hasPassedCycle(current)) {
        completeLoop(current, 'passed', `Passed before polish cycle ${cycleNumber} could finish.`);
        return;
      }

      completeLoop(current, 'failed', `Cycle ${cycleNumber} is missing.`, 'cycle_missing');
      return;
    }

    appendSessionResult(loop, cycle, 'critic', details.resultText);
    const finishedAt = new Date().toISOString();
    const durationMs = taskTime(cycle, 'startedAt') ? Math.max(0, Date.now() - taskTime(cycle, 'startedAt')) : 0;

    if (details.cancelled || current.cancelRequested) {
      const cancelled = updateCycle(current, cycleNumber, {
        status: 'cancelled',
        phase: cyclePhase(cycle, 'critic'),
        finishedAt,
        durationMs,
        ...cycleCostUsd(cycle, details.costUsd),
      });
      completeLoop(cancelled, 'cancelled', 'Cancelled.', 'cancelled');
      return;
    }

    const polishing = cycle.phase === 'polish';
    const verdict = polishing
      ? parsePolishVerdict(details.resultText)
      : parseCriticVerdict(details.resultText);
    const reason = criticFailureReason(details, verdict);
    const incompletePolishCritic = polishing && Boolean(reason);

    if (reason) {
      const passed = hasPassedCycle(current);
      if (passed) {
        const invalid = updateCycle(current, cycleNumber, {
          status: 'critic_invalid',
          phase: cyclePhase(cycle, 'critic'),
          summary: 'Critic did not produce a valid verdict.',
          finishedAt,
          durationMs,
          reason,
          ...cycleCostUsd(cycle, details.costUsd),
        });
        store.writeTask(invalid, 'running');
        recordEvent('critic_invalid', { id: loop.id, cycle: cycleNumber, reason });
        completeLoop(
          invalid,
          'passed',
          incompletePolishCritic
            ? incompletePolishSummary()
            : `Passed before polish cycle ${cycleNumber} received a valid verdict.`,
        );
        return;
      }

      registerFailedCycle(current, cycleNumber, {
        status: 'critic_invalid',
        phase: 'critic',
        verdict: 'FAIL',
        fixes: 'Critic did not produce a valid verdict. Re-check the current PLAN.md item.',
        summary: 'Critic did not produce a valid verdict.',
        finishedAt,
        durationMs,
        reason,
        ...cycleCostUsd(cycle, details.costUsd),
      }, {
        type: 'critic_invalid',
        data: { id: loop.id, cycle: cycleNumber, reason },
      });
      return;
    }

    if (polishing) {
      if (verdict.verdict === 'SHIP') {
        let shipped = updateCycle(current, cycleNumber, {
          status: 'passed',
          phase: 'polish',
          verdict: 'SHIP',
          summary: cycle.workerSummary || 'Critic shipped.',
          finishedAt,
          durationMs,
          ...cycleCostUsd(cycle, details.costUsd),
        });
        // Without this the shipped tree stays dirty and the next auto-checkpoint loop is refused.
        try {
          shipped = recordCheckpoint(shipped, null, 'wip(loop): polish shipped');
        } catch (error) {
          if (error instanceof GitCheckpointError) {
            registerFailedCycle(current, cycleNumber, {
              status: 'failed',
              phase: 'polish',
              verdict: 'FAIL',
              fixes: `Checkpoint failed: ${error.stderr}`,
              summary: `Checkpoint failed: ${error.stderr}`,
              finishedAt,
              durationMs,
              reason: error.stderr,
              ...cycleCostUsd(cycle, details.costUsd),
            }, {
              type: 'critic_verdict',
              data: { id: loop.id, cycle: cycleNumber, verdict: 'FAIL', fixes: `Checkpoint failed: ${error.stderr}`, reason: error.stderr },
            });
            return;
          }
          throw error;
        }
        store.writeTask(shipped, 'running');
        recordEvent('critic_verdict', { id: loop.id, cycle: cycleNumber, verdict: 'SHIP' });
        completeLoop(shipped, 'passed', `Shipped on cycle ${cycleNumber}.`);
        return;
      }

      let improved = updateCycle(current, cycleNumber, {
        status: 'improve',
        phase: 'polish',
        verdict: 'IMPROVE',
        fixes: verdict.improvement,
        summary: `Polish improvement: ${verdict.improvement}`,
        finishedAt,
        durationMs,
        ...cycleCostUsd(cycle, details.costUsd),
      });
      store.writeTask(improved, 'running');
      recordEvent('critic_verdict', {
        id: loop.id,
        cycle: cycleNumber,
        verdict: 'IMPROVE',
        fixes: verdict.improvement,
      });

      if (cycleNumber >= current.maxCycles) {
        // Without this the validated tree stays dirty and the next auto-checkpoint loop is refused.
        try {
          improved = recordCheckpoint(improved, null, 'wip(loop): polish improved');
        } catch (error) {
          if (error instanceof GitCheckpointError) {
            registerFailedCycle(current, cycleNumber, {
              status: 'failed',
              phase: 'polish',
              verdict: 'FAIL',
              fixes: `Checkpoint failed: ${error.stderr}`,
              summary: `Checkpoint failed: ${error.stderr}`,
              finishedAt,
              durationMs,
              reason: error.stderr,
              ...cycleCostUsd(cycle, details.costUsd),
            }, {
              type: 'critic_verdict',
              data: { id: loop.id, cycle: cycleNumber, verdict: 'FAIL', fixes: `Checkpoint failed: ${error.stderr}`, reason: error.stderr },
            });
            return;
          }
          throw error;
        }
        completeLoop(
          improved,
          'passed',
          'The final improvement was not applied; the working tree may not match the last validated state.',
        );
        return;
      }

      startNextLoopCycle(improved);
      return;
    }

    if (verdict.verdict === 'PASS') {
      const blockedCount = Array.isArray(current.blocked) ? current.blocked.length : 0;
      let passed = updateCycle(current, cycleNumber, {
        status: 'passed',
        phase: 'critic',
        verdict: 'PASS',
        summary: cycle.workerSummary || 'Critic passed.',
        finishedAt,
        durationMs,
        ...cycleCostUsd(cycle, details.costUsd),
      });

      try {
        passed = recordCheckpoint(passed, null, 'wip(loop): final pass');
      } catch (error) {
        if (error instanceof GitCheckpointError) {
          registerFailedCycle(current, cycleNumber, {
            status: 'failed',
            phase: 'critic',
            verdict: 'FAIL',
            fixes: `Checkpoint failed: ${error.stderr}`,
            summary: `Checkpoint failed: ${error.stderr}`,
            finishedAt,
            durationMs,
            reason: error.stderr,
            ...cycleCostUsd(cycle, details.costUsd),
          }, {
            type: 'critic_verdict',
            data: { id: loop.id, cycle: cycleNumber, verdict: 'FAIL', fixes: `Checkpoint failed: ${error.stderr}`, reason: error.stderr },
          });
          return;
        }
        throw error;
      }

      store.writeTask(passed, 'running');
      recordEvent('critic_verdict', { id: loop.id, cycle: cycleNumber, verdict: 'PASS' });

      if (blockedCount) {
        completeLoop(passed, 'partial', `Passed with ${blockedCount} blocked task${blockedCount === 1 ? '' : 's'}.`);
        return;
      }

      if (current.polish === true && cycleNumber < current.maxCycles) {
        startNextLoopCycle(passed);
        return;
      }

      completeLoop(passed, 'passed', `Passed on cycle ${cycleNumber}.`);
      return;
    }

    if (verdict.verdict === 'CONTINUE') {
      const done = [...(Array.isArray(current.done) ? current.done : []), verdict.done];
      const task = cycleTaskNumber(cycle, done.length);
      let continued = updateCycle(
        { ...current, done, nextItem: verdict.next, failStreak: 0 },
        cycleNumber,
        {
          status: 'continue',
          phase: 'critic',
          verdict: 'CONTINUE',
          done: verdict.done,
          next: verdict.next,
          summary: `Task ${task} done: ${verdict.done}`,
          finishedAt,
          durationMs,
          ...cycleCostUsd(cycle, details.costUsd),
        },
      );

      try {
        continued = recordCheckpoint(continued, cycleNumber, `wip(loop): task ${task} - ${verdict.done}`);
      } catch (error) {
        if (error instanceof GitCheckpointError) {
          registerFailedCycle(current, cycleNumber, {
            status: 'failed',
            phase: 'critic',
            verdict: 'FAIL',
            fixes: `Checkpoint failed: ${error.stderr}`,
            summary: `Checkpoint failed: ${error.stderr}`,
            finishedAt,
            durationMs,
            reason: error.stderr,
            ...cycleCostUsd(cycle, details.costUsd),
          }, {
            type: 'critic_verdict',
            data: { id: loop.id, cycle: cycleNumber, verdict: 'FAIL', fixes: `Checkpoint failed: ${error.stderr}`, reason: error.stderr },
          });
          return;
        }
        throw error;
      }

      store.writeTask(continued, 'running');
      recordEvent('critic_verdict', {
        id: loop.id,
        cycle: cycleNumber,
        verdict: 'CONTINUE',
        done: verdict.done,
        next: verdict.next,
      });

      if (cycleNumber >= current.maxCycles) {
        const exhausted = budgetExhaustedEnd(continued);

        completeLoop(continued, exhausted.status, exhausted.summary);
        return;
      }

      startNextLoopCycle(continued);
      return;
    }

    registerFailedCycle(current, cycleNumber, {
      status: 'failed',
      phase: 'critic',
      verdict: 'FAIL',
      fixes: verdict.fixes,
      summary: `Critic failed: ${verdict.fixes}`,
      finishedAt,
      durationMs,
      ...cycleCostUsd(cycle, details.costUsd),
    }, {
      type: 'critic_verdict',
      data: { id: loop.id, cycle: cycleNumber, verdict: 'FAIL', fixes: verdict.fixes },
    });
  } catch (error) {
    failLoopTransition(current, cycleNumber, error);
  }
}

function startLoop(loop) {
  const startedAt = new Date().toISOString();
  let planTasks = [];

  try {
    planTasks = parsePlanTasks(fs.readFileSync(path.join(loop.projectPath, 'PLAN.md'), 'utf8'));
  } catch {
  }

  const runningLoop = {
    ...loop,
    status: 'running',
    startedAt,
    cycle: 0,
    cycles: Array.isArray(loop.cycles) ? loop.cycles : [],
    ...(planTasks.length ? { planTasks } : {}),
  };

  try {
    store.moveTask(loop.id, 'pending', 'running');
  } catch (error) {
    console.error(`Failed to start ${loop.id}: ${error.message}`);
    return;
  }

  // The enqueue gate approved a tree that can drift while the loop waits for a slot.
  // A loop queued before the snapshot existed has no baseline to compare, so it is left alone.
  if (loop.gitAtQueue && !projectTreeUnchanged(loop.gitAtQueue, loop.projectPath)) {
    completeLoop(runningLoop, 'failed', dirtyTreeError, 'dirty_project_tree');
    return;
  }

  try {
    store.writeTask(runningLoop, 'running');
    recordEvent('loop_started', { id: loop.id });
    runningActivity.set(loop.id, { ts: startedAt, text: 'Loop starting.', toolCalls: 0 });
    startLoopCycle(runningLoop);
  } catch (error) {
    completeLoop(runningLoop, 'failed', 'Loop failed to start.', 'loop_start_failed');
    console.error(`Failed to start ${loop.id}: ${error.message}`);
  }
}

function spawnWorker(task) {
  const engine = engines.get(task.engine) || engines.get(store.config.defaultEngine);
  const model = engines.modelFor(engine, store.config, task.model);
  const cwd = task.cwd ? path.resolve(task.cwd) : path.join(store.paths.root, 'workspace');
  const outputPath = engine.usesOutputFile
    ? path.join(store.paths.results, `.${task.id}.${Date.now()}.last-message.tmp`)
    : null;
  let child;
  const record = recorder(store, task.id, { role: 'worker', stage: 'implementation', attempt: 1 });

  try {
    const scope = resolveWorkerScope(store.config, cwd, store.paths.config);
    const args = engine.args({ model, outputPath, workspaceRoot: scope.isolatedWorktree ? scope.cwd : null });
    child = captureProcess((_file, argv, options) => spawnEngine(engine, argv, options), engines.binary(engine, store.config.enginePaths) || engine.command, args, {
      cwd: scope.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }, record);
  } catch (error) {
    record('exception', { name: error.name, message: error.message, stack: error.stack, code: error.code });
    completeTask(task, {
      exitCode: null,
      forceFailed: true,
      reason: 'worker_start_failed',
      resultText: `Worker failed to start: ${error.message}`,
      timedOut: false,
    });
    return;
  }

  const tail = { text: '', message: '', result: '' };
  let inputFailed = false;
  let timedOut = false;
  let settled = false;
  let timeout;
  const worker = { child, timeout: null, cancelled: false };
  activeWorkers.set(task.id, worker);
  const captureLine = (line) => {
    try {
      store.appendLogLine(task.id, line);
    } catch (error) {
      console.error(`Failed to write log for ${task.id}: ${error.message}`);
    }

    trackTail(tail, recordActivity(task.id, engine, line));
  };
  const finish = (exitCode, signal, forceFailed = false, reason) => {
    if (settled || stopping) {
      return;
    }

    settled = true;
    clearTimeout(timeout);
    activeWorkers.delete(task.id);
    completeTask(task, {
      exitCode,
      signal,
      forceFailed,
      reason: timedOut ? 'timed_out' : reason || (inputFailed ? 'worker_input_failed' : undefined),
      resultText: finalText(engine, outputPath, tail, record),
      timedOut,
      cancelled: worker.cancelled,
      ...(typeof tail.costUsd === 'number' ? { costUsd: tail.costUsd } : {}),
    });
  };

  streamLines(child.stdout, captureLine);
  streamLines(child.stderr, captureLine);
  child.once('error', (error) => {
    captureLine(`Worker error: ${error.message}`);
    finish(null, null, true, 'worker_error');
  });
  child.once('close', (code, signal) => finish(code, signal));
  child.stdin.on('error', (error) => {
    inputFailed = true;
    captureLine(`Worker input error: ${error.message}`);
  });

  const timeoutMin = timeoutMinutes();
  timeout = setTimeout(() => {
    timedOut = true;
    captureLine(`Worker timed out after ${timeoutMin} minutes.`);
    terminateLoopWorker(worker);
  }, timeoutMin * 60 * 1000);
  worker.timeout = timeout;

  try {
    child.stdin.end(taskPrompt(task));
  } catch (error) {
    captureLine(`Worker input error: ${error.message}`);
    finish(null, null, true, 'worker_input_failed');
  }
}

function startTask(task) {
  const runningTask = {
    ...task,
    startedAt: new Date().toISOString(),
  };

  try {
    store.moveTask(task.id, 'pending', 'running');
  } catch (error) {
    console.error(`Failed to start ${task.id}: ${error.message}`);
    return;
  }

  try {
    store.writeTask(runningTask, 'running');
    recordEvent('start', { id: task.id });
    runningActivity.set(task.id, {
      ts: runningTask.startedAt,
      text: 'Worker starting.',
      toolCalls: 0,
    });
    spawnWorker(runningTask);
  } catch (error) {
    completeTask(runningTask, {
      exitCode: null,
      forceFailed: true,
      reason: 'worker_start_failed',
      resultText: `Worker failed to start: ${error.message}`,
      timedOut: false,
    });
  }
}

function failUnauthorizedR1Child(child, error) {
  const failed = {
    ...child, status: 'failed', finishedAt: new Date().toISOString(),
    reason: 'r1_child_unauthorized', summary: `R1 child admission refused: ${String(error.message).slice(0, 300)}`,
  };
  store.writeTask(failed, 'pending');
  store.moveTask(child.id, 'pending', 'done');
  store.writeResult({ id: child.id, status: 'failed', reason: failed.reason,
    finishedAt: failed.finishedAt, summary: failed.summary });
  recordEvent('loop_ended', { id: child.id, status: 'failed', reason: failed.reason });
}

function fillSlots() {
  const maxConcurrent = Math.max(1, Number(store.config.maxConcurrent) || 2);
  const running = store.listTasks('running');
  const r1 = running.find(task => task.workflow === 'r1');
  if (r1) {
    r1Jobs.advance(r1);
    // R1 owns the coordination slot. While its child is executing, no other
    // project can use a worker slot. This avoids maxConcurrent=1 deadlock.
    const childRunning = running.some(task => task.r1Child?.parentJobId === r1.id);
    if (childRunning) return;
    const pendingChildren = store.listTasks('pending').filter(task => task.r1Child?.parentJobId === r1.id);
    if (pendingChildren.length === 0) return;
    const candidate = sortPending(pendingChildren)[0];
    try {
      r1Jobs.authorizeChild(candidate);
      if (running.some(task => task.id !== r1.id)) return;
      startLoop(candidate);
    } catch (error) {
      failUnauthorizedR1Child(candidate, error);
    }
    return;
  }
  if (running.some(task => task.r1Child)) return;
  r1Jobs.admit();
  const runningCount = running.length;
  const slots = Math.max(0, maxConcurrent - runningCount);
  if (!slots) return;

  const pending = sortPending(store.listTasks('pending'));
  for (const task of pending.slice(0, slots)) {
    // An orphan child never becomes an ordinary unprivileged loop simply
    // because its parent moved to done/recovery before queue admission.
    if (task.r1Child) {
      failUnauthorizedR1Child(task, new Error('Parent R1 job is not executing.'));
      continue;
    }
    if (task.workflow === 'r1') {
      if (store.listTasks('running').length) return;
      store.moveTask(task.id, 'pending', 'running');
      r1Jobs.advance(task);
      return;
    }
    if (task.type === 'loop') startLoop(task);
    else startTask(task);
  }
}

function send(res, statusCode, body, contentType) {
  res.writeHead(statusCode, { 'content-type': contentType });
  res.end(body);
}

function sendJson(res, statusCode, value) {
  send(res, statusCode, JSON.stringify(value), 'application/json; charset=utf-8');
}

function resultForTask(task) {
  try {
    const resultPath = path.join(store.paths.results, `${task.id}.json`);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    return result && typeof result === 'object' ? result : null;
  } catch {
    return null;
  }
}

function dashboardEvent(event) {
  const id = typeof event.id === 'string' ? event.id : '';
  const task = id ? `task ${id}` : 'task';
  const loop = id ? `loop ${id}` : 'loop';
  const cycle = Number.isInteger(event.cycle) ? ` cycle ${event.cycle}` : '';
  const reason = typeof event.reason === 'string' ? `: ${event.reason}` : '';
  const value = {
    ts: typeof event.ts === 'string' ? event.ts : '',
    kind: 'info',
    text: 'activity',
    ...(id ? { taskId: id } : {}),
  };

  if (event.type === 'loop_started') {
    return { ...value, kind: 'spawn', text: `${loop} started` };
  }

  if (event.type === 'loop_queued') {
    return { ...value, kind: 'queue', text: `${loop} queued` };
  }

  if (event.type === 'cycle_started') {
    return { ...value, kind: 'spawn', text: `${loop}${cycle} started` };
  }

  if (event.type === 'worker_finished') {
    const status = event.status === 'done' ? 'finished' : 'failed';
    return { ...value, kind: event.status === 'done' ? 'result' : 'error', text: `${loop}${cycle} worker ${status}${reason}` };
  }

  if (event.type === 'critic_verdict') {
    const verdict = ['PASS', 'FAIL', 'IMPROVE', 'SHIP', 'CONTINUE'].includes(event.verdict) ? event.verdict : 'FAIL';
    const detail = ['FAIL', 'IMPROVE'].includes(verdict) && typeof event.fixes === 'string'
      ? `: ${event.fixes}`
      : verdict === 'CONTINUE' && typeof event.done === 'string' ? `: done: ${event.done}` : '';
    const kind = ['PASS', 'SHIP', 'CONTINUE'].includes(verdict) ? 'result' : verdict === 'IMPROVE' ? 'info' : 'error';
    return { ...value, kind, text: `${loop}${cycle} critic ${verdict}${detail}` };
  }

  if (event.type === 'task_blocked') {
    const item = typeof event.item === 'string' ? `: ${event.item}` : '';
    const taskNumber = Number.isInteger(event.task) ? ` task ${event.task}` : '';
    return { ...value, kind: 'error', text: `${loop}${taskNumber} blocked${item}` };
  }

  if (event.type === 'critic_invalid') {
    return { ...value, kind: 'error', text: `${loop}${cycle} critic invalid${reason}` };
  }

  if (event.type === 'loop_ended') {
    const status = typeof event.status === 'string' ? event.status : 'finished';
    const kind = status === 'passed' ? 'result' : status === 'failed' ? 'error' : 'info';
    return { ...value, kind, text: `${loop} ended: ${status}${reason}` };
  }

  if (event.type === 'queue') {
    return { ...value, kind: 'queue', text: `queued ${task}` };
  }

  if (event.type === 'start') {
    return { ...value, kind: 'spawn', text: `${task} started` };
  }

  if (event.type === 'done') {
    return { ...value, kind: 'result', text: `${task} done` };
  }

  if (event.type === 'fail') {
    return { ...value, kind: 'error', text: `${task} failed${reason}` };
  }

  if (event.type === 'cancel') {
    return { ...value, kind: 'info', text: `${task} cancelled${reason}` };
  }

  if (event.type === 'checkpoint_failed') {
    const errorMsg = typeof event.error === 'string' ? `: ${event.error}` : '';
    return { ...value, kind: 'error', text: `${loop}${cycle} checkpoint failed${errorMsg}` };
  }

  return { ...value, text: typeof event.type === 'string' ? event.type : value.text };
}

function recentEvents() {
  try {
    const size = fs.statSync(store.paths.events).size;

    if (!size) {
      return [];
    }

    const length = Math.min(size, maxEventBytes);
    const buffer = Buffer.alloc(length);
    const descriptor = fs.openSync(store.paths.events, 'r');
    let bytesRead;

    try {
      bytesRead = fs.readSync(descriptor, buffer, 0, length, size - length);
    } finally {
      fs.closeSync(descriptor);
    }

    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);

    if (size > length) {
      lines.shift();
    }

    if (lines[lines.length - 1] === '') {
      lines.pop();
    }

    const events = [];

    for (const line of lines.reverse()) {
      try {
        const event = JSON.parse(line);

        if (event && typeof event === 'object' && !Array.isArray(event)) {
          events.push(dashboardEvent(event));
          if (events.length === 30) {
            break;
          }
        }
      } catch {
      }
    }

    return events;
  } catch {
    return [];
  }
}

function daemonState() {
  const now = Date.now();
  const defaultEngine = store.config.defaultEngine;
  const pendingTasks = sortPending(store.listTasks('pending'));
  const runningTasks = store.listTasks('running');
  const completedTasks = store.listTasks('done');
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const done = completedTasks.filter((task) => (
    task.status === 'done' || (task.type === 'loop' && task.status === 'passed')
  )).length;
  const failed = completedTasks.filter((task) => (
    task.status === 'failed' || (task.type === 'loop' && task.status === 'maxed')
  )).length;
  const finishedToday = completedTasks.filter((task) => taskTime(task, 'finishedAt') >= todayMs).length;
  const results = new Map();
  const resultFor = (task) => {
    if (!results.has(task.id)) {
      results.set(task.id, resultForTask(task));
    }

    return results.get(task.id);
  };
  const taskCostToday = (task) => {
    if (task.type === 'loop') {
      return state.sumCycleCosts(task.cycles, todayMs);
    }

    if (taskTime(task, 'finishedAt') < todayMs) {
      return null;
    }

    const result = resultFor(task);

    return result && typeof result.costUsd === 'number' && Number.isFinite(result.costUsd)
      ? result.costUsd
      : null;
  };
  let todayCost = null;

  for (const task of [...runningTasks, ...completedTasks]) {
    const cost = taskCostToday(task);

    if (cost !== null) {
      todayCost = (todayCost || 0) + cost;
    }
  }

  return {
    daemon: {
      alive: true,
      pid: daemonInfo.pid,
      port: daemonInfo.port,
      startedAt: daemonInfo.startedAt,
      ts: new Date().toISOString(),
      engine: defaultEngine,
    },
    bridge: {
      running: bridgeRunning(),
    },
    engines: {
      selected: defaultEngine,
      available: engines.ids().map((id) => {
        const engine = engines.get(id);

        return {
          id,
          label: engine.label,
          installed: engines.available(engine, store.config.enginePaths),
        };
      }),
    },
    stats: {
      pending: pendingTasks.length,
      running: runningTasks.length,
      done,
      failed,
      today: {
        tasks: finishedToday,
        ...(todayCost !== null ? { costUsd: state.roundCost(todayCost) } : {}),
      },
      totalDone: done,
    },
    tasks: {
      pending: pendingTasks.map((task) => state.publicPending(task, defaultEngine)),
      running: runningTasks.map((task) => state.publicRunning(task, runningActivity.get(task.id), defaultEngine, now)),
      blocked: [],
      recent: completedTasks
        .sort((left, right) => taskTime(right, 'finishedAt') - taskTime(left, 'finishedAt'))
        .slice(0, 20)
        .map((task) => state.publicRecent(task, resultFor(task), defaultEngine)),
    },
    messages: store.readMessages(50),
    events: recentEvents(),
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);

      if (size > 1000000) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }

      body += chunk;
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function serveDashboard(res) {
  const dashboardPath = path.join(store.paths.root, 'public', 'index.html');

  try {
    send(res, 200, fs.readFileSync(dashboardPath), 'text/html; charset=utf-8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      send(res, 404, 'Not found.', 'text/plain; charset=utf-8');
      return;
    }

    throw error;
  }
}

function taskSource(body) {
  return body && body.source === 'mcp' ? 'mcp' : 'api';
}

// Project roots are an administrator-owned capability.  A request may name a
// configured project, but cannot choose a filesystem location or an operation
// for the daemon to perform there.
function authorizedProject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be an object.' };
  }

  if (Object.hasOwn(body, 'cwd') || Object.hasOwn(body, 'projectPath')) {
    return { error: 'cwd and projectPath are derived from the registered project.' };
  }

  if (Object.hasOwn(body, 'operation') || Object.hasOwn(body, 'type')) {
    return { error: 'Only standard task submission is supported.' };
  }

  const name = typeof body.project === 'string' ? body.project.trim() : '';

  if (!name || !Object.hasOwn(store.config.allowedProjects, name)) {
    return { error: 'Unknown project.' };
  }

  // The shared registry resolver also selects an optional owner-authorized
  // worktree and rechecks canonical paths before anything is queued.
  try {
    const scope = resolveProject(store.config, name, body.worktree, store.paths.config);
    return { name, projectPath: scope.cwd };
  } catch (error) {
    return { error: error.code === 'ENOENT' ? 'Registered project folder does not exist.' : error.message };
  }
}

async function dispatch(req, res) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    sendJson(res, 400, { error: 'prompt is required.' });
    return;
  }

  const project = authorizedProject(body);

  if (project.error) {
    sendJson(res, 400, { error: project.error });
    return;
  }

  const engine = body.engine || store.config.defaultEngine;

  if (!knownEngines.has(engine)) {
    sendJson(res, 400, { error: `Unsupported engine: ${engine}.` });
    return;
  }

  const task = store.enqueueTask({
    prompt: body.prompt,
    project: project.name,
    // Never accept a request path here: worker cwd comes only from the
    // canonical, realpath-resolved configured project root.
    cwd: project.projectPath,
    engine,
    model: body.model,
    title: body.title,
    priority: body.priority,
    source: taskSource(body),
  });
  recordEvent('queue', { id: task.id });

  sendJson(res, 201, { id: task.id });
}

async function createMessage(req, res) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const text = body && typeof body.text === 'string' ? body.text.trim() : '';

  if (!text) {
    sendJson(res, 400, { error: 'text is required.' });
    return;
  }

  if (Array.from(text).length > 2000) {
    sendJson(res, 400, { error: 'text must be 2000 characters or fewer.' });
    return;
  }

  const kind = body && typeof body === 'object' && body.kind !== undefined ? body.kind : 'info';

  if (!messageKinds.has(kind)) {
    sendJson(res, 400, { error: 'kind must be info, question, or results.' });
    return;
  }

  sendJson(res, 200, store.appendMessage({ kind, text }));
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function hasActiveLoop(projectPath) {
  for (const stage of ['pending', 'running']) {
    for (const task of store.listTasks(stage)) {
      if (task.type !== 'loop' || terminalTaskStatuses.has(task.status) || typeof task.projectPath !== 'string') {
        continue;
      }

      try {
        if (fs.realpathSync(task.projectPath) === projectPath) {
          return true;
        }
      } catch {
      }
    }
  }

  return false;
}

function runGit(projectPath, args) {
  try {
    const result = spawnSync('git', args, {
      cwd: projectPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });

    // Some constrained runtimes report EPERM on spawnSync even though the
    // child completed successfully and returned usable output.  Exit status
    // remains authoritative for a completed git command.
    if (result.status !== 0) {
      const output = String(result.stderr || result.stdout || (result.error && result.error.message) || '').trim();
      return { ok: false, output };
    }

    return { ok: true, output: String(result.stdout || '').trim() };
  } catch (error) {
    return { ok: false, output: error.message };
  }
}

// Porcelain records status codes and paths, never content: with autoCommit off a worker can rewrite
// the same already-dirty files every cycle and leave an identical status.
function dirtyDigest(projectPath) {
  const listed = runGit(projectPath, ['ls-files', '-m', '-o', '--exclude-standard', '-z', '--', '.']);

  if (!listed.ok) {
    return null;
  }

  const digest = crypto.createHash('sha1');

  for (const file of listed.output.split('\0').filter(Boolean).sort()) {
    const filePath = path.join(projectPath, file);
    digest.update(file);

    try {
      const stats = fs.statSync(filePath);

      digest.update(stats.size > maxDigestBytes ? `${stats.size}:${stats.mtimeMs}` : fs.readFileSync(filePath));
    } catch {
      digest.update('\0gone');
    }
  }

  return digest.digest('hex');
}

// A project can be a subdirectory: a sibling project's commit moves repository HEAD without
// touching these files, so the revision here is the last commit that did.
function projectHead(projectPath) {
  const head = runGit(projectPath, ['rev-list', '-1', 'HEAD', '--', '.']);
  return head.ok ? head.output : '';
}

// A checkpoint commit and a worker's own commit both move the project revision, so progress is the
// triple (revision, tree, content) changing - not the tree simply being dirty.
function gitSnapshot(projectPath) {
  const tree = runGit(projectPath, ['status', '--porcelain', '--', '.']);
  const dirty = tree.ok ? dirtyDigest(projectPath) : null;

  if (!tree.ok || dirty === null) {
    return null;
  }

  return { head: projectHead(projectPath), tree: tree.output, dirty };
}

// Cleanliness asks only whether the project's own files drifted, never where the revision sits.
function sameProjectTree(before, after) {
  return Boolean(before) && Boolean(after) && before.tree === after.tree && before.dirty === after.dirty;
}

// A transient git failure (lock contention, a spawn hiccup) yields no snapshot, which would read as
// drift. A few short retries separate that from a tree that really changed, which stays changed.
function projectTreeUnchanged(before, projectPath, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (sameProjectTree(before, gitSnapshot(projectPath))) {
      return true;
    }

    if (attempt < attempts) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }

  return false;
}

function madeNoChanges(before, after) {
  return sameProjectTree(before, after) && before.head === after.head;
}

function insideGitWorkTree(projectPath) {
  const result = runGit(projectPath, ['rev-parse', '--is-inside-work-tree']);
  return result.ok && result.output === 'true';
}

// A worker that committed its own work leaves nothing to commit, so its sha is this cycle's
// checkpoint. HEAD advancing over a clean tree is what separates that from a real git failure.
function workerCommitSha(headAtStart, head, tree) {
  return headAtStart && head && head !== headAtStart && tree === '' ? head : null;
}

// Checkpoint messages are daemon-authored from verdict text alone; agents never run git.
function checkpointCommit(loop, message, headAtStart) {
  if (loop.autoCommit !== true) {
    return null;
  }

  const value = String(message).replace(/\s+/g, ' ').trim().slice(0, 72);
  const add = runGit(loop.projectPath, ['add', '-A', '.']);
  const commit = add.ok ? runGit(loop.projectPath, ['commit', '-m', value, '--', '.']) : add;

  if (!commit.ok) {
    const tree = runGit(loop.projectPath, ['status', '--porcelain', '--', '.']);
    const adopted = tree.ok ? workerCommitSha(headAtStart, projectHead(loop.projectPath), tree.output) : null;

    if (!adopted) {
      const err = commit.output || 'git error';
      appendLoopLog(loop, `checkpoint failed: ${err}`);
      throw new GitCheckpointError(`checkpoint failed: ${err}`, err);
    }

    return adopted;
  }

  const head = runGit(loop.projectPath, ['rev-parse', 'HEAD']);

  if (!head.ok || !head.output) {
    const err = head.output || 'git rev-parse HEAD error';
    appendLoopLog(loop, `checkpoint failed: ${err}`);
    throw new GitCheckpointError(`checkpoint failed: ${err}`, err);
  }

  return head.output;
}

// cycleNumber ties the sha to that cycle's plan position; null marks the final-pass checkpoint.
function recordCheckpoint(loop, cycleNumber, message) {
  const cycle = cycleNumber === null ? null : currentCycle(loop, cycleNumber);
  const sha = checkpointCommit(loop, message, cycle && cycle.gitAtStart ? cycle.gitAtStart.head : '');

  if (!sha) {
    return loop;
  }

  const task = cycleTaskNumber(cycle, null);

  return {
    ...loop,
    checkpointShas: [
      ...(Array.isArray(loop.checkpointShas) ? loop.checkpointShas : []),
      { ...(task === null ? {} : { task }), sha },
    ],
  };
}

function seedLoopFiles(projectPath) {
  const defaults = [
    [
      path.join(projectPath, 'STATE.md'),
      '# State\n\n## Completed\n\n- Nothing yet.\n\n## Next\n\n- Start with the first incomplete plan item.\n\n## Notes\n\n- None.\n',
    ],
    [
      path.join(projectPath, 'GUIDELINES.md'),
      '# Quality Guidelines\n\n- Meet every requirement in PLAN.md.\n- Keep changes scoped to this project.\n- Validate inputs and relevant edge cases.\n- Add concise usage guidance for runnable work.\n- Run an appropriate check before finishing.\n',
    ],
  ];

  for (const [filePath, content] of defaults) {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf8');
    }
  }
}

async function createLoop(req, res) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const authorized = authorizedProject(body);

  if (authorized.error) {
    sendJson(res, 400, { error: authorized.error });
    return;
  }

  const project = authorized.name;
  const projectPath = authorized.projectPath;

  try {
    resolveWorkerScope(store.config, projectPath, store.paths.config);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  if (!isFile(path.join(projectPath, 'PLAN.md'))) {
    sendJson(res, 400, { error: 'Project folder must contain PLAN.md.' });
    return;
  }

  if (hasActiveLoop(projectPath)) {
    sendJson(res, 400, { error: 'A loop is already running for this project.' });
    return;
  }

  let selectedEngines;
  try { selectedEngines = loopEngines(body); }
  catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }
  const polish = body && body.polish === true;

  const gitPresent = insideGitWorkTree(projectPath);
  const autoCommit = !(body && body.autoCommit === false) && gitPresent;

  // Must run before seedLoopFiles: seeded STATE.md and GUIDELINES.md would trip it.
  if (autoCommit) {
    const status = runGit(projectPath, ['status', '--porcelain', '--', '.']);

    if (!status.ok || status.output) {
      sendJson(res, 400, { error: dirtyTreeError });
      return;
    }
  }

  try {
    seedLoopFiles(projectPath);
  } catch (error) {
    sendJson(res, 500, { error: `Could not seed loop files: ${error.message}` });
    return;
  }

  // The tree this gate approved, seeded files included: a queued loop revalidates against it.
  const gitAtQueue = autoCommit ? gitSnapshot(projectPath) : null;
  const loop = store.enqueueLoop({
    project,
    projectPath,
    maxCycles: loopCycles(body && body.maxCycles),
    taskRetries: loopRetries(body && body.taskRetries),
    autoCommit,
    ...(gitAtQueue ? { gitAtQueue } : {}),
    ...(gitPresent ? {} : { noGit: true }),
    ...(polish ? { polish: true } : {}),
    ...selectedEngines,
    title: `loop: ${project}`,
    source: taskSource(body),
  });
  recordEvent('loop_queued', { id: loop.id });
  sendJson(res, 201, { id: loop.id });
}

function logLineCount(value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return 200;
  }

  return Math.min(maxLogLines, parsed);
}

function logTaskId(requestPath) {
  try {
    const decoded = decodeURIComponent(requestPath);
    const cycle = /^\/api\/log\/([A-Za-z0-9_-]+)\/cycle\/([1-9][0-9]*)\/(worker|critic)$/.exec(decoded);

    if (cycle) {
      return cycleLogId(cycle[1], Number(cycle[2]), cycle[3]);
    }

    return decoded.slice('/api/log/'.length);
  } catch {
    return '';
  }
}

function serveLog(res, requestPath, requestUrl) {
  const id = logTaskId(requestPath);

  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    sendJson(res, 200, { lines: [] });
    return;
  }

  if (requestUrl.searchParams.has('download')) {
    const file = store.executionPath(id, requestUrl.searchParams.has('legacy'));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('No captured execution record'); return; }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="${id}.execution.ndjson"`, 'X-Content-Type-Options': 'nosniff' });
    const stream = fs.createReadStream(file);
    stream.on('error', error => res.destroy(error));
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return;
  }
  if (requestUrl.searchParams.has('raw')) {
    sendJson(res, 200, store.readExecutionBytes(id, Number(requestUrl.searchParams.get('offset') || 0), Number(requestUrl.searchParams.get('bytes') || 65536), requestUrl.searchParams.has('legacy')));
    return;
  }
  sendJson(res, 200, { lines: store.readLogLines(id, logLineCount(requestUrl.searchParams.get('lines'))) });
}

function readJob(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return null;
  }

  for (const stage of ['pending', 'running', 'done']) {
    try {
      const task = store.readTask(id, stage);
      const result = resultForTask(task);
      return {
        id: task.id,
        status: task.status || stage,
        ...(typeof task.project === 'string' ? { project: task.project } : {}),
        ...(result ? { result } : {}),
      };
    } catch {
      // A task may move stages between the lookup and read; continue searching.
    }
  }

  return null;
}

function cancelOwnedR1Child(id) {
  for (const stage of ['pending', 'running']) {
    let child;
    try { child = store.readTask(id, stage); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!child.r1Child || child.type !== 'loop') throw new Error('Cannot cancel a non-R1 implementation child.');
    if (stage === 'running') return cancelRunningLoop(id);
    const stopped = { ...child, status: 'cancelled', reason: 'parent_implementation_aborted', finishedAt: new Date().toISOString() };
    store.writeTask(stopped, 'pending');
    store.moveTask(id, 'pending', 'done');
    store.writeResult({ id, status: stopped.status, reason: stopped.reason, finishedAt: stopped.finishedAt });
    return { status: 200, ok: true };
  }
  try { const done = store.readTask(id, 'done'); if (done.r1Child) return { status: 200, ok: true }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { status: 404, error: 'R1 implementation child not found.' };
}

function cancelRunningLoop(id) {
  const worker = activeWorkers.get(id);
  const loop = readRunningLoop(id);
  if (!worker && !loop) return { status: 404, error: 'Task is not running.' };
  if (worker?.cancelled) return { status: 200, ok: true };
  if (worker?.type === 'loop' && loop) {
    store.writeTask({ ...loop, cancelRequested: true, lastActivity: 'Cancellation requested.' }, 'running');
  }
  if (worker) {
    worker.cancelled = true;
    clearTimeout(worker.timeout);
    worker.timeout = null;
    // The worker's existing `close` handler is the ONLY owner of the terminal
    // state: it runs after stdio closes, not when a kill signal is requested.
    // R1 child agents own a POSIX process group so grandchildren die too.
    terminateLoopWorker(worker);
    return { status: 200, ok: true };
  }
  // On restart a retained R1 loop can have no in-memory worker handle even
  // while its old detached agent is alive. Never clear it without proving
  // the previous process group has stopped. Repeated cancel is a safe escape.
  if (loop.r1Child && !terminatePriorR1Worker(loop)) {
    return { status: 503, error: 'Previous R1 agent process has not been confirmed stopped; workspace retained.' };
  }
  const cycle = currentCycle(loop, loop.cycle);
  const cancelled = cycle && cycle.status === 'running'
    ? updateCycle(loop, loop.cycle, { status: 'cancelled', finishedAt: new Date().toISOString() }) : loop;
  completeLoop(cancelled, 'cancelled', 'Cancelled.', 'cancelled');
  return { status: 200, ok: true };
}

async function cancelTask(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (error) { sendJson(res, 400, { error: error.message }); return; }
  const id = body && typeof body.id === 'string' ? body.id : '';
  if (!id) { sendJson(res, 400, { error: 'id is required.' }); return; }

  // A waiting R1 parent has no engine process itself. Propagate cancellation
  // to its one owned child before it can be scheduled or before further edits.
  let parent = null;
  try {
    const task = store.readTask(id, 'running');
    if (task.workflow === 'r1') parent = task;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (parent) {
    const attached = store.listR1ChildLoops(id);
    if (!attached.length) {
      sendJson(res, 404, { error: 'R1 parent has no attached loop to cancel.' });
      return;
    }
    // Cancellation retries complete any work left by a partial first request.
    if (!parent.cancelRequested) {
      store.writeTask({ ...parent, cancelRequested: true, lastActivity: 'Cancellation requested.' }, 'running');
    }
    for (const child of attached) {
      if (child.stage === 'running') {
        const stopped = cancelRunningLoop(child.id);
        if (stopped.status !== 200) { sendJson(res, stopped.status, { error: stopped.error }); return; }
      }
      else if (child.stage === 'pending') {
        const cancelled = { ...child.task, status: 'cancelled', reason: 'parent_cancelled', finishedAt: new Date().toISOString() };
        store.writeTask(cancelled, 'pending');
        store.moveTask(child.id, 'pending', 'done');
        store.writeResult({ id: child.id, status: 'cancelled', reason: 'parent_cancelled', finishedAt: cancelled.finishedAt });
      }
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  const outcome = cancelRunningLoop(id);
  sendJson(res, outcome.status, outcome.status === 200 ? { ok: true } : { error: outcome.error });
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const requestPath = requestUrl.pathname;

  if (req.method === 'GET' && (requestPath === '/' || requestPath === '/index.html')) {
    serveDashboard(res);
    return;
  }

  if (req.method === 'GET' && requestPath === '/api/state') {
    sendJson(res, 200, state.sanitizeState(daemonState()));
    return;
  }

  // Project paths are intentionally not part of the dashboard contract.  The
  // browser can select only administrator-configured project names.
  if (req.method === 'GET' && requestPath === '/api/projects') {
    sendJson(res, 200, { projects: Object.keys(store.config.allowedProjects || {}).sort() });
    return;
  }

  if (req.method === 'GET' && requestPath === '/api/bridge') {
    sendJson(res, 200, await bridgeDetails());
    return;
  }

  if (req.method === 'GET' && requestPath.startsWith('/api/log/')) {
    serveLog(res, requestPath, requestUrl);
    return;
  }

  // R1 issue workflows keep their own namespace so the generic job contract
  // above stays unchanged for existing clients.
  if (req.method === 'GET' && requestPath.startsWith('/api/r1/jobs/')) {
    const job = r1Jobs.read(requestPath.slice('/api/r1/jobs/'.length));
    sendJson(res, job ? 200 : 404, job || { error: 'Job not found.' });
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/r1/jobs') {
    try {
      const body = await readJsonBody(req);
      const job = r1Jobs.submit(body);
      sendJson(res, 201, { id: job.id });
    } catch (error) { sendJson(res, 400, { error: error.message }); }
    return;
  }

  if (req.method === 'GET' && requestPath.startsWith('/api/jobs/')) {
    let id = '';
    try {
      id = decodeURIComponent(requestPath.slice('/api/jobs/'.length));
    } catch {
    }
    const job = readJob(id);
    sendJson(res, job ? 200 : 404, job || { error: 'Job not found.' });
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/jobs') {
    await dispatch(req, res);
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/dispatch') {
    await dispatch(req, res);
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/loop') {
    await createLoop(req, res);
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/bridge/start') {
    sendJson(res, 200, { running: startBridge() || bridgeRunning() });
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/bridge/stop') {
    stopBridge();
    sendJson(res, 200, { running: bridgeRunning() });
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/cancel') {
    await cancelTask(req, res);
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/message') {
    await createMessage(req, res);
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/answer') {
    sendJson(res, 400, { error: 'not enabled' });
    return;
  }

  sendJson(res, 404, { error: 'Not found.' });
}

function tick() {
  try {
    store.writeHeartbeat(daemonInfo);
    fillSlots();
  } catch (error) {
    console.error(`Daemon tick failed: ${error.message}`);
  }
}

function recoverRunningTasks() {
  for (const task of store.listTasks('running')) {
    if (task.workflow === 'r1') { r1Jobs.recover(task); continue; }
    if (terminalTaskStatuses.has(task.status)) {
      try {
        store.moveTask(task.id, 'running', 'done');
      } catch (error) {
        console.error(`Failed to recover ${task.id}: ${error.message}`);
      }
      continue;
    }

    if (task.r1Child && !terminatePriorR1Worker(task)) {
      const note = 'R1 child process termination unconfirmed; worktree retained. Retry cancel after verifying the old process group has ended.';
      console.error(`R1 child ${task.id}: ${note}`);
      store.writeTask({ ...task, recoveryBlocked: true, lastActivity: note }, 'running');
      store.appendLogLine(task.id, note);
      recordEvent('r1_child_recovery_blocked', { id: task.id, reason: 'process_unconfirmed' });
      continue;
    }
    const finishedAt = new Date().toISOString();
    const isLoop = task.type === 'loop';
    const passed = isLoop && hasPassedCycle(task);
    const interruptedPolishCycle = isLoop && (Array.isArray(task.cycles) ? task.cycles : []).some((cycle) => (
      cycle && cycle.status === 'running' && cycle.phase === 'polish'
    ));
    const cycles = (Array.isArray(task.cycles) ? task.cycles : []).map((cycle) => (
      cycle && cycle.status === 'running'
        ? {
          ...cycle,
          status: 'failed',
          summary: 'Daemon restarted before the cycle finished.',
          finishedAt,
          reason: 'daemon_restarted',
        }
        : cycle
    ));
    const summary = passed
      ? interruptedPolishCycle
        ? incompletePolishSummary()
        : 'Passed before the daemon restarted.'
      : isLoop
        ? 'Daemon restarted before the loop finished.'
        : 'Daemon restarted before the task finished.';
    const recovered = {
      ...task,
      ...(isLoop ? { cycles } : {}),
      status: passed ? 'passed' : 'failed',
      summary,
      finishedAt,
      ...(passed ? {} : { reason: 'daemon_restarted' }),
    };
    const result = {
      id: task.id,
      status: passed ? 'passed' : 'failed',
      summary,
      ...(passed ? {} : { reason: 'daemon_restarted' }),
      durationMs: taskTime(task, 'startedAt') ? Math.max(0, Date.now() - taskTime(task, 'startedAt')) : 0,
      finishedAt,
    };

    try {
      store.writeResult(result);
      store.writeTask(recovered, 'running');
      store.moveTask(task.id, 'running', 'done');
      recordEvent(isLoop ? 'loop_ended' : 'fail', {
        id: task.id,
        ...(isLoop ? { status: passed ? 'passed' : 'failed' } : {}),
        ...(passed ? {} : { reason: 'daemon_restarted' }),
      });
    } catch (error) {
      console.error(`Failed to recover ${task.id}: ${error.message}`);
    }
  }
  // A child queued just before a crash must not remain pending after its
  // parent was moved back to the recovery queue. Otherwise attempt N+1
  // cannot proceed, and an old attempt might later execute unexpectedly.
  for (const child of store.listTasks('pending')) {
    if (!child.r1Child) continue;
    let activeParent = false;
    try {
      const parent = store.readTask(child.r1Child.parentJobId, 'running');
      activeParent = parent.workflow === 'r1' && parent.status === 'running'
        && parent.r1?.runs === child.r1Child.attempt && !parent.cancelRequested;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!activeParent) failUnauthorizedR1Child(child, new Error('Pending R1 child orphaned by daemon restart.'));
  }
}

// On Windows, a scripted SIGTERM (TerminateProcess) kills immediately and never reaches this handler.
async function stop(exitFn = process.exit) {
  if (stopping) {
    return;
  }
  stopping = true;

  let exited = false;
  const invokeExit = (code) => {
    if (exited) {
      return;
    }
    exited = true;
    if (typeof exitFn === 'function') {
      exitFn(code);
    }
  };

  const deadlineTimer = setTimeout(() => {
    invokeExit(1);
  }, shutdownGracePeriodMs + shutdownDeadlineMarginMs);
  if (deadlineTimer.unref) {
    deadlineTimer.unref();
  }

  clearInterval(ticker);
  stopBridge();
  const r1Stopped = r1Jobs.stop(terminateWorker);

  if (server) {
    try {
      server.close();
    } catch {
    }
  }

  let runningTasks = [];
  try {
    runningTasks = store.listTasks('running');
  } catch (error) {
    console.error(`Failed to list running tasks on shutdown: ${error.message}`);
  }

  for (const task of runningTasks) {
    if (task.workflow === 'r1') continue;
    if (task.r1Child && activeWorkers.has(task.id)) continue;
    if (terminalTaskStatuses.has(task.status)) {
      try {
        store.moveTask(task.id, 'running', 'done');
      } catch (error) {
        console.error(`Failed to move terminal task ${task.id}: ${error.message}`);
      }
      continue;
    }

    if (task.type === 'loop') {
      const finishedAt = new Date().toISOString();
      const passed = hasPassedCycle(task);
      const cycles = (Array.isArray(task.cycles) ? task.cycles : []).map((cycle) => (
        cycle && cycle.status === 'running'
          ? {
            ...cycle,
            status: 'failed',
            summary: 'Daemon shut down before the cycle finished.',
            finishedAt,
            reason: 'daemon_shutdown',
          }
          : cycle
      ));

      let dirtyOutput = '';
      if (task.projectPath) {
        const statusResult = runGit(task.projectPath, ['status', '--porcelain', '--', '.']);
        if (statusResult.ok && statusResult.output) {
          dirtyOutput = statusResult.output;
        }
      }

      if (dirtyOutput) {
        appendLoopLog(task, `unclean working tree on shutdown:\n${dirtyOutput}`);
      }

      const dirtyFiles = dirtyOutput ? dirtyOutput.split(/\r?\n/).filter(Boolean) : [];
      const summary = passed
        ? 'Passed before daemon shutdown.'
        : dirtyFiles.length
          ? `Daemon shut down before the loop finished. Working tree has uncommitted changes: ${dirtyFiles.join(', ')}`
          : 'Daemon shut down before the loop finished.';

      const loopToFinalize = {
        ...task,
        cycles,
        ...(dirtyFiles.length ? { dirtyFiles } : {}),
      };

      try {
        completeLoop(loopToFinalize, passed ? 'passed' : 'failed', summary, passed ? undefined : 'daemon_shutdown');
      } catch (error) {
        console.error(`Failed to finalize loop ${task.id} on shutdown: ${error.message}`);
      }
    } else {
      try {
        completeTask(task, {
          exitCode: null,
          forceFailed: true,
          reason: 'daemon_shutdown',
          resultText: 'Daemon shut down before the task finished.',
        });
      } catch (error) {
        console.error(`Failed to finalize task ${task.id} on shutdown: ${error.message}`);
      }
    }
  }

  const workers = [...activeWorkers.values()];

  for (const worker of workers) {
    if (worker.timeout) {
      clearTimeout(worker.timeout);
    }
  }

  if (workers.length > 0) {
    for (const worker of workers) {
      if (worker.child && worker.child.pid) {
        try {
          if (worker.detachedGroup && process.platform !== 'win32') process.kill(-worker.child.pid, 'SIGTERM');
          else worker.child.kill('SIGTERM');
        } catch {
        }
      }
    }

    const workerExits = workers.map((worker) => new Promise((resolve) => {
      if (!worker.child || worker.child.exitCode !== null || worker.child.killed) {
        resolve();
        return;
      }
      worker.child.once('exit', resolve);
      worker.child.once('close', resolve);
      worker.child.once('error', resolve);
    }));

    let graceTimer;
    const gracePromise = new Promise((resolve) => {
      graceTimer = setTimeout(resolve, shutdownGracePeriodMs);
      if (graceTimer.unref) {
        graceTimer.unref();
      }
    });

    try {
      await Promise.race([
        Promise.all(workerExits),
        gracePromise,
      ]);
    } finally {
      clearTimeout(graceTimer);
    }

    for (const worker of workers) {
      if (worker.child && worker.child.exitCode === null) {
        terminateWorker(worker.child);
      }
    }
  }

  let r1Grace;
  await Promise.race([r1Stopped, new Promise(resolve => { r1Grace = setTimeout(resolve, shutdownGracePeriodMs); })]);
  clearTimeout(r1Grace);
  activeWorkers.clear();

  try {
    fs.unlinkSync(store.paths.daemon);
  } catch {
  }

  clearTimeout(deadlineTimer);
  invokeExit(0);
}

function start(options = {}) {
  r1Jobs = createR1Jobs(store, { ...options.r1, cancelChild: cancelOwnedR1Child });
  store.ensureDirs();

  daemonInfo = {
    pid: process.pid,
    port: store.config.dashboardPort,
    startedAt: new Date().toISOString(),
  };

  if (!store.acquireHeartbeat(daemonInfo)) {
    console.error(`AgentLoop daemon is already running (state ${store.paths.state}).`);
    return;
  }

  recoverBridgeHeartbeat();
  recoverRunningTasks();

  server = createHttpServer();
  server.on('error', (error) => {
    console.error(`HTTP server failed: ${error.message}`);
    process.exitCode = 1;
    stop().catch((stopError) => {
      console.error(`Failed to stop daemon: ${stopError.message}`);
    });
  });
  server.listen(daemonInfo.port, '127.0.0.1', () => {
    if (stopping) {
      return;
    }

    daemonInfo.port = server.address().port;
    console.log(`Dashboard: http://127.0.0.1:${daemonInfo.port}`);
    ticker = setInterval(tick, pollMs);
    tick();
  });

  // Route shutdown signals to stop(); guard against double-entry inside stop().
  // On Windows, scripted SIGTERM bypasses handlers, but console SIGINT and POSIX signals reach here.
  process.once('SIGINT', () => {
    stop().catch((error) => console.error(`Failed to stop daemon on SIGINT: ${error.message}`));
  });
  process.once('SIGTERM', () => {
    stop().catch((error) => console.error(`Failed to stop daemon on SIGTERM: ${error.message}`));
  });
}

function createHttpServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      sendJson(res, 500, { error: error.message });
    });
  });
}

if (require.main === module) {
  start();
}

module.exports = {
  start,
  createHttpServer,
  stop,
  fillSlots,
  blockedEntry,
  cycleTaskNumber,
  gitSnapshot,
  sameProjectTree,
  projectTreeUnchanged,
  madeNoChanges,
  workerCommitSha,
  hasPassedCycle,
  checkpointCommit,
  recordCheckpoint,
  finishLoopCritic,
  finishLoopWorker,
  registerFailedCycle,
  loopEngines,
  sessionModel,
  GitCheckpointError,
  shutdownGracePeriodMs,
  resetStopping: () => { stopping = false; },
};
