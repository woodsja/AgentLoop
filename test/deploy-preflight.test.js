'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');
const state = require('../src/autopilot-state');
const { validateDeploymentCandidate } = require('../src/deploy-preflight');

// Load the private URL dependency only in tests. No observer/output is faked:
// every command, including the shipping ls-remote implementation, runs real Git.
function testValidator(remote, onObservation, onCommand = () => {}) {
  const filename = require.resolve('../src/deploy-preflight');
  const realRequire = createRequire(filename);
  const observedExec = (...args) => execFile(...args);
  observedExec[promisify.custom] = async (...args) => {
    onCommand(...args);
    if (args[1].includes('ls-remote') && !args[1].includes('--get-url')) onObservation(...args);
    const result = await promisify(execFile)(...args);
    // Git 2.43 can succeed despite missing-parent diagnostics; never hide them.
    if (args[1].includes('merge-base')) assert.doesNotMatch(result.stderr, /^(?:error|fatal|warning):/m);
    return result;
  };
  const localRequire = name => name === 'node:child_process'
    ? { execFile: observedExec } : realRequire(name);
  const loaded = { exports: {} };
  const source = fs.readFileSync(filename, 'utf8') +
    '\nmodule.exports.validateForTest = (issue, options) => validateCandidate(issue, options, testOnlyCanonicalUrl);';
  new Function('require', 'module', 'exports', 'testOnlyCanonicalUrl', source)(
    localRequire, loaded, loaded.exports, remote);
  return remote === undefined ? loaded.exports.validateDeploymentCandidate : loaded.exports.validateForTest;
}

function fixture(t, content = 'candidate\n', { installedAttributes, candidateAttributes, priorHistory = false, staleBase = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout');
  const remote = path.join(root, 'origin.git');
  fs.mkdirSync(checkout);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const rawGit = (...args) => spawnSync('git', ['-C', checkout, ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
  });
  git('init', '-b', 'ralph-dev');
  git('config', 'user.name', 'Preflight Test');
  git('config', 'user.email', 'preflight@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('init', '--bare', remote);
  // Writes and the real read-only observation use the disposable bare remote.
  let beforeRemote;
  let onCommand;
  const observations = [];
  const commands = [];
  const validate = testValidator(remote, (file, args, options) => {
    observations.push({ file, args, options });
    if (beforeRemote) beforeRemote();
  }, (file, args, options) => {
    commands.push({ file, args, options });
    if (onCommand) onCommand(file, args, options);
  });
  git('remote', 'add', 'origin', 'git@github.com:woodsja/AgentLoop.git');
  if (installedAttributes) fs.writeFileSync(path.join(checkout, '.gitattributes'), installedAttributes);
  const commit = text => {
    fs.writeFileSync(path.join(checkout, 'file.txt'), text);
    git('add', '.'); git('commit', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  if (priorHistory || staleBase) commit('earlier installed history\n');
  const fork = staleBase ? commit('installed\n') : undefined;
  if (staleBase) {
    fs.writeFileSync(path.join(checkout, 'base.txt'), 'another installed change\n');
    git('add', '.'); git('commit', '-m', 'base advanced after branch fork');
  }
  const oldSha = staleBase ? git('rev-parse', 'HEAD') : commit('installed\n');
  git('checkout', '-b', 'ralph/issue-28', ...(staleBase ? [fork] : []));
  const side = staleBase ? commit('first reviewed side commit\n') : undefined;
  if (candidateAttributes) fs.writeFileSync(path.join(checkout, '.gitattributes'), candidateAttributes);
  const head = commit(content);
  git('checkout', 'ralph-dev');
  git('merge', '--no-ff', 'ralph/issue-28', '-m', 'approved merge');
  const newSha = git('rev-parse', 'HEAD');
  git('push', remote, 'ralph-dev');
  git('reset', '--hard', oldSha);
  const configPath = path.join(root, 'projects.json');
  const project = {
    enabled: true, repo: 'woodsja/AgentLoop', checkout, worktreeRoot: root,
    stateDir: path.join(root, 'state'), baseBranch: 'ralph-dev',
    readyLabel: 'ready-for-agent', humanLabel: 'ready-for-human', worker: 'codex',
    verification: 'npm test && git diff --check', ciWorkflow: 'CI', reviewPolicy: 'always', autoMerge: true,
  };
  const configure = () => fs.writeFileSync(configPath, JSON.stringify({ ralph: project }));
  configure();
  const store = state.createJobStore(project.stateDir);
  const job = state.createJob({ projectName: 'ralph', repo: project.repo, issue: { number: 28, title: 'candidate' },
    branch: 'ralph/issue-28', worktreePath: checkout, now: store.now });
  state.recordVerification(job, project.verification, { passed: true, exitCode: 0, timedOut: false, stdout: 'passed', stderr: '' });
  state.recordDelivery(job, { commit: head });
  state.recordPullRequest(job, { number: 128, url: 'https://github.com/woodsja/AgentLoop/pull/128' });
  state.recordReview(job, { reviewer: 'claude:opus', verdict: 'PASS', commit: head, policy: 'always', findings: [], attempt: state.beginReviewAttempt(job) });
  state.recordCiState(job, { state: 'green', headCommit: head, prNumber: 128, requiredWorkflow: 'CI', runs: [{
    databaseId: 1, workflowName: 'CI', status: 'completed', conclusion: 'success', name: null,
    url: null, startedAt: null, updatedAt: null,
  }] });
  state.recordMerge(job, { prNumber: 128, approvedHead: head, commit: newSha, repo: project.repo, issueClosed: true });
  state.markTerminal(job, 'merged');
  const save = () => store.save(job);
  save();
  return { root, checkout, remote, configPath,
    setBeforeRemote: callback => { beforeRemote = callback; },
    setOnCommand: callback => { onCommand = callback; },
    observationCount: () => observations.length, observations, commands, git, rawGit, commit, oldSha, newSha, head, fork, side, job, store, save, project, configure,
    validate: () => validate(28, { configPath }) };
}

// Compare every byte, including config, durable evidence, index, and refs.
function snapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(file)) : [[file, fs.readFileSync(file).toString('base64')]];
  }));
}

test('valid merge returns frozen SHAs without writing any fixture files; already installed is a no-op', async t => {
  const f = fixture(t);
  const boundaries = [];
  f.setOnCommand((file, args, options) => {
    if (args.includes('merge-base')) boundaries.push(
      fs.readFileSync(path.join(options.cwd, 'shallow'), 'utf8'));
  });
  let before = snapshot(f.root);
  const result = await f.validate();
  assert.deepEqual(result, { oldSha: f.oldSha, newSha: f.newSha, noOp: false });
  assert.ok(Object.isFrozen(result));
  assert.throws(() => { result.newSha = f.oldSha; }, TypeError);
  assert.deepEqual(snapshot(f.root), before);
  f.git('reset', '--hard', f.newSha);
  before = snapshot(f.root);
  assert.deepEqual(await f.validate(), { oldSha: f.newSha, newSha: f.newSha, noOp: true });
  // Bound both real ancestry walks at installed HEAD, including merge-base A A.
  assert.deepEqual(boundaries, [`${f.oldSha}\n`, `${f.newSha}\n`]);
  assert.deepEqual(snapshot(f.root), before);
});

