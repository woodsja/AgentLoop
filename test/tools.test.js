const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tools = require('../src/tools');

test('structuredContent only ever carries a JSON object', () => {
  assert.deepEqual(tools.structuredValue({ delivered: true }), { delivered: true });
  assert.deepEqual(tools.structuredValue([{ id: 'a' }, { id: 'b' }]), { ok: true });
  assert.deepEqual(tools.structuredValue([]), { ok: true });
  assert.deepEqual(tools.structuredValue(null), { ok: true });
  assert.deepEqual(tools.structuredValue('queued'), { ok: true });
});

test('every tool advertises an object input schema', () => {
  for (const tool of tools.tools) {
    assert.equal(tool.inputSchema.type, 'object');
  }
});

const taskArguments = {
  project: 'example',
  id: 'task-1',
  goal: 'Add the feature',
  acceptance: ['Feature works'],
  verification: 'node test.js',
  worker: 'codex',
};

const permittedProjectPath = '/registered/example';
const permittedProjectResolver = (project) => {
  if (project !== 'example') throw new Error('Unknown project.');
  return permittedProjectPath;
};

function passingResult(attemptOverrides = {}) {
  return {
    task: { ...taskArguments, secret: 'full task must stay private' },
    status: 'passed',
    attempts: [{
      number: 1,
      status: 'passed',
      worker: { resultText: 'private worker output', model: 'private model', cost: 12 },
      verification: {
        passed: true,
        exitCode: 0,
        timedOut: false,
        stdout: 'output',
        stderr: '',
        durationMs: 10,
      },
      ...attemptOverrides,
    }],
  };
}

test('ralph_run_task advertises the structured task contract', () => {
  const advertised = tools.tools.filter((tool) => tool.name === 'ralph_run_task');
  assert.equal(advertised.length, 1);
  const schema = advertised[0].inputSchema;
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['project', 'id', 'goal', 'acceptance', 'verification', 'worker']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.project, { type: 'string', description: 'Registered project name.' });
  for (const field of ['id', 'goal', 'verification', 'model']) {
    assert.deepEqual(schema.properties[field], { type: 'string' });
  }
  assert.deepEqual(schema.properties.acceptance, {
    type: 'array', items: { type: 'string' }, minItems: 1,
  });
  assert.deepEqual(schema.properties.worker.enum, ['codex', 'claude']);
  assert.deepEqual(schema.properties.maxAttempts, { type: 'integer', minimum: 1, maximum: 10 });
  assert.deepEqual(schema.properties.reviewPolicy.enum, ['none', 'risk', 'always']);
});

