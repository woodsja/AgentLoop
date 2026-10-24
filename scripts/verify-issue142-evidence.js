'use strict';
// Read-only recovery audit. --live also compares retained operator files; never
// repairs history, writes state, calls GitHub or changes admission authority.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function verifyRecovery(root, { live = false } = {}) {
  const read = file => fs.readFileSync(path.join(root, file));
  const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 17 * 1024 * 1024 });
  const check = (ok, message) => { if (!ok) throw new Error(`Recovery integrity: ${message}`); };
  const manifest = JSON.parse(read('docs/evidence/review/manifest.json'));
  const provenance = JSON.parse(read('docs/evidence/issue-142/provenance.json'));
  git('merge-base', '--is-ancestor', provenance.intendedBase, provenance.correctedCommit);
  git('merge-base', '--is-ancestor', provenance.correctedCommit, 'HEAD');
  git('merge-base', '--is-ancestor', provenance.deployedBase, 'HEAD');
  for (const entry of manifest.entries) {
    const compressed = read(entry.archive), original = git('show', `${entry.sourceCommit}:${entry.original}`);
    const restored = gunzipSync(compressed, { maxOutputLength: 16 * 1024 * 1024 });
    check(restored.equals(original), entry.original + ' roundtrip');
    check(restored.length === entry.bytes && digest(restored) === entry.sha256 && digest(compressed) === entry.gzip_sha256, entry.original + ' digest/length');
    check(!fs.existsSync(path.join(root, entry.original)), entry.original + ' must be represented only once at head');
  }
  for (const entry of provenance.entries) {
    const packaged = manifest.entries.find(e => e.original === entry.original);
    check(packaged && packaged.bytes === entry.bytes && packaged.sha256 === entry.sha256, entry.original + ' snapshot lineage');
    if (live && path.isAbsolute(entry.source)) {
      const bytes = fs.readFileSync(entry.source);
      check(bytes.length === entry.bytes && digest(bytes) === entry.sha256, entry.source + ' changed since snapshot');
    }
  }
  if (live) for (const entry of provenance.protected) {
    const bytes = fs.readFileSync(entry.source);
    check(bytes.length === entry.bytes && digest(bytes) === entry.sha256, entry.source + ' protected history/settings changed');
  }
  let sourceFiles = 0;
  for (const [file, commit] of [['docs/evidence/issue-111/earlier-revision-9661ba4.sha256', '9661ba43033e761db512dc011326639372287951'], ['docs/evidence/issue-111/review-correction.sha256', provenance.correctedCommit], ['docs/evidence/issue-142/current-source.sha256', null]]) {
    for (const line of read(file).toString().trim().split('\n')) {
      const match = /^([a-f0-9]{64})  ([A-Za-z0-9_./-]+)$/.exec(line);
      check(match && !match[2].includes('..'), file + ' manifest syntax');
      const bytes = commit ? git('show', `${commit}:${match[2]}`) : read(match[2]);
      check(digest(bytes) === match[1], `${file}: ${match[2]} digest mismatch`);
      if (!commit) sourceFiles++;
    }
  }
  return { logs: manifest.entries.length, sourceFiles, liveFilesChecked: live };
}
if (require.main === module) console.log(JSON.stringify(verifyRecovery(path.resolve(__dirname, '..'), { live: process.argv.includes('--live') })));
module.exports = { verifyRecovery };
