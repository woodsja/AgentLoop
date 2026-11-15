'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

// Reuse the real disposable repositories and canonical approval records from
// preflight. Only the private canonical remote transport is changed to file.
const fixtureFile = require.resolve('./deploy-preflight.test');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8').split('// Compare every byte,')[0];
const stageFile = require.resolve('../src/deploy-stage');
const stageRequire = createRequire(stageFile);
const stageModule = { exports: {} };
new Function('require', 'module', 'exports', '__filename', fs.readFileSync(stageFile, 'utf8') +
  '\nmodule.exports.runLocked = runLocked;')(stageRequire, stageModule, stageModule.exports, stageFile);

function fixture(t, script = 'console.log("full candidate test stdout"); console.error("candidate stderr")', candidateAttributes) {
  const loaded = { exports: {} };
  const injected = fixtureSource.replace("fs.writeFileSync(path.join(checkout, 'file.txt'), text);", `
    fs.writeFileSync(path.join(checkout, 'file.txt'), text);
    fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'stage-fixture', version: '1.0.0', scripts: { test: 'node -e ' + JSON.stringify(npmScript) } }));
    fs.writeFileSync(path.join(checkout, 'package-lock.json'), JSON.stringify({ name: 'stage-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'stage-fixture', version: '1.0.0' } } }));
  `);
  new Function('require', 'module', 'exports', 'npmScript', injected + '\nmodule.exports = fixture;')(
    createRequire(fixtureFile), loaded, loaded.exports, script);
  const f = loaded.exports(t, 'candidate\n', { candidateAttributes });
  const worker = path.join(f.root, 'stage-worker.js');
  // Load shipping staging code with the same private local-transport validator
  // used by preflight's tests. No Git, npm, approval or filesystem gate is faked.
  fs.writeFileSync(worker, `
    const fs = require('node:fs');
    const {createRequire} = require('node:module');
    const filename = ${JSON.stringify(require.resolve('../src/deploy-preflight'))};
    const preflight = {exports:{}};
    new Function('require','module','exports', fs.readFileSync(filename,'utf8') +
      '\\nmodule.exports.validateDeploymentCandidate = (issue, options) => validateCandidate(issue, options, ' + ${JSON.stringify(JSON.stringify(f.remote))} + ');')(
        createRequire(filename),preflight,preflight.exports);
    const stageFile = ${JSON.stringify(stageFile)};
    const realRequire = createRequire(stageFile);
    const loaded = {exports:{}};
    new Function('require','module','exports','__filename', fs.readFileSync(stageFile,'utf8') + '\\nmodule.exports.prepare = prepare;')(
      name => name === './deploy-preflight' ? preflight.exports : realRequire(name),loaded,loaded.exports,stageFile);
    const {issueNumber,options} = JSON.parse(process.argv[3]);
    loaded.exports.prepare(issueNumber,options).then(result => fs.writeFileSync(1,JSON.stringify({checkpoint:result.checkpoint})))
      .catch(error => {fs.writeFileSync(2,error.stack);process.exitCode=1;});
  `);
  f.stageRoot = path.join(f.project.stateDir, 'deployment-staging');
  f.prepare = (options = {}) => stageModule.exports.runLocked(28, { configPath: f.configPath, ...options }, worker);
  f.checkpoint = () => path.join(f.stageRoot, `${f.oldSha}-${f.newSha}`, 'checkpoint.json');
  f.worker = worker;
  return f;
}
function snapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(file)) : [[file, fs.readFileSync(file).toString('base64')]];
  }));
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'fixture condition timed out'); await pause(30); }
}

test('stages exact candidate, full npm test, durable evidence and transcripts; re-entry is safe', async t => {
  const f = fixture(t);
  const before = snapshot(f.checkout);
  const result = await f.prepare();
  assert.equal(result.state, 'PREPARED');
  assert.equal(result.oldSha, f.oldSha);
  assert.equal(result.newSha, f.newSha);
  assert.equal(result.approvedEvidence.merge.commit, f.newSha);
  assert.equal((await promisify(execFile)('git', ['-C', result.repo, 'rev-parse', 'HEAD'])).stdout.trim(), f.newSha);
  assert.equal((await promisify(execFile)('git', ['-C', result.repo, 'show', `${f.oldSha}:file.txt`])).stdout, 'installed\n');
  assert.equal(fs.existsSync(path.join(result.repo, '.git/objects/info/alternates')), false);
  const records = fs.readFileSync(result.transcript, 'utf8').trim().split('\n').map(JSON.parse);
  const text = ['stdout', 'stderr'].map(stream => fs.readFileSync(path.join(result.attempt, `npm-test.${stream}`), 'utf8')).join('');
  assert.match(text, /full candidate test stdout/);
  assert.match(text, /candidate stderr/);
  assert.ok(records.some(record => record.command?.join(' ') === '/usr/bin/npm test'));
  fs.writeFileSync(path.join(result.repo, 'file.txt'), 'tampered');
  const retried = await f.prepare();
  assert.equal(retried.state, 'PREPARED');
  assert.notEqual(retried.attempt, result.attempt);
  assert.equal(fs.readFileSync(path.join(retried.repo, 'file.txt'), 'utf8'), 'candidate\n');
  assert.deepEqual(snapshot(f.checkout), before);
});

