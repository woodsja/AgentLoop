// Writes reach the kernel immediately. Disk barriers are scheduled in batches every
// 100ms; terminal records and orderly process exit synchronously drain barriers.
// SIGKILL retains written bytes; power loss can lose the current 100ms window.
const fs = require('node:fs');
const path = require('node:path');
const writers = new Map();
const terminal = new Set(['exit', 'exception', 'recovery', 'close']);
function flush(file) {
  const writer = writers.get(file);
  if (!writer) return;
  clearTimeout(writer.timer);
  fs.fsyncSync(writer.fd);
  fs.closeSync(writer.fd);
  writers.delete(file);
}
function append(file, record) {
  let writer = writers.get(file);
  if (!writer) {
    if (writers.size >= 64) flush(writers.keys().next().value);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existed = fs.existsSync(file);
    const fd = fs.openSync(file, 'a+', 0o600);
    writer = { fd, version: 0, timer: null };
    writers.set(file, writer);
    const size = fs.fstatSync(fd).size;
    if (size) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 10) fs.writeSync(fd, '\n');
    }
    if (!existed && process.platform !== 'win32') {
      for (const directory of [path.dirname(file), path.dirname(path.dirname(file))]) {
        const dir = fs.openSync(directory, 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
    }
  }
  const offset = writer.size ?? fs.fstatSync(writer.fd).size;
  const bytes = Buffer.from(JSON.stringify(record) + '\n');
  let written = 0;
  while (written < bytes.length) written += fs.writeSync(writer.fd, bytes, written, bytes.length - written);
  writer.size = offset + bytes.length;
  writer.version++;
  if (terminal.has(record.event)) flush(file);
  else if (!writer.timer) {
    const schedule = () => {
      writer.timer = setTimeout(() => {
        const version = writer.version;
        // A separate descriptor lets a simultaneous terminal flush close the
        // writer safely while this asynchronous disk barrier is in flight.
        let syncFd;
        try { syncFd = fs.openSync(file, 'r+'); }
        catch (error) {
          if (error.code === 'ENOENT') { flush(file); return; } // explicit log cleanup
          console.error(`Execution journal flush failed for ${file}: ${error.stack}`);
          schedule();
          return;
        }
        fs.fsync(syncFd, error => {
          fs.closeSync(syncFd);
          if (writers.get(file) !== writer) return;
          if (error) { console.error(`Execution journal flush failed for ${file}: ${error.stack}`); writer.timer = null; schedule(); return; }
          if (version !== writer.version) { schedule(); return; }
          fs.closeSync(writer.fd);
          writers.delete(file);
        });
      }, 100);
      writer.timer.unref();
    };
    schedule();
  }
  return offset;
}
function flushAll() { for (const file of writers.keys()) flush(file); }
process.on('exit', flushAll);
module.exports = { append, flush, flushAll };
