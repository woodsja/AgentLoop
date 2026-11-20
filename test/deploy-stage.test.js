'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { fixture, stageFile, stageModule, snapshot, pause, until } = require('./helpers/deploy-stage-fixture');
test('retained-size admission count tolerates concurrent atomic renames', t => {
  const stageSource = fs.readFileSync(stageFile, 'utf8');
  const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'stage-size-race-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  fs.writeFileSync(path.join(scratch, 'kept'), 'abc');
  const vanishing = path.join(scratch, 'checkpoint.json.tmp');
  const disappearingDir = path.join(scratch, 'attempt-finished');
  const synthetic = {
    ...fs,
    readdirSync(directory, options) {
      if (directory === scratch) return [
        { name: 'kept', isDirectory: () => false },
        { name: 'checkpoint.json.tmp', isDirectory: () => false },
        { name: 'attempt-finished', isDirectory: () => true }
      ];
      if (directory === disappearingDir) {
        const err = new Error('atomic rename removed directory'); err.code = 'ENOENT'; throw err;
      }
      return fs.readdirSync(directory, options);
    },
    lstatSync(file, options) {
      if (file === vanishing) {
        const err = new Error('atomic rename removed temporary checkpoint'); err.code = 'ENOENT'; throw err;
      }
      return fs.lstatSync(file, options);
    }
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', '__filename',
    stageSource + '\nmodule.exports._countForRaceTest = retainedSize;')(
    name => name === 'node:fs' ? synthetic : require('node:module').createRequire(stageFile)(name),
    module, module.exports, stageFile);
  assert.equal(module.exports._countForRaceTest(scratch), 3);
});

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
  assert.ok(records.some(record => record.command?.at(-1) === 'test' && record.command[0] === process.execPath));
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


function alterWorker(f, code) {
  const source = fs.readFileSync(f.worker, 'utf8');
  fs.writeFileSync(f.worker, source.replace('const {issueNumber,options}', `${code}\nconst {issueNumber,options}`));
}
for (const fault of ['fsync', 'kill', 'failed-record']) {
  test(`callback/storage fault ${fault} rejects and independently publishes FAILED`, async t => {
    const f = fixture(t, fault === 'kill' ? 'setInterval(()=>{}, 1000)' : 'process.exit(7)');
    alterWorker(f, `
      let injected = false, killCount = 0;
      const originalSync = fs.fsyncSync, originalKill = process.kill, originalWrite = fs.writeFileSync;
      ${fault === 'fsync' ? `fs.fsyncSync = fd => {
        if (!injected && fs.readlinkSync('/proc/self/fd/' + fd).endsWith('npm-test.stdout')) {
          injected = true; throw new Error('injected output fsync failure');
        }
        return originalSync(fd);
      };` : fault === 'kill' ? `process.kill = (...args) => {
        if (++killCount === 2) { injected = true; const error = new Error('injected kill failure'); error.code='EPERM'; throw error; }
        return originalKill(...args);
      };` : `fs.writeFileSync = (fd, data, ...args) => {
        if (!injected && typeof data === 'string' && data.includes('"state":"FAILED"')) {
          injected = true; throw new Error('injected FAILED record failure');
        }
        return originalWrite(fd, data, ...args);
      };`}
    `);
    await assert.rejects(f.prepare({ timeoutMs: 1200 }), /injected/);
    const receipt = JSON.parse(fs.readFileSync(f.checkpoint(), 'utf8'));
    assert.equal(receipt.state, 'FAILED');
    if (fault !== 'failed-record') assert.match(fs.readFileSync(receipt.transcript, 'utf8'), /"state":"FAILED"/);
  });
}
for (const [from, to, message] of [
  ['objects: 100000', 'objects: 1', 'history object count budget'],
  ['objectBytes: 512 * 1024 * 1024', 'objectBytes: 1', 'history byte budget'],
  ['commands: 128', 'commands: 1', 'Git command/time budget'],
  ['copyMs: 600000', 'copyMs: 1', 'Git command/time budget'],
  ['npmOutputBytes: 64 * 1024 * 1024', 'npmOutputBytes: 1', 'npm output budget'],
  ['gitOutputBytes: 768 * 1024 * 1024', 'gitOutputBytes: 1', 'Git output budget'],
]) {
  test(`resource threshold fails closed with complete retained records: ${message}`, async t => {
    const f = fixture(t);
    fs.writeFileSync(f.worker, fs.readFileSync(f.worker, 'utf8').replace("fs.readFileSync(stageFile,'utf8')", `fs.readFileSync(stageFile,'utf8').replace(${JSON.stringify(from)},${JSON.stringify(to)})`));
    await assert.rejects(f.prepare(), new RegExp(message));
    const receipt = JSON.parse(fs.readFileSync(f.checkpoint(), 'utf8'));
    assert.equal(receipt.state, 'FAILED');
    assert.match(fs.readFileSync(receipt.transcript, 'utf8'), /"state":"FAILED"/);
    for (const record of fs.readFileSync(receipt.transcript, 'utf8').trim().split('\n').map(JSON.parse).filter(record => record.command)) {
      assert.ok(fs.existsSync(record.stdout)); assert.ok(fs.existsSync(record.stderr));
    }
  });
}

