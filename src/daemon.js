const { recorder } = require('./execution-log');
// Daemon scheduler, worker runner, and local HTTP API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const store = require('./store');
const { createDevelopmentJobs } = require('./development-jobs');
const { terminatePriorR1Worker } = require('./r1-process-claim');
let developmentJobs = createDevelopmentJobs(store);
const engines = require('./engines');
const state = require('./state');

const pollMs = 1500;
const maxLogLines = 1000;
const cycleLogId = (id, number, role) => `${id}-cycle-${number}-${role}`;
const maxEventBytes = 16 * 1024;
const messageKinds = new Set(['info', 'question', 'results']);
const terminalTaskStatuses = new Set(['done', 'failed', 'cancelled', 'passed', 'maxed', 'partial', 'incomplete', 'plan_complete']);
const shutdownGracePeriodMs = 10000;
const shutdownDeadlineMarginMs = 2000;
const runningActivity = new Map();

let daemonInfo;
let server;
let ticker;
let stopping = false;
let bridgeChild;

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

// Legacy records remain readable, but a pre-upgrade queued task or loop
// is never allowed to start another executor after admission was retired.
// This is a terminal recovery transition, not a second job coordinator.
function closeRetiredJob(task, stage, reason = 'legacy_execution_retired') {
  const finishedAt = new Date().toISOString();
  const status = reason === 'cancelled' || reason === 'parent_cancelled' ? 'cancelled' : 'failed';
  const summary = {
    cancelled: 'Owner cancelled the legacy job. It will not be replayed.',
    parent_cancelled: 'Owner cancelled the parent job before this pending legacy child started.',
    daemon_shutdown: 'Daemon shut down before the legacy task finished.',
    daemon_restarted: 'Daemon restarted before the legacy job finished. The retired job will not be replayed.',
    legacy_execution_retired: 'Legacy execution admission retired. No worker or loop was started.',
  }[reason];
  const ended = { ...task, status, reason, summary, finishedAt };
  const result = { id: task.id, status, reason, summary, finishedAt,
    durationMs: taskTime(task, 'startedAt') ? Math.max(0, Date.now() - taskTime(task, 'startedAt')) : 0 };
  // A failed result/task/move write is not terminal: leave the original stage
  // for fail-closed recovery. Emit the terminal event only after the durable
  // state is actually in done, so retries cannot claim completion twice.
  store.writeResult(result);
  store.writeTask(ended, stage);
  store.moveTask(task.id, stage, 'done');
  // recorder handles journal write errors as best-effort evidence, recording
  // the failed append to stderr without undoing the already durable archive.
  recorder(store, task.id)('legacy_job_terminal', { status, reason, stage, summary });
  try { store.appendLogLine(task.id, summary); }
  catch (error) { console.error('Failed to append archived job log: ' + error.message); }
  recordEvent(status === 'cancelled' ? 'cancel' : 'fail', { id: task.id, reason });
}

function fillSlots() {
  const maxConcurrent = Math.max(1, Number(store.config.maxConcurrent) || 2);
  const running = store.listTasks('running', { dashboard: true })
    .filter(task => task.workflow !== 'r1' || task.autopilotStateDir);
  const r1 = running.find(task => task.workflow === 'r1');
  if (r1) { developmentJobs.advance(r1); return; }
  if (running.some(task => task.r1Child)) return;
  developmentJobs.admit();
  const runningCount = running.length;
  const slots = Math.max(0, maxConcurrent - runningCount);
  if (!slots) return;

  const pending = sortPending(store.listTasks('pending', { dashboard: true }).filter(task => !task.unreadable));
  const canonical = [];
  for (const entry of pending) {
    // A record can disappear or become unreadable between listing and reading.
    // Never start a retired worker or block unrelated jobs on that failure.
    let task;
    try { task = store.readTask(entry.id, 'pending'); }
    catch (error) {
      console.error(`Queued job ${entry.id} could not be read; no worker started: ${error.message}`);
      continue;
    }
    if (task.workflow === 'r1' && !task.autopilotStateDir) continue;
    if (task.r1Child) {
      let parent;
      try { parent = store.readTask(task.r1Child.parentJobId, 'running'); } catch {}
      if (!parent?.autopilotStateDir) {
        failUnauthorizedR1Child(task, new Error('Canonical parent is no longer running.'));
        continue;
      }
    }
    if (task.r1Child || task.workflow === 'r1') {
      canonical.push(entry);
    } else {
      try { closeRetiredJob(task, 'pending'); }
      catch (error) {
        console.error(`Legacy job ${task.id} could not be archived; no worker started: ${error.message}`);
      }
    }
  }
  for (const selected of canonical.slice(0, slots)) {
    const task = store.readTask(selected.id, 'pending');
    // An orphan child never becomes an ordinary unprivileged loop simply
    // because its parent moved to done/recovery before queue admission.
    if (task.r1Child) {
      failUnauthorizedR1Child(task, new Error('Parent R1 job is not executing.'));
      continue;
    }
    if (store.listTasks('running', { dashboard: true }).length) return;
    store.moveTask(task.id, 'pending', 'running');
    developmentJobs.advance(task);
    return;
  }
}

