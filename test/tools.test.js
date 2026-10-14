const test = require('node:test');
const assert = require('node:assert/strict');

const tools = require('../src/tools');
const http = require('node:http');
const store = require('../src/store');

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

test('start_loop advertises and forwards independent engine choices to the API', async () => {
  const schema = tools.tools.find(tool => tool.name === 'start_loop').inputSchema;
  assert.deepEqual(schema.properties.workerEngine.enum, ['claude', 'codex']);
  assert.deepEqual(schema.properties.criticEngine.enum, ['claude', 'codex']);
  assert.ok(!schema.required.includes('workerEngine'));
  assert.ok(!schema.required.includes('criticEngine'));
  let received;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received = { path: req.url, body: JSON.parse(body) };
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'test-loop' }));
    });
  });
  const saved = store.config.dashboardPort;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  store.config.dashboardPort = server.address().port;
  try {
    const result = await tools.callTool({ name: 'start_loop', arguments: {
      project: 'demo', engine: 'claude', workerEngine: 'codex', criticEngine: 'claude', maxCycles: 4, taskRetries: 2,
    } });
    assert.deepEqual(result.structuredContent, { id: 'test-loop' });
    assert.equal(received.path, '/api/loop');
    assert.deepEqual(received.body, {
      project: 'demo', engine: 'claude', workerEngine: 'codex', criticEngine: 'claude', maxCycles: 4, taskRetries: 2, source: 'mcp',
    });
  } finally {
    store.config.dashboardPort = saved;
    await new Promise(resolve => server.close(resolve));
  }
});
