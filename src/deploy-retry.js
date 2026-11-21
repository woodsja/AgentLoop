'use strict';
const fs = require('node:fs'), path = require('node:path');
const { hash, insist, regular, canonicalAbsolute } = require('./deploy-files');
function approval(file, identity) {
  canonicalAbsolute(file);
  regular(file); const bytes = fs.readFileSync(file), a = JSON.parse(bytes);
  insist(path.isAbsolute(file) && a.contract === 'step14-retry-v1' && a.ownerApproved === true
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(a.attemptId), 'explicit owner retry approval required');
  for (const key of ['oldSha','newSha','sourceCheckout','installedCheckout','evidenceHash']) insist(a[key] === identity[key], 'retry identity mismatch');
  canonicalAbsolute(a.priorCheckpoint);
  insist(path.dirname(path.dirname(a.priorCheckpoint)) === identity.root && path.basename(a.priorCheckpoint) === 'checkpoint.json', 'retry prior location mismatch');
  regular(a.priorCheckpoint);
  const prior = JSON.parse(fs.readFileSync(a.priorCheckpoint));
  const journalFile = path.join(path.dirname(a.priorCheckpoint), 'update.json'); regular(journalFile);
  const journalBytes = fs.readFileSync(journalFile), j = JSON.parse(journalBytes);
  insist(['FAILED','ROLLED_BACK'].includes(j.phase) && hash(journalBytes) === a.priorJournalHash
    && j.receiptHash === hash(fs.readFileSync(a.priorCheckpoint)), 'retry requires sealed terminal journal');
  for (const key of ['oldSha','newSha','sourceCheckout','installedCheckout','evidenceHash']) insist(prior[key] === a[key], 'retry prior identity mismatch');
  insist(file !== a.priorCheckpoint && !file.startsWith(identity.installedCheckout + path.sep)
    && !file.startsWith(identity.sourceCheckout + path.sep), 'external retry approval required');
  return { attemptId: a.attemptId, approvalFile: file, approvalHash: hash(bytes) };
}
module.exports = { approval };
