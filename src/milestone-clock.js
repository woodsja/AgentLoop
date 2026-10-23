// Authorization uses system time, never the scheduler/job-store clock. Preserve
// its greatest observation across restarts so clock rollback cannot renew a grant.
const fs = require('node:fs');
const path = require('node:path');
const observed = new Map();
function currentTime(state) {
  fs.mkdirSync(state, { recursive: true });
  const file = path.resolve(state, 'milestone-clock.ndjson');
  const fd = fs.openSync(file, 'a+', 0o600);
  let greatest;
  try {
    const stat = fs.fstatSync(fd);
    const cached = observed.get(file);
    // Only cache the already consumed prefix. Concurrent appenders' records
    // are always read before making a decision; appends never replace evidence.
    const prefix = cached && cached.ino === stat.ino && cached.dev === stat.dev && stat.size >= cached.offset
      ? cached : { offset: 0, greatest: 0 };
    const bytes = Buffer.alloc(stat.size - prefix.offset);
    fs.readSync(fd, bytes, 0, bytes.length, prefix.offset);
    greatest = Math.max(Date.now(), prefix.greatest);
    if (bytes.length && bytes.at(-1) !== 10) throw new Error('Incomplete durable authorization clock; reconcile before execution.');
    for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
      const value = Number(line);
      if (!/^\d+$/.test(line) || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid durable authorization clock; reconcile before execution.');
      greatest = Math.max(greatest, value);
    }
    fs.writeSync(fd, `${greatest}\n`); fs.fsyncSync(fd);
    // Do not skip concurrent appenders' data between the read and our append.
    observed.set(file, { ino: stat.ino, dev: stat.dev, offset: stat.size, greatest });
  } finally { fs.closeSync(fd); }
  const dir = fs.openSync(state, 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  return greatest;
}
module.exports = { currentTime };
