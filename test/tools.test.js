const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tools = require('../src/tools');

test('the MCP tool interface offers exactly one development-job submission', async () => {
  const names = tools.tools.map(tool => tool.name);
  assert.ok(names.includes('submit_r1_job'));
  for (const obsolete of ['dispatch_task', 'submit_job', 'ralph_run_task', 'start_loop']) {
    assert.equal(names.includes(obsolete), false, obsolete + ' is a competing execution interface');
    const denied = await tools.callTool({ name: obsolete, arguments: { project: 'demo', issue: 5 } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /Unknown tool/);
  }
  assert.ok(names.includes('get_job_status') && names.includes('get_job_result'), 'historical reads remain');
});

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

test('R1 admission remains separate from historical read-only job tools', async () => {
  const calls = [];
  const daemonRequest = async (requestPath, body) => {
    calls.push({ requestPath, body });
    return body ? { statusCode: 201, value: { id: 't-0000r1' } } : { statusCode: 200, value: { id: 't-0000r1', phase: 'review' } };
  };
  const submitted = await tools.callTool({ name: 'submit_r1_job', arguments: { project: 'demo', issue: 7, worktree: 'issue7' } }, { daemonRequest });
  const status = await tools.callTool({ name: 'get_r1_job_status', arguments: { id: 't-0000r1' } }, { daemonRequest });

  assert.deepEqual(calls, [
    { requestPath: '/api/r1/jobs', body: { project: 'demo', issue: 7, worktree: 'issue7', source: 'mcp' } },
    { requestPath: '/api/r1/jobs/t-0000r1', body: undefined },
  ]);
  assert.deepEqual(submitted.structuredContent, { id: 't-0000r1' });
  assert.deepEqual(status.structuredContent, { id: 't-0000r1', phase: 'review' });
  const canonical = tools.tools.find((tool) => tool.name === 'submit_r1_job');
  assert.deepEqual(canonical.inputSchema.required, ['project', 'issue']);
  assert.equal(Object.hasOwn(canonical.inputSchema.properties, 'prompt'), false);
  assert.deepEqual(canonical.inputSchema.properties.worktree, { type: 'string' });
  assert.equal(canonical.inputSchema.additionalProperties, false);
});
