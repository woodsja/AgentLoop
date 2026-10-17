const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-log-'));
process.env.AGENTLOOP_STATE_DIR = root;
const store = require('../src/store');
const { recorder, captureProcess, execFile, execFileSync, withExecution } = require('../src/execution-log');
const { runVerification } = require('../src/verifier');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const events = id => fs.readFileSync(store.executionPath(id), 'utf8').trim().split('\n').map(JSON.parse);
const output = (id, stream) => Buffer.concat(events(id).filter(r => r.event === 'output' && r.stream === stream).map(r => Buffer.from(r.base64, 'base64')));

test('native command capture preserves binary bytes, split UTF-8, CRLF and unterminated stderr', async () => {
  const id = 't-binary';
  await withExecution(recorder(store, id), () => new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', "require('fs').writeFileSync(1,Buffer.from([0,255,13,10,226,130,172]));require('fs').writeFileSync(2,'token=private /tmp/file')"], {encoding:'utf8'}, error => error ? reject(error) : resolve());
  }));
  assert.deepEqual(output(id, 'stdout'), Buffer.from([0,255,13,10,226,130,172]));
  assert.equal(output(id, 'stderr').toString(), 'token=private /tmp/file');
});

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`cancelled or abruptly killed CLI retains output and precise ${signal} outcome`, async () => {
    const id = `t-${signal}`;
    const child = captureProcess(spawn, process.execPath, ['-e', "require('fs').writeFileSync(1,'prior output\\r\\n');require('fs').writeFileSync(2,'prior error');setInterval(()=>{},1000)"], {stdio:['ignore','pipe','pipe']}, recorder(store, id, {role:'worker',attempt:1}));
    const closed = new Promise(resolve => child.once('close', resolve));
    await new Promise(resolve => child.stderr.once('data', resolve));
    child.kill(signal);
    await closed;
    assert.equal(output(id, 'stdout').toString(), 'prior output\r\n');
    assert.equal(output(id, 'stderr').toString(), 'prior error');
    assert.equal(events(id).at(-1).signal, signal);
    // A fresh store module uses the durable log, not an in-memory cache.
    delete require.cache[require.resolve('../src/store')];
    const reopened = require('../src/store');
    const page = reopened.readExecutionBytes(id, 0, 100000);
    assert.deepEqual(Buffer.from(page.base64, 'base64'), fs.readFileSync(store.executionPath(id)));
  });
}

test('timed-out verification retains prior output, command, signal and timeout evidence', async () => {
  const id = 't-timeout';
  const command = `${process.execPath} -e "require('fs').writeFileSync(1,'before timeout');setInterval(()=>{},1000)"`;
  const result = await runVerification(process.cwd(), command, 500, recorder(store, id, {role:'verification'}));
  assert.equal(result.command, command);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(output(id, 'stdout').toString(), 'before timeout');
});


test('a torn final crash record remains retrievable and cannot corrupt the next append', () => {
  const id = 't-torn';
  store.appendExecution(id, {event:'first'});
  const torn = '{"event":"partial';
  fs.appendFileSync(store.executionPath(id), torn);
  const before = fs.readFileSync(store.executionPath(id));
  store.appendExecution(id, {event:'recovered'});
  const after = Buffer.from(store.readExecutionBytes(id, 0, 100000).base64,'base64');
  assert.deepEqual(after.subarray(0,before.length), before);
  assert.equal(JSON.parse(after.toString().trim().split('\n').at(-1)).event, 'recovered');
});

test('persistence failure reports the exact fault through the remaining log sinks', () => {
  const lines = [];
  const previous = console.error;
  console.error = line => lines.push(line);
  try {
    recorder({appendExecution(){throw new Error('disk full /tmp/owner token=example');},appendLogLine(id,line){lines.push(line);}},'t-disk')('output',{base64:'YQ=='});
    assert.equal(lines.length,2);
    assert.ok(lines.every(line => line.includes('disk full /tmp/owner token=example')));
  } finally { console.error = previous; }
});


test('synchronous command output and failure diagnostics remain complete', () => {
  const id = 't-sync';
  withExecution(recorder(store,id), () => {
    assert.throws(() => execFileSync(process.execPath, ['-e', "require('fs').writeFileSync(1,'token=full');require('fs').writeFileSync(2,'/tmp/failure\\nstack');process.exit(7)"], {encoding:'utf8',stdio:'pipe'}), error => error.status === 7 && error.stdout === 'token=full');
  });
  const success = withExecution(recorder(store,'t-sync-success'), () => execFileSync(process.execPath, ['-e', "require('fs').writeFileSync(1,'ok');require('fs').writeFileSync(2,'successful stderr')"], {encoding:'utf8'}));
  assert.equal(success, 'ok');
  assert.equal(output('t-sync-success','stderr').toString(), 'successful stderr');
  assert.equal(output(id,'stdout').toString(),'token=full');
  assert.equal(output(id,'stderr').toString(),'/tmp/failure\nstack');
  assert.equal(events(id).at(-1).exitCode,7);
});
