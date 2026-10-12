const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(50); }
  throw new Error(`Timed out waiting for ${label}`);
}
function get(port, route) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}
const lines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);

test('the continuous runner admits ready issues itself and drives each to exactly one durable outcome', { timeout: 180000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-runner-'));
  const checkout = path.join(root, 'repo'); fs.mkdirSync(checkout);
  const git = (...args) => execFileSync('git', args, { cwd: checkout, stdio: 'pipe' });
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(checkout, 'initial'), 'fixture'); git('add', '.'); git('commit', '-m', 'Initial');
  const worktreeRoot = path.join(root, 'worktrees');
  const project = { enabled: true, repo: 'example/repo', checkout, worktreeRoot, baseBranch: 'main', worker: 'codex', reviewPolicy: 'always',
    autoMerge: true, readyLabel: 'ready-for-agent', humanLabel: 'ready-for-human', ciWorkflow: 'CI', maxAttempts: 1, stateDir: path.join(root, 'r1-state'),
    verification: `node -e "if(require('fs').readFileSync('answer','utf8')!=='42')process.exit(1)"` };
  const fixture = path.join(root, 'fixture.json');
  fs.writeFileSync(fixture, JSON.stringify({ root, project, rejected: 9, neverGreen: 10, gatedCi: 11, ciTimeoutMs: 6000 }));
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ dashboardPort: 0, allowedProjects: { demo: { root: checkout, worktreeRoot } } }));
  const spec = '## Acceptance criteria\n- Write the answer file containing 42 and keep tests green.';
  const ready = numbers => fs.writeFileSync(path.join(root, 'issues.json'), JSON.stringify(numbers.map(number => ({
    number, title: `Issue ${number}`, body: number === 8 ? 'fix it' : spec }))));
  const queue = path.join(root, 'queue');
  const tasksFor = number => ['pending', 'running', 'done'].flatMap(stage => {
    const directory = path.join(queue, 'tasks', stage);
    return fs.existsSync(directory) ? fs.readdirSync(directory).map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))) : [];
  }).filter(task => task.workflow === 'r1' && task.issue === number);
  const commands = () => lines(path.join(root, 'commands'));

  let child; let output = ''; let port;
  const launch = async () => {
    child = spawn(process.execPath, [path.join(__dirname, 'fixtures/r1-runner-daemon.js')], {
      env: { ...process.env, AGENTLOOP_CONFIG_PATH: config, AGENTLOOP_STATE_DIR: queue, R1_FIXTURE: fixture }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    port = await until(() => {
      try { const info = JSON.parse(fs.readFileSync(path.join(queue, 'daemon.json'))); return info.pid === child.pid && info.port > 0 && info.port; } catch { return false; }
    }, 'daemon');
  };
  const outcome = async number => until(async () => {
    const [task] = tasksFor(number);
    if (!task) return false;
    const job = await get(port, `/api/r1/jobs/${task.id}`);
    return ['merged', 'needs_specification', 'failed'].includes(job.status) && { task: tasksFor(number)[0], job };
  }, `outcome for #${number}`, 60000).catch(error => {
    const [task] = tasksFor(number);
    error.message += ` (phase ${task && task.phase}; ${JSON.stringify(task && task.r1 && { status: task.r1.status, failures: task.r1.failures, reviewCorrection: task.r1.reviewCorrection && task.r1.reviewCorrection.status })})`;
    throw error;
  });
  try {
    ready([7]);
    await launch();
    // MERGED: admitted by the runner, never submitted through the API.
    const merged = await outcome(7);
    assert.deepEqual([merged.job.status, merged.task.source, merged.job.phase], ['merged', 'runner', 'completed']);
    assert.equal(merged.job.evidence.review.verdict, 'PASS');
    assert.equal(merged.job.evidence.ci.state, 'green');
    assert.equal(merged.job.evidence.verification.passed, true);
    assert.deepEqual(lines(path.join(root, 'merges')), [{ number: 7, headCommit: merged.job.evidence.commit, issue: 7 }]);
    assert.deepEqual(lines(path.join(root, 'closures')), [7]);
    assert.ok(commands().some(c => c.join(' ') === 'gh api --method DELETE repos/example/repo/git/refs/heads/ralph/issue-7-issue-7'));
    assert.ok(commands().some(c => c.join(' ').endsWith('branch -D ralph/issue-7-issue-7')));
    assert.ok(!commands().some(c => c[1] === 'pr' && c[2] === 'close'), 'a merged PR is never closed');
    // The CI watcher polls with a bound instead of on every 1.5s daemon tick.
    const ci7 = lines(path.join(root, 'ci')).filter(call => call.number === 7);
    assert.ok(ci7.length >= 2 && ci7.length <= 4, `bounded CI polls: ${ci7.length}`);
    assert.ok(ci7[1].at - ci7[0].at >= 90, 'CI polls are paced');

    // NEEDS_SPECIFICATION: no worker runs for an issue without a specification.
    ready([7, 8]);
    const unspecified = await outcome(8);
    assert.equal(unspecified.job.status, 'needs_specification');
    assert.ok(!lines(path.join(root, 'workers')).includes('issue-8'));
    assert.ok(commands().some(c => c.join(' ') === 'gh issue edit 8 --repo example/repo --remove-label ready-for-agent --add-label ready-for-human'));
    assert.ok(commands().some(c => c[1] === 'issue' && c[2] === 'comment' && c[3] === '8' && /product specification/.test(c.at(-1))));

    // FAILED after the bounded review correction: PR closed, branch deleted, nothing merged.
    ready([7, 8, 9]);
    const rejected = await outcome(9);
    assert.equal(rejected.job.status, 'failed');
    assert.equal(lines(path.join(root, 'reviews')).filter(review => review.number === 9).length, 2);
    const closed = commands().find(c => c.slice(0, 5).join(' ') === 'gh pr close 9 --repo');
    assert.ok(closed && /outcome FAILED/.test(closed.at(-1)) && !/please review|approve/i.test(closed.at(-1)), 'PR closed with an outcome report, not a review request');
    assert.ok(commands().some(c => c.join(' ').includes('git/refs/heads/ralph/issue-9-issue-9')));
    assert.equal(lines(path.join(root, 'merges')).length, 1);

    // FAILED when required CI never finishes within the bounded watch.
    ready([10]);
    const stalled = await outcome(10);
    assert.equal(stalled.job.status, 'failed');
    assert.match(stalled.task.failure, /Required CI did not reach a final result/);
    assert.equal(lines(path.join(root, 'merges')).length, 1);

    // Crash while waiting for CI: the restarted daemon resumes the same job once.
    ready([11]);
    const [waiting] = await until(() => { const tasks = tasksFor(11); return tasks[0] && tasks[0].phase === 'ci' && tasks; }, '#11 waiting for CI');
    const died = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await died;
    fs.writeFileSync(path.join(root, 'ci-release'), '');
    await launch();
    const recovered = await outcome(11);
    assert.deepEqual([recovered.task.id, recovered.job.status], [waiting.id, 'merged']);
    assert.equal(lines(path.join(root, 'workers')).filter(name => name === 'issue-11').length, 1);
    assert.equal(lines(path.join(root, 'merges')).filter(merge => merge.number === 11).length, 1);

    // Repeated admission never duplicates a queued, running, or terminal issue.
    ready([7, 8, 9, 10, 11]);
    await delay(800);
    for (const number of [7, 8, 9, 10, 11]) assert.equal(tasksFor(number).length, 1, `#${number}`);
    assert.equal(lines(path.join(root, 'merges')).length, 2);
  } catch (error) { error.message += '\n' + output; throw error; }
  finally {
    if (child && child.exitCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await ended; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
