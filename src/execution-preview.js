const crypto = require('node:crypto');
// Navigation only. Never use this preview as canonical execution state.
// Hashes, rather than previous output copies, bound the journal diff cache.
const diagnosticFields = new Set(['r1', 'stdout', 'stderr', 'output', 'summary', 'diagnostics', 'message', 'stack', 'exception', 'verification', 'rawResult', 'findings', 'failure', 'lastError', 'result', 'details', 'lastActivity', 'reason', 'error', 'fixes', 'workerSummary', 'criticSummary', 'checkpointError']);
function preview(value, budget = { remaining: 65536 }, bounded = false) {
  if (typeof value === 'string') {
    if (!bounded || value.length <= 256) return value;
    const limit = Math.max(0, Math.min(4096, budget.remaining));
    budget.remaining -= Math.min(value.length, limit);
    return value.length > limit ? value.slice(0, limit) + '\n[Preview limited; complete value in execution journal]' : value;
  }
  if (Array.isArray(value)) return (bounded ? value.slice(0, 50) : value).map(item => preview(item, budget, bounded));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, preview(item, budget, bounded || diagnosticFields.has(key))]));
  return value;
}
function snapshotter() {
  const hashes = new Map();
  return (key, value, append) => {
    const previous = hashes.get(key) || {};
    const next = {};
    const changes = {};
    for (const [field, item] of Object.entries(value)) {
      if (field === 'executionJournal') continue;
      const serialized = JSON.stringify(item);
      if (serialized === undefined) continue;
      next[field] = crypto.createHash('sha256').update(serialized).digest('hex');
      if (previous[field] !== next[field]) changes[field] = item;
    }
    const removed = Object.keys(previous).filter(field => !(field in next));
    if (Object.keys(changes).length || removed.length) {
      // Throw on failure: a preview must never replace the sole complete record.
      append({ event: 'evidence', changes, removed });
      if (!hashes.has(key) && hashes.size >= 256) hashes.delete(hashes.keys().next().value);
      hashes.set(key, next);
    }
    return preview(value);
  };
}
module.exports = { preview, snapshotter };
