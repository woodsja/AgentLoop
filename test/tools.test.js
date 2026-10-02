const test = require('node:test');
const assert = require('node:assert/strict');

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
  projectPath: '/project/example',
  id: 'task-1',
  goal: 'Add the feature',
  acceptance: ['Feature works'],
  verification: 'node test.js',
  worker: 'codex',
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
  assert.deepEqual(schema.required, ['projectPath', 'id', 'goal', 'acceptance', 'verification', 'worker']);
  assert.equal(schema.additionalProperties, false);
  for (const field of ['projectPath', 'id', 'goal', 'verification', 'model']) {
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
  }, { ralphTaskService });

  assert.deepEqual(calls, [{
    projectPath: taskArguments.projectPath,
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
    taskArguments.projectPath, taskArguments.verification]) {
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
  }, { ralphTaskService });
  assert.deepEqual(received, {
    projectPath: taskArguments.projectPath,
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
  const result = await tools.callTool({ name: 'ralph_run_task', arguments: taskArguments }, { ralphTaskService });
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
  const result = await tools.callTool({ name: 'ralph_run_task', arguments: taskArguments }, { ralphTaskService });
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
  const result = await tools.callTool({ name: 'ralph_run_task', arguments: taskArguments }, { ralphTaskService });
  assert.deepEqual(result, {
    content: [{ type: 'text', text: 'service failed' }],
    isError: true,
  });
});
