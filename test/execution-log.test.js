const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-log-'));
process.env.AGENTLOOP_STATE_DIR = root;
const store = require('../src/store');
const { recorder, captureProcess, execFile, execFileSync, withExecution } = require('../src/execution-log');
const { runVerification } = require('../src/verifier');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const events = id => fs.readFileSync(store.executionPath(id), 'utf8').trim().split('\n').map(JSON.parse);
const output = (id, stream) => Buffer.concat(events(id).filter(r => r.event === 'output' && r.stream === stream).map(r => Buffer.from(r.base64, 'base64')));

test('native command capture preserves binary bytes, split UTF-8, CRLF and unterminated stderr', async () => {
  const id = 't-binary';
  await withExecution(recorder(store, id), () => new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', "require('fs').writeFileSync(1,Buffer.from([0,255,13,10,226,130,172]));require('fs').writeFileSync(2,'token=private /tmp/file')"], {encoding:'utf8'}, error => error ? reject(error) : resolve());
  }));
  assert.deepEqual(output(id, 'stdout'), Buffer.from([0,255,13,10,226,130,172]));
  assert.equal(output(id, 'stderr').toString(), 'token=private /tmp/file');
});

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`cancelled or abruptly killed CLI retains output and precise ${signal} outcome`, async () => {
    const id = `t-${signal}`;
    const child = captureProcess(spawn, process.execPath, ['-e', "require('fs').writeFileSync(1,'prior output\\r\\n');require('fs').writeFileSync(2,'prior error');setInterval(()=>{},1000)"], {stdio:['ignore','pipe','pipe']}, recorder(store, id, {role:'worker',attempt:1}));
    const closed = new Promise(resolve => child.once('close', resolve));
    await new Promise(resolve => child.stderr.once('data', resolve));
    child.kill(signal);
    await closed;
    assert.equal(output(id, 'stdout').toString(), 'prior output\r\n');
    assert.equal(output(id, 'stderr').toString(), 'prior error');
    assert.equal(events(id).at(-1).signal, signal);
    // A fresh store module uses the durable log, not an in-memory cache.
    delete require.cache[require.resolve('../src/store')];
    const reopened = require('../src/store');
    const page = reopened.readExecutionBytes(id, 0, 100000);
    assert.deepEqual(Buffer.from(page.base64, 'base64'), fs.readFileSync(store.executionPath(id)));
  });
}

test('timed-out verification retains prior output, command, signal and timeout evidence', async () => {
  const id = 't-timeout';
  const command = `${process.execPath} -e "require('fs').writeFileSync(1,'before timeout');setInterval(()=>{},1000)"`;
  const result = await runVerification(process.cwd(), command, 500, recorder(store, id, {role:'verification'}));
  assert.equal(result.command, command);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(output(id, 'stdout').toString(), 'before timeout');
});


test('a torn final crash record remains retrievable and cannot corrupt the next append', () => {
  const id = 't-torn';
  store.appendExecution(id, {event:'first'});
  require('../src/execution-journal').flush(store.executionPath(id)); // simulate a prior crashed writer
  const torn = '{"event":"partial';
  fs.appendFileSync(store.executionPath(id), torn);
  const before = fs.readFileSync(store.executionPath(id));
  store.appendExecution(id, {event:'recovered'});
  const after = Buffer.from(store.readExecutionBytes(id, 0, 100000).base64,'base64');
  assert.deepEqual(after.subarray(0,before.length), before);
  assert.equal(JSON.parse(after.toString().trim().split('\n').at(-1)).event, 'recovered');
});

test('persistence failure reports the exact fault through the remaining log sinks', () => {
  const lines = [];
  const previous = console.error;
  console.error = line => lines.push(line);
  try {
    recorder({appendExecution(){throw new Error('disk full /tmp/owner token=example');},appendLogLine(id,line){lines.push(line);}},'t-disk')('output',{base64:'YQ=='});
    assert.equal(lines.length,2);
    assert.ok(lines.every(line => line.includes('disk full /tmp/owner token=example')));
  } finally { console.error = previous; }
});


