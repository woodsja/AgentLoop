'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTime, terminatePriorR1Worker } = require('../src/r1-process-claim');

test('Linux process identity includes a stable start-time fingerprint', { skip: process.platform !== 'linux' }, () => {
  const first = startTime(process.pid);
  assert.match(first, /^\d+$/);
  assert.equal(startTime(process.pid), first);
});

test('unclaimed process remains ambiguous and must block restart', () => {
  assert.equal(terminatePriorR1Worker({ r1Child: { parentJobId: 't-abc' } }), false);
});

test('a known vanished process group can be safely recovered', { skip: process.platform !== 'linux' }, () => {
  assert.equal(terminatePriorR1Worker({ r1Child: { parentJobId: 't-abc' },
    workerPid: 99999999, workerStartTime: '111' }), true);
});

test('normal unowned tasks are unaffected by R1 process safety gate', () => {
  assert.equal(terminatePriorR1Worker({ type: 'loop' }), true);
});
