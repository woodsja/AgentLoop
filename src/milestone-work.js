const fs = require('node:fs');
const path = require('node:path');
const { currentTime } = require('./milestone-clock');
// Fast canonical read for cooperative cancellation. Full GitHub-backed admission
// still runs before every attempt and merge. This never invents a terminal result.
function checkCurrent(authorization, options = {}) {
  if (!authorization) return;
  const state = options.stateDir || process.env.AGENTLOOP_STATE_DIR || path.join(__dirname, '../state');
  const g = JSON.parse(fs.readFileSync(path.join(state, 'milestone-grants.json'), 'utf8')).grants[authorization.grantId];
  const r = Object.values(g?.receipts || {}).find(r => r.id === authorization.receiptId);
  if (!g || g.state !== 'active' || g.digest !== authorization.grantDigest || !require('./milestone-tickets').grantIntegrity(g)
    || !r || r.revision !== g.revision || r.grantDigest !== g.digest || r.request.ticketDigest !== authorization.ticketDigest
    || !Number.isFinite(Date.parse(g.expiresAt)) || Date.parse(g.expiresAt) <= currentTime(state)) {
    throw new Error(`Canonical milestone authorization changed (${g?.state || 'missing'}, revision ${g?.revision || 'missing'}).`);
  }
}
async function runAuthorizedWork(service, cwd, task, { authorization, options, record = () => {}, authorize, onInterruptedResult, intervalMs = 250 } = {}) {
  await authorize();
  let blocked, timer;
  const writeRecord = (event, details) => {
    try { record(event, details); }
    catch (error) { blocked ||= new Error(`Execution evidence persistence failed: ${error.message}`, { cause: error }); }
  };
  const check = () => {
    if (blocked) return;
    try { checkCurrent(authorization, options); }
    catch (error) {
      blocked = error;
      let outcome;
      try { outcome = typeof service.cancel === 'function' ? service.cancel(error.message) : { requested: false, reason: 'Service has no cooperative cancellation interface; waiting for its actual result.' }; }
      catch (e) { outcome = { requested: false, reason: e.message }; }
      writeRecord('milestone_cancellation', { reason: error.message, outcome });
    }
  };
  check();
  if (blocked) await authorize();
  if (!blocked && authorization) timer = setInterval(check, intervalMs);
  try {
    const result = await service.run(cwd, task);
    // The actual result is retained before denying any subsequent delivery.
    writeRecord('milestone_work_result', { result });
    if (blocked) { onInterruptedResult?.(result); throw blocked; }
    return result;
  } catch (error) {
    writeRecord('milestone_work_error', { message: error.message, stack: error.stack, cancellationRequested: !!blocked });
    if (blocked) {
      const denial = new Error(`Milestone authorization blocked: ${blocked.message}`, { cause: error });
      denial.code = 'MILESTONE_AUTHORIZATION_BLOCKED'; denial.decision = 'DENY';
      throw denial;
    }
    throw error;
  } finally { clearInterval(timer); }
}
module.exports = { checkCurrent, runAuthorizedWork };
