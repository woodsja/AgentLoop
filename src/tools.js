// MCP tool definitions and dispatch, shared by both transports (bridge.js http, mcp-server.js stdio).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const store = require('./store');
const { createRalphTaskService } = require('./ralph-task-service');
const { resolveProject } = require('./project-registry');
const { runBash, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS } = require('./run-bash');

let defaultRalphTaskService;

function ralphTaskService() {
  if (!defaultRalphTaskService) {
    defaultRalphTaskService = createRalphTaskService({
      config: store.config,
      workerTimeoutMs: store.config.taskTimeoutMin * 60 * 1000,
    });
  }
  return defaultRalphTaskService;
}

// Ralph tasks run synchronously, so this boundary must independently enforce
// the same administrator-owned project registry used by daemon submissions.
// A caller can select a registered name, never a filesystem location.
function resolveRegisteredProject(project, config = store.config) {
  const name = typeof project === 'string' ? project.trim() : '';
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) {
    throw new Error('Unknown project.');
  }

  const allowedProjects = config && config.allowedProjects;
  const entry = allowedProjects && Object.hasOwn(allowedProjects, name)
    ? allowedProjects[name]
    : null;
  const configuredRoot = entry && typeof entry === 'object' ? entry.root : entry;
  if (typeof configuredRoot !== 'string' || !configuredRoot.trim()) {
    throw new Error('Unknown project.');
  }

  try {
    const projectPath = fs.realpathSync(configuredRoot);
    if (!fs.statSync(projectPath).isDirectory()) {
      throw new Error('not a directory');
    }
    return projectPath;
  } catch {
    throw new Error('Registered project folder does not exist.');
  }
}

function boundedOutput(value) {
  const limit = 4000;
  const marker = '[truncated]';
  return value.length > limit ? marker + value.slice(-(limit - marker.length)) : value;
}

function compactRalphResult(result) {
  return {
    id: result.task.id,
    status: result.status,
    attempts: result.attempts.map((attempt) => {
      const compact = { number: attempt.number, status: attempt.status };
      if (attempt.status === 'worker_error') {
        compact.error = {
          name: attempt.error.name,
          message: attempt.error.message,
        };
      } else {
        const verification = attempt.verification;
        compact.verification = {
          passed: verification.passed,
          exitCode: verification.exitCode,
          timedOut: verification.timedOut,
          stdout: boundedOutput(verification.stdout),
          stderr: boundedOutput(verification.stderr),
        };
      }
      return compact;
    }),
  };
}

// A non-numeric config value reaches http.request as-is and fails every tool call.
function dashboardPort() {
  const parsed = Number(store.config.dashboardPort);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 5757;
}

function daemonRequest(requestPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({
      hostname: '127.0.0.1',
      port: dashboardPort(),
      path: requestPath,
      method: data ? 'POST' : 'GET',
      headers: data ? {
        'content-type': 'application/json',
        'content-length': data.length,
      } : {},
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let value = null;

        try {
          value = text ? JSON.parse(text) : null;
        } catch {
          value = null;
        }

        resolve({ statusCode: response.statusCode || 500, value });
      });
    });

    request.setTimeout(10000, () => request.destroy(new Error('Daemon request timed out.')));
    request.on('error', reject);
    request.end(data || undefined);
  });
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusSnapshot(state) {
  const stats = state && typeof state.stats === 'object' ? state.stats : {};
  const tasks = state && typeof state.tasks === 'object' ? state.tasks : {};
  const running = Array.isArray(tasks.running) ? tasks.running : [];
  const recent = Array.isArray(tasks.recent) ? tasks.recent : [];

  return {
    daemonAlive: state?.daemon?.alive === true,
    counts: {
      pending: numeric(stats.pending),
      running: numeric(stats.running),
      done: numeric(stats.done),
      failed: numeric(stats.failed),
    },
    runningTasks: running.map((task) => ({
      id: task.id,
      title: task.title,
      elapsed: numeric(task.elapsedMs),
    })),
    recentResults: recent.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status || task.result?.status || null,
    })),
  };
}

// MCP requires structuredContent to be a JSON object: an array or an empty body is not one.
function structuredValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : { ok: true };
}

