'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recoverBlockedChild } = require('../src/r1-child-recover');
const id = 't-0123456789abcdef01234567';
function fixture() {
  const child = { id, source: 'r1', type: 'loop', recoveryBlocked: true, status: 'running',
    r1Child: { parentJobId: 't-12345678', attempt: 1, issue: 5 } };
  const called = [];
  const store = { isAlive: () => false, readTask: () => ({ ...child }),
    listR1ChildLoops: () => [{ id, stage: 'running', task: child }],
    appendEvent: (...args) => called.push(['event', ...args]),
    appendLogLine: (...args) => called.push(['log', ...args]),
    writeTask: (...args) => called.push(['write', ...args]),
    moveTask: (...args) => called.push(['move', ...args]),
    writeResult: (...args) => called.push(['result', ...args]) };
  return { store, child, called };
}
test('offline confirmed R1 recovery is audited and fails the child terminal', () => {
  const f = fixture();
  const result = recoverBlockedChild(f.store, id, true);
  assert.equal(result.status, 'failed');
  assert.equal(f.called[0][0], 'event');
  assert.equal(f.called[2][0], 'write');
  assert.equal(f.called[2][1].reason, 'operator_confirmed_child_stopped');
  assert.equal(f.called[3][0], 'move');
});
test('an unconfirmed request or running daemon cannot release child', () => {
  const f = fixture();
  assert.throws(() => recoverBlockedChild(f.store, id, false), /confirm-stopped/);
  f.store.isAlive = () => true;
  assert.throws(() => recoverBlockedChild(f.store, id, true), /Stop the AgentLoop daemon/);
  assert.deepEqual(f.called, []);
});
test('operator cannot release an unrelated loop or a mismatched reservation', () => {
  const f = fixture();
  f.store.readTask = () => ({ ...f.child, recoveryBlocked: false });
  assert.throws(() => recoverBlockedChild(f.store, id, true), /recovery-blocked/);
  f.store.readTask = () => f.child;
  f.store.listR1ChildLoops = () => [];
  assert.throws(() => recoverBlockedChild(f.store, id, true), /reservation/);
  assert.deepEqual(f.called, []);
});
