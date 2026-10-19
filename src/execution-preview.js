const crypto = require('node:crypto');
// Navigation only. Never use this preview as canonical execution state.
// Hashes, rather than previous output copies, bound the journal diff cache.
const LIMITED = '[Preview limited; complete value in execution journal]';
// Admission shares these projections. Reserve navigation fields before large
// diagnostics, regardless of the insertion order in a canonical checkpoint.
const navigation = new Set(['id', 'type', 'workflow', 'status', 'phase', 'project', 'r1Child',
  'priority', 'createdAt', 'startedAt', 'updatedAt', 'finishedAt', 'engine', 'workerEngine',
  'criticEngine', 'executionJournal']);
function preview(value, budget = { remaining: 65536, nodes: 2048 }, depth = 0) {
  // Charge short strings, keys and containers too: thousands of short findings
  // or an unfamiliar output field must not bypass the shared preview budget.
  if (budget.remaining < 64 || budget.nodes-- <= 0 || depth > 32) return LIMITED;
  budget.remaining -= 16;
  if (typeof value === 'string') {
    const limit = Math.max(0, Math.min(4096, budget.remaining));
    budget.remaining -= Math.min(value.length, limit);
    return value.length > limit ? value.slice(0, limit) + '\n' + LIMITED : value;
  }
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value) {
      if (result.length >= 50 || budget.remaining < 64 || budget.nodes <= 0) { result.push(LIMITED); break; }
      result.push(preview(item, budget, depth + 1));
    }
    return result;
  }
  if (value && typeof value === 'object') {
    const result = {};
    const keys = Object.keys(value);
    if (depth === 0) keys.sort((a, b) => Number(navigation.has(b)) - Number(navigation.has(a)));
    for (const key of keys) {
      if (budget.remaining < key.length + 64 || budget.nodes <= 0) {
        Object.defineProperty(result, '_preview', { value: LIMITED, enumerable: true });
        break;
      }
      budget.remaining -= key.length;
      Object.defineProperty(result, key, { value: preview(value[key], budget, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  return value;
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Hash leaves rather than containers so status changes do not re-journal all
// nested R1 output. Arrays remain atomic ordered evidence values.
function evidenceTree(value) {
  if (object(value)) return { children: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evidenceTree(item)])) };
  const serialized = JSON.stringify(value);
  return { hash: crypto.createHash('sha256').update(serialized ?? 'undefined').digest('hex') };
}
function diff(value, next, previous, path, removedPaths) {
  if (!previous || !next.children || !previous.children) return next.hash && next.hash === previous?.hash ? undefined : value;
  const changes = {};
  for (const key of Object.keys(previous.children)) {
    if (!Object.hasOwn(next.children, key)) removedPaths.push([...path, key]);
  }
  for (const [key, child] of Object.entries(next.children)) {
    const changed = diff(value[key], child, previous.children[key], [...path, key], removedPaths);
    if (changed !== undefined) Object.defineProperty(changes, key, { value: changed, enumerable: true });
  }
  return Object.keys(changes).length ? changes : undefined;
}
function snapshotter() {
  const hashes = new Map();
  return (key, value, append) => {
    const evidence = Object.fromEntries(Object.entries(value).filter(([field, item]) => field !== 'executionJournal' && item !== undefined));
    const next = evidenceTree(evidence);
    const removedPaths = [];
    const changes = diff(evidence, next, hashes.get(key), [], removedPaths);
    if (changes !== undefined || removedPaths.length) {
      // Throw on failure: a preview must never replace the sole complete record.
      append({ event: 'evidence', format: 'nested-merge-v1', changes: changes || {},
        removed: removedPaths.filter(path => path.length === 1).map(path => path[0]), removedPaths });
      if (!hashes.has(key) && hashes.size >= 256) hashes.delete(hashes.keys().next().value);
      hashes.set(key, next);
    }
    return preview(value);
  };
}
module.exports = { preview, snapshotter };
