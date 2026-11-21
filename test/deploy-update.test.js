'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Real Step 13 staging, local Git remote and canonical review/CI fixtures.
const loaded = { exports: require('./deploy-stage-fixture').fixture };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, mode = 'good', beforePrepare = () => {}, extra = {}) {
  const f = loaded.exports(t, undefined, undefined, extra);
  beforePrepare(f);
  // Manual bootstrap copies into a NEW disposable install; the source keeps all
  // issue refs, reflogs and worktrees. Future candidate objects stay in source.
  f.sourceCheckout = f.checkout;
  f.sourceGit = f.git;
  const install = path.join(f.root, 'deployment');
  fs.mkdirSync(install);
  const installGit = (...args) => require('node:child_process').execFileSync('/usr/bin/git',['-C',install,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  installGit('init','--template=','--initial-branch=ralph-dev');
  installGit('config','core.logallrefupdates','false');
  fs.cpSync(path.join(f.sourceCheckout,'.git/objects'),path.join(install,'.git/objects'),{recursive:true});
  installGit('update-ref','refs/heads/ralph-dev',f.oldSha);
  installGit('read-tree','--reset','-u',f.oldSha);
  installGit('remote','add','origin','git@github.com:woodsja/AgentLoop.git');
  for (const ref of installGit('for-each-ref','--format=%(refname)').split('\n')) if(ref !== 'refs/heads/ralph-dev') installGit('update-ref','-d',ref);
  for (const name of fs.readdirSync(path.join(install,'.git'))) if (!['HEAD','config','index','objects','refs'].includes(name)) fs.rmSync(path.join(install,'.git',name),{recursive:true,force:true});
  installGit('config','core.logallrefupdates','false');
  fs.writeFileSync(path.join(install,'.git/deployment-only'),'disposable-deployment-v1\n');
  f.checkout = install; f.git = installGit;
  const deploymentConfigPath = path.join(f.root,'deployment.json');
  fs.writeFileSync(deploymentConfigPath,JSON.stringify({contract:'step14-layout-v1',lockProtocol:'deployment-lock-v1',sourceCheckout:f.sourceCheckout,installedCheckout:install,projectConfigFile:f.configPath}));
  f.deploymentConfigPath = deploymentConfigPath;
  const prepare = f.prepare;
  f.prepare = (opts = {}) => prepare({deploymentConfigPath,...opts});
  const receipt = await f.prepare();
  f.receipt = receipt;
  const control = path.join(f.root, 'service.json');
  fs.writeFileSync(control, JSON.stringify({ pid: 0, mode, restarts: 0 }));
  const runner = path.join(f.root, 'fake-service.js');
  // Scoped fake service: no systemctl, network, unit installation or owner files.
  fs.writeFileSync(runner, `
    const fs = require('fs'), {spawn} = require('child_process');
    const file = ${JSON.stringify(control)}, live = ${JSON.stringify(f.checkout)};
    const state = JSON.parse(fs.readFileSync(file));
    const action = process.argv[2];
    if (action === 'check' && state.mode === 'invalidbootstrap') throw Error('bounded JobTimeoutSec=1..60 bootstrap required');
    if (action === 'restart') {
      if (state.pid && state.mode !== 'samepid') { try { process.kill(state.pid, 'SIGKILL'); } catch {} }
      if (state.mode !== 'samepid' || !state.pid) {
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);setTimeout(()=>process.exit(),120000)'], {stdio:'ignore'});
        state.pid = child.pid; child.unref();
      }
      state.restarts++;
      fs.writeFileSync(file, JSON.stringify(state));
    }
    const candidate = fs.existsSync(live + '/file.txt') && fs.readFileSync(live + '/file.txt','utf8') === 'candidate\\n';
    if (action === 'restart' && state.mode === 'slowrestart' && state.restarts > 1) setInterval(()=>{},1000);
    fs.writeSync(1, JSON.stringify({pid:state.pid, active:true, healthy:state.mode !== 'badall' && !(state.restarts === 2 && state.mode === 'badnew')}));
  `);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, 'restart'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('fake service bootstrap failed: ' + code)));
  });
  const pids = new Set([JSON.parse(fs.readFileSync(control)).pid]);
  t.after(() => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  const worker = path.join(f.root, 'update-worker.js');
  const implementation = require.resolve('../src/deploy-update');
  fs.writeFileSync(worker, `
    const fs = require('fs');
    const filename = ${JSON.stringify(implementation)}, loaded = {exports:{}};
    loaded.exports = require(filename).testing;
    const service = async (action, command) => JSON.parse((await command(process.execPath,
      [${JSON.stringify(runner)},action])).toString());
    let faulted = false;
    const rename = fs.renameSync;
    fs.renameSync = (from,to) => {
      if (!faulted && process.argv[2] === 'renamefail:' + require('path').basename(from)) { faulted = true; throw Error('injected rename failure'); }
      return rename(from,to);
    };
    loaded.exports.update(process.argv[3],service,phase => {
      if (!faulted && process.argv[2] === 'throw:' + phase) { faulted = true; throw Error('injected phase fault'); }
      if (!faulted && process.argv[2] === 'settingsfail:' + phase) { faulted = true; fs.appendFileSync(${JSON.stringify(f.configPath)}, ' '); }
      if (!faulted && process.argv[2] === 'tamper:' + phase) { faulted = true;
        const target = phase === 'RESTARTING' ? ${JSON.stringify(f.checkout)} : ${JSON.stringify(receipt.repo)};
        fs.writeFileSync(target + '/file.txt', 'changed during swap');
      }
      if (phase === 'RESTARTED' && process.argv[2] === 'mutate') {
        fs.writeFileSync(${JSON.stringify(f.checkout + '/file.txt')}, 'candidate wrote this');
        fs.writeFileSync(${JSON.stringify(f.checkout + '/.git/config')}, 'broken candidate metadata');
      }
      if (phase === process.argv[2]) process.kill(process.pid,'SIGKILL');
    }, {healthMs:1500, ...(process.argv[2] === 'budget' ? {workBytes:1} : {})}).then(result => fs.writeSync(1,JSON.stringify(result))).catch(error => {fs.writeSync(2,error.stack);process.exitCode=1;});
  `);
  let invocation = 0;
  f.run = crash => new Promise(resolve => {
    const run = ++invocation;
    const fd = fs.openSync(path.join(f.stageRoot, 'deployment.lock'), 'a+');
    const child = spawn('/bin/sh', ['-c', '/usr/bin/flock -n 3 || exit 75\nexec "$@"', 'test-update',
      process.execPath, worker, crash || '', f.receipt.checkpoint], { stdio: ['ignore', 'pipe', 'pipe', fd] });
    fs.closeSync(fd);
    f.activeWorker = child;
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('close', (code, signal) => {
      if (process.env.RALPH_DEPLOY_TEST_AUDIT_DIR) {
        const prefix = path.join(path.dirname(f.receipt.checkpoint), `caller-${run}`);
        fs.writeFileSync(prefix + '.stdout', stdout); fs.writeFileSync(prefix + '.stderr', stderr);
        fs.writeFileSync(prefix + '.json', JSON.stringify({ crash, code, signal }));
      }
      pids.add(JSON.parse(fs.readFileSync(control)).pid); resolve({ code, signal, stdout, stderr });
    });
  });
  f.service = () => JSON.parse(fs.readFileSync(control));
  f.mode = mode => fs.writeFileSync(control, JSON.stringify({ ...f.service(), mode }));
  f.journal = () => JSON.parse(fs.readFileSync(path.join(path.dirname(f.receipt.checkpoint), 'update.json')));
  f.head = () => f.git('rev-parse', 'HEAD');
  return f;
}
function success(result) { assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout); }