function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolFailure(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

const tools = [
  {
    name: 'submit_r1_job', description: 'Queue an authorized R1 issue for asynchronous implementation, verification and independent review. Returns a job ID immediately.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, issue: { type: 'integer', minimum: 1 }, worktree: { type: 'string' } }, required: ['project', 'issue'], additionalProperties: false },
    annotations: { readOnlyHint: false },
  },
  ...['get_r1_job_status', 'get_r1_job_result'].map(name => ({
    name, description: 'Retrieve persisted R1 job phases and review evidence by job ID.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  })),
  {
    name: 'agentloop_status',
    description: 'Read the current AgentLoop status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dispatch_task',
    description: 'Dispatch a task to AgentLoop.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Registered project name.' },
        worktree: { type: 'string', description: 'Owner-authorized worktree name.' },
        title: { type: 'string' },
        prompt: { type: 'string' },
        engine: { type: 'string', enum: ['claude', 'codex'] },
      },
      required: ['project', 'title', 'prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'submit_job',
    description: 'Queue a job for a registered AgentLoop project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Registered project name.' },
        title: { type: 'string' },
        prompt: { type: 'string' },
        engine: { type: 'string', enum: ['claude', 'codex'] },
      },
      required: ['project', 'title', 'prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'get_job_status',
    description: 'Read compact status for a queued AgentLoop job.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_job_result',
    description: 'Read compact completion metadata for an AgentLoop job.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'start_loop',
    description: 'Start an AgentLoop project loop.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        worktree: { type: 'string', description: 'Owner-authorized worktree name.' },
        maxCycles: { type: 'integer', minimum: 1, maximum: 50 },
        taskRetries: { type: 'integer', minimum: 1, maximum: 10, description: 'failed cycles per task before it is blocked and skipped' },
        engine: { type: 'string', enum: ['claude', 'codex'] },
        polish: { type: 'boolean', default: false, description: 'keep improving after the plan passes' },
        autoCommit: { type: 'boolean', default: true, description: 'daemon makes a local git checkpoint commit after each completed task' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'send_message',
    description: 'Post short progress updates, questions for the human, and final result summaries to the AgentLoop dashboard.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 2000 },
        kind: { type: 'string', enum: ['info', 'question', 'results'], default: 'info' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'ralph_run_task',
    description: 'Run a structured Ralph task in a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Registered project name.' },
        worktree: { type: 'string', description: 'Owner-authorized worktree name.' },
        id: { type: 'string' },
        goal: { type: 'string' },
        acceptance: { type: 'array', items: { type: 'string' }, minItems: 1 },
        verification: { type: 'string' },
        worker: { type: 'string', enum: ['codex', 'claude'] },
        maxAttempts: { type: 'integer', minimum: 1, maximum: 10 },
        reviewPolicy: { type: 'string', enum: ['none', 'risk', 'always'] },
        model: { type: 'string' },
      },
      required: ['project', 'id', 'goal', 'acceptance', 'verification', 'worker'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
];

// Opt-in only: mcp-server.js lists and dispatches this tool when started with --enable-run-bash.
// It is deliberately absent from `tools`, which the HTTP bridge also serves.
const runBashTool = {
  name: 'run_bash',
  description: [
    'Run a Bash command directly on the Ralph host as its unprivileged service user, without Codex or Claude.',
    'Commands can create, modify, or delete anything that user can, and can reach the network.',
    'The optional registered project or worktree only sets the starting directory; it does not restrict filesystem access.',
    `One command runs at a time. Timeout defaults to ${DEFAULT_TIMEOUT_SECONDS}s (max ${MAX_TIMEOUT_SECONDS}s); stdin is closed; output is truncated to the most recent 32 KiB per stream.`,
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', minLength: 1, maxLength: 16384, description: 'Bash command, run with bash -c.' },
      project: { type: 'string', description: 'Registered project name; sets the starting directory.' },
      worktree: { type: 'string', description: 'Owner-authorized worktree name of the project.' },
      timeoutSeconds: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_SECONDS, default: DEFAULT_TIMEOUT_SECONDS },
    },
    required: ['command'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

function resolveRunBashCwd(project, worktree) {
  return worktree === undefined
    ? resolveRegisteredProject(project)
    : resolveProject(store.config, project, worktree, store.paths.config).cwd;
}

function daemonError(response) {
  return response.value && typeof response.value.error === 'string'
    ? response.value.error
    : `Daemon request failed (${response.statusCode}).`;
}

// Job records can contain worker output. Keep the MCP read surface to stable,
// non-sensitive metadata rather than reflecting the daemon's stored payload.
function compactJobStatus(job) {
  return {
    id: typeof job?.id === 'string' ? job.id : null,
    status: typeof job?.status === 'string' ? job.status : null,
    ...(typeof job?.project === 'string' ? { project: job.project } : {}),
  };
}

function compactJobResult(job) {
  const status = compactJobStatus(job);
  const result = job && typeof job.result === 'object' && !Array.isArray(job.result) ? job.result : null;

  return {
    ...status,
    ...(result ? {
      result: {
        status: typeof result.status === 'string' ? result.status : status.status,
        ...(typeof result.durationMs === 'number' ? { durationMs: result.durationMs } : {}),
        ...(typeof result.finishedAt === 'string' ? { finishedAt: result.finishedAt } : {}),
        ...(typeof result.costUsd === 'number' ? { costUsd: result.costUsd } : {}),
      },
    } : {}),
  };
}

async function requestDaemon(options, requestPath, body) {
  try {
    return await (options.daemonRequest ?? daemonRequest)(requestPath, body);
  } catch {
    return null;
  }
}

async function callTool(params, options = {}) {
  const name = params && typeof params.name === 'string' ? params.name : '';
  const args = params && params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments
    : {};

  if (name === 'agentloop_status') {
    try {
      const response = await daemonRequest('/api/state');
      return toolResult(statusSnapshot(response.statusCode === 200 ? response.value : null));
    } catch {
      return toolResult(statusSnapshot(null));
    }
  }

  if (['submit_r1_job', 'get_r1_job_status', 'get_r1_job_result'].includes(name)) {
    const response = name === 'submit_r1_job'
      ? await requestDaemon(options, '/api/r1/jobs', { project: args.project, issue: args.issue, worktree: args.worktree, source: 'mcp' })
      : await requestDaemon(options, `/api/r1/jobs/${encodeURIComponent(args.id || '')}`);
    return response && response.statusCode >= 200 && response.statusCode < 300
      ? toolResult(response.value) : toolFailure(response ? daemonError(response) : 'Daemon unavailable.');
  }

  if (name === 'dispatch_task') {
    const response = await requestDaemon(options, '/api/dispatch', {
      project: args.project,
      ...(args.worktree !== undefined ? { worktree: args.worktree } : {}),
      title: args.title,
      prompt: args.prompt,
      engine: args.engine,
      source: 'mcp',
    });

    return response && response.statusCode >= 200 && response.statusCode < 300
      ? toolResult({ id: response.value?.id })
      : toolFailure(response ? daemonError(response) : 'Daemon unavailable.');
  }

  if (name === 'submit_job') {
    const response = await requestDaemon(options, '/api/jobs', {
      project: args.project,
      title: args.title,
      prompt: args.prompt,
      engine: args.engine,
      source: 'mcp',
    });

    return response && response.statusCode >= 200 && response.statusCode < 300
      ? toolResult({ id: response.value?.id })
      : toolFailure(response ? daemonError(response) : 'Daemon unavailable.');
  }

  if (name === 'get_job_status' || name === 'get_job_result') {
    const response = await requestDaemon(options, `/api/jobs/${encodeURIComponent(args.id || '')}`);

    if (!response) return toolFailure('Daemon unavailable.');
    if (response.statusCode < 200 || response.statusCode >= 300) return toolFailure(daemonError(response));
    return toolResult(name === 'get_job_status'
      ? compactJobStatus(response.value)
      : compactJobResult(response.value));
  }

  if (name === 'start_loop') {
    const response = await requestDaemon(options, '/api/loop', {
      project: args.project,
      worktree: args.worktree,
      maxCycles: args.maxCycles,
      taskRetries: args.taskRetries,
      engine: args.engine,
      polish: args.polish,
      autoCommit: args.autoCommit,
      source: 'mcp',
    });

    return response && response.statusCode >= 200 && response.statusCode < 300
      ? toolResult({ id: response.value?.id })
      : toolFailure(response ? daemonError(response) : 'Daemon unavailable.');
  }

  if (name === 'send_message') {
    const response = await requestDaemon(options, '/api/message', {
      text: args.text,
      kind: args.kind,
    });

    return response && response.statusCode >= 200 && response.statusCode < 300
      ? toolResult(structuredValue(response.value))
      : toolFailure(response ? daemonError(response) : 'Daemon unavailable.');
  }

  if (name === 'ralph_run_task') {
    if (Object.hasOwn(args, 'cwd') || Object.hasOwn(args, 'projectPath')) {
      return toolFailure('cwd and projectPath are derived from the registered project.');
    }
    const task = {
      id: args.id,
      goal: args.goal,
      acceptance: args.acceptance,
      verification: args.verification,
      worker: args.worker,
    };
    for (const field of ['maxAttempts', 'reviewPolicy', 'model']) {
      if (args[field] !== undefined) task[field] = args[field];
    }

    try {
      const projectPath = args.worktree === undefined
        ? (options.resolveProject ?? resolveRegisteredProject)(args.project)
        : resolveProject(store.config, args.project, args.worktree, store.paths.config).cwd;
      const service = options.ralphTaskService ?? ralphTaskService();
      return toolResult(compactRalphResult(await service.run(projectPath, task)));
    } catch (error) {
      return toolFailure(error.message);
    }
  }

  if (name === 'run_bash' && options.runBash === true) {
    try {
      return toolResult(await runBash(args, {
        resolveCwd: options.resolveRunBashCwd ?? resolveRunBashCwd,
        lockPath: options.runBashLockPath ?? path.join(store.paths.state, 'run-bash.lock'),
        auditPath: options.runBashAuditPath ?? path.join(store.paths.logs, 'run-bash.ndjson'),
        ...(options.runBashDefaultCwd ? { defaultCwd: options.runBashDefaultCwd } : {}),
      }));
    } catch (error) {
      return toolFailure(error.message);
    }
  }

  return toolFailure(`Unknown tool: ${name}.`);
}

module.exports = {
  tools,
  runBashTool,
  callTool,
  structuredValue,
  compactJobStatus,
  compactJobResult,
  resolveRegisteredProject,
};
