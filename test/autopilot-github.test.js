'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverReadyIssues, selectReadyIssue } = require('../src/autopilot-github');

function ghResponse(stdout, error = null, stderr = '') {
  return (file, args, options, callback) => {
    assert.equal(file, 'gh');
    assert.deepEqual(args, ['issue', 'list', '--repo', 'example/repo', '--state', 'open', '--label', 'ready', '--json', 'number,title,state', '--limit', '1000']);
    assert.equal(options.shell, false);
    callback(error, stdout, stderr);
    return {};
  };
}

test('discovers and normalizes ready issues in oldest issue-number order', async () => {
  const issues = await discoverReadyIssues({ repo: 'example/repo', readyLabel: 'ready' }, {
    execFile: ghResponse(JSON.stringify([{ number: 12, title: 'Later', state: 'OPEN' }, { number: 3, title: 'First', state: 'OPEN' }])),
  });
  assert.deepEqual(issues, [{ number: 3, title: 'First' }, { number: 12, title: 'Later' }]);
  assert.deepEqual(selectReadyIssue(issues), { number: 3, title: 'First' });
});

test('fails closed for gh errors, malformed JSON, and unexpected response shapes', async () => {
  await assert.rejects(discoverReadyIssues({ repo: 'example/repo', readyLabel: 'ready' }, { execFile: ghResponse('', new Error('failed'), 'not authenticated') }), /unsuccessfully/);
  await assert.rejects(discoverReadyIssues({ repo: 'example/repo', readyLabel: 'ready' }, { execFile: ghResponse('{bad') }), /malformed JSON/);
  await assert.rejects(discoverReadyIssues({ repo: 'example/repo', readyLabel: 'ready' }, { execFile: ghResponse(JSON.stringify({ number: 1 })) }), /unexpected response shape/);
  await assert.rejects(discoverReadyIssues({ repo: 'example/repo', readyLabel: 'ready' }, { execFile: ghResponse(JSON.stringify([{ number: 1, title: 'bad', state: 'CLOSED' }])) }), /unexpected issue shape/);
});