test('sealed PREPARED installs exact SHA, proves new real fake-daemon PID and bounded health; idempotent', async t => {
  const f = await fixture(t);
  const oldPid = f.service().pid;
  const result = success(await f.run());
  assert.equal(result.state, 'DEPLOYED');
  assert.notEqual(result.newPid, oldPid);
  assert.equal(result.newPid, f.service().pid);
  assert.doesNotThrow(() => process.kill(result.newPid, 0));
  assert.equal(f.head(), f.newSha);
  assert.equal(f.service().restarts, 2);
  assert.equal(success(await f.run()).state, 'DEPLOYED');
  assert.equal(f.service().restarts, 2);
  const records = fs.readFileSync(path.join(path.dirname(f.receipt.checkpoint), 'update.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(records.filter(record => record.health?.pid === result.newPid).length >= 2);
  assert.ok(records.some(record => record.command));
  assert.ok(records.some(record => record.stream === 'stdout' && record.encoding === 'base64'));
});

test('unhealthy candidate rolls back exact old SHA and proves rollback restart with fresh PID', async t => {
  const f = await fixture(t, 'badnew');
  const result = success(await f.run());
  assert.equal(result.state, 'ROLLED_BACK');
  assert.equal(f.head(), f.oldSha);
  assert.notEqual(result.rollbackPid, result.oldPid);
  assert.equal(f.service().restarts, 3);
  assert.equal(success(await f.run()).state, 'ROLLED_BACK');
  assert.equal(f.service().restarts, 3);
});

test('same PID never passes health; rollback health failure is durably FAILED', async t => {
  const f = await fixture(t, 'samepid');
  const result = await f.run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /fresh PID/);
  assert.equal(f.head(), f.oldSha);
  assert.equal(f.journal().state, 'FAILED');
  assert.equal(success(await f.run()).state, 'FAILED');
});

for (const crash of ['READY', 'SWAPPING', 'rename:deployment', 'rename:repo', 'RESTARTING', 'RESTARTED']) {
  test(`SIGKILL at ${crash}: resume reconciles swaps and restarts`, async t => {
    const f = await fixture(t);
    assert.equal((await f.run(crash)).signal, 'SIGKILL');
    assert.equal(success(await f.run()).state, 'DEPLOYED');
    assert.equal(f.head(), f.newSha);
  });
}
for (const crash of ['ROLLING_BACK', 'rename:deployment', 'ROLLBACK_RESTART', 'ROLLBACK_RESTARTED']) {
  test(`rollback crash at ${crash}: retained old installation recovers`, async t => {
    const f = await fixture(t, 'badnew');
    // rename:deployment first occurs during forward swap; resume then kills in rollback.
    assert.equal((await f.run(crash)).signal, 'SIGKILL');
    if (crash === 'rename:deployment') assert.equal((await f.run(crash)).signal, 'SIGKILL');
    assert.equal(success(await f.run()).state, 'ROLLED_BACK');
    assert.equal(f.head(), f.oldSha);
  });
}

for (const alteration of ['candidate', 'installed', 'config', 'review', 'ci', 'receipt', 'ownerfile']) {
  test(`refuses ${alteration} tampering before service restart`, async t => {
    const f = await fixture(t);
    if (alteration === 'candidate') fs.writeFileSync(path.join(f.receipt.repo, 'file.txt'), 'tampered');
    if (alteration === 'installed') fs.writeFileSync(path.join(f.checkout, 'file.txt'), 'dirty');
    if (alteration === 'config') fs.appendFileSync(f.configPath, ' ');
    if (alteration === 'review') { f.job.review.reviewer = 'codex:not-independent'; f.save(); }
    if (alteration === 'ci') { f.job.ci.runs = []; f.save(); }
    if (alteration === 'receipt') { const r = { ...f.receipt, state: 'FAILED' }; fs.writeFileSync(f.receipt.checkpoint, JSON.stringify(r)); }
    if (alteration === 'ownerfile') fs.writeFileSync(path.join(f.checkout, 'config.local.json'), '{}');
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert.equal(f.service().restarts, 1);
    assert.equal(f.head(), f.oldSha);
  });
}

test('deployment lock excludes another updater and staging', async t => {
  const f = await fixture(t);
  const fd = fs.openSync(path.join(f.stageRoot, 'deployment.lock'), 'a+');
  const holder = spawn('/bin/sh', ['-c', '/usr/bin/flock -n 3 || exit 75\necho locked\nread line'], { stdio: ['pipe', 'pipe', 'pipe', fd] });
  fs.closeSync(fd);
  await new Promise(resolve => holder.stdout.once('data', resolve));
  try {
    assert.equal((await f.run()).code, 75);
    await assert.rejects(f.prepare(), /lock busy/);
    assert.equal(f.service().restarts, 1);
  } finally { holder.stdin.end('\n'); await new Promise(resolve => holder.on('close', resolve)); }
  assert.equal(success(await f.run()).state, 'DEPLOYED');
});

test('production adapter is pinned to agentloop.service, checks unit identity and API PID', async t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'update-adapter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = root + '-config.json';
  t.after(() => fs.rmSync(configFile, { force: true }));
  fs.writeFileSync(configFile, JSON.stringify({ dashboardPort: 12345 }));
  const filename = require.resolve('../src/deploy-update');
  const loaded = { exports: {} };
  loaded.exports = require(filename).testing;
  const projectFile = root + '-projects.json';
  fs.writeFileSync(projectFile, '{}');
  t.after(() => fs.rmSync(projectFile, { force: true }));
  const identity = { path: projectFile, hash: require('../src/deploy-files').hash(fs.readFileSync(projectFile)) };
  const adapter = (action, command, live) => loaded.exports.systemd(action, command, live, undefined, identity);
  const calls = [];
  let apiPid = 123;
  let apiError = false;
  let apiConfig = { pathHash: require('../src/deploy-files').hash(identity.path), hash: identity.hash };
  let unitProjectsPath = projectFile;
  let unitRoot = root;
  let stateRoot = root + '-runtime';
  fs.mkdirSync(stateRoot); t.after(() => fs.rmSync(root + '-runtime', { recursive: true, force: true }));
  const command = async (file, args) => {
    calls.push([file, args]);
    if (file === '/usr/bin/systemctl') {
      assert.equal(args[2], 'agentloop.service');
      if (args[1] === 'restart') return Buffer.alloc(0);
      return Buffer.from(`MainPID=123\nActiveState=active\nSubState=running\nResult=success\nWorkingDirectory=${unitRoot}\nExecStart={ path=${process.execPath} ; argv[]=${process.execPath} ${unitRoot}/src/daemon.js ; ignore_errors=no ; }\nEnvironment=AGENTLOOP_STATE_DIR=${stateRoot} AGENTLOOP_CONFIG_PATH=${configFile} AGENTLOOP_PROJECTS_PATH=${unitProjectsPath}\n`);
    }
    assert.equal(file, process.execPath);
    if (args[1] === 'restart' || args[1] === 'settle') {
      assert.equal(args[0],require.resolve('../src/deploy-systemd-guardian')); return Buffer.alloc(0);
    }
    assert.equal(args[0], '-e');
    assert.match(args[1], /host:'127.0.0.1'/);
    assert.match(args[1], /path:'\/api\/state'/);
    assert.match(args[1], /setTimeout\(1000/);
    assert.equal(args[2], '12345');
    if (apiError) throw new Error('API timeout');
    return Buffer.from(JSON.stringify({ daemon: { alive: true, pid: apiPid, projectConfig: apiConfig } }));
  };
  assert.equal((await adapter('status', command, root)).healthy, true);
  apiConfig = { ...apiConfig, hash: '0'.repeat(64) };
  assert.equal((await adapter('status', command, root)).healthy, false);
  apiConfig = {pathHash:require('../src/deploy-files').hash(identity.path),hash:identity.hash};
  unitProjectsPath = projectFile + '-wrong';
  await assert.rejects(adapter('status', command, root), /project configuration identity mismatch/);
  unitProjectsPath = root+'/other/../projects.json';
  await assert.rejects(adapter('status', command, root), /canonical absolute/);
  unitProjectsPath = projectFile;
  fs.appendFileSync(projectFile,' ');
  await assert.rejects(adapter('status', command, root), /owner project configuration changed/);
  fs.writeFileSync(projectFile,'{}');
  apiPid = 456;
  assert.equal((await adapter('status', command, root)).healthy, false);
  apiError = true;
  assert.equal((await adapter('status', command, root)).healthy, false);
  unitRoot = '/unexpected/checkout';
  await assert.rejects(adapter('status', command, root), /unexpected agentloop service command/);
  unitRoot = root; stateRoot = root + '/state';
  await assert.rejects(adapter('status', command, root), /bootstrap required/);
  await loaded.exports.systemd('restart', command, root);
  assert.equal(calls.at(-1)[0], process.execPath);
  assert.equal(calls.at(-1)[1][1], 'restart');
  await assert.rejects(loaded.exports.systemd('reboot', command, root), /unsupported service action/);
});

test('owner settings excluded only by Git metadata cannot bypass the preparation dirty gate', async t => {
  const f = loaded.exports(t);
  fs.appendFileSync(path.join(f.checkout, '.git/info/exclude'), '\nconfig.local.json\n');
  fs.writeFileSync(path.join(f.checkout, 'config.local.json'), '{"owner":"keep"}');
  await assert.rejects(f.prepare(), /checkout is dirty/);
  assert.equal(fs.readFileSync(path.join(f.checkout, 'config.local.json'), 'utf8'), '{"owner":"keep"}');
});

test('independent raw-byte check rejects a dirty checkout even if its inventory seal matches', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.checkout, 'file.txt'), 'uncommitted owner change');
  const receipt = JSON.parse(fs.readFileSync(f.receipt.checkpoint));
  receipt.installedHash = require('../src/deploy-files').inventory(f.checkout);
  fs.writeFileSync(f.receipt.checkpoint, JSON.stringify(receipt));
  const result = await f.run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /dirty tracked bytes/);
  assert.equal(f.service().restarts, 1);
});

