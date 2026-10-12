'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  discoverReadyIssues,
  selectReadyIssue,
  observePullRequestCi,
  collectCiFailureDiagnostics,
} = require('../src/autopilot-github');

function ghResponse(stdout, error = null, stderr = '') {
  return (file, args, options, callback) => {
    assert.equal(file, 'gh');
    assert.deepEqual(args, ['issue', 'list', '--repo', 'example/repo', '--state', 'open', '--label', 'ready', '--json', 'number,title,body,state', '--limit', '1000']);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 60 * 1000);
    assert.equal(options.killSignal, 'SIGTERM');
    assert.equal(options.maxBuffer, 1024 * 1024);
    assert.equal(options.env.GH_PROMPT_DISABLED, '1');
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    callback(error, stdout, stderr);
    return {};
  };
}

function assertUnattendedGhOptions(options) {
  assert.equal(options.shell, false);
  assert.equal(options.timeout, 60 * 1000);
  assert.equal(options.killSignal, 'SIGTERM');
  assert.equal(options.env.GH_PROMPT_DISABLED, '1');
  assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
}

test('discovers and normalizes ready issues in oldest issue-number order', async () => {
  const issues = await discoverReadyIssues({ repo: 'example/repo', readyLabel: 'ready' }, {
    execFile: ghResponse(JSON.stringify([{ number: 12, title: 'Later', body: '', state: 'OPEN' }, { number: 3, title: 'First', body: 'Details', state: 'OPEN' }])),
  });
  assert.deepEqual(issues, [{ number: 3, title: 'First', body: 'Details' }, { number: 12, title: 'Later', body: '' }]);
  assert.deepEqual(selectReadyIssue(issues), { number: 3, title: 'First', body: 'Details' });
});

test('fails closed for gh errors, malformed JSON, and unexpected response shapes', async () => {
  await assert.rejects(discoverReadyIssues({ repo: 'example/repo', readyLabel: 'ready' }, { execFile: ghResponse('', new Error('failed'), 'not authenticated') }), /unsuccessfully/);
  await assert.rejects(discoverReadyIssues({ repo: 'example/repo', readyLabel: 'ready' }, { execFile: ghResponse('{bad') }), /malformed JSON/);
  await assert.rejects(discoverReadyIssues({ repo: 'example/repo', readyLabel: 'ready' }, { execFile: ghResponse(JSON.stringify({ number: 1 })) }), /unexpected response shape/);
  await assert.rejects(discoverReadyIssues({ repo: 'example/repo', readyLabel: 'ready' }, { execFile: ghResponse(JSON.stringify([{ number: 1, title: 'bad', body: '', state: 'CLOSED' }])) }), /unexpected issue shape/);
});

