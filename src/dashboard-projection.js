// Disposable navigation sidecars. Canonical files remain the only execution
// input. A crash between the two atomic writes is repaired on the next read.
const fs = require('node:fs');
const path = require('node:path');
const { preview } = require('./execution-preview');
const VERSION = 2;

function signature(file) {
  const stat = fs.statSync(file, { bigint: true });
  return [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function createDashboardProjection(directory, writeJson) {
  const projectionPath = file => path.join(directory, path.basename(file));
  const memory = new Map();
  function remember(file, entry) {
    if (!memory.has(file) && memory.size >= 256) memory.delete(memory.keys().next().value);
    memory.set(file, entry);
    return entry.value;
  }
  function save(file, value) {
    const projected = preview(value);
    try {
      const entry = { version: VERSION, source: signature(file), value: projected };
      remember(file, entry);
      writeJson(projectionPath(file), entry);
    } catch (error) {
      // Canonical persistence already succeeded. A disposable cache must never
      // fail an execution checkpoint; memory also avoids reparsing on each poll.
      console.error(`Dashboard projection write failed for ${file}: ${error.stack || error.message}`);
    }
    return projected;
  }
  function read(file, { optional = false } = {}) {
    let source;
    try {
      source = signature(file);
      if (memory.get(file)?.source === source) return memory.get(file).value;
      try {
        const cached = JSON.parse(fs.readFileSync(projectionPath(file), 'utf8'));
        if (cached?.version === VERSION && cached.source === source && cached.value && typeof cached.value === 'object' && !Array.isArray(cached.value)) {
          return remember(file, cached);
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
          console.error(`Dashboard projection read failed for ${file}: ${error.stack || error.message}`);
        }
      }
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Canonical state must be an object');
      return save(file, value);
    } catch (error) {
      // A result is optional for older tasks and for a crash between task
      // completion and result persistence. Preserve the task's own status.
      if (optional && source === undefined && error.code === 'ENOENT') return null;
      console.error(`Cannot project canonical state ${file}: ${error.stack || error.message}`);
      // Keep damaged owner data untouched and visible as an error. This is
      // navigation only: canonical execution reads still throw and fail closed.
      const id = path.basename(file, '.json');
      return remember(file, { source, value: { id, type: 'task', status: 'unreadable', unreadable: true,
        summary: error.message, executionJournal: { id, raw: `/api/log/${encodeURIComponent(id)}?raw=1` } } });
    }
  }
  return { read, save };
}

module.exports = { createDashboardProjection };
