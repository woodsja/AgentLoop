'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  discoverReadyIssues,
  selectReadyIssue,
  observePullRequestCi,
  observePullRequest,
  mergePullRequest,
  reconcileIssueClosure,
  collectCiFailureDiagnostics,
} = require('../src/autopilot-github');

function ghResponse(stdout, error = null, stderr = '') {
  return (file, args, options, callback) => {
    assert.equal(file, 'gh');
    assert.deepEqual(args, ['issue', 'list', '--repo', 'example/repo', '--state', 'open', '--label', 'ready', '--json', 'number,title,body,state,labels', '--limit', '1000']);
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

test('observes exact PR identity, merges with GitHub expected-head protection, and closes the issue', async () => {
  const calls = [];
  const responses = [
    JSON.stringify({ number: 42, url: 'https://github.com/example/repo/pull/42', state: 'OPEN', isCrossRepository: false, headRefName: 'ralph/issue-42', headRefOid: 'deadbeef', baseRefName: 'ralph-dev', mergeCommit: null }),
    JSON.stringify({ merged: true, sha: 'mergecafe' }),
    JSON.stringify({ number: 9, state: 'open', repository_url: 'https://api.github.com/repos/example/repo' }),
    JSON.stringify({ number: 9, state: 'closed', repository_url: 'https://api.github.com/repos/example/repo' }),
  ];
  const executeFile = (file, args, options, callback) => { calls.push([file, args]); assertUnattendedGhOptions(options); callback(null, responses.shift(), ''); };
  const project = { repo: 'example/repo' };
  assert.deepEqual(await observePullRequest(project, 42, { execFile: executeFile }), {
    number: 42, url: 'https://github.com/example/repo/pull/42', state: 'OPEN', isCrossRepository: false, headRefName: 'ralph/issue-42', headRefOid: 'deadbeef', baseRefName: 'ralph-dev', mergeCommit: null,
  });
  assert.deepEqual(await mergePullRequest(project, { number: 42, headCommit: 'deadbeef' }, { execFile: executeFile }), { mergeCommit: 'mergecafe' });
  assert.deepEqual(await reconcileIssueClosure(project, 9, { execFile: executeFile }), { number: 9, state: 'closed' });
  assert.deepEqual(calls.map(([, args]) => args), [
    ['pr', 'view', '42', '--repo', 'example/repo', '--json', 'number,url,state,headRefName,headRefOid,baseRefName,mergeCommit,isCrossRepository'],
    ['api', '--method', 'PUT', 'repos/example/repo/pulls/42/merge', '-f', 'sha=deadbeef'],
    ['api', 'repos/example/repo/issues/9'],
    ['api', '--method', 'PATCH', 'repos/example/repo/issues/9', '-f', 'state=closed'],
  ]);
});

test('classifies real gh merge failures by the HTTP status gh prints on stderr', async () => {
  const merge = stderr => mergePullRequest({ repo: 'example/repo' }, { number: 42, headCommit: 'deadbeef' }, {
    // A real gh failure carries only an exit code; the status is in stderr.
    execFile: (file, args, options, callback) => callback(Object.assign(new Error('Command failed'), { code: 1 }), '', stderr),
  });
  for (const [stderr, code, statusCode, retryable] of [
    ['gh: Head branch was modified. Review and try the merge again. (HTTP 409)\n', 'AUTOPILOT_MERGE_REJECTED', 409, false],
    ['gh: Pull Request is not mergeable (HTTP 405)\n', 'AUTOPILOT_MERGE_REJECTED', 405, false],
    ['gh: API rate limit exceeded (HTTP 429)\n', 'AUTOPILOT_GITHUB_TRANSPORT', 429, true],
    ['gh: Server Error (HTTP 502)\n', 'AUTOPILOT_GITHUB_TRANSPORT', 502, true],
    ['error connecting to api.github.com\n', 'AUTOPILOT_GITHUB_TRANSPORT', undefined, true],
  ]) {
    await assert.rejects(merge(stderr), error => error.code === code && error.statusCode === statusCode && error.retryable === retryable, stderr);
  }
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

const issueState = (number, state, repository = 'example/repo') => ({
  number, state, repository_url: `https://api.github.com/repos/${repository}`,
});

test('issue closure: an already closed GitHub issue is confirmed without a redundant PATCH', async () => {
  const commands = [];
  const executeFile = (file, args, options, callback) => {
    assert.equal(file, 'gh');
    assertUnattendedGhOptions(options);
    commands.push(args);
    if (args.includes('PATCH')) return callback(new Error('Unexpected PATCH'), '', 'gh: Validation Failed (HTTP 422)');
    callback(null, JSON.stringify(issueState(4, 'closed')), '');
  };
  assert.deepEqual(await reconcileIssueClosure({ repo: 'example/repo' }, 4, { execFile: executeFile }), { number: 4, state: 'closed' });
  assert.deepEqual(commands, [['api', 'repos/example/repo/issues/4']]);
});

test('issue closure: a 422 after GitHub closed it concurrently is reconciled by a verified GET', async () => {
  const commands = [];
  let reads = 0;
  const executeFile = (file, args, options, callback) => {
    assert.equal(file, 'gh');
    assertUnattendedGhOptions(options);
    commands.push(args);
    if (args[2] === 'PATCH') {
      return callback(Object.assign(new Error('Validation Failed'), { code: 1 }), '', 'gh: Validation Failed (HTTP 422)');
    }
    reads += 1;
    callback(null, JSON.stringify(issueState(4, reads === 1 ? 'open' : 'closed')), '');
  };
  const outcome = await reconcileIssueClosure({ repo: 'example/repo' }, 4, { execFile: executeFile });
  assert.equal(outcome.number, 4);
  assert.equal(outcome.state, 'closed');
  assert.ok(outcome.reconciledAfterError instanceof Error);
  assert.match(outcome.reconciledAfterError.message, /Validation Failed \(HTTP 422\)/);
  assert.equal(outcome.reconciledAfterError.code, 'AUTOPILOT_GITHUB_TRANSPORT');
  assert.equal(outcome.reconciledAfterError.statusCode, 422);
  assert.deepEqual(commands.map(args => args[2] || 'GET'), ['GET', 'PATCH', 'GET']);
});

test('issue closure: 422 with issue still open, malformed identity, or malformed GitHub is never approved', async () => {
  for (const after of [issueState(4, 'open'), issueState(999, 'closed'), 'malformed']) {
    let reads = 0;
    const executeFile = (file, args, options, callback) => {
      assert.equal(file, 'gh');
      assertUnattendedGhOptions(options);
      if (args[2] === 'PATCH') {
        return callback(Object.assign(new Error('Validation Failed'), { code: 1 }), '', 'gh: Validation Failed (HTTP 422)');
      }
      reads += 1;
      const value = reads === 1 ? issueState(4, 'open') : after;
      callback(null, value === 'malformed' ? '{bad' : JSON.stringify(value), '');
    };
    await assert.rejects(reconcileIssueClosure({ repo: 'example/repo' }, 4, { execFile: executeFile }),
      /GitHub issue reconciliation failed/);
  }
});

test('issue closure rejects transferred issue identity, even if same issue number and closed', async () => {
  let patchCalled = false;
  const executeFile = (file, args, options, callback) => {
    assertUnattendedGhOptions(options);
    if (args[2] === 'PATCH') patchCalled = true;
    callback(null, JSON.stringify(issueState(4, 'closed', 'other/repository')), '');
  };
  await assert.rejects(reconcileIssueClosure({ repo: 'example/repo' }, 4, { execFile: executeFile }), /issue identity and state/);
  assert.equal(patchCalled, false);
});

test('issue closure rejects a PR-shaped response at the issues endpoint', async () => {
  const executeFile = (file, args, options, callback) => callback(null,
    JSON.stringify({ ...issueState(4, 'closed'), pull_request: { url: 'https://api.github.com/repos/example/repo/pulls/4' } }), '');
  await assert.rejects(reconcileIssueClosure({ repo: 'example/repo' }, 4, { execFile: executeFile }), /issue identity and state/);
});

test('issue closure rejects a successful PATCH response with another repository identity', async () => {
  let reads = 0;
  const executeFile = (file, args, options, callback) => {
    if (args[2] === 'PATCH') return callback(null, JSON.stringify(issueState(4, 'closed', 'other/repository')), '');
    reads += 1;
    callback(null, JSON.stringify(issueState(4, 'open')), '');
  };
  await assert.rejects(reconcileIssueClosure({ repo: 'example/repo' }, 4, { execFile: executeFile }), /did not confirm issue closure/);
  assert.equal(reads, 1);
});

test('issue closure preserves original PATCH HTTP 422 and subsequent read failure diagnostics', async () => {
  for (const post of [issueState(4, 'closed', 'foreign/repo'), 'malformed', 'network']) {
    let reads = 0;
    const executeFile = (file, args, options, callback) => {
      if (args[2] === 'PATCH') {
        return callback(Object.assign(new Error('GitHub 422'), { code: 1 }), '', 'gh: Validation Failed (HTTP 422)');
      }
      reads += 1;
      if (reads === 1) return callback(null, JSON.stringify(issueState(4, 'open')), '');
      if (post === 'network') {
        return callback(Object.assign(new Error('disconnected'), { code: 1 }), '', 'gh: temporary GitHub outage (HTTP 502)');
      }
      callback(null, post === 'malformed' ? '{bad' : JSON.stringify(post), '');
    };
    await assert.rejects(reconcileIssueClosure({ repo: 'example/repo' }, 4, { execFile: executeFile }), error =>
      error.message.includes('Validation Failed (HTTP 422)')
      && (error.message.includes('identity') || error.message.includes('malformed') || error.message.includes('outage'))
      && (post === 'network' ? error.statusCode === 502 && error.cause?.statusCode === 422 : error.statusCode === 422));
  }
});

test('issue closure initial GET errors fail closed without any PATCH', async () => {
  for (const value of ['{bad', 'network']) {
    const calls = [];
    const executeFile = (file, args, options, callback) => {
      calls.push(args);
      if (value === 'network') {
        callback(Object.assign(new Error('temporarily unavailable'), { code: 1 }), '', 'gh: API unavailable (HTTP 503)');
      } else callback(null, value, '');
    };
    await assert.rejects(reconcileIssueClosure({ repo: 'example/repo' }, 4, { execFile: executeFile }),
      /GitHub issue reconciliation failed/);
    assert.deepEqual(calls, [['api', 'repos/example/repo/issues/4']]);
  }
});


test('issue closure preserves malformed PATCH body error and failed read error together', async () => {
  let reads = 0;
  const executeFile = (file, args, options, callback) => {
    assertUnattendedGhOptions(options);
    if (args[2] === 'PATCH') return callback(null, '{bad', '');
    reads += 1;
    if (reads === 1) return callback(null, JSON.stringify(issueState(4, 'open')), '');
    callback(Object.assign(new Error('Service unavailable'), { code: 1 }), '', 'gh: temporary GitHub outage (HTTP 502)');
  };
  await assert.rejects(reconcileIssueClosure({ repo: 'example/repo' }, 4, { execFile: executeFile }), error =>
    error.message.includes('GitHub issue reconciliation failed: gh returned malformed JSON')
    && error.message.includes('subsequent GitHub issue observation failed')
    && error.message.includes('temporary GitHub outage (HTTP 502)')
    && error.code === 'AUTOPILOT_GITHUB_TRANSPORT' && error.statusCode === 502);
});

test('issue closure keeps HTTP failure classification when read confirms issue remains open', async () => {
  const executeFile = (file, args, options, callback) => {
    assertUnattendedGhOptions(options);
    if (args[2] === 'PATCH') {
      return callback(Object.assign(new Error('Rejected'), { code: 1, statusCode: 422 }), '',
        'gh: Validation Failed (HTTP 422)');
    }
    callback(null, JSON.stringify(issueState(4, 'open')), '');
  };
  await assert.rejects(reconcileIssueClosure({ repo: 'example/repo' }, 4, { execFile: executeFile }), error =>
    error.code === 'AUTOPILOT_GITHUB_TRANSPORT' && error.statusCode === 422
    && error.message.includes('Validation Failed (HTTP 422)')
    && error.message.includes('issue remains open'));
});

test('issue closure accepts only the configured HTTPS GitHub API host and exact repository endpoint', async () => {
  const invalidUrls = [
    'https://evil.example/repos/example/repo',
    'https://api.github.com/x/repos/example/repo',
    'http://api.github.com/repos/example/repo',
    'https://api.github.com/repos/example/repo-fake',
  ];
  for (const repository_url of invalidUrls) {
    let patched = false;
    const executeFile = (file, args, options, callback) => {
      if (args[2] === 'PATCH') patched = true;
      callback(null, JSON.stringify({ ...issueState(4, 'closed'), repository_url }), '');
    };
    await assert.rejects(reconcileIssueClosure({ repo: 'example/repo' }, 4, { execFile: executeFile }),
      /issue identity and state/, repository_url);
    assert.equal(patched, false);
  }
});

test('failed PATCH and failed follow-up GET keep both original errors, stacks, and causes', async () => {
  let reads = 0;
  const executeFile = (file, args, options, callback) => {
    assertUnattendedGhOptions(options);
    if (args[2] === 'PATCH') {
      return callback(Object.assign(new Error('GitHub PATCH 422'), { code: 1, statusCode: 422 }), '',
        'gh: Validation Failed (HTTP 422)');
    }
    reads += 1;
    callback(null, reads === 1 ? JSON.stringify(issueState(4, 'open')) : '{bad', '');
  };
  await assert.rejects(reconcileIssueClosure({ repo: 'example/repo' }, 4, { execFile: executeFile }), error =>
    error.message.includes('Validation Failed (HTTP 422)')
    && error.cause?.statusCode === 422
    && error.observationError?.message.includes('malformed JSON')
    && error.observationError?.cause instanceof SyntaxError
    && typeof error.observationError.cause.stack === 'string');
});

test('decision issues never enter admission even with a ready label or duplicate events', async () => {
  const normal = { number: 3, title: 'Implementation', body: '', state: 'OPEN', labels: [{ name: 'ready' }] };
  const decision = { ...normal, number: 1, labels: [{ name: 'ready' }, { name: 'needs-owner-decision' }] };
  const marked = { ...normal, number: 2, body: '<!-- ralph-decision:' + 'a'.repeat(64) + ' -->' };
  const issues = await discoverReadyIssues({ repo: 'example/repo', readyLabel: 'ready' }, {
    execFile: ghResponse(JSON.stringify([decision, marked, decision, normal])),
  });
  assert.deepEqual(issues.map(i => i.number), [3]);
  assert.equal(selectReadyIssue([decision, marked]), null);
  assert.equal(selectReadyIssue([decision, normal]).number, 3);
  const adr = { ...normal, body: marked.body + ' ADR proposal\nSeparately released ADR delivery' };
  assert.equal(selectReadyIssue([adr]).number, 3);
});
