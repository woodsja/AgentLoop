// Disposable navigation sidecars. Canonical files remain the only execution
// input. A crash between the two atomic writes is repaired on the next read.
const fs = require('node:fs');
const path = require('node:path');
const { preview } = require('./execution-preview');

function signature(file) {
  const stat = fs.statSync(file, { bigint: true });
  return [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function createDashboardProjection(directory, writeJson) {
  const projectionPath = file => path.join(directory, path.basename(file));
  function save(file, value) {
    const projected = preview(value);
    writeJson(projectionPath(file), { source: signature(file), value: projected });
    return projected;
  }
  function read(file) {
    const source = signature(file);
    try {
      const cached = JSON.parse(fs.readFileSync(projectionPath(file), 'utf8'));
      if (cached.source === source) return cached.value;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return save(file, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return { read, save };
}

module.exports = { createDashboardProjection };
