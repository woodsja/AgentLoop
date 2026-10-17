const journal = require('./execution-journal');
const { snapshotter } = require('./execution-preview');
const { createDashboardProjection } = require('./dashboard-projection');
const taskSnapshot = snapshotter();
// Filesystem-backed task state and daemon configuration.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { configuredProjects } = require('./project-registry');
const { createR1ChildStore } = require('./r1-child-store');

const root = path.resolve(__dirname, '..');
function resolveConfigPath() {
  if (process.env.AGENTLOOP_CONFIG_PATH) {
    return path.resolve(process.env.AGENTLOOP_CONFIG_PATH);
  }
  const flagIndex = process.argv.indexOf('--config');
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) {
    return path.resolve(process.argv[flagIndex + 1]);
  }
  return path.join(root, 'config.json');
}

// An isolated state directory lets a harness daemon run beside a live daemon
// without contending for its heartbeat, queue, or event log.
const stateRoot = process.env.AGENTLOOP_STATE_DIR
  ? path.resolve(process.env.AGENTLOOP_STATE_DIR)
  : path.join(root, 'state');

const paths = {
  root,
  config: resolveConfigPath(),
  state: stateRoot,
  tasks: path.join(stateRoot, 'tasks'),
  taskRuns: path.join(stateRoot, 'task-runs'),
  pending: path.join(stateRoot, 'tasks', 'pending'),
  running: path.join(stateRoot, 'tasks', 'running'),
  done: path.join(stateRoot, 'tasks', 'done'),
  results: path.join(stateRoot, 'results'),
  logs: path.join(stateRoot, 'logs'),
  events: path.join(stateRoot, 'events.ndjson'),
  messages: path.join(stateRoot, 'messages.ndjson'),
  daemon: path.join(stateRoot, 'daemon.json'),
  bridge: path.join(stateRoot, 'bridge.json'),
  mcpToken: path.join(stateRoot, 'mcp-token'),
};

// 50 messages x 2000 code points x 4 bytes, plus JSON overhead and headroom.
const maxMessageBytes = 512 * 1024;

const defaults = {
  dashboardPort: 5757,
  maxConcurrent: 2,
  taskTimeoutMin: 45,
  defaultEngine: 'codex',
  mcpBridge: { port: 5758 },
};

function loadConfig() {
  let loaded = {};

  try {
    loaded = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch {
    loaded = {};
  }

  const config = {
    dashboardPort: loaded.dashboardPort ?? defaults.dashboardPort,
    maxConcurrent: loaded.maxConcurrent ?? defaults.maxConcurrent,
    taskTimeoutMin: loaded.taskTimeoutMin ?? defaults.taskTimeoutMin,
    defaultEngine: loaded.defaultEngine ?? defaults.defaultEngine,
    mcpBridge: {
      port: loaded.mcpBridge?.port ?? defaults.mcpBridge.port,
    },
    models: loaded.models ?? {},
    enginePaths: loaded.enginePaths ?? {},
    // This is deliberately configuration only.  Requests can select a name,
    // never add a project or provide the path where a worker will run.
    allowedProjects: configuredProjects(loaded.allowedProjects, paths.config),
  };

  if (loaded.model) {
    config.model = loaded.model;
  }

  return config;
}

const config = loadConfig();

function ensureDirs() {
  for (const directory of [paths.pending, paths.running, paths.done, paths.taskRuns, paths.results, paths.logs]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function stageDir(stage) {
  if (!['pending', 'running', 'done'].includes(stage)) {
    throw new Error(`Unknown task stage: ${stage}`);
  }

  return paths[stage];
}

function taskPath(id, stage) {
  return path.join(stageDir(stage), `${id}.json`);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );

  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (error.code !== 'EXDEV') {
      try {
        fs.unlinkSync(tempPath);
      } catch {
      }
      throw error;
    }

    fs.copyFileSync(tempPath, filePath);
    fs.unlinkSync(tempPath);
  }
}

function moveFile(source, destination) {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error;
    }

    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
  }
}

function enqueueTask(partial = {}) {
  const input = partial && typeof partial === 'object' ? partial : {};
  const task = {
    ...input,
    id: `t-${crypto.randomBytes(4).toString('hex')}`,
    type: 'task',
    title: input.title || 'untitled',
    priority: input.priority ?? 5,
    createdAt: new Date().toISOString(),
    source: input.source || 'api',
  };

  writeTask(task, 'pending');
  return task;
}