test('synchronous command output and failure diagnostics remain complete', () => {
  const id = 't-sync';
  withExecution(recorder(store,id), () => {
    assert.throws(() => execFileSync(process.execPath, ['-e', "require('fs').writeFileSync(1,'token=full');require('fs').writeFileSync(2,'/tmp/failure\\nstack');process.exit(7)"], {encoding:'utf8',stdio:'pipe'}), error => error.status === 7 && error.stdout === 'token=full');
  });
  const stderrWrite = process.stderr.write;
  let echoed = '';
  try {
    process.stderr.write = chunk => { echoed += chunk; return true; };
    const success = withExecution(recorder(store,'t-sync-success'), () => execFileSync(process.execPath, ['-e', "require('fs').writeFileSync(1,'ok');require('fs').writeFileSync(2,'successful stderr')"], {encoding:'utf8'}));
    assert.equal(success, 'ok');
    assert.equal(echoed, 'successful stderr', 'native default stderr echo is preserved');
  } finally { process.stderr.write = stderrWrite; }
  assert.equal(output('t-sync-success','stderr').toString(), 'successful stderr');
  assert.equal(output(id,'stdout').toString(),'token=full');
  assert.equal(output(id,'stderr').toString(),'/tmp/failure\nstack');
  assert.equal(events(id).at(-1).exitCode,7);
});

test('large task and job diagnostics keep full checkpoints and bounded dashboard projections', () => {
  const raw = 'token=visible /tmp/owner\r\n' + 'x'.repeat(2 * 1024 * 1024) + '\0tail';
  const task = { id: 't-large', type: 'task', status: 'running', description: 'owner instructions', r1: { verification: { stdout: raw, stderr: raw }, reviewHistory: [{rawResult: raw}], failures: [{message: raw}] } };
  store.writeTask(task, 'running');
  task.status = 'passed';
  store.writeTask(task, 'running');
  const checkpoint = store.readTask(task.id, 'running');
  assert.equal(checkpoint.r1.verification.stdout, raw);
  assert.equal(checkpoint.r1.verification.stderr, raw);
  const projection = store.listTasks('running', { dashboard: true }).find(value => value.id === task.id);
  assert.ok(JSON.stringify(projection).length < 80000);
  assert.ok(projection.r1.verification.stdout.length < 4200);
  assert.equal(checkpoint.executionJournal.id, task.id);
  const records = events(task.id);
  assert.equal(records[0].changes.r1.verification.stdout, raw);
  assert.equal(records[0].changes.r1.verification.stderr, raw);
  assert.equal(records[0].changes.r1.reviewHistory[0].rawResult, raw);
  assert.equal(records[1].changes.r1, undefined);
  const { createJob, createJobStore } = require('../src/autopilot-state');
  const jobs = createJobStore(path.join(root, 'jobs'));
  const job = createJob({ projectName:'example', repo:'owner/repo', issue:{number:1,title:'Fix'}, branch:'fix', worktreePath:'/tmp/work', now:jobs.now });
  job.verification = {command:'npm test',commit:null,passed:false,timedOut:false,exitCode:1,stdout:raw,stderr:raw};
  jobs.save(job);
  assert.ok(fs.statSync(jobs.jobPath(1)).size > raw.length);
  const summary = jobs.load(1);
  assert.equal(summary.verification.stdout, raw);
  assert.equal(JSON.parse(fs.readFileSync(summary.executionJournal.file,'utf8').trim()).changes.verification.stdout, raw);
});

test('chatty output coalesces disk barriers and terminal records flush immediately', async () => {
  const journal = require('../src/execution-journal');
  journal.flushAll();
  const file = store.executionPath('t-batch');
  const sync = fs.fsyncSync;
  const asyncSync = fs.fsync;
  let barriers = 0;
  let batches = 0;
  fs.fsyncSync = fd => { barriers++; return sync(fd); };
  fs.fsync = (fd, callback) => { batches++; return asyncSync(fd, callback); };
  try {
    store.appendExecution('t-batch', {event:'command'});
    const initial = barriers;
    for (let i=0;i<100;i++) store.appendExecution('t-batch', {event:'output',base64:'AP8='});
    assert.equal(barriers, initial, 'no synchronous per-chunk barriers');
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(batches, 1);
    store.appendExecution('t-batch', {event:'exit',exitCode:0});
    assert.equal(barriers, initial + 1);
    assert.equal(events('t-batch').length, 102);
  } finally { fs.fsyncSync = sync; fs.fsync = asyncSync; journal.flush(file); }
});

