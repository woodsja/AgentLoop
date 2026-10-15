'use strict';

// Explicit offline operator recovery for an R1 child whose old process group
// cannot be proven stopped. Never expose this override through HTTP or MCP.
function recoverBlockedChild(store, id, confirmStopped) {
  if (!/^t-[a-f0-9]{24}$/.test(id || '')) throw new Error('A valid R1 child ID is required.');
  if (confirmStopped !== true) throw new Error('Explicit --confirm-stopped is required.');
  if (store.isAlive()) throw new Error('Stop the AgentLoop daemon before offline R1 child recovery.');

  const child = store.readTask(id, 'running');
  if (child.id !== id || child.type !== 'loop' || child.source !== 'r1'
    || !child.r1Child?.parentJobId || child.recoveryBlocked !== true) {
    throw new Error('Only a previously recovery-blocked R1 child can be released.');
  }
  const reservation = store.listR1ChildLoops(child.r1Child.parentJobId)
    .filter(entry => entry.id === id && entry.stage === 'running');
  if (reservation.length !== 1) throw new Error('R1 child reservation does not match the blocked queue record.');

  const now = new Date().toISOString();
  const recovered = { ...child, status: 'failed', finishedAt: now,
    reason: 'operator_confirmed_child_stopped', recoveryBlocked: false,
    summary: 'Operator confirmed old R1 agent processes stopped before offline recovery.' };
  // Write the audit record before changing the queue stage. If the write
  // fails, the child remains blocked; on retry the operator can confirm again.
  const audit = store.appendEvent('r1_child_operator_recovery', { id, parentJobId: child.r1Child.parentJobId,
    reason: 'operator_confirmed_stopped', at: now });
  if (!audit) throw new Error('R1 child recovery refused: durable audit event could not be written.');
  store.appendLogLine(id, `Operator confirmed R1 child processes stopped at ${now}; fail-closing prior attempt.`);
  store.writeTask(recovered, 'running');
  store.moveTask(id, 'running', 'done');
  store.writeResult({ id, status: 'failed', reason: recovered.reason, finishedAt: now, summary: recovered.summary });
  return { id, status: 'failed', reason: recovered.reason };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || args[0] !== '--id' || args[2] !== '--confirm-stopped') {
      throw new Error('Usage: node src/r1-child-recover.js --id t-<24hex> --confirm-stopped');
    }
    const store = require('./store');
    process.stdout.write(`${JSON.stringify(recoverBlockedChild(store, args[1], true))}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { recoverBlockedChild };