test('ralph_run_task passes only supplied task fields and returns a compact result', async () => {
  const calls = [];
  const ralphTaskService = {
    async run(projectPath, task) {
      calls.push({ projectPath, task });
      return passingResult();
    },
  };
  const result = await tools.callTool({
    name: 'ralph_run_task',
    arguments: { ...taskArguments, extra: 'ignored' },
  }, { ralphTaskService, resolveProject: permittedProjectResolver });

  assert.deepEqual(calls, [{
    projectPath: permittedProjectPath,
    task: {
      id: taskArguments.id,
      goal: taskArguments.goal,
      acceptance: taskArguments.acceptance,
      verification: taskArguments.verification,
      worker: taskArguments.worker,
    },
  }]);
  assert.deepEqual(result.structuredContent, {
    id: 'task-1',
    status: 'passed',
    attempts: [{
      number: 1,
      status: 'passed',
      verification: {
        passed: true,
        exitCode: 0,
        timedOut: false,
        stdout: 'output',
        stderr: '',
      },
    }],
  });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  for (const privateValue of ['private worker output', 'private model', 'full task must stay private',
    permittedProjectPath, taskArguments.verification]) {
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
});

test('ralph_run_task preserves supplied optional task fields', async () => {
  let received;
  const ralphTaskService = {
    async run(projectPath, task) {
      received = { projectPath, task };
      return passingResult();
    },
  };
  await tools.callTool({
    name: 'ralph_run_task',
    arguments: { ...taskArguments, maxAttempts: 3, reviewPolicy: 'risk', model: 'chosen-model' },
  }, { ralphTaskService, resolveProject: permittedProjectResolver });
  assert.deepEqual(received, {
    projectPath: permittedProjectPath,
    task: {
      id: taskArguments.id,
      goal: taskArguments.goal,
      acceptance: taskArguments.acceptance,
      verification: taskArguments.verification,
      worker: taskArguments.worker,
      maxAttempts: 3,
      reviewPolicy: 'risk',
      model: 'chosen-model',
    },
  });
});

test('ralph_run_task bounds each verification stream and keeps its tail', async () => {
  const stdout = 'A'.repeat(4100) + 'stdout tail';
  const stderr = 'B'.repeat(4200) + 'stderr tail';
  const ralphTaskService = {
    async run() {
      return passingResult({ verification: {
        passed: false, exitCode: 1, timedOut: false, stdout, stderr,
      } });
    },
  };
  const result = await tools.callTool({ name: 'ralph_run_task', arguments: taskArguments }, { ralphTaskService, resolveProject: permittedProjectResolver });
  const verification = result.structuredContent.attempts[0].verification;
  for (const [actual, original] of [[verification.stdout, stdout], [verification.stderr, stderr]]) {
    assert.equal(actual.length, 4000);
    assert.ok(actual.startsWith('[truncated]'));
    assert.ok(actual.endsWith(original.slice(-(4000 - '[truncated]'.length))));
  }
});

test('ralph_run_task returns compact worker errors', async () => {
  const ralphTaskService = {
    async run() {
      return {
        task: { ...taskArguments },
        status: 'needs_planning',
        attempts: [{
          number: 1,
          status: 'worker_error',
          error: { name: 'Error', message: 'worker failed', private: 'hidden' },
          worker: { resultText: 'private worker output' },
        }],
      };
    },
  };
  const result = await tools.callTool({ name: 'ralph_run_task', arguments: taskArguments }, { ralphTaskService, resolveProject: permittedProjectResolver });
  assert.deepEqual(result.structuredContent, {
    id: 'task-1',
    status: 'needs_planning',
    attempts: [{ number: 1, status: 'worker_error', error: { name: 'Error', message: 'worker failed' } }],
  });
});

test('ralph_run_task converts service errors to MCP failures', async () => {
  const ralphTaskService = {
    async run() { throw new Error('service failed'); },
  };
  const result = await tools.callTool({ name: 'ralph_run_task', arguments: taskArguments }, { ralphTaskService, resolveProject: permittedProjectResolver });
  assert.deepEqual(result, {
    content: [{ type: 'text', text: 'service failed' }],
    isError: true,
  });
});

test('ralph_run_task rejects unknown, empty, and path-like projects before starting a worker', async () => {
  let runs = 0;
  const ralphTaskService = { async run() { runs += 1; } };
  const resolveProject = (project) => {
    if (typeof project !== 'string' || !project.trim() || /[\\/]/.test(project) || /^[A-Za-z]:/.test(project)) {
      throw new Error('Unknown project.');
    }
    if (project !== 'example') throw new Error('Unknown project.');
    return permittedProjectPath;
  };

  for (const project of ['', '.', '..', 'unknown', '../example', '/registered/example', 'C:\\registered\\example']) {
    const result = await tools.callTool({
      name: 'ralph_run_task', arguments: { ...taskArguments, project },
    }, { ralphTaskService, resolveProject });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'Unknown project.');
  }
  const suppliedPath = await tools.callTool({
    name: 'ralph_run_task', arguments: { ...taskArguments, projectPath: '/arbitrary/path' },
  }, { ralphTaskService, resolveProject });
  assert.deepEqual(suppliedPath, {
    content: [{ type: 'text', text: 'cwd and projectPath are derived from the registered project.' }],
    isError: true,
  });
  assert.equal(runs, 0);
});