test('SIGKILL before the batch timer retains kernel-written bytes on restart', async () => {
  const id = 't-crash-batch';
  const script = `const s=require(${JSON.stringify(require.resolve('../src/store'))});for(let i=0;i<100;i++)s.appendExecution('${id}',{event:'output',base64:Buffer.from([i,0,255]).toString('base64')});process.stdout.write('ready');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e',script], {env:{...process.env,AGENTLOOP_STATE_DIR:root},stdio:['ignore','pipe','pipe']});
  const closed = new Promise(resolve => child.once('close', resolve));
  await new Promise(resolve => child.stdout.once('data',resolve));
  child.kill('SIGKILL');
  await closed;
  store.appendExecution(id,{event:'recovery',message:'Exit details unknown'});
  const records = events(id);
  assert.equal(records.length,101);
  records.slice(0,100).forEach((record,i) => assert.deepEqual(Buffer.from(record.base64,'base64'),Buffer.from([i,0,255])));
  assert.equal(records.at(-1).event,'recovery');
});

test('Python runner streams complete binary pipes while callback diagnostics stay bounded', async () => {
  const id = 't-python-stream';
  const raw = Buffer.concat([Buffer.from([0,255,13,10]),Buffer.alloc(100000,120)]);
  await withExecution(recorder(store,id), () => new Promise((resolve,reject) => {
    const runner = execFile(process.execPath,[path.join(__dirname,'../src/python-preflight-runner.js'),process.execPath,'-e',`const b=Buffer.concat([Buffer.from([0,255,13,10]),Buffer.alloc(100000,120)]);require('fs').writeFileSync(1,b);require('fs').writeFileSync(2,b);`],{encoding:'utf8',executionPreviewBytes:4096},(error,stdout,stderr)=>{
      if(error) return reject(error);
      assert.ok(stdout.length<=4096);
      assert.ok(stderr.length<=4096);
      resolve();
    });
    runner.stdin.end('start\n');
  }));
  assert.deepEqual(output(id,'stdout'),raw);
  assert.deepEqual(output(id,'stderr'),raw);
});

test('previews cannot overwrite complete checkpoints when journal persistence fails', () => {
  const { snapshotter } = require('../src/execution-preview');
  const snapshot = snapshotter();
  const value = {stdout:'owner bytes '.repeat(1000)};
  assert.throws(()=>snapshot('id',value,()=>{throw new Error('disk full');}),/disk full/);
  let evidence;
  const summary=snapshot('id',value,record=>{evidence=record;});
  assert.equal(evidence.changes.stdout,value.stdout,'failed attempts never advance the evidence cache');
  assert.ok(summary.stdout.length<4200);
});

test('startup builds recoverable projections without changing canonical files', () => {
  const id = 't-old-state';
  store.ensureDirs();
  const raw = 'old output\r\n'.repeat(100000);
  const taskFile = path.join(store.paths.done, `${id}.json`);
  const resultFile = path.join(store.paths.results, `${id}.json`);
  const task = JSON.stringify({id,status:'failed',r1:{verification:{stdout:raw}}});
  const result = JSON.stringify({id,summary:raw});
  fs.writeFileSync(taskFile, task);
  fs.writeFileSync(resultFile, result);
  store.compactState();
  assert.equal(fs.readFileSync(taskFile,'utf8'), task);
  assert.equal(fs.readFileSync(resultFile,'utf8'), result);
  assert.ok(store.readDashboardResult(id).summary.length < 4200);
  // A new process/module reuses durable projections; polls never read full files.
  delete require.cache[require.resolve('../src/store')];
  const reopened = require('../src/store');
  const read = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    assert.ok(![taskFile, resultFile].includes(file), 'poll must not parse canonical output');
    return read(file, ...args);
  };
  try {
    for (let i=0;i<3;i++) {
      assert.ok(reopened.listTasks('done', { dashboard: true }).find(t=>t.id===id).r1.verification.stdout.length < 4200);
      assert.ok(reopened.readDashboardResult(id).summary.length < 4200);
    }
  } finally { fs.readFileSync = read; }
  // Simulate a crash after a canonical write but before its sidecar update.
  fs.writeFileSync(resultFile, JSON.stringify({id, summary:'NEW HEAD'+raw+'NEW TAIL'}));
  assert.ok(reopened.readDashboardResult(id).summary.startsWith('NEW HEAD'));
  assert.equal(JSON.parse(fs.readFileSync(resultFile)).summary, 'NEW HEAD'+raw+'NEW TAIL');
  fs.writeFileSync(path.join(root,'dashboard/results',`${id}.json`), '{torn');
  assert.ok(reopened.readDashboardResult(id).summary.startsWith('NEW HEAD'));
  fs.rmSync(path.join(root,'dashboard'),{recursive:true,force:true});
  reopened.compactState();
  assert.ok(reopened.readDashboardResult(id).summary.length < 4200);
});

test('eight critic retry cycles retain exact previous fixes in the next worker prompt after reload', () => {
  const { loopWorkerPrompt } = require('../src/prompts');
  const id = 't-critic-context';
  let loop = { id, type:'loop', cycles:[] };
  for (let n=1;n<=8;n++) {
    const fixes = `cycle ${n} exact diagnostics ` + 'f'.repeat(20000) + ` tail ${n} token=owner /tmp/file`;
    loop.cycles.push({n,status:'failed',fixes,workerSummary:'w'.repeat(20000),criticSummary:'c'.repeat(20000),summary:'s'.repeat(20000)});
    store.writeTask(loop,'running');
    delete require.cache[require.resolve('../src/store')];
    loop = require('../src/store').readTask(id,'running');
    assert.equal(loop.cycles.at(-1).fixes,fixes);
    const prompt = loopWorkerPrompt(loop, loop.cycles.at(-1).fixes);
    assert.equal(prompt.split('--- FIXES START ---\n')[1].split('\n--- FIXES END ---')[0],fixes);
    assert.equal(loop.cycles[0].fixes, 'cycle 1 exact diagnostics ' + 'f'.repeat(20000) + ' tail 1 token=owner /tmp/file');
  }
});

test('CI corrective prompt receives every diagnostic byte, including the tail, after job-store reload', () => {
  const { createJob, createJobStore, recordCorrectiveCycle } = require('../src/autopilot-state');
  const { buildCorrectiveTask } = require('../src/autopilot-task');
  const directory = path.join(root,'corrective-jobs');
  const jobs = createJobStore(directory);
  const issue = { number:90,title:'Fix diagnostics',body:'Preserve complete state' };
  const job = createJob({projectName:'example',repo:'owner/repo',issue,branch:'fix',worktreePath:'/tmp/work',now:jobs.now});
  const diagnostics = 'CI HEAD\n' + 'log\n'.repeat(100000) + 'EXACT FAILURE TAIL token=owner /tmp/failure\nstack';
  recordCorrectiveCycle(job,{redCommit:'a'.repeat(40),diagnostics});
  jobs.save(job);
  const reloaded = createJobStore(directory).load(90);
  assert.equal(reloaded.correction.diagnostics,diagnostics);
  const task = buildCorrectiveTask({repo:'owner/repo',verification:'npm test'},issue,[],reloaded.correction);
  assert.ok(task.goal.includes(`CI failure diagnostics:\n${diagnostics}\n\n`));
});

test('daemon recovers with corrupt historical files while huge output stays out of state polls', async () => {
  const http = require('node:http');
  const pollRoot = fs.mkdtempSync(path.join(root,'poll-'));
  const configFile = path.join(pollRoot,'config.json');
  fs.writeFileSync(configFile, JSON.stringify({dashboardPort:0,maxConcurrent:0}));
  const script = `
    const fs=require('node:fs'),path=require('node:path');
    const store=require(${JSON.stringify(require.resolve('../src/store'))});
    const id='t-api-huge',raw='owner token=raw /tmp/path\\n'+'X'.repeat(4*1024*1024)+'END';
    if(!fs.existsSync(path.join(store.paths.done,id+'.json'))) {
      store.writeTask({id,type:'task',status:'done',finishedAt:new Date().toISOString(),prompt:raw,goal:raw,description:raw,acceptance:[raw],r1:{verification:{stdout:raw}}},'done');
      store.writeResult({id,status:'done',summary:raw});
      store.writeTask({id:'t-recover-context',type:'task',status:'running',prompt:raw},'running');
      fs.writeFileSync(path.join(store.paths.done,'t-torn-history.json'),'{torn');
      fs.writeFileSync(path.join(store.paths.results,'t-empty-history.json'),'');
      fs.rmSync(path.join(store.paths.state,'dashboard'),{recursive:true,force:true});
    }
    store.compactState();
    const read=fs.readFileSync;
    fs.readFileSync=(file,...args)=>{
      if([path.join(store.paths.done,id+'.json'),path.join(store.paths.results,id+'.json')].includes(file)) throw Error('API read full canonical output');
      return read(file,...args);
    };
    require(${JSON.stringify(require.resolve('../src/daemon'))}).start();
  `;
  for(let restart=0;restart<2;restart++) {
    const child=spawn(process.execPath,['-e',script],{env:{...process.env,AGENTLOOP_STATE_DIR:pollRoot,AGENTLOOP_CONFIG_PATH:configFile},stdio:['ignore','pipe','pipe']});
    const closed=new Promise(resolve=>child.once('close',resolve));
    let port, errors='';
    child.stderr.on('data',chunk=>errors+=chunk);
    try {
      await new Promise((resolve,reject)=>{
        child.once('error',reject);
        child.stdout.on('data',chunk=>{const match=String(chunk).match(/Dashboard: http:\/\/127.0.0.1:(\d+)/);if(match){port=Number(match[1]);resolve();}});
        child.once('exit',()=>reject(Error('fixture daemon exited before listening')));
      });
      for(let i=0;i<3;i++) {
        const response=await new Promise((resolve,reject)=>{
          http.get({host:'127.0.0.1',port,path:'/api/state'},res=>{
            let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body}));
          }).on('error',reject);
        });
        assert.equal(response.status,200,response.body);
        assert.ok(response.body.length<100000);
        assert.ok(JSON.parse(response.body).tasks.recent.find(t=>t.id==='t-api-huge').summary.length<4200);
        assert.equal(JSON.parse(response.body).tasks.recent.find(t=>t.id==='t-torn-history').status,'unreadable');
      }
      assert.match(errors,/Cannot project canonical state.*t-torn-history/);
      assert.match(errors,/Cannot project canonical state.*t-empty-history/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(pollRoot,'tasks/done/t-recover-context.json'))).status,'failed');
      assert.equal(fs.readFileSync(path.join(pollRoot,'tasks/done/t-torn-history.json'),'utf8'),'{torn');
      assert.equal(fs.readFileSync(path.join(pollRoot,'results/t-empty-history.json'),'utf8'),'');
    } finally {child.kill('SIGTERM');await closed;}
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(pollRoot,'tasks/done/t-api-huge.json'))).r1.verification.stdout.length,('owner token=raw /tmp/path\n'+'X'.repeat(4*1024*1024)+'END').length);
});

test('projection write failures preserve canonical checkpoints and cache reads; invalid cache shapes repair', () => {
  const { createDashboardProjection } = require('../src/dashboard-projection');
  const directory=path.join(root,'fault-projections');
  const file=path.join(root,'canonical-cache.json');
  const value={id:'canonical-cache',stdout:'owner bytes '.repeat(10000)};
  fs.writeFileSync(file,JSON.stringify(value));
  const messages=[],previous=console.error;
  console.error=message=>messages.push(message);
  try {
    const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{if(to.includes(`${path.sep}dashboard${path.sep}`)) throw new Error('projection rename failed');return rename(from,to);};
    try {
      store.writeTask({id:'t-cache-write',type:'task',stdout:value.stdout},'pending');
      store.writeResult({id:'t-cache-write',summary:value.stdout});
    } finally {fs.renameSync=rename;}
    assert.equal(store.readTask('t-cache-write','pending').stdout,value.stdout);
    assert.equal(JSON.parse(fs.readFileSync(path.join(store.paths.results,'t-cache-write.json'))).summary,value.stdout);
    assert.ok(messages.some(message=>message.includes('projection rename failed')));
    const cache=createDashboardProjection(directory,()=>{throw new Error('projection disk unavailable');});
    assert.ok(cache.save(file,value).stdout.length<4200);
    const read=fs.readFileSync;
    fs.readFileSync=(candidate,...args)=>{assert.notEqual(candidate,file);return read(candidate,...args);};
    try {assert.ok(cache.read(file).stdout.length<4200);} finally {fs.readFileSync=read;}
    assert.ok(messages.some(message=>message.includes('projection disk unavailable')));
    assert.deepEqual(JSON.parse(fs.readFileSync(file)),value);
    const write=(candidate,entry)=>{fs.mkdirSync(path.dirname(candidate),{recursive:true});fs.writeFileSync(candidate,JSON.stringify(entry));};
    const reopen=()=>createDashboardProjection(directory,write);
    reopen().read(file);
    const sidecar=path.join(directory,path.basename(file));
    const entry=JSON.parse(fs.readFileSync(sidecar));
    for(const damaged of [null,[],{source:entry.source,value:null},{source:entry.source,value:[]}]) {
      fs.writeFileSync(sidecar,JSON.stringify(damaged));
      assert.ok(reopen().read(file).stdout.length<4200);
      assert.ok(JSON.parse(fs.readFileSync(sidecar)).value.stdout.length<4200);
    }
  } finally {console.error=previous;}
});