test('independently refuses an approved merge whose first parent is not the installed SHA', async t => {
  const f = await fixture(t);
  f.git('reset', '--hard', f.job.delivery.commit);
  fs.rmSync(path.join(f.checkout, '.git/ORIG_HEAD'), { force: true });
  const receipt = JSON.parse(fs.readFileSync(f.receipt.checkpoint));
  const previousCheckpoint = f.receipt.checkpoint;
  const previousLocation = path.dirname(previousCheckpoint);
  receipt.oldSha = f.job.delivery.commit;
  receipt.deploymentKey = `${receipt.oldSha}-${receipt.newSha}`;
  receipt.installedHash = require('../src/deploy-files').inventory(f.checkout);
  const location = path.join(f.stageRoot, `${receipt.oldSha}-${receipt.newSha}`);
  fs.renameSync(previousLocation, location);
  receipt.attempt = path.join(location, path.basename(receipt.attempt));
  receipt.repo = path.join(receipt.attempt, 'repo');
  const checkpoint = path.join(location, 'checkpoint.json');
  fs.writeFileSync(checkpoint, JSON.stringify(receipt));
  f.receipt = { ...receipt, checkpoint };
  const result = await f.run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unexpected deployment ancestry/);
  assert.equal(f.service().restarts, 1);
});