test('rejects whitespace in the committed delta even though the checkout is clean', async t => {
  const f = fixture(t, 'bad trailing whitespace  \n');
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.git('diff', '--check'), '');
  f.git('config', 'core.whitespace', '-blank-at-eol,-blank-at-eof,-space-before-tab');
  await assert.rejects(f.validate(), error => /trailing whitespace/.test(error.stdout));
});

for (const kind of ['untracked', 'unstaged', 'staged', 'branch', 'detached', 'origin', 'missing remote ref', 'stale remote tracking ref', 'non-FF']) {
  test(`rejects ${kind}`, async t => {
    const f = fixture(t);
    if (kind === 'untracked') fs.writeFileSync(path.join(f.checkout, 'extra'), 'dirty');
    if (['unstaged', 'staged'].includes(kind)) {
      fs.writeFileSync(path.join(f.checkout, 'file.txt'), 'dirty\n');
      if (kind === 'staged') f.git('add', '.');
    }
    if (kind === 'branch') f.git('checkout', '-b', 'main');
    if (kind === 'detached') f.git('checkout', '--detach');
    if (kind === 'origin') f.git('remote', 'set-url', 'origin', f.remote);
    if (kind === 'missing remote ref') f.git('push', f.remote, ':ralph-dev');
    if (kind === 'stale remote tracking ref') {
      f.git('push', '--force', f.remote, `${f.oldSha}:refs/heads/ralph-dev`);
      f.git('update-ref', 'refs/remotes/origin/ralph-dev', f.newSha);
    }
    if (kind === 'non-FF') f.commit('divergent installed commit\n');
    const before = snapshot(f.root);
    await assert.rejects(f.validate());
    assert.deepEqual(snapshot(f.root), before);
  });
}

const invalidEvidence = {
  unreviewed: j => { j.review = null; },
  stale: j => { j.review.commit = 'a'.repeat(40); },
  foreign: j => { j.merge.repo = 'other/repo'; },
  'foreign job repository': j => { j.repo = 'other/repo'; },
  'wrong project': j => { j.project = 'finance-dashboard'; },
  'not merged': j => { j.terminalState = 'failed'; },
  'wrong approved head': j => { j.merge.approvedHead = 'a'.repeat(40); },
  'worker approval': j => { j.review.reviewer = 'codex'; },
  findings: j => { j.review.verdict = 'NEEDS_CHANGES'; j.review.findings = [{ summary: 'bug', file: null, severity: null, line: null }]; },
  'stale CI': j => { j.ci.headCommit = 'a'.repeat(40); },
  'wrong CI PR': j => { j.ci.prNumber++; },
  'wrong merge PR': j => { j.merge.prNumber++; },
  'missing required CI': j => { j.ci.runs = []; },
  'red required CI': j => { j.ci.runs[0].conclusion = 'failure'; },
  'stale workflow': j => { j.ci.requiredWorkflow = 'Other'; },
  'CI provider failure': j => { j.ci.providerError = true; },
  'newer required CI retry': j => { j.ci.runs.push({ ...j.ci.runs[0], databaseId: 2, status: 'in_progress', conclusion: null }); },
  'red other workflow': j => { j.ci.runs.push({ ...j.ci.runs[0], databaseId: 2, workflowName: 'Other', conclusion: 'failure' }); },
  'failed deterministic tests': j => { j.verification.passed = false; },
  'fake SHA': j => { j.merge.commit = 'a'.repeat(40); },
};
for (const [name, change] of Object.entries(invalidEvidence)) {
  test(`durable evidence fails closed: ${name}`, async t => {
    const f = fixture(t);
    change(f.job); f.save();
    await assert.rejects(f.validate());
  });
}

test('accepts a fast-forward whose target is the exact reviewed head', async t => {
  const f = fixture(t);
  f.git('push', '--force', f.remote, `${f.head}:refs/heads/ralph-dev`);
  f.job.merge.commit = f.head; f.save();
  assert.deepEqual(await f.validate(), { oldSha: f.oldSha, newSha: f.head, noOp: false });
});

for (const kind of ['merge', 'fast-forward', 'no-op']) {
  test(`accepts ${kind} with non-root installed HEAD without walking older history`, async t => {
    const f = fixture(t, 'candidate\n', { priorHistory: true });
    if (kind === 'fast-forward') {
      f.git('push', '--force', f.remote, `${f.head}:refs/heads/ralph-dev`);
      f.job.merge.commit = f.head; f.save();
    }
    if (kind === 'no-op') f.git('reset', '--hard', f.newSha);
    const installed = f.git('rev-parse', 'HEAD');
    const older = f.git('rev-parse', `${installed}^1`);
    let walked = false;
    f.setOnCommand((file, args, options) => {
      if (!args.includes('merge-base')) return;
      walked = true;
      assert.equal(fs.readFileSync(path.join(options.cwd, 'shallow'), 'utf8'), `${installed}\n`);
      // The real private walk has no older commit or alternate to fall back on.
      const objects = options.env.GIT_OBJECT_DIRECTORY;
      assert.equal(fs.existsSync(path.join(objects, older.slice(0, 2), older.slice(2))), false);
      assert.equal(fs.existsSync(path.join(objects, 'info/alternates')), false);
    });
    const before = snapshot(f.root);
    assert.deepEqual(await f.validate(), {
      oldSha: installed, newSha: f.job.merge.commit, noOp: kind === 'no-op',
    });
    assert.equal(walked, true);
    assert.deepEqual(snapshot(f.root), before);
  });
}

