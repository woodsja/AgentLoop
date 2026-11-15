'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { fixture, stageFile } = require('./helpers/deploy-stage-fixture');
process.env.RALPH_STAGE_TEST_AUDIT_DIR ||= path.resolve(__dirname, '../state/verification-reports/deploy-stage-integration-records');

test('shipping worker stages the real Ralph npm ci and complete npm test offline', { timeout: 2400000 }, async t => {
  const f = fixture(t);
  const { execFileSync } = require('node:child_process');
  const root = path.resolve(__dirname, '..');
  fs.rmSync(f.checkout, { recursive: true, force: true });
  execFileSync('/usr/bin/git', ['clone', '--local', '--no-hardlinks', root, f.checkout], { stdio: ['ignore', 'pipe', 'pipe'] });
  f.git('config', 'user.name', 'Staging Integration');
  f.git('config', 'user.email', 'stage@example.invalid');
  f.git('config', 'commit.gpgsign', 'false');
  f.git('checkout', '-B', 'ralph-dev');
  f.oldSha = f.git('rev-parse', 'HEAD');
  // Include uncommitted corrections in the disposable candidate, retaining the
  // real package, lockfile, suite, and all reachable evidence history.
  const tracked = execFileSync('/usr/bin/git', ['-C', root, 'ls-files', '-z'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().split('\0').filter(Boolean);
  for (const name of tracked) {
    fs.mkdirSync(path.dirname(path.join(f.checkout, name)), { recursive: true });
    fs.copyFileSync(path.join(root, name), path.join(f.checkout, name));
  }
  for (const name of ['test/deploy-stage.integration.test.js', 'test/helpers/deploy-stage-fixture.js', 'test/deploy-stage.copy-benchmark.test.js']) {
    fs.mkdirSync(path.dirname(path.join(f.checkout, name)), {recursive:true});
    fs.copyFileSync(path.join(root,name),path.join(f.checkout,name));
  }
  fs.writeFileSync(path.join(f.checkout, 'staging-integration-marker'), 'candidate\n');
  f.git('add', '.'); f.git('commit', '-m', 'real Ralph staging candidate');
  f.newSha = f.git('rev-parse', 'HEAD');
  fs.rmSync(f.remote, { recursive: true, force: true });
  execFileSync('/usr/bin/git', ['clone', '--bare', '--local', '--no-hardlinks', f.checkout, f.remote], { stdio: ['ignore', 'pipe', 'pipe'] });
  f.git('remote', 'set-url', 'origin', 'git@github.com:woodsja/AgentLoop.git');
  f.git('reset', '--hard', f.oldSha);
  // Materialize raw committed bytes, bypassing *.cmd CRLF checkout conversion.
  const entries = execFileSync('/usr/bin/git', ['-C', f.checkout, 'ls-files', '--stage', '-z'], {stdio:['ignore','pipe','pipe']}).toString().split('\0').filter(Boolean);
  for (const entry of entries) {
    const tab = entry.indexOf('\t'), name = entry.slice(tab + 1);
    const [mode, oid] = entry.slice(0, tab).split(' ');
    const file = path.join(f.checkout, name), bytes = fs.readFileSync(file);
    const actual = require('node:crypto').createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
    if (actual !== oid) fs.writeFileSync(file, execFileSync('/usr/bin/git', ['-C', f.checkout, 'cat-file', 'blob', oid], {stdio:['ignore','pipe','pipe']}));
    assert.equal(Boolean(fs.statSync(path.join(f.checkout, name)).mode & 0o111), mode === '100755', name + ' installed mode');
  }
  f.job.delivery.commit = f.job.verification.commit = f.job.review.commit = f.job.ci.headCommit = f.newSha;
  f.job.merge.approvedHead = f.job.merge.commit = f.newSha; f.save();
  // Only the canonical remote observation is redirected to a real local bare
  // repository. No validator, worker, Git output, npm command or test is faked.
  const preload = path.join(f.root, 'local-transport.cjs');
  fs.writeFileSync(preload, `
    const cp = require('node:child_process'), {promisify} = require('node:util');
    const original = cp.execFile, launch = cp.spawn;
    function translate(file, args, options) {
      if (args.includes('ls-remote') && args.includes('https://github.com/woodsja/AgentLoop.git')) {
        args = args.map(arg => arg === 'https://github.com/woodsja/AgentLoop.git' ? ${JSON.stringify(f.remote)} : arg);
        options = {...options, env: {...options.env, GIT_ALLOW_PROTOCOL: 'file'}};
      }
      return [file, args, options];
    }
    cp.execFile = (file,args,options,callback) => original(...translate(file,args,options),callback);
    cp.execFile[promisify.custom] = (file,args,options) => promisify(original)(...translate(file,args,options));
    cp.spawn = (file,args,options) => {
      const index = args.indexOf(${JSON.stringify(stageFile)});
      if (file === '/bin/sh' && index >= 0) args = [...args.slice(0,index), '--require', ${JSON.stringify(preload)}, ...args.slice(index)];
      return launch(file,args,options);
    };
  `);
  const launcher = `require(${JSON.stringify(stageFile)}).prepareDeploymentCandidate(28, {configPath:${JSON.stringify(f.configPath)},timeoutMs:1800000})
    .then(receipt=>require('node:fs').writeFileSync(1,JSON.stringify(receipt))).catch(error=>{require('node:fs').writeFileSync(2,error.stack);process.exitCode=1;});`;
  let result;
  try {
    result = await promisify(execFile)(process.execPath, ['--require', preload, '-e', launcher], {
      timeout: 2340000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    function diagnostics(directory) {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && entry.name !== 'repo' && entry.name !== 'home') diagnostics(file);
        else if (/worker\.stderr|npm-.*\.(stdout|stderr)|checkpoint\.json/.test(entry.name)) t.diagnostic(file + '\n' + fs.readFileSync(file, 'utf8'));
      }
    }
    diagnostics(f.stageRoot);
    throw error;
  }
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.state, 'PREPARED');
  assert.equal(receipt.newSha, f.newSha);
  const output = fs.readFileSync(path.join(receipt.attempt, 'npm-test.stdout'), 'utf8');
  assert.match(output, /python|uv/);
  assert.match(output, /stages exact candidate/);
  assert.equal(fs.readFileSync(path.join(receipt.repo, 'package.json'), 'utf8'), fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const records = fs.readFileSync(receipt.transcript, 'utf8').trim().split('\n').map(JSON.parse);
  const lookup = records.find(record => record.command?.includes('--git-path'));
  assert.ok(lookup.command.includes('objects'));
  assert.equal(fs.readFileSync(lookup.stdout, 'utf8').trim(), path.join(f.checkout, '.git/objects'));
  assert.equal(fs.readFileSync(lookup.stderr, 'utf8'), '');
  const launch = records.find(record => record.environment);
  assert.ok(launch.environment.PATH.endsWith('/.local/bin'));
  t.diagnostic(JSON.stringify({ productionWorker: stageFile, state: receipt.state, oldSha: f.oldSha, newSha: f.newSha,
    environment: launch.environment, npmStdoutBytes: Buffer.byteLength(output),
    npmStdoutSha256: require('node:crypto').createHash('sha256').update(output).digest('hex'),
    copiedObjects: records.find(record => record.historyCopy).historyCopy }));
});