test('owner project configuration inside installation fails closed without publishing it', async t => {
  const f = await fixture(t);
  const receipt = JSON.parse(fs.readFileSync(f.receipt.checkpoint));
  const file = path.join(f.checkout, 'autopilot-projects.json');
  fs.copyFileSync(f.configPath, file);
  receipt.configFile = file;
  fs.writeFileSync(f.receipt.checkpoint, JSON.stringify(receipt));
  const before = fs.readFileSync(file);
  assert.match((await f.run()).stderr, /external owner project configuration/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(f.service().restarts, 1);
});

test('crash after restoring backup but before rollback restart reconciles exact old SHA', async t => {
  const f = await fixture(t, 'badnew');
  assert.equal((await f.run(`rename:deployment.rollback-${f.oldSha}-${f.newSha}`)).signal, 'SIGKILL');
  assert.equal(f.journal().phase, 'ROLLING_BACK');
  assert.equal(f.head(), f.oldSha);
  assert.equal(success(await f.run()).state, 'ROLLED_BACK');
});

test('worker death during a pending command retains exclusive lock until bounded command exits', async t => {
  const f = await fixture(t, 'slowrestart');
  const pending = f.run();
  const deadline = Date.now() + 10000;
  while (f.service().restarts < 2) {
    assert.ok(Date.now() < deadline, 'restart was not reached');
    await pause(30);
  }
  f.activeWorker.kill('SIGKILL');
  assert.equal((await pending).signal, 'SIGKILL');
  assert.equal((await f.run()).code, 75);
  f.mode('good');
  await pause(5200);
  assert.equal(success(await f.run()).state, 'DEPLOYED');
});

for (const fault of ['throw:rename:deployment', 'throw:rename:repo', 'throw:RESTARTING', 'renamefail:repo', 'settingsfail:rename:deployment', 'settingsfail:rename:repo', 'tamper:rename:deployment', 'tamper:RESTARTING']) {
  test(`observed ${fault} durably restores old checkout`, async t => {
    const f = await fixture(t);
    const old = require('../src/deploy-files').inventory(f.checkout);
    const result = success(await f.run(fault));
    assert.equal(result.state, 'ROLLED_BACK');
    assert.equal(f.head(), f.oldSha);
    assert.equal(require('../src/deploy-files').inventory(f.checkout), old);
    const journalFile = path.join(path.dirname(f.receipt.checkpoint), 'update.json');
    const before = fs.readFileSync(journalFile);
    if (fault.startsWith('settingsfail:')) assert.notEqual((await f.run()).code, 0);
    else assert.equal(success(await f.run()).state, 'ROLLED_BACK');
    assert.deepEqual(fs.readFileSync(journalFile), before);
  });
}
test('running rejected candidate may change tracked files and .git; rollback retains exact evidence', async t => {
  const f = await fixture(t, 'badall');
  // Initial old service must be healthy; switch only after preparation in fake runner.
  f.mode('badnew');
  const result = success(await f.run('mutate'));
  assert.equal(result.state, 'ROLLED_BACK');
  assert.equal(f.head(), f.oldSha);
  assert.equal(fs.readFileSync(path.join(result.rejected, '.git/config'), 'utf8'), 'broken candidate metadata');
  assert.equal(fs.readFileSync(path.join(result.rejected, 'file.txt'), 'utf8'), 'candidate wrote this');
});
for (const mode of ['good', 'badnew', 'samepid']) {
  test(`terminal ${mode} journal remains byte-identical after tree and identity changes`, async t => {
    const f = await fixture(t, mode);
    await f.run();
    const file = path.join(path.dirname(f.receipt.checkpoint), 'update.json');
    const before = fs.readFileSync(file);
    fs.appendFileSync(path.join(f.checkout, '.git/config'), '\n# runtime change');
    success(await f.run());
    assert.deepEqual(fs.readFileSync(file), before);
    const receipt = JSON.parse(fs.readFileSync(f.receipt.checkpoint)); receipt.installedHash = 'changed';
    fs.writeFileSync(f.receipt.checkpoint, JSON.stringify(receipt));
    assert.notEqual((await f.run()).code, 0);
    assert.deepEqual(fs.readFileSync(file), before);
  });
}
for (const metadata of ['branch', 'stash', 'hook', 'reflog', 'exclude', 'linked-worktree']) {
  test(`owner ${metadata} metadata is refused and preserved`, async t => {
    const f = await fixture(t);
    if (metadata === 'branch') f.git('branch', 'owner-branch');
    if (metadata === 'stash') f.git('update-ref', 'refs/stash', f.oldSha);
    if (metadata === 'hook') { fs.mkdirSync(path.join(f.checkout, '.git/hooks')); fs.writeFileSync(path.join(f.checkout, '.git/hooks/pre-commit'), 'owner hook'); }
    if (metadata === 'reflog') { fs.mkdirSync(path.join(f.checkout, '.git/logs')); fs.writeFileSync(path.join(f.checkout, '.git/logs/HEAD'), 'owner history'); }
    if (metadata === 'exclude') { fs.mkdirSync(path.join(f.checkout, '.git/info')); fs.writeFileSync(path.join(f.checkout, '.git/info/exclude'), 'owner.json'); }
    if (metadata === 'linked-worktree') f.git('worktree', 'add', '--detach', path.join(f.root, 'owner-worktree'), f.oldSha);
    const before = require('../src/deploy-files').inventory(f.checkout);
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert.equal(f.service().restarts, 1);
    assert.equal(require('../src/deploy-files').inventory(f.checkout), before);
    if (metadata === 'linked-worktree') assert.ok(fs.existsSync(path.join(f.root, 'owner-worktree/.git')));
  });
}
test('resume with changed approval after first rename restores backup', async t => {
  const f = await fixture(t);
  assert.equal((await f.run('rename:deployment')).signal, 'SIGKILL');
  f.job.review.reviewer = 'claude:changed'; f.save();
  assert.equal(success(await f.run()).state, 'ROLLED_BACK');
  assert.equal(f.head(), f.oldSha);
});
test('cgroup rejection and inventory resource bounds are fail closed', () => {
  const filename = require.resolve('../src/deploy-update'); const loaded = { exports: {} };
  loaded.exports = require(filename).testing;
  assert.throws(() => loaded.exports.outsideService('0::/user.slice/agentloop.service/child'), /cgroup/);
  assert.doesNotThrow(() => loaded.exports.outsideService('0::/user.slice/manual.scope'));
});
test('audit quota refuses further work without truncating existing evidence', async t => {
  const f = await fixture(t);
  const log = path.join(path.dirname(f.receipt.checkpoint), 'update.jsonl');
  const fd = fs.openSync(log, 'w'); fs.writeSync(fd, 'retained evidence'); fs.ftruncateSync(fd, 128 * 1024 * 1024); fs.closeSync(fd);
  assert.match((await f.run()).stderr, /audit budget exhausted/);
  assert.equal(fs.statSync(log).size, 128 * 1024 * 1024);
  assert.equal(fs.readFileSync(log).subarray(0,17).toString(), 'retained evidence');
  assert.equal(f.service().restarts, 1);
});

test('legacy staging lock and old receipt contract cannot mix with updater', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.stageRoot, 'prepare.lock'), '');
  assert.match((await f.run()).stderr, /legacy preparation lock/);
  assert.equal(f.service().restarts, 1);
  fs.unlinkSync(path.join(f.stageRoot, 'prepare.lock'));
  const r = JSON.parse(fs.readFileSync(f.receipt.checkpoint)); delete r.updaterContract;
  fs.writeFileSync(f.receipt.checkpoint, JSON.stringify(r));
  assert.notEqual((await f.run()).code, 0);
  assert.equal(f.service().restarts, 1);
});