test('observes the persisted PR head through GitHub Actions and normalizes workflow states', async () => {
  const calls = [];
  const observe = async response => observePullRequestCi({ repo: 'example/repo', ciWorkflow: 'CI' }, { number: 42, commit: 'deadbeef' }, {
    execFile: (file, args, options, callback) => {
      calls.push([file, args, options]);
      callback(null, JSON.stringify(response), '');
    },
  });
  const base = { databaseId: 123, status: 'completed', conclusion: 'success', name: 'test', workflowName: 'CI', url: 'https://example/run/123', startedAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:01:00Z' };

  const green = await observe([base, { ...base, databaseId: 124, workflowName: 'Docs', conclusion: 'skipped' }]);
  assert.equal(green.state, 'green');
  assert.equal(green.prNumber, 42);
  assert.equal(green.headCommit, 'deadbeef');
  assert.deepEqual(green.runs.map(run => run.databaseId), [123, 124]);
  assert.match(green.details, /CI \(#123\): completed\/success/);
  assert.equal((await observe([{ ...base, status: 'in_progress', conclusion: null }])).state, 'pending');
  assert.equal((await observe([{ ...base, conclusion: 'failure' }])).state, 'red');
  assert.equal((await observe([])).state, 'pending');
  assert.equal((await observe([base, { ...base, databaseId: 125, workflowName: 'Lint', status: 'queued', conclusion: null }])).state, 'pending');
  // A newer run of the same workflow supersedes an earlier failure, and vice versa.
  const rerun = await observe([{ ...base, conclusion: 'failure' }, { ...base, databaseId: 130 }]);
  assert.equal(rerun.state, 'green');
  assert.deepEqual(rerun.runs.map(run => run.databaseId), [123, 130]);
  assert.equal((await observe([{ ...base, databaseId: 130, conclusion: 'failure' }, base])).state, 'red');
  assert.deepEqual(calls[0][0], 'gh');
  assert.deepEqual(calls[0][1], ['run', 'list', '--repo', 'example/repo', '--commit', 'deadbeef', '--json', 'databaseId,status,conclusion,name,workflowName,url,startedAt,updatedAt', '--limit', '100']);
  assertUnattendedGhOptions(calls[0][2]);
});

test('only a successful run of the required test workflow for the exact commit is green CI', async () => {
  const calls = [];
  const observe = (response, project = { repo: 'example/repo', ciWorkflow: 'CI' }) => observePullRequestCi(project, { number: 15, commit: 'efcb3d3' }, {
    execFile: (file, args, options, callback) => { calls.push(args); callback(null, JSON.stringify(response), ''); },
  });
  const test = { databaseId: 10, status: 'completed', conclusion: 'success', name: 'test', workflowName: 'CI', url: null, startedAt: null, updatedAt: null };
  const review = { ...test, databaseId: 11, name: 'claude-review', workflowName: 'Claude PR Review' };

  // Missing: no runs at all, or only an unrelated successful review workflow.
  assert.equal((await observe([])).state, 'pending');
  const unrelated = await observe([review]);
  assert.equal(unrelated.state, 'pending');
  assert.match(unrelated.details, /Required CI workflow "CI" has not run for efcb3d3\. Other runs: Claude PR Review \(#11\): completed\/success/);
  // Pending: queued or in progress, even beside a successful review.
  assert.equal((await observe([{ ...test, status: 'queued', conclusion: null }, review])).state, 'pending');
  assert.equal((await observe([{ ...test, status: 'in_progress', conclusion: null }])).state, 'pending');
  // Failed: any completed conclusion other than success is red.
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', 'action_required']) {
    assert.equal((await observe([{ ...test, conclusion }, review])).state, 'red', conclusion);
  }
  // Successful: the required workflow succeeded for the observed commit.
  assert.equal((await observe([test, review])).state, 'green');
  assert.equal((await observe([test])).state, 'green');
  assert.ok(calls.every(args => args[args.indexOf('--commit') + 1] === 'efcb3d3'));
  // No required workflow configured: fail closed without consulting GitHub.
  const before = calls.length;
  for (const project of [{ repo: 'example/repo' }, { repo: 'example/repo', ciWorkflow: ' ' }]) {
    const unconfigured = await observe([test, review], project);
    assert.equal(unconfigured.state, 'pending');
    assert.match(unconfigured.details, /No required CI workflow/);
  }
  assert.equal(calls.length, before);
});

test('CI observation rejects malformed Actions responses', async () => {
  const observe = stdout => observePullRequestCi({ repo: 'example/repo', ciWorkflow: 'CI' }, { number: 42, commit: 'deadbeef' }, {
    execFile: (file, args, options, callback) => callback(null, stdout, ''),
  });
  await assert.rejects(observe('{bad'), /malformed JSON/);
  await assert.rejects(observe(JSON.stringify({})), /unexpected response shape/);
  await assert.rejects(observe(JSON.stringify([{ databaseId: 1 }])), /unexpected workflow run shape/);
});

test('collects deterministic failed job and log diagnostics without re-running workflows', async () => {
  const calls = [];
  const run = { databaseId: 601, status: 'completed', conclusion: 'failure', name: 'test', workflowName: 'CI', url: 'https://example/run/601', startedAt: null, updatedAt: null };
  const observation = {
    state: 'red', details: 'CI (#601): completed/failure', prNumber: 42, headCommit: 'deadbeef',
    runs: [{ ...run, databaseId: 590 }, run, { ...run, databaseId: 602, workflowName: 'Lint', conclusion: 'success' }],
  };
  const jobs = JSON.stringify({ jobs: [
    { name: 'unit', conclusion: 'failure', steps: [{ name: 'checkout', conclusion: 'success' }, { name: 'npm test', conclusion: 'failure' }] },
    { name: 'build', conclusion: 'success', steps: [] },
  ] });
  const log = 'unit\tnpm test\t2026-10-03T00:00:01.1234567Z \u001b[31mnot ok 1 - ledger balances\u001b[0m\n';
  const collect = () => collectCiFailureDiagnostics({ repo: 'example/repo' }, observation, {
    execFile: (file, args, options, callback) => {
      calls.push([file, args]);
      assertUnattendedGhOptions(options);
      callback(null, args.includes('--log-failed') ? log : jobs, '');
    },
  });

  const diagnostics = await collect();
  assert.equal(diagnostics, await collect());
  assert.deepEqual(calls.slice(0, 2), [
    ['gh', ['run', 'view', '601', '--repo', 'example/repo', '--json', 'jobs']],
    ['gh', ['run', 'view', '601', '--repo', 'example/repo', '--log-failed']],
  ]);
  assert.equal(calls.length, 4);
  assert.equal(calls.some(([, args]) => args.includes('rerun')), false);
  assert.match(diagnostics, /CI red for commit deadbeef \(PR #42\)/);
  assert.match(diagnostics, /== CI \(#601\): failure https:\/\/example\/run\/601/);
  assert.match(diagnostics, /- job unit: failure; failed steps: npm test \(failure\)/);
  assert.match(diagnostics, /unit\tnpm test\tnot ok 1 - ledger balances/);
  assert.doesNotMatch(diagnostics, /build|2026-10-03T|\u001b/);

  const unavailable = await collectCiFailureDiagnostics({ repo: 'example/repo' }, observation, {
    execFile: (file, args, options, callback) => callback(new Error('failed'), '', 'log not found'),
  });
  assert.match(unavailable, /== CI \(#601\): failure https:\/\/example\/run\/601/);
  assert.match(unavailable, /failed job details unavailable/);
  assert.match(unavailable, /failed-step log unavailable/);
  assert.doesNotMatch(unavailable, /log not found/);
  const empty = await collectCiFailureDiagnostics({ repo: 'example/repo' }, { ...observation, runs: [] }, {
    execFile: () => { throw new Error('gh must not be called'); },
  });
  assert.match(empty, /no logs are available/);
});
