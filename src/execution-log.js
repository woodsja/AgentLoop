// Durable owner records use the existing state/logs facility. Buffers are stored
// as base64 so split UTF-8, CRLF, NUL and terminal controls remain reversible.
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { execFile: nativeExecFile, execFileSync: nativeExecFileSync, spawnSync: nativeSpawnSync } = require('node:child_process');
const executionContext = new AsyncLocalStorage();

function recorder(store, id, metadata = {}) {
  return (event, details = {}) => {
    if (typeof store.appendExecution !== 'function') return;
    try { store.appendExecution(id, { ...metadata, ...details, event }); }
    catch (error) {
      const message = `Execution log persistence failed for ${id}: ${error.stack || error.message}`;
      console.error(message);
      try { store.appendLogLine(id, message); } catch { /* stderr remains the last available sink */ }
    }
  };
}

function captureProcess(spawnImpl, file, args, options, record) {
  const commandId = crypto.randomUUID();
  const emit = (event, details) => record(event, { commandId, ...details });
  emit('command', { command: file, args, cwd: options.cwd });
  emit('capabilities', { internalReasoning: 'Only CLI-exported events are available; non-exported model thoughts are unavailable.' });
  let child;
  try { child = spawnImpl(file, args, options); }
  catch (error) { emit('exception', { name: error.name, message: error.message, stack: error.stack, code: error.code }); throw error; }
  for (const stream of ['stdout', 'stderr']) {
    child[stream]?.on('data', chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (let offset = 0; offset < bytes.length; offset += 16384) {
        emit('output', { stream, base64: bytes.subarray(offset, offset + 16384).toString('base64') });
      }
    });
  }
  child.once('error', error => emit('exception', { name: error.name, message: error.message, stack: error.stack, code: error.code }));
  child.once('close', (exitCode, signal) => emit('exit', { exitCode, signal }));
  return child;
}

// Context follows asynchronous calls within one queue job, never another job.
// Capture native command pipes before adapters reduce them to diagnostics.
function execFile(file, args, options, callback) {
  const record = executionContext.getStore();
  if (!record) return nativeExecFile(file, args, options, callback);
  return captureProcess((command, argv, opts) => nativeExecFile(command, argv, { ...opts, encoding: 'buffer' }, (error, stdout, stderr) => {
    const decode = value => opts.encoding === 'buffer' || opts.encoding === null ? value : value?.toString(opts.encoding || 'utf8');
    callback(error, decode(stdout), decode(stderr));
  }), file, args, options, record);
}
function execFileSync(file, args, options = {}) {
  const record = executionContext.getStore();
  if (!record) return nativeExecFileSync(file, args, options);
  const commandId = crypto.randomUUID();
  const emit = (event, details) => record(event, { commandId, ...details });
  const capture = (stream, value) => {
    if (value == null) return;
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    for (let offset = 0; offset < bytes.length; offset += 16384) emit('output', { stream, base64: bytes.subarray(offset, offset + 16384).toString('base64') });
  };
  const decode = value => options.encoding && options.encoding !== 'buffer' ? value?.toString(options.encoding) : value;
  emit('command', { command: file, args, cwd: options.cwd });
  const result = nativeSpawnSync(file, args, { ...options, encoding: 'buffer' });
  capture('stdout', result.stdout);
  capture('stderr', result.stderr);
  if (result.error || result.status !== 0) {
    const error = result.error || new Error(`Command failed: ${file} ${args.join(' ')}\n${result.stderr?.toString('utf8') || ''}`);
    Object.assign(error, { status: result.status, signal: result.signal, pid: result.pid,
      stdout: decode(result.stdout), stderr: decode(result.stderr), output: result.output?.map(decode) });
    emit('exception', { name: error.name, message: error.message, stack: error.stack, code: error.code });
    emit('exit', { exitCode: result.status, signal: result.signal });
    throw error;
  }
  emit('exit', { exitCode: result.status, signal: result.signal });
  return decode(result.stdout);
}
function withExecution(record, run) { return executionContext.run(record, run); }
module.exports = { recorder, captureProcess, execFile, execFileSync, withExecution };