test('checkpoint evidence and SHA mismatch fail closed', async t => {
  const f = fixture(t);
  await f.prepare();
  const checkpoint = JSON.parse(fs.readFileSync(f.checkpoint(), 'utf8'));
  checkpoint.oldSha = '0'.repeat(40);
  fs.writeFileSync(f.checkpoint(), JSON.stringify(checkpoint));
  await assert.rejects(f.prepare(), /checkpoint oldSha mismatch/);
  checkpoint.oldSha = f.oldSha;
  fs.writeFileSync(f.checkpoint(), JSON.stringify(checkpoint));
  f.job.review.reviewer = 'claude:other-approved-reviewer'; f.save();
  await assert.rejects(f.prepare(), /checkpoint evidenceHash mismatch/);
});

test('candidate bytes are materialized without attribute EOL conversion', async t => {
  const f = fixture(t, undefined, 'file.txt text eol=crlf\n');
  const receipt = await f.prepare();
  assert.equal(fs.readFileSync(path.join(receipt.repo, 'file.txt'), 'utf8'), 'candidate\n');
});

test('default canonical state root survives the worker environment boundary', async t => {
  const f = fixture(t);
  const canonical = path.join(f.root, '.local/state/ralph-autopilot/ralph');
  fs.mkdirSync(canonical, { recursive: true });
  fs.copyFileSync(path.join(f.project.stateDir, 'issue-28.json'), path.join(canonical, 'issue-28.json'));
  delete f.project.stateDir; f.configure();
  const launcher = path.join(f.root, 'default-state-launcher.js');
  fs.writeFileSync(launcher, `
    const fs = require('node:fs'), {createRequire} = require('node:module');
    const filename = ${JSON.stringify(stageFile)}, loaded = {exports:{}};
    new Function('require','module','exports','__filename',fs.readFileSync(filename,'utf8') + '\\nmodule.exports.runLocked = runLocked;')(
      createRequire(filename),loaded,loaded.exports,filename);
    loaded.exports.runLocked(28,{configPath:${JSON.stringify(f.configPath)}},${JSON.stringify(f.worker)})
      .then(receipt => fs.writeFileSync(1,JSON.stringify({state:receipt.state,checkpoint:receipt.checkpoint})))
      .catch(error => {fs.writeFileSync(2,error.stack);process.exitCode=1;});
  `);
  const result = await promisify(execFile)(process.execPath, [launcher], { env: { ...process.env, HOME: f.root } });
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.state, 'PREPARED');
  assert.ok(receipt.checkpoint.startsWith(`${canonical}/deployment-staging/`));
});

for (const script of ['process.exit(7)', 'setInterval(()=>{}, 1000)']) {
  test(`failed/bounded tests never become PREPARED: ${script}`, async t => {
    const f = fixture(t, script);
    await assert.rejects(f.prepare({ timeoutMs: script.includes('setInterval') ? 1500 : 5000 }), /npm test failed/);
    const receipt = JSON.parse(fs.readFileSync(f.checkpoint(), 'utf8'));
    assert.equal(receipt.state, 'FAILED');
    assert.ok(fs.readFileSync(receipt.transcript, 'utf8').includes('exitCode'));
  });
}

test('rejects staging ancestors pointing into live checkout', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.project.stateDir, { recursive: true });
  fs.symlinkSync(f.checkout, f.stageRoot);
  await assert.rejects(f.prepare(), /unsafe directory/);
  fs.unlinkSync(f.stageRoot);
  f.project.stateDir = path.join(f.checkout, 'state'); f.configure();
  await assert.rejects(f.prepare(), /overlap/);
  assert.equal(fs.existsSync(f.project.stateDir), false);
});