function enqueueLoop(partial = {}) {
  const input = partial && typeof partial === 'object' ? partial : {};
  const loop = {
    ...input,
    id: `t-${crypto.randomBytes(4).toString('hex')}`,
    type: 'loop',
    title: input.title || `loop: ${input.project || 'untitled'}`,
    priority: input.priority ?? 5,
    cycles: Array.isArray(input.cycles) ? input.cycles : [],
    createdAt: new Date().toISOString(),
    source: input.source || 'api',
  };

  writeTask(loop, 'pending');
  return loop;
}

function moveTask(id, fromStage, toStage) {
  ensureDirs();
  moveFile(taskPath(id, fromStage), taskPath(id, toStage));
}

const taskProjection = createDashboardProjection(path.join(stateRoot, 'dashboard', 'tasks'), writeJsonAtomic);
const resultProjection = createDashboardProjection(path.join(stateRoot, 'dashboard', 'results'), writeJsonAtomic);

function readTask(id, stage) {
  return JSON.parse(fs.readFileSync(taskPath(id, stage), 'utf8'));
}

function writeTask(task, stage) {
  if (!task || !task.id) {
    throw new Error('Task id is required.');
  }

  ensureDirs();
  const summary = taskSnapshot(task.id, task, record => appendExecution(task.id, record));
  summary.executionJournal = { id: task.id, raw: `/api/log/${encodeURIComponent(task.id)}?raw=1` };
  const file = taskPath(task.id, stage);
  writeJsonAtomic(file, { ...task, executionJournal: summary.executionJournal });
  taskProjection.save(file, { ...task, executionJournal: summary.executionJournal });
}

function taskRunPath(id) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('Task run id is required.');
  }

  const filename = `${crypto.createHash('sha256').update(id).digest('hex')}.json`;
  return path.join(paths.taskRuns, filename);
}

function writeTaskRunState(record) {
  const filePath = taskRunPath(record?.id);
  writeJsonAtomic(filePath, record);
}