test('retained request budget refuses new work without deleting records', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.stageRoot, { recursive: true });
  for (let i = 0; i < 64; i++) fs.mkdirSync(path.join(f.stageRoot, `request-${i}`));
  await assert.rejects(f.prepare(), /retained staging budget exhausted/);
  assert.equal(fs.readdirSync(f.stageRoot).length, 64);
});

test('API close callback fsync failure rejects without an uncaught exception', async t => {
  const f = fixture(t);
  const original = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = fd => {
    if (!injected && fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith('worker.stdout')) {
      injected = true; throw new Error('injected API output fsync failure');
    }
    return original(fd);
  };
  try {
    await assert.rejects(f.prepare(), /injected API output fsync failure/);
    assert.equal(JSON.parse(fs.readFileSync(f.checkpoint(), 'utf8')).state, 'PREPARED');
  } finally { fs.fsyncSync = original; }
});

test('real npm resolves ordinary VM uv with isolated HOME and ignores inherited PATH', { skip: process.env.RALPH_STAGE_VM_UV !== '1' && 'VM-only: opt in with RALPH_STAGE_VM_UV=1' }, async t => {
  const f = fixture(t, `
    const fs = require('node:fs');
    const output = require('node:child_process').execFileSync('uv', ['--version'], {stdio:['ignore','pipe','pipe']});
    fs.writeFileSync(1, output);
    fs.writeFileSync(1, JSON.stringify({home:process.env.HOME,path:process.env.PATH}) + '\\n');
  `.replaceAll('\n', ' '));
  const previousPath = process.env.PATH;
  let receipt;
  try {
    process.env.PATH = '/untrusted/inherited/path';
    receipt = await f.prepare();
  } finally { process.env.PATH = previousPath; }
  assert.equal(receipt.state, 'PREPARED');
  const output = fs.readFileSync(path.join(receipt.attempt, 'npm-test.stdout'), 'utf8');
  assert.match(output, /uv \d+\./);
  const actual = JSON.parse(output.trim().split('\n').at(-1));
  assert.equal(actual.home, path.join(receipt.attempt, 'home'));
  assert.ok(actual.path.endsWith(':' + [path.dirname(process.execPath),'/usr/bin','/bin','/usr/local/bin',path.join(require('node:os').userInfo().homedir,'.local/bin')].join(':')));
  assert.equal(actual.path.includes('/untrusted/inherited/path'), false);
});