test('dangling checkpoint symlink is refused without writing its live target', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.checkpoint()), { recursive: true });
  const target = path.join(f.checkout, 'must-not-create');
  fs.symlinkSync(target, f.checkpoint());
  await assert.rejects(f.prepare(), /unsafe file/);
  assert.equal(fs.existsSync(target), false);
  assert.ok(fs.lstatSync(f.checkpoint()).isSymbolicLink());
});

test('candidate symlinks fail before npm or checkout can follow them', async t => {
  const f = fixture(t);
  f.git('checkout', '-b', 'symlink-candidate');
  fs.symlinkSync(path.join(f.checkout, 'file.txt'), path.join(f.checkout, 'link'));
  f.git('add', '.'); f.git('commit', '-m', 'candidate symlink');
  const candidate = f.git('rev-parse', 'HEAD');
  f.git('push', '--force', f.remote, 'HEAD:ralph-dev');
  f.git('checkout', 'ralph-dev');
  f.job.delivery.commit = f.job.verification.commit = f.job.review.commit = f.job.ci.headCommit = candidate;
  f.job.merge.approvedHead = f.job.merge.commit = candidate;
  f.save();
  await assert.rejects(f.prepare(), /symlinks and gitlinks are unsupported/);
});

for (const script of [
  'require("fs").writeFileSync("file.txt", "changed")',
  'require("fs").appendFileSync(".git/config", "\\n[core]\\nignorecase = true\\n")',
  'require("fs").symlinkSync("/tmp", "outgoing-link")',
]) {
  test(`rejects modifications by passing tests: ${script}`, async t => {
    const f = fixture(t, script);
    await assert.rejects(f.prepare(), /tracked file changed|Git metadata changed|outgoing staging symlink/);
    assert.equal(JSON.parse(fs.readFileSync(f.checkpoint(), 'utf8')).state, 'FAILED');
  });
}

test('approval changed during npm test fails final reconciliation', async t => {
  const marker = path.join('/tmp', `stage-evidence-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(marker, { force: true }));
  const f = fixture(t, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setTimeout(()=>{}, 700)`);
  const pending = assert.rejects(f.prepare(), /candidate or evidence changed/);
  await until(() => fs.existsSync(marker));
  f.job.review.reviewer = 'claude:changed'; f.save();
  await pending;
  assert.equal(JSON.parse(fs.readFileSync(f.checkpoint(), 'utf8')).state, 'FAILED');
});

test('process crash retains exclusive lock for bounded tests; retry reconciles interrupted attempt', async t => {
  const marker = path.join('/tmp', `stage-marker-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(marker, { force: true }));
  const f = fixture(t, `const fs = require('fs'); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(()=>{}, 1000); }`);
  // Launch an actual flock worker without the API process, then SIGKILL the
  // worker during npm test. npm/timeout inherit the lock until they exit.
  fs.mkdirSync(f.stageRoot, { recursive: true });
  const fd = fs.openSync(path.join(f.stageRoot, 'prepare.lock'), 'a+');
  const child = spawn('/bin/sh', ['-c', '/usr/bin/flock -n 3 || exit 75\nexec "$@"', 'stage-lock',
    process.execPath, f.worker, '--stage-worker', JSON.stringify({ issueNumber: 28, options: { configPath: f.configPath, timeoutMs: 2500 } })],
  { stdio: ['ignore', 'ignore', 'ignore', fd] });
  fs.closeSync(fd);
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await until(() => fs.existsSync(marker));
  await assert.rejects(f.prepare(), /lock busy/);
  child.kill('SIGKILL');
  await pause(80);
  await assert.rejects(f.prepare(), /lock busy/);
  await pause(2800);
  assert.equal(JSON.parse(fs.readFileSync(f.checkpoint(), 'utf8')).state, 'PREPARING');
  const receipt = await f.prepare();
  assert.equal(receipt.state, 'PREPARED');
});

test('public surface only exposes prepare; preflight failure cannot stage an unapproved candidate', async t => {
  assert.deepEqual(Object.keys(require('../src/deploy-stage')), ['prepareDeploymentCandidate']);
  const f = fixture(t);
  f.job.review.reviewer = 'codex:invalid';
  fs.writeFileSync(path.join(f.project.stateDir, 'issue-28.json'), JSON.stringify(f.job));
  await assert.rejects(f.prepare(), /approved MERGED evidence/);
  // This shipping public-worker call fails before any Git or remote observation.
  await assert.rejects(require('../src/deploy-stage').prepareDeploymentCandidate(28, { configPath: f.configPath }), /approved MERGED evidence/);
  assert.equal(fs.existsSync(f.checkpoint()), false);
});