function send(res, statusCode, body, contentType) {
  res.writeHead(statusCode, { 'content-type': contentType });
  res.end(body);
}

function sendJson(res, statusCode, value) {
  send(res, statusCode, JSON.stringify(value), 'application/json; charset=utf-8');
}

function resultForTask(task, dashboard = false) {
  try {
    if (task.autopilotStateDir) {
      const job = developmentJobs.read(task.id);
      const result = { id: task.id, status: job.status, project: task.project, evidence: job.evidence };
      return dashboard ? require('./execution-preview').preview(result) : result;
    }
    if (dashboard) return store.readDashboardResult(task.id);
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
  const projectTask = task => {
    if (!task.autopilotStateDir) return task;
    const current = developmentJobs.read(task.id) || { status: 'blocked', diagnostic: 'Canonical checkpoint unavailable.', executionJournal: { raw: `/api/log/${task.id}?raw=1` } };
    return { ...task, ...require('./execution-preview').preview(current),
      ...(current.evidence?.updatedAt ? { finishedAt: current.evidence.updatedAt } : {}) };
  };
  const pendingTasks = sortPending(store.listTasks('pending', { dashboard: true }).map(projectTask));
  const runningTasks = store.listTasks('running', { dashboard: true }).map(projectTask);
  const completedTasks = store.listTasks('done', { dashboard: true }).map(projectTask);
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
      results.set(task.id, resultForTask(task, true));
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
      projectConfig: require('./autopilot-config').runtimeProjectConfigState(),
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
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="${id}${requestUrl.searchParams.has('legacy') ? '' : '.execution'}.ndjson"`, 'X-Content-Type-Options': 'nosniff' });
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
      const canonical = task.autopilotStateDir ? developmentJobs.read(task.id) : null;
      const result = canonical?.evidence ? { id: task.id, status: canonical.status, evidence: canonical.evidence } : resultForTask(task);
      return {
        id: task.id,
        status: canonical?.status || task.status || stage,
        ...(typeof task.project === 'string' ? { project: task.project } : {}),
        ...(result ? { result } : {}),
      };
    } catch {
      // A task may move stages between the lookup and read; continue searching.
    }
  }

  return null;
}

// Only historical, already-materialized loop records reach this path.
function cancelRunningLoop(id) {
  let task;
  try { task = store.readTask(id, 'running'); }
  catch (error) { if (error.code === 'ENOENT') return { status: 404, error: 'Task is not running.' }; throw error; }
  if (task.r1Child && !terminatePriorR1Worker(task)) {
    return { status: 503, error: 'Previous R1 agent process has not been confirmed stopped; workspace retained.' };
  }
  closeRetiredJob(task, 'running', 'cancelled');
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
    for (const stage of ['running', 'pending']) {
      try {
        const task = store.readTask(id, stage);
        if (task.workflow === 'r1') { parent = task; parent.queueStage = stage; break; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (parent) {
    const attached = store.listR1ChildLoops(id);
    // Cancellation retries complete any work left by a partial first request.
    if (!parent.cancelRequested) {
      const { queueStage, ...reservation } = parent;
      store.writeTask({ ...reservation, cancelRequested: true, lastActivity: 'Cancellation requested.' }, queueStage);
    }
    developmentJobs.cancel(id, terminateWorker);
    for (const child of attached) {
      if (child.stage === 'running') {
        const stopped = cancelRunningLoop(child.id);
        if (stopped.status !== 200) { sendJson(res, stopped.status, { error: stopped.error }); return; }
      }
      else if (child.stage === 'pending') {
        closeRetiredJob(child.task, 'pending', 'parent_cancelled');
      }
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  const outcome = cancelRunningLoop(id);
  sendJson(res, outcome.status, outcome.status === 200 ? { ok: true } : { error: outcome.error });
}

async function handleRequest(req, res) {
  const port = req.socket.localPort;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(req.headers.host) || (req.headers.origin && ![...allowedHosts].some(host => req.headers.origin === `http://${host}`))) {
    sendJson(res, 403, { error: 'Local dashboard Host and Origin required.' });
    return;
  }
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
  if (req.method === 'GET' && requestPath === '/api/project-onboarding') {
    const projects = require('./project-registration').diagnosticProjects(store.paths.config);
    const runs = fs.existsSync(store.paths.logs) ? fs.readdirSync(store.paths.logs)
      .filter(name => /^onboarding-[A-Za-z0-9_-]+\.execution\.ndjson$/.test(name))
      .map(name => ({ logId: name.replace('.execution.ndjson', '') })) : [];
    sendJson(res, 200, { projects, runs });
    return;
  }

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

  // Development jobs have one canonical admission and read namespace.
  // Generic historical job reads remain available separately.
  if (req.method === 'GET' && requestPath.startsWith('/api/development/jobs/')) {
    const job = developmentJobs.read(requestPath.slice('/api/development/jobs/'.length));
    sendJson(res, job ? 200 : 404, job || { error: 'Job not found.' });
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/development/jobs') {
    try {
      const body = await readJsonBody(req);
      const job = await developmentJobs.submit(body);
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
    if (task.workflow === 'r1') {
      // A held session never started a process. Keep its parent attached so
      // canonical authorization can be rechecked without inventing a failure.
      developmentJobs.recover(task);
      continue;
    }
    if (terminalTaskStatuses.has(task.status)) {
      try {
        store.moveTask(task.id, 'running', 'done');
      } catch (error) {
        console.error(`Failed to recover ${task.id}: ${error.message}`);
      }
      continue;
    }

    if (task.r1Child) recorder(store, task.id, { parentId: task.r1Child.parentJobId })('recovery', { previousStatus: task.status, message: 'Daemon restarted; captured output retained. Interrupted process exit details are unknown unless previously recorded.' });
    if (task.r1Child && !terminatePriorR1Worker(task)) {
      const note = 'R1 child process termination unconfirmed; worktree retained. Retry cancel after verifying the old process group has ended.';
      console.error(`R1 child ${task.id}: ${note}`);
      store.writeTask({ ...task, recoveryBlocked: true, lastActivity: note }, 'running');
      store.appendLogLine(task.id, note);
      recordEvent('r1_child_recovery_blocked', { id: task.id, reason: 'process_unconfirmed' });
      continue;
    }
    try { closeRetiredJob(task, 'running', 'daemon_restarted'); }
    catch (error) { console.error(`Failed to recover ${task.id}: ${error.message}`); }
  }
  // A child queued just before a crash must not remain pending after its
  // parent was moved back to the recovery queue. Otherwise attempt N+1
  // cannot proceed, and an old attempt might later execute unexpectedly.
  for (const child of store.listTasks('pending')) {
    if (!child.r1Child) continue;
    let activeParent = false;
    try {
      const parent = store.readTask(child.r1Child.parentJobId, 'running');
      const job = parent.autopilotStateDir
        ? require('./autopilot-state').createJobStore(parent.autopilotStateDir).load(parent.issue, parent.id) : null;
      activeParent = parent.workflow === 'r1' && parent.status === 'running'
        && job?.runs === child.r1Child.attempt && !parent.cancelRequested;
    } catch (error) { console.error(`R1 child recovery denied: ${error.message}`); }
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
  const r1Stopped = developmentJobs.stop(terminateWorker);

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
    if (terminalTaskStatuses.has(task.status)) {
      try {
        store.moveTask(task.id, 'running', 'done');
      } catch (error) {
        console.error(`Failed to move terminal task ${task.id}: ${error.message}`);
      }
      continue;
    }

    if (task.r1Child && !terminatePriorR1Worker(task)) continue;
    try { closeRetiredJob(task, 'running', 'daemon_shutdown'); }
    catch (error) { console.error(`Failed to finalize ${task.id}: ${error.message}`); }
  }

  let r1Grace;
  await Promise.race([r1Stopped, new Promise(resolve => { r1Grace = setTimeout(resolve, shutdownGracePeriodMs); })]);
  clearTimeout(r1Grace);

  try {
    fs.unlinkSync(store.paths.daemon);
  } catch {
  }

  clearTimeout(deadlineTimer);
  invokeExit(0);
}

function initializeRuntime(options = {}) {
  require('./autopilot-config').runtimeProjectConfigIdentity();
  developmentJobs = createDevelopmentJobs(store, { projectsPath: require('./autopilot-config').projectConfigPath(), ...options.r1 });
  store.ensureDirs();

  daemonInfo = {
    pid: process.pid,
    port: store.config.dashboardPort,
    startedAt: new Date().toISOString(),
  };
}

function start(options = {}) {
  initializeRuntime(options);
  if (!store.acquireHeartbeat(daemonInfo)) {
    console.error(`AgentLoop daemon is already running (state ${store.paths.state}).`);
    return;
  }

  try { store.compactState(); }
  catch (error) { console.error(`Dashboard projection warm-up failed: ${error.stack || error.message}`); }
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
  testing: { initializeRuntime },
  start,
  createHttpServer,
  stop,
  fillSlots,
  shutdownGracePeriodMs,
  resetStopping: () => { stopping = false; },
};