for (const target of ['git', 'npm']) {
  for (const lateClose of [false, true]) {
    const errorCode = lateClose ? 'EMFILE' : 'ENFILE';
    test(`spawn ${target} error ${lateClose ? 'with late close' : 'without close'} releases lock and records FAILED`, { timeout: 15000 }, async t => {
      const f = fixture(t);
      const worker = fs.readFileSync(f.worker, 'utf8');
      fs.writeFileSync(f.worker, worker.replace('const loaded = {exports:{}};', `
        const cp = require('node:child_process'), originalSpawn = cp.spawn;
        cp.spawn = (file, args, options) => {
          if (file === ${JSON.stringify(target === 'git' ? '/usr/bin/git' : '/usr/bin/timeout')}) {
            const child = new (require('node:events').EventEmitter)();
            child.kill = () => false;
            const outputs = options.stdio.slice(1,3);
            process.nextTick(() => {
              const error = new Error('injected ${target} ${errorCode}'); error.code = '${errorCode}';
              child.emit('error', error);
              for (const fd of outputs) {
                let closed = false;
                try { fs.fstatSync(fd); } catch (error) { closed = error.code === 'EBADF'; }
                if (!closed) throw new Error('spawn error leaked output descriptor');
              }
              ${lateClose ? "child.emit('close', -1, null); child.emit('close', -1, null);" : ''}
            });
            return child;
          }
          return originalSpawn(file,args,options);
        };
        const loaded = {exports:{}};
      `));
      await assert.rejects(f.prepare(), new RegExp('injected ' + target + ' ' + errorCode));
      const failed = JSON.parse(fs.readFileSync(f.checkpoint(), 'utf8'));
      assert.equal(failed.state, 'FAILED');
      const records = fs.readFileSync(failed.transcript, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(records.filter(record => record.state === 'FAILED').length, 1);
      assert.ok(records.some(record => /EMFILE|ENFILE/.test(record.error)));
      fs.writeFileSync(f.worker, worker);
      assert.equal((await f.prepare()).state, 'PREPARED');
    });
  }
}

test('packed objects and binary blob/tree delimiters retain exact bytes', async t => {
  const f = fixture(t);
  f.git('gc', '--prune=now');
  const result = await f.prepare();
  assert.deepEqual(fs.readFileSync(path.join(result.repo, 'binary-newline\nfile')), Buffer.from([0,10,255,32,10,0,100]));
  const records = fs.readFileSync(result.transcript, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(record => record.command?.includes('--batch')).length, 1);
  assert.equal(records.filter(record => record.command?.includes('--batch-check')).length, 1);
});

for (const fault of ['hash', 'length', 'type', 'duplicate', 'trailing']) {
  test(`invalid bulk object ${fault} fails closed retaining raw output`, async t => {
    const f = fixture(t);
    alterWorker(f, `
      const originalRead = fs.readFileSync;
      fs.readFileSync = (file,...args) => {
        const bytes = originalRead(file,...args);
        // Commands: init, source lookup, IDs, size/type plan, binary batch.
        if (typeof file === 'string' && file.endsWith('git-5.stdout')) {
          const changed = Buffer.from(bytes), end = changed.indexOf(10);
          ${fault === 'hash' ? "changed[end+1] ^= 1; return changed;" :
            fault === 'length' ? "return changed.subarray(0,changed.length-1);" :
            fault === 'type' ? "return Buffer.concat([Buffer.from(changed.subarray(0,end).toString().replace('commit','blob')),changed.subarray(end)]);" :
            fault === 'duplicate' ? "return Buffer.concat([changed,changed]);" : "return Buffer.concat([changed,Buffer.from('garbage')]);"}
        }
        return bytes;
      };
    `);
    await assert.rejects(f.prepare(), /object hash mismatch|invalid batch|trailing batch/);
    const result = JSON.parse(fs.readFileSync(f.checkpoint(), 'utf8'));
    assert.equal(result.state, 'FAILED');
    assert.ok(fs.statSync(path.join(result.attempt, 'git-5.stdout')).size > 0);
    assert.equal(fs.existsSync(path.join(result.attempt, 'npm-ci.stdout')), false);
  });
}

test('trusted Node/npm outside system bin work without inherited PATH or npm_execpath', async t => {
  const f = fixture(t, 'console.log(JSON.stringify({node:process.execPath,path:process.env.PATH}))');
  const bin = path.join(f.root, 'trusted-runtime/bin');
  fs.mkdirSync(bin, {recursive:true});
  const node = path.join(bin, 'node');
  fs.copyFileSync(process.execPath, node);
  fs.chmodSync(node, 0o700);
  fs.symlinkSync(stageModule.exports.npmCli(), path.join(bin, 'npm'));
  const launcher = path.join(f.root, 'runtime-launcher.js');
  fs.writeFileSync(launcher, `
    const fs = require('node:fs'), {createRequire} = require('node:module');
    const filename = ${JSON.stringify(stageFile)}, loaded = {exports:{}};
    new Function('require','module','exports','__filename',fs.readFileSync(filename,'utf8') + '\\nmodule.exports.runLocked = runLocked;')(
      createRequire(filename),loaded,loaded.exports,filename);
    loaded.exports.runLocked(28,{configPath:${JSON.stringify(f.configPath)}},${JSON.stringify(f.worker)})
      .then(receipt => fs.writeFileSync(1,JSON.stringify(receipt)))
      .catch(error => {fs.writeFileSync(2,error.stack);process.exitCode=1;});
  `);
  const result = await promisify(execFile)(node, [launcher], {
    env: {...process.env, PATH:'/untrusted/path', npm_execpath:'/untrusted/npm'} });
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.state, 'PREPARED');
  const output = fs.readFileSync(path.join(receipt.attempt, 'npm-test.stdout'), 'utf8');
  const actual = JSON.parse(output.trim().split('\n').at(-1));
  assert.equal(actual.node, node);
  assert.ok(actual.path.includes(':' + bin + ':'));
  assert.equal(actual.path.includes('/untrusted'), false);
  const records = fs.readFileSync(receipt.transcript, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.find(record => record.command?.at(-1) === 'test').command[0], node);
});