test('aggregate raw command output limit stops verification and preserves all captured chunks', async t => {
  const f = await fixture(t);
  const result = await f.run('budget');
  assert.notEqual(result.code, 0);
  assert.equal(f.service().restarts, 1);
  assert.equal(f.head(), f.oldSha);
  const records = fs.readFileSync(path.join(path.dirname(f.receipt.checkpoint), 'update.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(records.some(r => r.encoding === 'base64' && Buffer.from(r.bytes, 'base64').includes(Buffer.from('refs/heads/ralph-dev'))));
});
test('inventory rejects oversized files before reading them', t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'update-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fd = fs.openSync(path.join(root, 'oversized'), 'w'); fs.ftruncateSync(fd, 513 * 1024 * 1024); fs.closeSync(fd);
  assert.throws(() => require('../src/deploy-files').inventory(root), /inventory byte budget/);
});

test('ignored config.json and autopilot-projects.json are refused intact, never published', async t => {
  const f = await fixture(t, 'good', f => {
    f.git('checkout', '-b', 'deployment-layout', f.oldSha);
    fs.writeFileSync(path.join(f.checkout, '.gitignore'), 'config.json\nautopilot-projects.json\n');
    f.git('add', '.gitignore'); f.git('commit', '-m', 'disposable layout');
    f.oldSha = f.git('rev-parse', 'HEAD');
    f.git('checkout', 'ralph-dev'); f.git('reset', '--hard', f.oldSha);
    f.git('merge', '--no-ff', 'ralph/issue-28', '-m', 'layout merge');
    f.newSha = f.git('rev-parse', 'HEAD');
    f.publish(); f.git('reset', '--hard', f.oldSha);
    f.job.merge.commit = f.newSha; f.save();
  });
  for (const name of ['config.json', 'autopilot-projects.json']) fs.writeFileSync(path.join(f.checkout, name), '{"owner":"private"}');
  const receipt = JSON.parse(fs.readFileSync(f.receipt.checkpoint));
  receipt.installedHash = require('../src/deploy-files').inventory(f.checkout);
  fs.writeFileSync(f.receipt.checkpoint, JSON.stringify(receipt));
  assert.match((await f.run()).stderr, /unmanaged owner files/);
  for (const name of ['config.json', 'autopilot-projects.json']) {
    assert.equal(fs.readFileSync(path.join(f.checkout, name), 'utf8'), '{"owner":"private"}');
    assert.equal(f.git('ls-files', name), '');
    assert.equal(fs.existsSync(path.join(f.receipt.repo, name)), false);
  }
  assert.equal(f.service().restarts, 1);
});

test('invalid journal phase and mismatched journal identity are refused without rewriting bytes', async t => {
  const f = await fixture(t);
  success(await f.run());
  const file = path.join(path.dirname(f.receipt.checkpoint), 'update.json');
  for (const change of [{ phase: 'UNKNOWN' }, { live: '/invalid' }]) {
    const journal = { ...f.journal(), ...change };
    fs.writeFileSync(file, JSON.stringify(journal));
    const before = fs.readFileSync(file);
    assert.notEqual((await f.run()).code, 0);
    assert.deepEqual(fs.readFileSync(file), before);
  }
});

function approveNext(f, delivered, merged) {
  const state = require('../src/autopilot-state');
  const job = state.createJob({projectName:'ralph',repo:f.project.repo,issue:{number:28,title:'next approved candidate'},branch:'ralph/issue-next',worktreePath:f.sourceCheckout,now:f.store.now});
  state.recordVerification(job,f.project.verification,{passed:true,exitCode:0,timedOut:false,stdout:'next passed',stderr:''});
  state.recordDelivery(job,{commit:delivered});
  state.recordPullRequest(job,{number:129,url:'https://github.com/woodsja/AgentLoop/pull/129'});
  state.recordReview(job,{reviewer:'claude:independent-fixture',verdict:'PASS',commit:delivered,policy:'always',findings:[],attempt:state.beginReviewAttempt(job)});
  state.recordCiState(job,{state:'green',headCommit:delivered,prNumber:129,requiredWorkflow:'CI',runs:[{databaseId:2,workflowName:'CI',status:'completed',conclusion:'success',name:null,url:null,startedAt:null,updatedAt:null}]});
  state.recordMerge(job,{prNumber:129,approvedHead:delivered,commit:merged,repo:f.project.repo,issueClosed:true});
  state.markTerminal(job,'merged');f.store.save(job);
}
test('two consecutive deployments stage future objects from a retained source with issue refs and linked worktree', async t => {
  const f = await fixture(t,'good', f => f.git('worktree','add','--detach',path.join(f.root,'owner-worktree'),f.oldSha));
  const { inventory }=require('../src/deploy-files');
  assert.match(f.sourceGit('for-each-ref','--format=%(refname)'),/ralph\/issue-28/);
  const sourceBefore=inventory(f.sourceCheckout), worktreeBefore=inventory(path.join(f.root,'owner-worktree'));
  const first=success(await f.run());assert.equal(first.state,'DEPLOYED');
  assert.equal(inventory(f.sourceCheckout),sourceBefore);
  assert.equal(inventory(path.join(f.root,'owner-worktree')),worktreeBefore);
  const firstJournal=fs.readFileSync(path.join(path.dirname(f.receipt.checkpoint),'update.json'));
  const firstBackup=inventory(first.backup);
  f.sourceGit('reset','--hard',f.newSha);
  f.sourceGit('checkout','-b','ralph/issue-next');
  const delivered=f.commit('candidate-2\n');
  f.sourceGit('checkout','ralph-dev');f.sourceGit('merge','--no-ff','ralph/issue-next','-m','second independently approved merge');
  const merged=f.sourceGit('rev-parse','HEAD');
  f.publish(); // Local object copy plus bare update-ref; no fetch or push.
  approveNext(f,delivered,merged);
  // New candidate does not exist in installed .git. No fetch or object write there.
  assert.throws(()=>f.git('cat-file','-t',merged));
  const installedBefore=inventory(f.checkout);
  const receipt2=await f.prepare();
  assert.equal(receipt2.oldSha,f.newSha);assert.equal(receipt2.newSha,merged);
  assert.equal(inventory(f.checkout),installedBefore);
  assert.throws(()=>f.git('cat-file','-t',merged));
  const nextSource=inventory(f.sourceCheckout);
  const prior=f.receipt;f.receipt=receipt2;
  const second=success(await f.run());assert.equal(second.state,'DEPLOYED');
  assert.equal(f.head(),merged);assert.equal(inventory(f.sourceCheckout),nextSource);
  assert.equal(inventory(first.backup),firstBackup);
  assert.equal(inventory(path.join(f.root,'owner-worktree')),worktreeBefore);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(prior.checkpoint),'update.json')),firstJournal);
  assert.notEqual(second.backup,first.backup);
});
for (const mode of ['badnew','samepid']) test(`owner-sealed fresh retry retains terminal ${mode} journal and rejected tree`, async t => {
  const f=await fixture(t,mode), {hash,inventory}=require('../src/deploy-files');
  await f.run();
  const prior=f.receipt, file=path.join(path.dirname(prior.checkpoint),'update.json');
  const terminalBytes=fs.readFileSync(file), terminal=f.journal();
  assert.ok(['ROLLED_BACK','FAILED'].includes(terminal.phase));
  const rejectedHash=inventory(terminal.rejected);
  await assert.rejects(f.prepare(),/journal exists/);
  const approvalFile=path.join(f.root,'owner-retry.json');
  const authorization={contract:'step14-retry-v1',ownerApproved:true,attemptId:require('node:crypto').randomUUID(),priorCheckpoint:prior.checkpoint,priorJournalHash:hash(terminalBytes),oldSha:prior.oldSha,newSha:prior.newSha,sourceCheckout:prior.sourceCheckout,installedCheckout:prior.installedCheckout,evidenceHash:prior.evidenceHash};
  fs.writeFileSync(approvalFile,JSON.stringify({...authorization,ownerApproved:false}));
  await assert.rejects(f.prepare({retryApprovalPath:approvalFile}),/explicit owner retry/);
  fs.writeFileSync(approvalFile,JSON.stringify({...authorization,priorJournalHash:'bad'}));
  await assert.rejects(f.prepare({retryApprovalPath:approvalFile}),/sealed terminal/);
  fs.writeFileSync(approvalFile,JSON.stringify(authorization));
  const retried=await f.prepare({retryApprovalPath:approvalFile});
  assert.notEqual(retried.checkpoint,prior.checkpoint);
  assert.match(retried.deploymentKey,/-retry-/);
  f.receipt=retried;f.mode('good');
  const result=success(await f.run());assert.equal(result.state,'DEPLOYED');
  assert.notEqual(result.backup,terminal.backup);assert.notEqual(result.rejected,terminal.rejected);
  assert.deepEqual(fs.readFileSync(file),terminalBytes);
  assert.equal(inventory(terminal.rejected),rejectedHash);
  const terminalRetryBytes=fs.readFileSync(path.join(path.dirname(retried.checkpoint),'update.json'));
  await assert.rejects(f.prepare({retryApprovalPath:approvalFile}),/retry identity mismatch/);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(retried.checkpoint),'update.json')),terminalRetryBytes);
});
test('changed owner layout refuses forward update; unrelated source branch creation is allowed', async t => {
  const f=await fixture(t), {inventory}=require('../src/deploy-files');
  const original=fs.readFileSync(f.deploymentConfigPath), before=inventory(f.checkout);
  fs.appendFileSync(f.deploymentConfigPath,' ');
  assert.match((await f.run()).stderr,/layout changed/);
  fs.writeFileSync(f.deploymentConfigPath,original);
  f.sourceGit('branch','future-owner-branch');
  assert.equal(success(await f.run()).state,'DEPLOYED');
  assert.notEqual(inventory(f.checkout),before);assert.equal(f.service().restarts,2);
});

