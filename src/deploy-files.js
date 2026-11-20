'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function insist(ok, message) { if (!ok) throw new Error(`Deployment refused: ${message}`); }
function canonicalAbsolute(file) {
  insist(typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file, 'canonical absolute path required');
  return file;
}
function directory(root) {
  root = path.resolve(root);
  let current = path.parse(root).root;
  for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    insist(stat.isDirectory() && !stat.isSymbolicLink(), `unsafe directory ${current}`);
  }
  return root;
}
function regular(file) {
  directory(path.dirname(file));
  const stat = fs.lstatSync(file);
  insist(stat.isFile() && stat.nlink === 1 && !stat.isSymbolicLink(), `unsafe file ${file}`);
}
function sync(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function atomic(file, value) {
  directory(path.dirname(file));
  if (fs.lstatSync(file, { throwIfNoEntry: false })) regular(file);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file); sync(path.dirname(file));
}
const INVENTORY_MAX_ENTRIES = 50000;
function inventoryCapacity(count, reserve = 0) {
  insist(Number.isSafeInteger(count) && count >= 0 && Number.isSafeInteger(reserve) && reserve >= 0
    && count + reserve <= INVENTORY_MAX_ENTRIES, 'inventory work budget exceeded');
}
// Count the materialized private tree before npm, including root, directories,
// loose objects and metadata. Do not follow links or hash all the object bytes.
function inventoryEntryCount(root, reserve = 0) {
  directory(root);
  let count = 0;
  const deadline = Date.now() + 30000;
  function walk(relative) {
    inventoryCapacity(++count, reserve);
    insist(relative.split(path.sep).length < 64 && Date.now() < deadline, 'inventory work budget exceeded');
    const file = path.join(root, relative);
    if (fs.lstatSync(file).isDirectory()) {
      for (const name of fs.readdirSync(file)) walk(path.join(relative, name));
    }
  }
  walk('');
  return count;
}
// Includes ignored files, executable bits and private Git metadata. Relative
// internal links (npm bin links) remain valid when the directory is renamed.
function inventory(root) {
  directory(root);
  const entries = [];
  let total = 0, count = 0;
  const deadline = Date.now() + 30000;
  const buffer = Buffer.alloc(1024 * 1024);
  function walk(relative) {
    inventoryCapacity(++count);
    insist(relative.split(path.sep).length < 64 && Date.now() < deadline, 'inventory work budget exceeded');
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      entries.push([relative, 'directory', stat.mode & 0o777]);
      for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name));
    } else if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      const resolved = fs.realpathSync(file);
      insist(!path.isAbsolute(target) && resolved.startsWith(root + path.sep), 'unsafe installer symlink');
      entries.push([relative, 'link', target]);
    } else {
      regular(file);
      total += stat.size;
      insist(total <= 512 * 1024 * 1024, 'inventory byte budget exceeded');
      const digest = crypto.createHash('sha256');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) {
        insist(Date.now() < deadline, 'inventory time budget exceeded'); digest.update(buffer.subarray(0, size));
      } } finally { fs.closeSync(fd); }
      entries.push([relative, 'file', stat.mode & 0o777, digest.digest('hex')]);
    }
  }
  walk('');
  return hash(JSON.stringify(entries));
}
module.exports = { canonicalAbsolute, hash, insist, directory, regular, sync, atomic, inventory, inventoryEntryCount, inventoryCapacity, INVENTORY_MAX_ENTRIES };
