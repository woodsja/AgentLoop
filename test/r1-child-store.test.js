'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createR1ChildStore } = require('../src/r1-child-store');

const parentJobId = 't-12345678';
const loop = {
  project: 'demo', projectPath: '/worktrees/demo/issue-65', source: 'r1', title: 'R1 65',
  engine: 'codex', workerEngine: 'codex', criticEngine: 'claude', autoCommit: true,
  maxCycles: 3, taskRetries: 2, r1Child: { parentJobId, attempt: 1, issue: 65 },
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-child-unique-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function make(writeTask = (value, stage) => {
    const dir = path.join(root, 'tasks', stage);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${value.id}.json`), JSON.stringify(value), { flag: 'wx' });
  }) { return createR1ChildStore({ stateRoot: root, writeTask }); }
  return { root, make };
}

test('repeated requests for same parent attempt use one durable child across queue stages', t => {
  const f = fixture(t), first = f.make();
  const made = first.ensureLoop(parentJobId, 1, loop);
  assert.equal(made.created, true);
  assert.deepEqual(f.make().ensureLoop(parentJobId, 1, loop), { id: made.id, created: false });
  const pending = path.join(f.root, 'tasks', 'pending', `${made.id}.json`);
  const running = path.join(f.root, 'tasks', 'running', `${made.id}.json`);
  fs.mkdirSync(path.dirname(running), { recursive: true });
  fs.renameSync(pending, running);
  assert.deepEqual(f.make().ensureLoop(parentJobId, 1, loop), { id: made.id, created: false });
  const completed = path.join(f.root, 'tasks', 'done', `${made.id}.json`);
  fs.mkdirSync(path.dirname(completed), { recursive: true });
  fs.writeFileSync(running, JSON.stringify({ ...loop, type: 'loop', id: made.id, status: 'passed' }));
  fs.renameSync(running, completed);
  assert.deepEqual(f.make().ensureLoop(parentJobId, 1, loop), { id: made.id, created: false });
  assert.equal(f.make().listChildren(parentJobId)[0].stage, 'done');
});

test('incomplete reservation fails closed after crash without creating a second child', t => {
  const f = fixture(t);
  assert.throws(() => f.make(() => { throw new Error('simulated power loss'); }).ensureLoop(parentJobId, 1, loop), /simulated power loss/);
  assert.throws(() => f.make().ensureLoop(parentJobId, 1, loop), /reservation.*without.*queue|pending.*materialization/i);
  const children = f.make().listChildren(parentJobId);
  assert.equal(children.length, 1);
  assert.equal(children[0].stage, null);
});

test('an attempt cannot reuse a reservation with incompatible job parameters', t => {
  const f = fixture(t); f.make().ensureLoop(parentJobId, 1, loop);
  assert.throws(() => f.make().ensureLoop(parentJobId, 1, { ...loop, projectPath: '/unrelated' }), /reservation.*mismatch|does not match/i);
});

test('competing OS processes cannot reserve two children for one parent and attempt', async t => {
  const f = fixture(t);
  const script = `
    const fs=require('node:fs'),path=require('node:path');
    const {createR1ChildStore}=require(process.argv[1]);
    const root=process.argv[2],payload=JSON.parse(process.argv[3]);
    const store=createR1ChildStore({stateRoot:root,writeTask:(t,s)=>{const d=path.join(root,'tasks',s);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,t.id+'.json'),JSON.stringify(t),{flag:'wx'});}});
    let value;
    for(let i=0;i<40;i++) {
      try {value=store.ensureLoop('t-12345678',1,payload);break;}
      catch(e) {if (!/reservation.*without.*queue|pending.*materialization/i.test(e.message)) throw e; const start=Date.now();while(Date.now()-start<3){}}
    }
    if(!value)throw Error('reservation never materialized');
    console.log(JSON.stringify(value));
  `;
  const workerFile = path.resolve(__dirname, '../src/r1-child-store.js');
  const runs = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', script, workerFile, f.root, JSON.stringify(loop)]);
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    p.on('close', code => code ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)));
    p.on('error', reject);
  })));
  assert.equal(new Set(runs.map(x => x.id)).size, 1);
  assert.equal(runs.filter(x => x.created).length, 1);
  assert.equal(fs.readdirSync(path.join(f.root, 'tasks', 'pending')).length, 1);
  assert.equal(f.make().listChildren(parentJobId).length, 1);
});
