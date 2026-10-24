'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const http = require('node:http');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding:'utf8' }).trim(); }
async function until(get, timeout = 32000) {
  const end = Date.now() + timeout;
  while(Date.now() < end){const result = await get();if(result)return result;await pause(60);}
  throw Error('R1 mixed-engine integration timeout');
}
function request(port, route, body) {return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path:route,method:body?'POST':'GET',headers:{'content-type':'application/json'}},res=>{
    let raw='';res.on('data',c=>{raw+=c;});res.on('end',()=>{try{resolve(JSON.parse(raw));}catch(error){reject(new Error(`Unexpected daemon response (${res.statusCode}): ${raw.slice(0,250)}`));}});
  });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
});}
function download(port, route) { return new Promise((resolve, reject) => {
  http.get({hostname:'127.0.0.1',port,path:route}, res => {
    const chunks=[]; res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => { try { assert.equal(res.statusCode,200); assert.match(res.headers['content-disposition'], /attachment/); resolve(Buffer.concat(chunks)); } catch(error) { reject(error); } });
  }).on('error',reject);
}); }
function lines(file){try{return fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}}

async function runCase(testCase) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'r1-mixed-e2e-'));
 const checkout=path.join(root,'repo');fs.mkdirSync(checkout);git(checkout,'init','-b','main');
 git(checkout,'config','user.name','Fixture');git(checkout,'config','user.email','fixture@example.test');
 fs.writeFileSync(path.join(checkout,'README'),'test');git(checkout,'add','.');git(checkout,'commit','-m','init');
 const worktreeRoot=path.join(root,'worktrees');fs.mkdirSync(worktreeRoot);
 const marker = 'token=owner-secret /tmp/private/vm-file <script>alert(1)</script>\r\nmultiline failure\n';
 const scenarioPath=path.join(root,'scenario.json');const mockState=path.join(root,'mock-state');
 fs.writeFileSync(scenarioPath,JSON.stringify({engine:{worker:[{write:'answer',contents:'wrong',touchState:false,stdout:marker,stderr:'worker stderr\n',earlyStdout:testCase==='transcript-crash'?marker:undefined,latencyMs:testCase==='transcript-crash'?10000:0},{write:'answer',contents:'42',touchState:false}],critic:testCase==='critic-reject' ? ['FAIL - not acceptable'] : [{verdict:'FAIL - answer was wrong',stderr:marker},'PASS']}}));
 const project={enabled:true,repo:'fixture/none',checkout,worktreeRoot,baseBranch:'main',worker:'codex',reviewPolicy:'always',reviewModel:'opus',implementationStrategy:'worker-critic-loop',autoMerge:false,
  readyLabel:'ready-for-agent',humanLabel:'ready-for-human',maxAttempts:2,stateDir:path.join(root,'r1-jobs'),verification:`node -e "if(require('fs').readFileSync('answer','utf8') !== '42')process.exit(1);require('fs').writeFileSync('${path.join(worktreeRoot, 'issue-5', 'verified-at')}',new Date().toISOString())"`};
 if (testCase === 'transcript') {
   fs.writeFileSync(path.join(checkout,'verify.js'), `require('fs').writeFileSync(1, ${JSON.stringify(marker + 'large-log\n'.repeat(200000))});require('fs').writeFileSync(2, 'test: owner failure\\nstack line\\n');process.exit(7);`);
   git(checkout,'add','verify.js');git(checkout,'commit','-m','Verification fixture');
   project.verification = 'node verify.js';
 }
 const mock=path.resolve(__dirname,'mock-engine.js');
 const config=path.join(root,'config.json');const queue=path.join(root,'queue');const fixture=path.join(root,'fixture.json');
 fs.writeFileSync(config,JSON.stringify({dashboardPort:0,maxConcurrent:1,defaultEngine:'codex',models:{codex:'gpt-6.1-sol',claude:'opus'},
  enginePaths:{codex:mock,claude:mock},allowedProjects:{demo:{root:checkout,worktreeRoot}}}));
 fs.writeFileSync(fixture,JSON.stringify({root,project}));
 let daemon,output='';
 const launch = async () => {
  daemon=spawn(process.execPath,[path.join(__dirname,'fixtures/r1-mixed-daemon.js')],{
   env:{...process.env,AGENTLOOP_CONFIG_PATH:config,AGENTLOOP_STATE_DIR:queue,R1_MIXED_FIXTURE:fixture,AGENTLOOP_MOCK_SCENARIO:scenarioPath,AGENTLOOP_MOCK_STATE:mockState},stdio:['ignore','pipe','pipe']});
  daemon.stdout.on('data',d=>{output+=d;});daemon.stderr.on('data',d=>{output+=d;});
  return await until(()=>{try{const x=JSON.parse(fs.readFileSync(path.join(queue,'daemon.json')));return x.pid===daemon.pid && x.port||null;}catch{return null;}},7000);
 };
 try{
  let port = await launch();
  const created=await request(port,'/api/r1/jobs',{project:'demo',issue:5,title:'Add answer'});
  assert.match(created.id,/^t-[a-f0-9]{8}$/);
  if (testCase === 'transcript-crash') {
    const before = await until(async () => {
      const page = await request(port, `/api/log/${created.id}?raw=1&bytes=262144`);
      const raw = Buffer.from(page.base64 || '', 'base64');
      const captured = raw.toString().split('\n').flatMap(line => { try { const r = JSON.parse(line); return r.base64 ? [Buffer.from(r.base64, 'base64').toString()] : []; } catch { return []; } }).join('');
      return captured.includes(marker) && raw;
    });
    const exit = new Promise(resolve => daemon.once('exit', resolve)); daemon.kill('SIGKILL'); await exit;
    port = await launch();
    const after = await request(port, `/api/log/${created.id}?raw=1&bytes=262144`);
    assert.deepEqual(Buffer.from(after.base64,'base64').subarray(0,before.length), before, 'daemon SIGKILL preserves all prior captured bytes across recovery');
    return;
  }
  const finished=await until(async()=>{const j=await request(port,`/api/r1/jobs/${created.id}`);return ['ready_for_human_merge','blocked','failed','passed'].includes(j.status)&&j;},55000);
  if (testCase === 'transcript') {
    assert.equal(finished.status, 'blocked');
    const fullOutput = marker + 'large-log\n'.repeat(200000);
    assert.equal(finished.evidence.verification.stdout, undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(queue,'tasks/done',`${created.id}.json`))).r1.verification.stdout, fullOutput);
    assert.equal(JSON.parse(fs.readFileSync(path.join(project.stateDir,'issue-5.json'))).verification.stdout, fullOutput);
    for (let poll = 0; poll < 3; poll++) {
      const state = await request(port,'/api/state');
      assert.ok(JSON.stringify(state).length < 100000, 'fast state polls exclude massive captured output');
    }
    const rawPage = async (id, offset = 0) => request(port, `/api/log/${id}?raw=1&offset=${offset}&bytes=262144`);
    const retrieve = async id => {
      let offset = 0; const chunks = [];
      do {
        const page = await rawPage(id, offset);
        assert.equal(page.offset, offset);
        assert.ok(page.nextOffset >= offset);
        chunks.push(Buffer.from(page.base64, 'base64'));
        if (page.nextOffset === offset) break;
        offset = page.nextOffset;
        if (!page.hasMore) break;
      } while (true);
      return Buffer.concat(chunks);
    };
    const before = await retrieve(created.id);
    assert.deepEqual(await download(port, `/api/log/${created.id}?download=1`), before);
    assert.deepEqual(await download(port, `/api/log/${created.id}?download=1&legacy=1`), fs.readFileSync(path.join(queue,'logs',`${created.id}.ndjson`)));
    assert.ok(before.length > 2000000, 'large logs remain retrievable beyond preview limits');
    const records = before.toString().trim().split('\n').flatMap(line => {try{return [JSON.parse(line)];}catch{return [];}});
    const captured = (role, stream) => Buffer.concat(records.filter(r => r.event === 'output' && r.role === role && r.stream === stream).map(r => Buffer.from(r.base64, 'base64'))).toString();
    assert.ok(captured('worker','stdout').includes(marker));
    assert.ok(captured('critic','stderr').includes(marker));
    assert.equal(captured('verification','stdout'), marker + 'large-log\n'.repeat(200000));
    assert.equal(captured('verification','stderr'), 'test: owner failure\nstack line\n');
    assert.ok(records.some(r => r.event === 'command' && r.role === 'verification' && r.command === 'node verify.js'));
    assert.ok(records.some(r => r.event === 'exit' && r.role === 'verification' && r.exitCode === 7));
    const childRecord = records.find(r => r.role === 'critic' && r.childId);
    assert.ok(childRecord, 'parent journal correlates actual child engine activity');
    assert.equal(childRecord.parentId, created.id);
    assert.ok(childRecord.attempt >= 1 && childRecord.timestamp);
    assert.ok(records.some(r => r.event === 'capabilities' && r.internalReasoning === 'Only CLI-exported events are available; non-exported model thoughts are unavailable.'));
    const childBefore = await retrieve(childRecord.childId);
    git(checkout,'worktree','remove','--force',path.join(worktreeRoot,'issue-5'));
    assert.deepEqual(await retrieve(created.id), before, 'worktree cleanup leaves every captured byte retrievable');
    assert.ok(childBefore.includes(Buffer.from('"role":"critic"')));
    const ended = new Promise(resolve => daemon.once('exit', resolve)); daemon.kill('SIGKILL'); await ended;
    // Recovery reads the durable state and journals, with no replay of a terminal job.
    port = await launch();
    assert.deepEqual(await retrieve(created.id), before);
    assert.deepEqual(await retrieve(childRecord.childId), childBefore);
    assert.equal((await request(port, `/api/r1/jobs/${created.id}`)).evidence.verification.stderr, undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(queue, 'tasks/done', `${created.id}.json`))).r1.verification.stderr, 'test: owner failure\nstack line\n');
    return;
  }
  if(testCase==='critic-reject') {
    assert.ok(['blocked','failed'].includes(finished.status), `Unexpected rejection status: ${finished.status}`);
    const rejectedInvocations=lines(path.join(mockState,'invocations.ndjson'));
    const critics=rejectedInvocations.filter(x=>x.role==='critic');
    assert.ok(critics.length>=2,'Critic must actually reject repeatedly, not merely fail to start');
    assert.ok(critics.every(x=>/VERDICT: FAIL/.test(x.verdict)),'All critic attempts must reject');
    assert.ok(rejectedInvocations.some(x=>x.role==='worker'),'Codex must actually run');
    assert.equal(lines(path.join(root,'delivery')).length,0);
    assert.equal(lines(path.join(root,'ci')).length,0);
    assert.equal(lines(path.join(root,'final-review')).length,0);
    return;
  }
  assert.equal(finished.status,'passed',JSON.stringify({phase:finished.phase,status:finished.status,fail:finished.failure,evidence:finished.evidence,logs:output.slice(-4000)}));
  assert.equal(finished.evidence.outcome,'ready_for_human_merge');
  const invocations=lines(path.join(mockState,'invocations.ndjson'));
  assert.deepEqual(invocations.map(x=>[x.engine,x.role]),[['codex','worker'],['claude','critic'],['codex','worker'],['claude','critic']]);
  assert.deepEqual(invocations.map(x=>x.model),['gpt-6.1-sol','opus','gpt-6.1-sol','opus']);
  assert.ok(invocations[1].argv.includes('dontAsk'));
  assert.ok(invocations[1].argv.includes('--restricted'));
  assert.ok(invocations[1].argv.includes('Read,Glob,Grep'));
  const verificationTime=Date.parse(fs.readFileSync(path.join(worktreeRoot,'issue-5','verified-at'),'utf8'));
  const finalCriticTime=Date.parse(invocations.at(-1).ts);
  assert.ok(verificationTime>=finalCriticTime,'deterministic verification must occur only after final critic PASS');
  const deliveries=lines(path.join(root,'delivery'));
  assert.equal(deliveries.length,1,'one delivery only');
  const [delivered]=deliveries;
  const ci=lines(path.join(root,'ci'));
  const review=lines(path.join(root,'final-review'));
  assert.ok(ci.length>=1 && ci.every(x=>x.commit===delivered.commit),'every CI observation uses the delivery SHA');
  assert.ok(review.length>=1 && review.every(x=>x.headCommit===delivered.commit && x.verified?.passed===true),
    'every final Opus review must use the verified delivery SHA');
  const worktree=path.join(worktreeRoot,'issue-5');
  const historical=git(worktree,'log','--format=','--name-only','HEAD').split('\n');
  for(const name of ['PLAN.md','GUIDELINES.md','STATE.md'])assert.equal(historical.includes(name),false);
  const children=fs.readdirSync(path.join(queue,'r1-child-index',created.id));
  assert.equal(children.filter(name=>name.endsWith('.json')).length,1);
  const identity=JSON.parse(fs.readFileSync(path.join(queue,'r1-child-index',created.id,children.find(x=>x.endsWith('.json')))));
  assert.equal(identity.parentJobId,created.id);
  const childState=JSON.parse(fs.readFileSync(path.join(queue,'tasks','done',`${identity.id}.json`)));
  assert.equal(childState.status,'passed');
  assert.equal(childState.criticEngine,'claude');
  assert.equal(childState.cycles.at(-1).verdict,'PASS');
  const parentState=JSON.parse(fs.readFileSync(path.join(root,'r1-jobs','issue-5.json')));
  assert.equal(parentState.ralph.childLoopId,identity.id);
  assert.equal(parentState.r1ParentJobId,created.id);
  assert.equal(parentState.verification.commit,delivered.commit);
 }catch(e){e.message+='\nDaemon diagnostic:\n'+output.slice(-6000);throw e;}
 finally{
  if(daemon && daemon.exitCode===null){const exit=new Promise(resolve=>daemon.once('exit',resolve));daemon.kill('SIGTERM');await Promise.race([exit,pause(5000)]);if(daemon.exitCode===null)daemon.kill('SIGKILL');}
  fs.rmSync(root,{recursive:true,force:true});
 }
}

test('opt-in parent executes Codex FAIL -> Claude critic -> Codex correction -> Claude PASS then R1 gates', {timeout:69000}, () => runCase('accepted'));
test('rejected final critic never delivers, observes CI, or records final PR review', {timeout:69000}, () => runCase('critic-reject'));

test('complete worker, critic and failed verification output is paged verbatim after daemon restart', {timeout:69000}, () => runCase('transcript'));

test('daemon SIGKILL during active child execution preserves captured output through recovery', {timeout:69000}, () => runCase('transcript-crash'));