for (const attack of ['none', 'boundary bytes', 'side bytes', 'first parent', 'second parent']) {
  test(`stale-base merge with two side commits: ${attack}`, async t => {
    const f = fixture(t, 'candidate\n', { staleBase: true });
    assert.equal(f.git('rev-parse', `${f.head}^`), f.side);
    assert.equal(f.git('rev-parse', `${f.side}^`), f.fork);
    assert.equal(f.git('rev-parse', `${f.oldSha}^`), f.fork);
    const older = f.git('rev-parse', `${f.fork}^`);
    if (attack.endsWith('bytes')) {
      const id = attack === 'boundary bytes' ? f.fork : f.side;
      plantObject(f, id, 'commit', Buffer.from(f.git('cat-file', 'commit', id) + '\nforged\n'));
    }
    if (attack.endsWith('parent')) {
      const tree = f.git('rev-parse', `${f.newSha}^{tree}`);
      const changed = f.git('commit-tree', tree, '-p', attack === 'first parent' ? f.fork : f.oldSha,
        '-p', attack === 'second parent' ? f.side : f.head, '-m', 'wrong raw ancestry');
      f.git('push', '--force', f.remote, `${changed}:refs/heads/ralph-dev`);
      f.job.merge.commit = changed; f.save();
    }
    let walked = false;
    f.setOnCommand((file, args, options) => {
      if (!args.includes('merge-base')) return;
      walked = true;
      assert.deepEqual(new Set(fs.readFileSync(path.join(options.cwd, 'shallow'), 'utf8').trim().split('\n')),
        new Set([f.oldSha, f.fork]));
      const objects = options.env.GIT_OBJECT_DIRECTORY;
      assert.ok(fs.existsSync(path.join(objects, f.fork.slice(0, 2), f.fork.slice(2))));
      assert.equal(fs.existsSync(path.join(objects, older.slice(0, 2), older.slice(2))), false);
      assert.equal(fs.existsSync(path.join(objects, 'info/alternates')), false);
    });
    const before = snapshot(f.root);
    if (attack === 'none') {
      assert.deepEqual(await f.validate(), { oldSha: f.oldSha, newSha: f.newSha, noOp: false });
      assert.equal(walked, true);
    } else {
      await assert.rejects(f.validate(), attack.endsWith('bytes') ? /object hash mismatch/
        : attack === 'first parent' ? /unreviewed intermediate/ : /exact reviewed head/);
      assert.equal(walked, false);
    }
    assert.deepEqual(snapshot(f.root), before);
  });
}

test('rejects a real remote commit unrelated to the exact approved head', async t => {
  const f = fixture(t);
  f.git('checkout', '--orphan', 'unrelated');
  const unrelated = f.commit('unrelated\n');
  f.git('push', '--force', f.remote, `${unrelated}:refs/heads/ralph-dev`);
  f.git('checkout', 'ralph-dev');
  f.job.merge.commit = unrelated; f.save();
  await assert.rejects(f.validate(), /exact reviewed head/);
});

test('rejects missing local candidate objects without fetching', async t => {
  const f = fixture(t);
  const remoteGit = (...args) => execFileSync('git', ['--git-dir', f.remote, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const tree = remoteGit('rev-parse', `${f.newSha}^{tree}`);
  const unknown = remoteGit('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit-tree', tree, '-p', f.newSha, '-m', 'remote only');
  remoteGit('update-ref', 'refs/heads/ralph-dev', unknown);
  f.job.merge.commit = unknown; f.save();
  const before = snapshot(f.root);
  await assert.rejects(f.validate());
  assert.deepEqual(snapshot(f.root), before);
});

test('missing or malformed durable evidence fails closed; no state is created', async t => {
  const f = fixture(t);
  const file = path.join(f.store.directory, 'issue-28.json');
  fs.writeFileSync(file, '{');
  await assert.rejects(f.validate(), /malformed/);
  fs.rmSync(f.store.directory, { recursive: true });
  await assert.rejects(f.validate(), /MERGED evidence/);
  assert.equal(fs.existsSync(f.store.directory), false);
});

test('owner configuration must retain Ralph deployment branch and review policy', async t => {
  const f = fixture(t);
  f.project.baseBranch = 'main'; f.configure();
  await assert.rejects(f.validate(), /owner Ralph policy/);
  f.project.baseBranch = 'ralph-dev'; f.project.reviewPolicy = 'none'; f.configure();
  await assert.rejects(f.validate(), /owner Ralph policy/);
});

for (const kind of ['merge', 'fast-forward']) {
  test(`rejects an unreviewed intermediate commit before approved ${kind}`, async t => {
    const f = fixture(t);
    const intermediate = f.commit('unreviewed base change\n');
    f.git('checkout', '-b', 'reviewed-after-intermediate');
    const head = f.commit('approved change\n');
    f.git('checkout', 'ralph-dev');
    if (kind === 'merge') f.git('merge', '--no-ff', head, '-m', 'merge after unreviewed push');
    else f.git('merge', '--ff-only', head);
    const candidate = f.git('rev-parse', 'HEAD');
    if (kind === 'merge') assert.equal(f.git('rev-parse', `${candidate}^1`), intermediate);
    f.git('push', '--force', f.remote, 'ralph-dev');
    f.git('reset', '--hard', f.oldSha);
    f.job.verification.commit = head;
    f.job.delivery.commit = head;
    f.job.review.commit = head;
    f.job.ci.headCommit = head;
    f.job.merge.approvedHead = head;
    f.job.merge.commit = candidate;
    f.save();
    const before = snapshot(f.root);
    await assert.rejects(f.validate(), /unreviewed intermediate commits/);
    assert.deepEqual(snapshot(f.root), before);
  });
}

test('rejects an unexpected effective origin after insteadOf rewriting', async t => {
  const f = fixture(t);
  f.git('config', `url.${f.remote}.insteadOf`, 'git@github.com:woodsja/AgentLoop.git');
  assert.equal(f.git('ls-remote', '--get-url', 'origin'), f.remote);
  assert.equal(f.git('ls-remote', '--refs', 'origin', 'refs/heads/ralph-dev'), `${f.newSha}\trefs/heads/ralph-dev`);
  const before = snapshot(f.root);
  await assert.rejects(f.validate(), /origin does not identify/);
  assert.deepEqual(snapshot(f.root), before);
});

for (const location of ['installed', 'candidate', 'info']) {
  test(`attributes in ${location} cannot disable mandatory whitespace checks`, async t => {
    const f = fixture(t, 'bad whitespace  \n', {
      installedAttributes: location === 'installed' ? '* -whitespace\n' : undefined,
      candidateAttributes: location === 'candidate' ? '* -whitespace\n' : undefined,
    });
    if (location === 'info') fs.writeFileSync(path.join(f.checkout, '.git/info/attributes'), '* -whitespace\n');
    const before = snapshot(f.root);
    await assert.rejects(f.validate(), error => /trailing whitespace/.test(error.stdout));
    assert.deepEqual(snapshot(f.root), before);
  });
}

for (const attributes of [false, true]) {
  test(`preserves stricter owner whitespace rules${attributes ? ' despite disabling attributes' : ''}`, async t => {
    const f = fixture(t, '\tindent\n', { installedAttributes: attributes ? '* -whitespace\n' : undefined });
    f.git('config', 'core.whitespace', 'tab-in-indent');
    const before = snapshot(f.root);
    await assert.rejects(f.validate(), error => /tab in indent/.test(error.stdout));
    assert.deepEqual(snapshot(f.root), before);
  });
}

for (const kind of ['HEAD', 'branch', 'dirty', 'detached']) {
  test(`rejects concurrent ${kind} change during remote observation`, async t => {
    const f = fixture(t);
    const changes = {
      HEAD: () => f.git('reset', '--hard', f.newSha),
      branch: () => f.git('checkout', '-b', 'concurrent'),
      dirty: () => fs.writeFileSync(path.join(f.checkout, 'file.txt'), 'dirty\n'),
      detached: () => f.git('checkout', '--detach'),
    };
    f.setBeforeRemote(changes[kind]);
    await assert.rejects(f.validate(), kind === 'detached' ? undefined : /checkout (HEAD changed|branch changed|became dirty)/);
  });
}

test('rejects a direct base push before merging the original reviewed head', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.checkout, 'unreviewed.txt'), 'direct base push\n');
  f.git('add', '.');
  f.git('commit', '-m', 'unreviewed base push');
  const intermediate = f.git('rev-parse', 'HEAD');
  f.git('merge', '--no-ff', f.head, '-m', 'approved PR after direct push');
  const candidate = f.git('rev-parse', 'HEAD');
  assert.equal(f.git('rev-parse', `${candidate}^1`), intermediate);
  assert.equal(f.git('rev-parse', `${candidate}^2`), f.head);
  f.git('push', '--force', f.remote, 'ralph-dev');
  f.git('reset', '--hard', f.oldSha);
  f.job.merge.commit = candidate; f.save();
  const before = snapshot(f.root);
  await assert.rejects(f.validate(), /unreviewed intermediate commits/);
  assert.deepEqual(snapshot(f.root), before);
});