function readTaskRunState(id) {
  try {
    return JSON.parse(fs.readFileSync(taskRunPath(id), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function listTasks(stage, { dashboard = false } = {}) {
  ensureDirs();

  return fs.readdirSync(stageDir(stage), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const file = path.join(stageDir(stage), entry.name);
      return dashboard ? taskProjection.read(file) : JSON.parse(fs.readFileSync(file, 'utf8'));
    });
}

// Warm disposable projections at startup without rewriting canonical state.
function compactState() {
  ensureDirs();
  for (const stage of ['pending', 'running', 'done']) {
    listTasks(stage, { dashboard: true });
  }
  for (const name of fs.readdirSync(paths.results).filter(name => name.endsWith('.json'))) {
    resultProjection.read(path.join(paths.results, name));
  }
}

function writeResult(result) {
  if (!result || !result.id) {
    throw new Error('Result id is required.');
  }

  ensureDirs();
  const summary = taskSnapshot(`result:${result.id}`, result, record => appendExecution(result.id, { ...record, kind: 'result' }));
  if (JSON.stringify(summary) !== JSON.stringify(result)) summary.executionJournal = { id: result.id, raw: `/api/log/${encodeURIComponent(result.id)}?raw=1` };
  const file = path.join(paths.results, `${result.id}.json`);
  writeJsonAtomic(file, { ...result, ...(summary.executionJournal ? { executionJournal: summary.executionJournal } : {}) });
  resultProjection.save(file, result);
}

function readDashboardResult(id) {
  return resultProjection.read(path.join(paths.results, `${id}.json`));
}

function logPath(id) {
  return path.join(paths.logs, `${id}.ndjson`);
}

function appendLogLine(id, line) {
  if (!id) {
    throw new Error('Task id is required.');
  }

  ensureDirs();
  const value = String(line ?? '').replace(/[\r\n]+/g, ' ');
  fs.appendFileSync(logPath(id), `${value}\n`, 'utf8');
}

function readLogLines(id, limit = 200) {
  try {
    const lines = fs.readFileSync(logPath(id), 'utf8').split(/\r?\n/);

    if (lines[lines.length - 1] === '') {
      lines.pop();
    }

    return lines.slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}

function executionPath(id, legacy = false) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid execution log id.');
  return path.join(paths.logs, `${id}${legacy ? '' : '.execution'}.ndjson`);
}

function appendExecution(id, record) {
  ensureDirs();
  return journal.append(executionPath(id), { ...record, jobId: id, timestamp: new Date().toISOString() });
}

function readExecutionBytes(id, offset = 0, bytes = 65536, legacy = false) {
  const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const length = Number.isSafeInteger(bytes) && bytes > 0 ? Math.min(bytes, 262144) : 65536;
  let fd;
  try {
    fd = fs.openSync(executionPath(id, legacy), 'r');
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(length, Math.max(0, size - start)));
    const count = fs.readSync(fd, buffer, 0, buffer.length, start);
    return { offset: start, nextOffset: start + count, hasMore: start + count < size, base64: buffer.subarray(0, count).toString('base64') };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { offset: start, nextOffset: start, hasMore: false, base64: '' };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function appendEvent(type, dataObj = {}) {
  try {
    ensureDirs();
    const event = {
      ...(dataObj && typeof dataObj === 'object' ? dataObj : {}),
      type,
      ts: new Date().toISOString(),
    };

    fs.appendFileSync(paths.events, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  } catch {
    return null;
  }
}

function appendMessage(partial = {}) {
  const input = partial && typeof partial === 'object' ? partial : {};
  const message = {
    id: `m-${crypto.randomBytes(4).toString('hex')}`,
    ts: new Date().toISOString(),
    kind: input.kind,
    text: input.text,
  };

  ensureDirs();
  fs.appendFileSync(paths.messages, `${JSON.stringify(message)}\n`, 'utf8');
  return message;
}

function readMessages(limit = 50) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : 50;

  try {
    const size = fs.statSync(paths.messages).size;

    if (!size) {
      return [];
    }

    const length = Math.min(size, maxMessageBytes);
    const buffer = Buffer.alloc(length);
    const descriptor = fs.openSync(paths.messages, 'r');
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

    const messages = [];

    for (const line of lines.reverse()) {
      try {
        const message = JSON.parse(line);

        if (message && typeof message === 'object' && !Array.isArray(message)) {
          messages.push(message);
          if (messages.length === max) {
            break;
          }
        }
      } catch {
      }
    }

    return messages;
  } catch {
    return [];
  }
}

function heartbeatValue(heartbeat) {
  return {
    ...heartbeat,
    ts: new Date().toISOString(),
  };
}

function writeExclusiveHeartbeat(value) {
  let fd;

  try {
    fd = fs.openSync(paths.daemon, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function acquireHeartbeat(heartbeat) {
  ensureDirs();
  const value = heartbeatValue(heartbeat);

  try {
    writeExclusiveHeartbeat(value);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }

  const existing = readHeartbeat();

  if (isAlive(existing)) {
    return false;
  }

  if (!existing) {
    let age;

    try {
      age = Date.now() - fs.statSync(paths.daemon).mtimeMs;
    } catch {
      return false;
    }

    if (!Number.isFinite(age) || age < 15000) {
      return false;
    }
  }

  try {
    fs.unlinkSync(paths.daemon);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    writeExclusiveHeartbeat(value);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

function writeHeartbeat(heartbeat) {
  const value = heartbeatValue(heartbeat);

  ensureDirs();
  writeJsonAtomic(paths.daemon, value);
  return value;
}

function readHeartbeat() {
  try {
    return JSON.parse(fs.readFileSync(paths.daemon, 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(heartbeat = readHeartbeat()) {
  const timestamp = heartbeat && Date.parse(heartbeat.ts);
  const pid = heartbeat && Number(heartbeat.pid);

  if (!Number.isFinite(timestamp) || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  if (Date.now() - timestamp >= 15000) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const childStore = createR1ChildStore({ stateRoot: paths.state, writeTask });

module.exports = {
  enqueueR1ChildLoopOnce: childStore.ensureLoop,
  listR1ChildLoops: childStore.listChildren,
  config,
  paths,
  ensureDirs,
  enqueueTask,
  enqueueLoop,
  moveTask,
  readTask,
  writeTask,
  writeTaskRunState,
  readTaskRunState,
  listTasks,
  writeResult,
  readDashboardResult,
  compactState,
  appendLogLine,
  appendExecution,
  readExecutionBytes,
  executionPath,
  readLogLines,
  appendEvent,
  appendMessage,
  readMessages,
  acquireHeartbeat,
  writeHeartbeat,
  readHeartbeat,
  isAlive,
};