test('registered Ralph projects resolve to their canonical configured root', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-tool-project-'));
  try {
    const config = { allowedProjects: { example: directory, '/path-like-name': directory } };
    assert.equal(tools.resolveRegisteredProject('example', config), fs.realpathSync(directory));
    assert.throws(() => tools.resolveRegisteredProject('', config), /Unknown project/);
    assert.throws(() => tools.resolveRegisteredProject('.', config), /Unknown project/);
    assert.throws(() => tools.resolveRegisteredProject('../example', config), /Unknown project/);
    assert.throws(() => tools.resolveRegisteredProject('/path-like-name', config), /Unknown project/);
    assert.throws(() => tools.resolveRegisteredProject('missing', config), /Unknown project/);
    assert.throws(() => tools.resolveRegisteredProject('gone', {
      allowedProjects: { gone: path.join(directory, 'missing') },
    }), /Registered project folder does not exist/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('submit_job queues a registered project and returns its persisted id without waiting', async () => {
  const calls = [];
  const result = await tools.callTool({
    name: 'submit_job',
    arguments: { project: 'demo', title: 'Add coverage', prompt: 'Write one focused test.', engine: 'codex' },
  }, {
    async daemonRequest(requestPath, body) {
      calls.push({ requestPath, body });
      return { statusCode: 201, value: { id: 't-queued' } };
    },
  });

  assert.deepEqual(calls, [{
    requestPath: '/api/jobs',
    body: {
      project: 'demo', title: 'Add coverage', prompt: 'Write one focused test.', engine: 'codex', source: 'mcp',
    },
  }]);
  assert.deepEqual(result.structuredContent, { id: 't-queued' });
});

test('job tools read compact status and completed result without worker-private fields', async () => {
  const calls = [];
  const job = {
    id: 't-complete',
    status: 'done',
    project: 'demo',
    prompt: 'private worker prompt',
    cwd: '/private/project',
    result: {
      id: 't-complete',
      status: 'done',
      summary: 'private worker result',
      resultText: 'credentials=private',
      durationMs: 42,
      finishedAt: '2026-10-09T00:00:00.000Z',
      costUsd: 0.12,
    },
  };
  const daemonRequest = async (requestPath) => {
    calls.push(requestPath);
    return { statusCode: 200, value: job };
  };

  const status = await tools.callTool({ name: 'get_job_status', arguments: { id: 't-complete' } }, { daemonRequest });
  const result = await tools.callTool({ name: 'get_job_result', arguments: { id: 't-complete' } }, { daemonRequest });

  assert.deepEqual(calls, ['/api/jobs/t-complete', '/api/jobs/t-complete']);
  assert.deepEqual(status.structuredContent, { id: 't-complete', status: 'done', project: 'demo' });
  assert.deepEqual(result.structuredContent, {
    id: 't-complete',
    status: 'done',
    project: 'demo',
    result: { status: 'done', durationMs: 42, finishedAt: '2026-10-09T00:00:00.000Z', costUsd: 0.12 },
  });
  for (const privateValue of ['private worker prompt', '/private/project', 'private worker result', 'credentials=private']) {
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
});

test('submit_job rejects unknown projects and reports a down daemon', async () => {
  const rejected = await tools.callTool({
    name: 'submit_job',
    arguments: { project: '/arbitrary/path', title: 'Nope', prompt: 'Nope' },
  }, {
    async daemonRequest(requestPath, body) {
      assert.equal(requestPath, '/api/jobs');
      assert.equal(body.project, '/arbitrary/path');
      return { statusCode: 400, value: { error: 'Unknown project.' } };
    },
  });
  assert.deepEqual(rejected, {
    content: [{ type: 'text', text: 'Unknown project.' }],
    isError: true,
  });

  const unavailable = await tools.callTool({
    name: 'submit_job',
    arguments: { project: 'demo', title: 'Retry later', prompt: 'Nope' },
  }, {
    async daemonRequest() { throw new Error('connect ECONNREFUSED'); },
  });
  assert.deepEqual(unavailable, {
    content: [{ type: 'text', text: 'Daemon unavailable.' }],
    isError: true,
  });
});

test('dispatch_task requires and forwards a registered project name', async () => {
  const dispatch = tools.tools.find((tool) => tool.name === 'dispatch_task');
  assert.deepEqual(dispatch.inputSchema.required, ['project', 'title', 'prompt']);
  let received;
  await tools.callTool({
    name: 'dispatch_task',
    arguments: { project: 'demo', title: 'Legacy task', prompt: 'Do it' },
  }, {
    async daemonRequest(requestPath, body) {
      received = { requestPath, body };
      return { statusCode: 201, value: { id: 't-legacy' } };
    },
  });
  assert.deepEqual(received, {
    requestPath: '/api/dispatch',
    body: { project: 'demo', title: 'Legacy task', prompt: 'Do it', engine: undefined, source: 'mcp' },
  });
});