test('preserves stricter owner info-attribute whitespace rules', async t => {
  const f = fixture(t, '\tindent\n');
  fs.writeFileSync(path.join(f.checkout, '.git/info/attributes'), '* whitespace=tab-in-indent\n');
  const before = snapshot(f.root);
  await assert.rejects(f.validate(), error => /tab in indent/.test(error.stdout));
  assert.deepEqual(snapshot(f.root), before);
});

for (const kind of ['merge', 'fast-forward']) {
  test(`raw parents reject graft-hidden unreviewed commits before approved ${kind}`, async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.checkout, 'unreviewed.txt'), 'direct base push\n');
    f.git('add', '.');
    f.git('commit', '-m', 'unreviewed base push');
    const intermediate = f.git('rev-parse', 'HEAD');
    let head = f.head;
    if (kind === 'merge') f.git('merge', '--no-ff', head, '-m', 'approved PR after direct push');
    else head = f.commit('reviewed after direct push\n');
    const candidate = f.git('rev-parse', 'HEAD');
    f.git('push', '--force', f.remote, 'ralph-dev');
    f.git('reset', '--hard', f.oldSha);
    f.job.verification.commit = head;
    f.job.delivery.commit = head;
    f.job.review.commit = head;
    f.job.ci.headCommit = head;
    f.job.merge.approvedHead = head;
    f.job.merge.commit = candidate;
    f.save();
    // Populate the real shared object-store cache as well as forging the graph.
    f.git('commit-graph', 'write', '--reachable');
    const forgedParents = kind === 'merge' ? [f.oldSha, head] : [f.oldSha];
    fs.writeFileSync(path.join(f.checkout, '.git/info/grafts'), `${candidate} ${forgedParents.join(' ')}\n`);
    // Prove the former gate accepts this metadata, while the raw object does not.
    assert.equal(f.git('rev-list', '--parents', '-n', '1', candidate), `${candidate} ${forgedParents.join(' ')}`);
    assert.equal(f.git('merge-base', '--is-ancestor', f.oldSha, candidate), '');
    assert.match(f.git('cat-file', 'commit', candidate), new RegExp(`\nparent ${intermediate}\n`));
    const before = snapshot(f.root);
    await assert.rejects(f.validate(), /unreviewed intermediate commits/);
    assert.deepEqual(snapshot(f.root), before);
    const raw = f.commands.find(command => command.args.includes('cat-file'));
    assert.notEqual(raw.options.cwd, f.checkout);
    assert.ok(raw.args.includes('core.commitGraph=false'));
    assert.equal(fs.existsSync(raw.options.cwd), false);
  });
}