test('bootstrap refusal precedes READY and permits corrected fake service with the same receipt', async t => {
  const f = await fixture(t, 'invalidbootstrap');
  const {inventory} = require('../src/deploy-files');
  const before = inventory(f.checkout), receiptBytes = fs.readFileSync(f.receipt.checkpoint);
  const result = await f.run();
  assert.notEqual(result.code, 0); assert.match(result.stderr, /command failed/);
  assert.equal(fs.existsSync(path.join(path.dirname(f.receipt.checkpoint), 'update.json')), false);
  assert.equal(inventory(f.checkout), before); assert.equal(f.service().restarts, 1);
  assert.deepEqual(fs.readFileSync(f.receipt.checkpoint), receiptBytes);
  const audit = fs.readFileSync(path.join(path.dirname(f.receipt.checkpoint), 'update.jsonl'), 'utf8');
  const stderr = audit.trim().split('\n').map(JSON.parse).filter(e=>e.stream==='stderr').map(e=>Buffer.from(e.bytes ?? e.data,'base64').toString()).join('');
  assert.match(stderr, /JobTimeoutSec/); assert.doesNotMatch(audit, /"phase":"READY"/);
  f.mode('good');
  assert.equal(success(await f.run()).state, 'DEPLOYED');
});

test('over 512 MiB unrelated source state and concurrent independent Git/worktree activity allow deployment', async t => {
  let activity, activityClosed;
  try {
  const f = await fixture(t, 'good', f => {
    fs.mkdirSync(path.join(f.checkout, 'state'));
    fs.writeFileSync(path.join(f.checkout,'state','owner-history'), 'owner history retained');
    fs.truncateSync(path.join(f.checkout,'state','owner-history'), 513 * 1024 * 1024);
    fs.appendFileSync(path.join(f.checkout,'.git/info/exclude'), '\nstate/\n');
    const worktree = path.join(f.root, 'independent-worktree');
    f.git('worktree','add','-b','independent-owner-work',worktree,f.oldSha);
    const script = path.join(f.root,'independent-development.js');
    fs.writeFileSync(script, `const fs=require('fs'),cp=require('child_process');let count=0;
      const source=${JSON.stringify(f.checkout)},worktree=${JSON.stringify(worktree)};
      function change(){
        fs.writeFileSync(source+'/state/activity',String(++count));
        fs.writeFileSync(worktree+'/file.txt','independent work '+count);
        fs.writeFileSync(source+'/.git/FETCH_HEAD','independent local observation '+count);
        cp.execFileSync('/usr/bin/git',['-C',source,'update-ref','refs/remotes/origin/independent',count%2?${JSON.stringify(f.oldSha)}:${JSON.stringify(f.newSha)}],{stdio:['ignore','pipe','pipe']});
      }change();setInterval(change,25);`);
    activity = spawn(process.execPath,[script],{stdio:['ignore','ignore','pipe']});
    let stderr=''; activity.stderr.on('data',b=>stderr+=b);
    activityClosed = new Promise(resolve=>activity.on('close',(code,signal)=>resolve({code,signal,stderr})));
  }, { ignore: 'state/\n' });
    const stateFile = path.join(f.sourceCheckout,'state','activity');
    const first = Number(fs.readFileSync(stateFile));
    assert.ok(first > 0, 'independent process ran throughout preparation');
    assert.equal(f.receipt.sourceHash, undefined);
    assert.equal(f.receipt.candidateTree, f.sourceGit('rev-parse', f.newSha+'^{tree}'));
    const result = success(await f.run()); assert.equal(result.state,'DEPLOYED');
    assert.ok(Number(fs.readFileSync(stateFile)) > first, 'independent writes continued through swap');
    assert.equal(fs.statSync(path.join(f.sourceCheckout,'state','owner-history')).size,513*1024*1024);
    assert.ok(f.sourceGit('worktree','list').includes('independent-worktree'));
    const fd = fs.openSync(path.join(f.sourceCheckout,'state','owner-history'),'r'), prefix=Buffer.alloc(22);
    try { fs.readSync(fd,prefix,0,22,0); } finally { fs.closeSync(fd); }
    assert.equal(prefix.toString(),'owner history retained');
    t.diagnostic(JSON.stringify({unrelatedOwnerStateBytes:513*1024*1024,activityBeforeUpdate:first,activityAfterUpdate:Number(fs.readFileSync(stateFile)),phase:result.phase}));
  } finally { if (activity) { activity.kill('SIGTERM'); const result=await activityClosed; assert.equal(result.stderr,''); } }
});