test('ancestry uses isolated metadata without shared grafts or commit-graph reads', async t => {
  const f = fixture(t);
  f.git('commit-graph', 'write', '--reachable');
  // A graft claiming the valid merge is a root must not affect either gate.
  fs.writeFileSync(path.join(f.checkout, '.git/info/grafts'), `${f.newSha}\n`);
  assert.equal(f.git('rev-list', '--parents', '-n', '1', f.newSha), f.newSha);
  assert.throws(() => f.git('merge-base', '--is-ancestor', f.oldSha, f.newSha));
  const before = snapshot(f.root);
  assert.deepEqual(await f.validate(), { oldSha: f.oldSha, newSha: f.newSha, noOp: false });
  assert.deepEqual(snapshot(f.root), before);
  for (const name of ['cat-file', 'merge-base']) {
    const command = f.commands.find(command => command.args.includes(name));
    assert.notEqual(command.options.cwd, f.checkout);
    assert.ok(command.args.includes(`--git-dir=${command.options.cwd}`));
    assert.ok(command.args.includes('core.commitGraph=false'));
    assert.equal(command.options.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(command.options.env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(fs.existsSync(command.options.cwd), false);
  }
});

for (const kind of ['clean', 'initial dirt', 'concurrent dirt', 'whitespace']) {
  test(`configured fsmonitor never executes during ${kind} validation`, async t => {
    const f = fixture(t, kind === 'whitespace' ? 'bad whitespace  \n' : 'candidate\n');
    const marker = path.join(f.root, 'fsmonitor-executed');
    const program = path.join(f.root, 'fsmonitor');
    fs.writeFileSync(program, `#!/bin/sh\nprintf executed > '${marker}'\nprintf 'token\\000/\\000'\n`, { mode: 0o755 });
    f.git('config', 'core.untrackedCache', 'true');
    f.git('update-index', '--untracked-cache');
    f.git('config', 'core.fsmonitor', program);
    // Show that the real Git status command would execute this program.
    f.git('status', '--porcelain=v1', '--untracked-files=all');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'executed');
    fs.rmSync(marker);
    if (kind === 'initial dirt') fs.writeFileSync(path.join(f.checkout, 'dirty'), 'dirty');
    if (kind === 'concurrent dirt') {
      f.setBeforeRemote(() => fs.writeFileSync(path.join(f.checkout, 'dirty'), 'dirty'));
    }
    const before = snapshot(f.root);
    if (kind === 'clean') {
      assert.deepEqual(await f.validate(), { oldSha: f.oldSha, newSha: f.newSha, noOp: false });
    } else if (kind === 'whitespace') {
      await assert.rejects(f.validate(), error => /trailing whitespace/.test(error.stdout));
    } else {
      await assert.rejects(f.validate(), /checkout (is dirty|became dirty)/);
    }
    assert.equal(fs.existsSync(marker), false);
    if (kind !== 'concurrent dirt') assert.deepEqual(snapshot(f.root), before);
    else {
      fs.rmSync(path.join(f.checkout, 'dirty'));
      assert.deepEqual(snapshot(f.root), before);
    }
    const reads = f.commands.filter(command => command.args.includes('status') || command.args.includes('diff'));
    assert.ok(reads.length > 0);
    for (const command of reads) {
      assert.ok(command.args.includes('core.fsmonitor=false'));
      assert.ok(command.args.includes('core.untrackedCache=false'));
    }
  });
}

for (const key of ['core.sshCommand', 'ssh.variant', 'remote.origin.uploadpack']) {
  test(`ignores hostile ${key} during canonical remote observation`, async t => {
    const f = fixture(t);
    const marker = path.join(f.root, 'transport-executed');
    const command = `touch '${marker}'; git-upload-pack '${f.remote}'`;
    f.git('config', key, key === 'ssh.variant' ? 'simple' : command);
    const before = snapshot(f.root);
    assert.deepEqual(await f.validate(), { oldSha: f.oldSha, newSha: f.newSha, noOp: false });
    assert.equal(f.observationCount(), 1);
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(snapshot(f.root), before);
  });
}

test('vcs helper alias can forge origin, but cannot forge canonical observation', async t => {
  const f = fixture(t);
  const marker = path.join(f.root, 'alias-executed');
  f.git('push', '--force', f.remote, `${f.oldSha}:refs/heads/ralph-dev`);
  const helper = `preflight-forgery-${process.pid}`;
  f.git('config', 'remote.origin.vcs', helper);
  f.git('config', `alias.remote-${helper}`,
    `!f() { touch '${marker}'; while IFS= read -r command; do case \"$command\" in capabilities) printf '\\n';; list*) printf '%s %s\\n\\n' '${f.newSha}' 'refs/heads/ralph-dev';; esac; done; }; f`);
  // Prove this attack actually works against checkout-based observation.
  assert.equal(f.git('ls-remote', '--exit-code', '--refs', 'origin', 'refs/heads/ralph-dev'),
    `${f.newSha}\trefs/heads/ralph-dev`);
  assert.equal(fs.existsSync(marker), true);
  fs.rmSync(marker);
  const before = snapshot(f.root);
  await assert.rejects(f.validate(), /exact origin\/ralph-dev target/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(f.observationCount(), 1);
  assert.deepEqual(snapshot(f.root), before);
});

for (const [key, value] of Object.entries({
  'http.proxy': 'http://127.0.0.1:1',
  'http.sslVerify': 'false',
  'http.sslCAInfo': '/untrusted/ca.pem',
  'http.curloptResolve': 'github.com:443:127.0.0.1',
  'http.https://github.com/.proxy': 'http://127.0.0.1:1',
})) {
  test(`canonical observation cannot read checkout ${key}`, async t => {
    const f = fixture(t);
    f.git('config', key, value);
    f.setBeforeRemote(() => {
      const { file, args, options } = f.observations.at(-1);
      // Inspect the real observation's exact Git context, rather than assuming
      // a local file transport would exercise HTTP configuration on its own.
      const prefix = args.slice(0, args.indexOf('ls-remote'));
      const config = execFileSync(file, [...prefix, 'config', '--list'], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.doesNotMatch(config, /http\./i);
      assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1');
      assert.equal(options.env.GIT_CONFIG_GLOBAL, '/dev/null');
      assert.equal(fs.existsSync(path.join(options.cwd, 'config')), false);
    });
    const before = snapshot(f.root);
    assert.deepEqual(await f.validate(), { oldSha: f.oldSha, newSha: f.newSha, noOp: false });
    assert.deepEqual(snapshot(f.root), before);
    // Correct config isolation must also reject a real stale remote.
    f.git('push', '--force', f.remote, `${f.oldSha}:refs/heads/ralph-dev`);
    await assert.rejects(f.validate(), /exact origin\/ralph-dev target/);
  });
}

test('observation uses config-free scratch metadata and a controlled environment', async t => {
  const f = fixture(t);
  const home = path.join(f.root, 'hostile-home');
  fs.mkdirSync(home);
  const included = path.join(home, 'included');
  fs.writeFileSync(included, '[http]\n proxy = http://127.0.0.1:1\n sslVerify = false\n');
  fs.writeFileSync(path.join(home, '.gitconfig'), `[include]\n path = ${included}\n`);
  const hostile = {
    HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_SYSTEM: included, GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.proxy', GIT_CONFIG_VALUE_0: 'http://127.0.0.1:1',
    GIT_CONFIG_PARAMETERS: "'http.sslVerify=false'", GIT_EXEC_PATH: home,
    GIT_SSH_COMMAND: 'false', GIT_PROXY_COMMAND: 'false', GIT_ALLOW_PROTOCOL: 'ext',
    HTTPS_PROXY: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1',
    ALL_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1',
    SSL_CERT_FILE: included, CURL_CA_BUNDLE: included, LD_PRELOAD: '/missing/preload.so',
  };
  const original = Object.fromEntries(Object.keys(hostile).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, hostile);
    f.setBeforeRemote(() => {
      const { file, args, options } = f.observations.at(-1);
      assert.equal(file, '/usr/bin/git');
      assert.equal(options.env.PATH, '/usr/bin:/bin');
      assert.notEqual(options.cwd, f.checkout);
      assert.equal(options.env.HOME, path.join(options.cwd, 'home'));
      assert.deepEqual(fs.readdirSync(options.env.HOME), []);
      assert.equal(options.env.GIT_ALLOW_PROTOCOL, 'file');
      for (const key of Object.keys(hostile)) {
        if (!['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_ALLOW_PROTOCOL'].includes(key)) {
          assert.equal(options.env[key], undefined, key);
        }
      }
      const prefix = args.slice(0, args.indexOf('ls-remote'));
      assert.equal(execFileSync(file, [...prefix, 'config', '--list'], { ...options, stdio: ['ignore', 'pipe', 'pipe'] }).trim(), 'core.bare=true');
    });
    assert.deepEqual(await f.validate(), { oldSha: f.oldSha, newSha: f.newSha, noOp: false });
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  assert.equal(fs.existsSync(f.observations[0].options.cwd), false);
});

test('public interface fixes the production canonical URL and permits only HTTPS', async t => {
  assert.deepEqual(Object.keys(require('../src/deploy-preflight')), ['validateDeploymentCandidate']);
  assert.equal(validateDeploymentCandidate.length, 2);
  const f = fixture(t);
  const stopped = new Error('stop before contacting production');
  let scratch;
  const validate = testValidator(undefined, (file, args, options) => {
    scratch = options.cwd;
    assert.equal(file, '/usr/bin/git');
    assert.deepEqual(args.slice(args.indexOf('ls-remote')), [
      'ls-remote', '--exit-code', '--refs',
      'https://github.com/woodsja/AgentLoop.git', 'refs/heads/ralph-dev',
    ]);
    assert.equal(options.env.GIT_ALLOW_PROTOCOL, 'https');
    throw stopped;
  });
  await assert.rejects(validate(28, {
    configPath: f.configPath, canonicalUrl: f.remote, testOnlyCanonicalUrl: f.remote,
    observeRemote: () => `${f.newSha}\trefs/heads/ralph-dev`,
  }, f.remote), error => error === stopped);
  assert.equal(fs.existsSync(scratch), false);
});

// Plant an actual loose object under somebody else's name, bypassing Git's
// write-time hashing just as a worker with shared-object-store access can do.
function plantObject(f, id, type, bytes) {
  const { deflateSync } = require('node:zlib');
  const file = path.join(f.checkout, '.git/objects', id.slice(0, 2), id.slice(2));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.unlinkSync(file);
  fs.writeFileSync(file, deflateSync(Buffer.concat([
    Buffer.from(`${type} ${bytes.length}\0`), bytes,
  ])));
}

for (const kind of ['merge', 'reviewed commit', 'installed commit', 'tree', 'blob']) {
  test(`rejects forged loose ${kind} bytes without changing the fixture`, async t => {
    const f = fixture(t);
    let id = kind === 'reviewed commit' ? f.head : kind === 'installed commit' ? f.oldSha : f.newSha;
    let type = 'commit';
    if (kind === 'tree') { id = f.git('rev-parse', `${f.newSha}^{tree}`); type = 'tree'; }
    if (kind === 'blob') { id = f.git('rev-parse', `${f.newSha}:file.txt`); type = 'blob'; }
    const bytes = execFileSync('git', ['-C', f.checkout, 'cat-file', type, id], { stdio: ['ignore', 'pipe', 'pipe'] });
    // Change a message, filename or blob byte while preserving parseability.
    const forged = Buffer.from(bytes);
    forged[kind === 'tree' ? forged.indexOf(Buffer.from('file.txt')) : forged.length - 2] ^= 1;
    plantObject(f, id, type, forged);
    assert.deepEqual(execFileSync('git', ['-C', f.checkout, 'cat-file', type, id], { stdio: ['ignore', 'pipe', 'pipe'] }), forged);
    const before = snapshot(f.root);
    await assert.rejects(f.validate(), /hash mismatch/);
    assert.deepEqual(snapshot(f.root), before);
  });
}

test('forged raw merge parents cannot hide an unreviewed direct push', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.checkout, 'unreviewed.txt'), 'unreviewed\n');
  f.git('add', '.'); f.git('commit', '-m', 'direct push');
  const intermediate = f.git('rev-parse', 'HEAD');
  f.git('merge', '--no-ff', f.head, '-m', 'approved merge');
  const candidate = f.git('rev-parse', 'HEAD');
  f.git('push', '--force', f.remote, 'ralph-dev');
  f.git('reset', '--hard', f.oldSha);
  f.job.merge.commit = candidate; f.save();
  const forged = f.git('cat-file', 'commit', candidate).replace(`parent ${intermediate}`, `parent ${f.oldSha}`) + '\n';
  plantObject(f, candidate, 'commit', Buffer.from(forged));
  assert.equal(f.git('rev-list', '--parents', '-n', '1', candidate), `${candidate} ${f.oldSha} ${f.head}`);
  // Some Git paths already rehash loose commits; cat-file/rev-list above do
  // not. The preflight must explicitly hash before trusting raw parents.
  const before = snapshot(f.root);
  await assert.rejects(f.validate(), /object hash mismatch/);
  assert.deepEqual(snapshot(f.root), before);
});

test('hash verification preserves binary blob bytes and final newlines', async t => {
  const f = fixture(t, Buffer.from([0, 255, 128, 10, 10]));
  const before = snapshot(f.root);
  assert.deepEqual(await f.validate(), { oldSha: f.oldSha, newSha: f.newSha, noOp: false });
  assert.deepEqual(snapshot(f.root), before);
});

for (const driver of ['clean', 'process']) {
  for (const phase of ['initial', 'concurrent', 'dirty']) {
    test(`${driver} filter never executes during ${phase} status`, async t => {
      const f = fixture(t);
      const marker = path.join(f.root, 'filter-executed');
      const program = path.join(f.root, 'filter');
      fs.writeFileSync(program, `#!/bin/sh\nprintf executed > '${marker}'\n${driver === 'clean' ? 'cat' : 'exit 1'}\n`, { mode: 0o755 });
      const arm = () => {
        fs.writeFileSync(path.join(f.checkout, '.git/info/attributes'), 'file.txt filter=hostile\n');
        f.git('config', `filter.hostile.${driver}`, program);
        const file = path.join(f.checkout, 'file.txt');
        const future = new Date(Date.now() + 10000);
        fs.utimesSync(file, future, future);
      };
      arm();
      const control = f.rawGit('status', '--porcelain=v1', '--untracked-files=all');
      // Optional process-filter handshake failure may be fatal or fall back to
      // the original bytes depending on Git. The marker proves execution in
      // either case; the preflight below must never create it.
      t.diagnostic(JSON.stringify({ control: driver, phase, status: control.status,
        signal: control.signal, stdout: control.stdout, stderr: control.stderr }));
      assert.ifError(control.error);
      assert.equal(control.signal, null);
      if (driver === 'clean') {
        assert.equal(control.status, 0);
        assert.equal(control.stdout, '');
      }
      assert.equal(fs.readFileSync(marker, 'utf8'), 'executed');
      fs.rmSync(marker);
      if (phase === 'concurrent') {
        f.git('config', '--unset', `filter.hostile.${driver}`);
        f.setBeforeRemote(arm);
      }
      if (phase === 'dirty') fs.writeFileSync(path.join(f.checkout, 'file.txt'), 'dirty\n');
      if (phase === 'dirty') await assert.rejects(f.validate(), /checkout is dirty/);
      else assert.deepEqual(await f.validate(), { oldSha: f.oldSha, newSha: f.newSha, noOp: false });
      assert.equal(fs.existsSync(marker), false);
      const statuses = f.commands.filter(c => c.args.includes('status'));
      assert.ok(statuses.length > 0);
      for (const c of statuses) {
        assert.notEqual(c.options.cwd, f.checkout);
        assert.equal(c.options.env.GIT_CONFIG_GLOBAL, '/dev/null');
        assert.ok(c.args.includes('--ignore-submodules=all'));
        assert.equal(fs.existsSync(c.options.cwd), false);
      }
    });
  }
}