for (const object of ['commit','tree','blob','HEAD']) test(`sealed candidate ${object} tampering refuses before journal or restart`, async t => {
  const f = await fixture(t);
  if (object === 'HEAD') fs.writeFileSync(path.join(f.receipt.repo,'.git/HEAD'), f.oldSha+'\n');
  else {
    const id = object === 'commit' ? f.newSha : f.sourceGit('rev-parse', object === 'tree' ? f.newSha+'^{tree}' : f.newSha+':file.txt');
    fs.appendFileSync(path.join(f.receipt.repo,'.git/objects',id.slice(0,2),id.slice(2)), 'altered object');
  }
  assert.notEqual((await f.run()).code,0);
  assert.equal(fs.existsSync(path.join(path.dirname(f.receipt.checkpoint),'update.json')),false);
  assert.equal(f.service().restarts,1); assert.equal(f.head(),f.oldSha);
});

test('canonical absolute layout/project/retry filenames reject parent aliases before containment', async t => {
  const f = await fixture(t);
  const layout = require('../src/deploy-layout').layout;
  const alias = file => path.dirname(file)+'/other/../'+path.basename(file);
  assert.throws(()=>layout(alias(f.deploymentConfigPath),f.configPath,f.sourceCheckout),/canonical absolute/);
  assert.throws(()=>layout(f.deploymentConfigPath,alias(f.configPath),f.sourceCheckout),/canonical absolute/);
  assert.throws(()=>require('../src/deploy-retry').approval(alias(f.configPath),{}),/canonical absolute/);
  assert.equal(layout(f.deploymentConfigPath,f.configPath,f.sourceCheckout).installedCheckout,f.checkout);
});

for (const phase of ['READY','SWAPPING']) for (const change of ['config','evidence','layout']) test(`real ${phase} resume refuses ${change} without restarting or swapping`, async t=>{
  const f=await fixture(t);
  assert.equal((await f.run(phase)).signal,'SIGKILL');
  assert.equal(f.journal().phase,phase);
  const beforeService=f.service(),beforeTree=require('../src/deploy-files').inventory(f.checkout);
  const receipt=fs.readFileSync(f.receipt.checkpoint);
  if(change==='config')fs.appendFileSync(f.configPath,' ');
  if(change==='evidence'){f.job.review.reviewer='claude:changed';f.save();}
  if(change==='layout'){const layout=JSON.parse(fs.readFileSync(f.deploymentConfigPath));layout.installedCheckout=path.join(f.root,'other');fs.writeFileSync(f.deploymentConfigPath,JSON.stringify(layout));}
  const result=await f.run();assert.notEqual(result.code,0,result.stdout);
  assert.equal(f.journal().phase,'FAILED');assert.equal(f.journal().state,'FAILED');
  assert.deepEqual(f.service(),beforeService);assert.equal(require('../src/deploy-files').inventory(f.checkout),beforeTree);
  assert.equal(fs.existsSync(f.journal().backup),false);assert.equal(fs.existsSync(f.journal().rejected),false);
  assert.deepEqual(fs.readFileSync(f.receipt.checkpoint),receipt);
  const log=fs.readFileSync(path.join(path.dirname(f.receipt.checkpoint),'update.jsonl'),'utf8');
  assert.match(log,new RegExp(phase));assert.match(log,/FAILED/);assert.doesNotMatch(log,/ROLLING_BACK|ROLLBACK_RESTART/);
  assert.ok(f.journal().error);assert.ok(log.includes(f.journal().error));
  const failed=fs.readFileSync(path.join(path.dirname(f.receipt.checkpoint),'update.json'));
  assert.notEqual((await f.run()).code,0);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(f.receipt.checkpoint),'update.json')),failed);
  assert.deepEqual(f.service(),beforeService);
});