for (const phase of ['initial', 'concurrent']) {
  test(`rejects ${phase} submodule without executing its configured command`, async t => {
    const f = fixture(t);
    f.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-b', 'ralph-dev', f.remote, 'child');
    f.git('commit', '-am', 'installed submodule');
    const marker = path.join(f.root, 'submodule-command-executed');
    const program = path.join(f.root, 'submodule-fsmonitor');
    fs.writeFileSync(program, `#!/bin/sh\nprintf executed > '${marker}'\nprintf 'token\\000/\\000'\n`, { mode: 0o755 });
    f.git('-C', 'child', 'config', 'core.fsmonitor', program);
    f.git('status', '--porcelain=v1', '--ignore-submodules=none');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'executed');
    fs.rmSync(marker);
    if (phase === 'concurrent') {
      // Introduce the populated submodule only after the initial clean check.
      f.git('reset', '--mixed', f.oldSha);
      fs.rmSync(path.join(f.checkout, '.gitmodules'));
      const parked = path.join(f.root, 'parked-child');
      fs.renameSync(path.join(f.checkout, 'child'), parked);
      f.setBeforeRemote(() => {
        fs.renameSync(parked, path.join(f.checkout, 'child'));
        f.git('update-index', '--add', '--cacheinfo', `160000,${f.newSha},child`);
      });
    }
    const before = snapshot(f.root);
    await assert.rejects(f.validate(), /submodule checkouts are unsupported/);
    assert.equal(fs.existsSync(marker), false);
    if (phase === 'initial') assert.deepEqual(snapshot(f.root), before);
  });
}

test('hash-verifies blobs supplied by an alternate object store', async t => {
  const f = fixture(t);
  const id = f.git('rev-parse', `${f.newSha}:file.txt`);
  const alternate = path.join(f.root, 'alternate-objects');
  const loose = path.join(f.checkout, '.git/objects', id.slice(0, 2), id.slice(2));
  plantObject(f, id, 'blob', Buffer.from('forged alternate blob\n'));
  fs.mkdirSync(path.join(alternate, id.slice(0, 2)), { recursive: true });
  fs.renameSync(loose, path.join(alternate, id.slice(0, 2), id.slice(2)));
  fs.mkdirSync(path.join(f.checkout, '.git/objects/info'), { recursive: true });
  fs.writeFileSync(path.join(f.checkout, '.git/objects/info/alternates'), `${alternate}\n`);
  assert.equal(f.git('cat-file', 'blob', id), 'forged alternate blob');
  const before = snapshot(f.root);
  await assert.rejects(f.validate(), /object hash mismatch/);
  assert.deepEqual(snapshot(f.root), before);
});

test('already-installed candidate still hash-verifies the reviewed commit', async t => {
  const f = fixture(t);
  f.git('reset', '--hard', f.newSha);
  const bytes = Buffer.from(f.git('cat-file', 'commit', f.head) + '\nchanged message\n');
  plantObject(f, f.head, 'commit', bytes);
  const before = snapshot(f.root);
  await assert.rejects(f.validate(), /object hash mismatch/);
  assert.deepEqual(snapshot(f.root), before);
});


for (const flag of ['assume-unchanged', 'skip-worktree']) {
  for (const phase of ['initial', 'concurrent']) {
    test(`rejects dirty ${flag} index attack at ${phase} clean check`, async t => {
      const f = fixture(t);
      const attack = () => {
        f.git('update-index', `--${flag}`, 'file.txt');
        fs.writeFileSync(path.join(f.checkout, 'file.txt'), 'hidden dirty bytes\n');
        // Demonstrate the actual bypass of ordinary status.
        assert.equal(f.git('status', '--porcelain'), '');
      };
      if (phase === 'initial') attack();
      else f.setBeforeRemote(attack);
      const before = snapshot(f.root);
      await assert.rejects(f.validate(), /index assume-unchanged or skip-worktree flags/);
      if (phase === 'initial') assert.deepEqual(snapshot(f.root), before);
    });
  }
}

for (const gate of ['owner', 'independent']) {
  for (const type of ['blob', 'tree']) {
    test(`${gate} whitespace diff rejects ${type} swap after verification`, async t => {
      const f = fixture(t, 'bad trailing whitespace  \n');
      // Force the independent diff to be the rejecting gate in this variant.
      if (gate === 'independent') {
        fs.writeFileSync(path.join(f.checkout, '.git/info/attributes'), '* -whitespace\n');
      }
      const blob = f.git('rev-parse', `${f.newSha}:file.txt`);
      const tree = f.git('rev-parse', `${f.newSha}^{tree}`);
      const cleanBytes = Buffer.from('clean candidate\n');
      const cleanBlob = require('node:crypto').createHash('sha1')
        .update(Buffer.from(`blob ${cleanBytes.length}\0`)).update(cleanBytes).digest('hex');
      plantObject(f, cleanBlob, 'blob', cleanBytes);
      const treeBytes = execFileSync('git', ['-C', f.checkout, 'cat-file', 'tree', tree], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const offset = treeBytes.indexOf(Buffer.from(blob, 'hex'));
      assert.ok(offset >= 0);
      Buffer.from(cleanBlob, 'hex').copy(treeBytes, offset);
      let swaps = 0;
      f.setOnCommand((file, args) => {
        if (!args.includes('diff') || swaps) return;
        swaps++;
        // All verification is complete. Alter real on-disk object bytes just
        // before the first diff starts, leaving them forged for the second.
        plantObject(f, type === 'blob' ? blob : tree, type,
          type === 'blob' ? cleanBytes : treeBytes);
        // Prove that rereading the shared store accepts the forged delta.
        assert.equal(f.git('diff', '--no-ext-diff', '--no-textconv', '--check', f.oldSha, f.newSha), '');
      });
      await assert.rejects(f.validate(), error => /trailing whitespace/.test(error.stdout));
      assert.equal(swaps, 1);
      const diffs = f.commands.filter(c => c.args.includes('diff'));
      assert.equal(diffs.length, gate === 'owner' ? 1 : 2);
      const store = diffs[0].options.env.GIT_OBJECT_DIRECTORY;
      assert.notEqual(store, path.join(f.checkout, '.git/objects'));
      assert.equal(fs.existsSync(store), false);
      for (const diff of diffs) assert.equal(diff.options.env.GIT_OBJECT_DIRECTORY, store);
    });
  }
}

test('both successful whitespace diffs use private verified objects without alternates', async t => {
  const f = fixture(t);
  const blob = f.git('rev-parse', `${f.newSha}:file.txt`);
  let removed = false;
  f.setOnCommand((file, args, options) => {
    if (!args.includes('diff')) return;
    const store = options.env.GIT_OBJECT_DIRECTORY;
    assert.ok(store);
    assert.equal(fs.existsSync(path.join(store, 'info/alternates')), false);
    assert.equal(options.env.GIT_ALTERNATE_OBJECT_DIRECTORIES, undefined);
    if (!removed) {
      fs.unlinkSync(path.join(f.checkout, '.git/objects', blob.slice(0, 2), blob.slice(2)));
      removed = true;
    }
  });
  assert.deepEqual(await f.validate(), { oldSha: f.oldSha, newSha: f.newSha, noOp: false });
  assert.equal(removed, true);
  const diffs = f.commands.filter(c => c.args.includes('diff'));
  assert.equal(diffs.length, 2);
  assert.equal(diffs[0].options.env.GIT_OBJECT_DIRECTORY, diffs[1].options.env.GIT_OBJECT_DIRECTORY);
});

// Rewrite a real v2 entry, retaining HEAD's OID and flags while forging all
// cached stat fields and the trailing SHA-1 checksum. Ordinary status is fooled.
function forgeStatCache(f) {
  f.git('update-index', '--index-version=2');
  const file = path.join(f.checkout, 'file.txt');
  fs.writeFileSync(file, 'malicious\n'); // Same length as installed blob.
  const stat = fs.statSync(file, { bigint: true });
  const index = path.join(f.checkout, '.git/index');
  const bytes = fs.readFileSync(index);
  assert.equal(bytes.readUInt32BE(4), 2);
  assert.equal(bytes.readUInt32BE(8), 1);
  assert.equal(bytes.subarray(74, bytes.indexOf(0, 74)).toString(), 'file.txt');
  const values = [stat.ctimeNs / 1000000000n, stat.ctimeNs % 1000000000n,
    stat.mtimeNs / 1000000000n, stat.mtimeNs % 1000000000n,
    stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size];
  values.forEach((value, i) => bytes.writeUInt32BE(Number(value & 0xffffffffn), 12 + i * 4));
  require('node:crypto').createHash('sha1').update(bytes.subarray(0, -20)).digest().copy(bytes, bytes.length - 20);
  fs.writeFileSync(index, bytes);
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(index, future, future); // Ensure Git does not classify it as racy.
  assert.equal(f.git('status', '--porcelain'), '');
}

for (const phase of ['initial', 'final']) {
  test(`rejects forged index stat cache and checksum at ${phase} status`, async t => {
    const f = fixture(t);
    if (phase === 'initial') forgeStatCache(f);
    else f.setBeforeRemote(() => forgeStatCache(f));
    const before = snapshot(f.root);
    await assert.rejects(f.validate(), phase === 'initial' ? /checkout is dirty/ : /checkout became dirty/);
    if (phase === 'initial') assert.deepEqual(snapshot(f.root), before);
  });

  for (const type of ['commit', 'tree', 'blob']) {
    test(`rejects shared installed ${type} swap immediately before ${phase} status`, async t => {
      const f = fixture(t);
      const tree = f.git('rev-parse', `${f.oldSha}^{tree}`);
      const blob = f.git('rev-parse', `${f.oldSha}:file.txt`);
      const originalCommit = Buffer.from(f.git('cat-file', 'commit', f.oldSha) + '\n');
      let statuses = 0;
      let attacked = false;
      f.setOnCommand((file, args, options) => {
        if (!args.includes('status')) return;
        statuses++;
        // Every status starts from a new index with zero stat data, and uses
        // the verified store while it still exists, without shared alternates.
        const index = fs.readFileSync(options.env.GIT_INDEX_FILE);
        assert.deepEqual(index.subarray(12, 36), Buffer.alloc(24));
        const store = options.env.GIT_OBJECT_DIRECTORY;
        assert.notEqual(store, path.join(f.checkout, '.git/objects'));
        assert.ok(fs.existsSync(store));
        assert.equal(fs.existsSync(path.join(store, 'info/alternates')), false);
        assert.equal(options.env.GIT_ALTERNATE_OBJECT_DIRECTORIES, undefined);
        if (statuses !== (phase === 'initial' ? 1 : 2)) return;
        attacked = true;
        const dirty = Buffer.from('malicious\n');
        fs.writeFileSync(path.join(f.checkout, 'file.txt'), dirty);
        if (type === 'blob') {
          plantObject(f, blob, 'blob', dirty);
          forgeStatCache(f);
        }
        else {
          f.git('add', 'file.txt');
          const dirtyTree = f.git('write-tree');
          if (type === 'commit') plantObject(f, f.oldSha, 'commit',
            Buffer.from(originalCommit.toString().replace(tree, dirtyTree)));
          else plantObject(f, tree, 'tree', execFileSync('git', ['-C', f.checkout, 'cat-file', 'tree', dirtyTree], { stdio: ['ignore', 'pipe', 'pipe'] }));
        }
        // cat-file serves the forged tree bytes; some Git versions rehash
        // trees in status itself. Commit/stat-cache variants fool real status.
        if (type === 'tree') {
          assert.deepEqual(execFileSync('git', ['-C', f.checkout, 'cat-file', 'tree', tree],
            { stdio: ['ignore', 'pipe', 'pipe'] }), execFileSync('git',
            ['-C', f.checkout, 'cat-file', 'tree', f.git('write-tree')], { stdio: ['ignore', 'pipe', 'pipe'] }));
        } else assert.equal(f.git('status', '--porcelain'), '');
      });
      await assert.rejects(f.validate(), phase === 'initial' ? /checkout is dirty/ : /checkout became dirty/);
      assert.equal(attacked, true);
      const statusCommands = f.commands.filter(c => c.args.includes('status'));
      const store = statusCommands[0].options.env.GIT_OBJECT_DIRECTORY;
      for (const command of statusCommands) assert.equal(command.options.env.GIT_OBJECT_DIRECTORY, store);
      assert.equal(fs.existsSync(store), false);
    });
  }
}

for (const type of ['commit', 'tree', 'blob']) {
  test(`hash-verifies installed ${type} before the first status`, async t => {
    const f = fixture(t);
    const id = type === 'commit' ? f.oldSha : f.git('rev-parse', type === 'tree' ? `${f.oldSha}^{tree}` : `${f.oldSha}:file.txt`);
    const bytes = execFileSync('git', ['-C', f.checkout, 'cat-file', type, id], { stdio: ['ignore', 'pipe', 'pipe'] });
    let attacked = false;
    f.setOnCommand((file, args) => {
      if (attacked || !args.includes('cat-file') || !args.includes(id)) return;
      attacked = true;
      const forged = Buffer.from(bytes);
      forged[forged.length - 2] ^= 1;
      plantObject(f, id, type, forged);
    });
    await assert.rejects(f.validate(), /object hash mismatch/);
    assert.equal(attacked, true);
    assert.equal(f.commands.some(c => c.args.includes('status')), false);
  });
}

test('raw byte comparison rejects attribute-normalized worktree content', async t => {
  const f = fixture(t, 'candidate\n', { installedAttributes: 'file.txt text\n' });
  fs.writeFileSync(path.join(f.checkout, 'file.txt'), 'installed\r\n');
  f.git('add', 'file.txt');
  assert.equal(f.git('status', '--porcelain'), '');
  f.setOnCommand((file, args, options) => {
    if (args.includes('status')) assert.equal(execFileSync(file, args,
      { ...options, stdio: ['ignore', 'pipe', 'pipe'] }).trim(), '');
  });
  await assert.rejects(f.validate(), /checkout is dirty/);
  assert.equal(f.commands.filter(c => c.args.includes('status')).length, 1);
});