for (const fault of ['throw:SWAPPING','settingsfail:SWAPPING','renamefail:deployment','tamper:SWAPPING']) test(`observed ${fault} before first rename leaves original service running`, async t=>{
  const f=await fixture(t),beforeService=f.service(),beforeTree=require('../src/deploy-files').inventory(f.checkout);
  const result=await f.run(fault);
  assert.notEqual(result.code,0,result.stdout);
  const expected=fault.startsWith('settingsfail:')?'owner configuration changed':fault.startsWith('renamefail:')?'injected rename failure':fault.startsWith('tamper:')?'installation modified or dirty checkout':'injected phase fault';
  assert.ok(result.stderr.includes(expected),result.stderr);
  assert.equal(f.journal().phase,'FAILED');assert.ok(f.journal().error.includes(expected));
  assert.deepEqual(f.service(),beforeService);assert.equal(require('../src/deploy-files').inventory(f.checkout),beforeTree);
  assert.equal(fs.existsSync(f.journal().backup),false);assert.equal(fs.existsSync(f.journal().rejected),false);
  const file=path.join(path.dirname(f.receipt.checkpoint),'update.json'),before=fs.readFileSync(file);
  const log=fs.readFileSync(path.join(path.dirname(file),'update.jsonl'),'utf8');
  assert.ok(log.includes(expected));assert.doesNotMatch(log,/ROLLING_BACK|ROLLBACK_RESTART|"rename":/);
  if(fault.startsWith('settingsfail:'))assert.notEqual((await f.run()).code,0);
  else assert.equal(success(await f.run()).state,'FAILED');
  assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(f.service(),beforeService);
});

for (const mutation of ['live','missing-live','rejected']) test(`SWAPPING without backup refuses ambiguous ${mutation} state without restart`, async t=>{
  const f=await fixture(t);
  assert.equal((await f.run('SWAPPING')).signal,'SIGKILL');
  const beforeService=f.service();
  if(mutation==='live')fs.writeFileSync(path.join(f.checkout,'file.txt'),'concurrent owner write');
  if(mutation==='missing-live')fs.renameSync(f.checkout,path.join(f.root,'owner-moved-install'));
  if(mutation==='rejected')fs.mkdirSync(f.journal().rejected);
  const result=await f.run();assert.notEqual(result.code,0,result.stdout);
  assert.equal(f.journal().phase,'FAILED');assert.deepEqual(f.service(),beforeService);
  assert.equal(fs.existsSync(f.journal().backup),false);
  if(mutation==='live')assert.equal(fs.readFileSync(path.join(f.checkout,'file.txt'),'utf8'),'concurrent owner write');
  if(mutation==='missing-live')assert.equal(fs.existsSync(f.checkout),false);
  if(mutation==='rejected')assert.equal(fs.existsSync(f.journal().rejected),true);
  const log=fs.readFileSync(path.join(path.dirname(f.receipt.checkpoint),'update.jsonl'),'utf8');
  assert.doesNotMatch(log,/ROLLING_BACK|ROLLBACK_RESTART|"rename":/);
});

test('SWAPPING resume retains original settings refusal alongside concurrent live verification failure', async t=>{
  const f=await fixture(t);
  assert.equal((await f.run('SWAPPING')).signal,'SIGKILL');
  const beforeService=f.service();
  fs.appendFileSync(f.configPath,' ');
  fs.writeFileSync(path.join(f.checkout,'file.txt'),'concurrent owner write');
  const result=await f.run();assert.notEqual(result.code,0,result.stdout);
  assert.match(result.stderr,/owner configuration changed/);
  assert.equal(f.journal().phase,'FAILED');assert.match(f.journal().error,/owner configuration changed/);
  assert.match(f.journal().verificationError,/installation modified or dirty checkout/);
  assert.deepEqual(f.service(),beforeService);
  assert.equal(fs.readFileSync(path.join(f.checkout,'file.txt'),'utf8'),'concurrent owner write');
  const log=fs.readFileSync(path.join(path.dirname(f.receipt.checkpoint),'update.jsonl'),'utf8');
  assert.match(log,/owner configuration changed/);assert.match(log,/installation modified or dirty checkout/);
  assert.doesNotMatch(log,/ROLLING_BACK|ROLLBACK_RESTART|"rename":/);
});

// Cross-step regression: #28 boundary verification must feed #29 bulk staging
// and the #30 sealed receipt without borrowing installed Git history.
test('combined stale-base reviewed merge stages and updates while source and owner evidence stay intact', async t => {
  const f = await fixture(t, 'good', f => {
    // Observe the real isolated walk without replacing any Git result/check.
    fs.writeFileSync(f.preflightObserver, `
      const fs = require('node:fs');
      module.exports = {onCommand(file,args,options) {
        if (args.includes('merge-base')) fs.appendFileSync(${JSON.stringify(path.join(f.root,'walk-boundaries.jsonl'))},
          JSON.stringify(fs.readFileSync(require('path').join(options.cwd,'shallow'),'utf8').trim().split('\\n'))+'\\n');
      }};
    `);
  }, { staleBase: true });
  const boundaries = fs.readFileSync(path.join(f.root,'walk-boundaries.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(boundaries.length, 2);
  for (const ids of boundaries) assert.deepEqual(new Set(ids),new Set([f.oldSha,f.fork]));
  const sourceHead = f.sourceGit('rev-parse', 'HEAD');
  const config = fs.readFileSync(f.configPath);
  const evidence = fs.readFileSync(path.join(f.project.stateDir, 'issue-28.json'));
  assert.equal(f.receipt.updaterContract, 'step14-update-v3');
  assert.equal(f.receipt.candidateTree, f.sourceGit('rev-parse', f.newSha + '^{tree}'));
  assert.ok(f.receipt.installedHash && f.receipt.installerHash);
  const records = fs.readFileSync(f.receipt.transcript, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(r => r.command?.includes('--batch')).length, 1);
  assert.equal(records.find(r => r.historyCopy).historyCopy.verified, true);
  assert.equal(success(await f.run()).state, 'DEPLOYED');
  assert.equal(f.head(), f.newSha);
  assert.equal(f.sourceGit('rev-parse', 'HEAD'), sourceHead);
  assert.deepEqual(fs.readFileSync(f.configPath), config);
  assert.deepEqual(fs.readFileSync(path.join(f.project.stateDir, 'issue-28.json')), evidence);
});
