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
    let raw='';res.on('data',c=>{raw+=c;});res.on('end',()=>resolve(JSON.parse(raw)));
  });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
});}
function lines(file){try{return fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}}

async function runCase(testCase) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'r1-mixed-e2e-'));
 const checkout=path.join(root,'repo');fs.mkdirSync(checkout);git(checkout,'init','-b','main');
 git(checkout,'config','user.name','Fixture');git(checkout,'config','user.email','fixture@example.test');
 fs.writeFileSync(path.join(checkout,'README'),'test');git(checkout,'add','.');git(checkout,'commit','-m','init');
 const worktreeRoot=path.join(root,'worktrees');fs.mkdirSync(worktreeRoot);
 const scenarioPath=path.join(root,'scenario.json');const mockState=path.join(root,'mock-state');
 fs.writeFileSync(scenarioPath,JSON.stringify({engine:{worker:[{write:'answer',contents:'wrong',touchState:false},{write:'answer',contents:'42',touchState:false}],critic:testCase==='critic-reject' ? ['FAIL - not acceptable'] : ['FAIL - answer was wrong','PASS']}}));
 const project={enabled:true,repo:'fixture/none',checkout,worktreeRoot,baseBranch:'main',worker:'codex',reviewPolicy:'always',reviewModel:'opus',implementationStrategy:'worker-critic-loop',autoMerge:false,
  readyLabel:'ready-for-agent',humanLabel:'ready-for-human',maxAttempts:2,stateDir:path.join(root,'r1-jobs'),verification:`node -e "if(require('fs').readFileSync('answer','utf8') !== '42')process.exit(1)"`};
 const mock=path.resolve(__dirname,'mock-engine.js');fs.chmodSync(mock,0o755);
 const config=path.join(root,'config.json');const queue=path.join(root,'queue');const fixture=path.join(root,'fixture.json');
 fs.writeFileSync(config,JSON.stringify({dashboardPort:0,maxConcurrent:1,defaultEngine:'codex',models:{codex:'gpt-5.6-terra',claude:'opus'},
  enginePaths:{codex:mock,claude:mock},allowedProjects:{demo:{root:checkout,worktreeRoot}}}));
 fs.writeFileSync(fixture,JSON.stringify({root,project}));
 let daemon,stderr='';
 try{
  daemon=spawn(process.execPath,[path.join(__dirname,'fixtures/r1-mixed-daemon.js')],{
   env:{...process.env,AGENTLOOP_CONFIG_PATH:config,AGENTLOOP_STATE_DIR:queue,R1_MIXED_FIXTURE:fixture,AGENTLOOP_MOCK_SCENARIO:scenarioPath,AGENTLOOP_MOCK_STATE:mockState},stdio:['ignore','pipe','pipe']});
  daemon.stdout.on('data',d=>{stderr+=d;});daemon.stderr.on('data',d=>{stderr+=d;});
  const port=await until(()=>{try{const x=JSON.parse(fs.readFileSync(path.join(queue,'daemon.json')));return x.pid===daemon.pid && x.port||null;}catch{return null;}});
  const created=await request(port,'/api/r1/jobs',{project:'demo',issue:5,title:'Add answer'});
  assert.match(created.id,/^t-[a-f0-9]{8}$/);
  const finished=await until(async()=>{const j=await request(port,`/api/r1/jobs/${created.id}`);return ['ready_for_human_merge','blocked','failed','passed'].includes(j.status)&&j;},55000);
  if(testCase==='critic-reject') {
    assert.notEqual(finished.status,'passed');
    assert.equal(lines(path.join(root,'delivery')).length,0);
    assert.equal(lines(path.join(root,'ci')).length,0);
    assert.equal(lines(path.join(root,'final-review')).length,0);
    return;
  }
  assert.equal(finished.status,'passed',JSON.stringify({phase:finished.phase,status:finished.status,fail:finished.failure,evidence:finished.evidence,logs:stderr.slice(-4000)}));
  assert.equal(finished.evidence.outcome,'ready_for_human_merge');
  const invocations=lines(path.join(mockState,'invocations.ndjson'));
  assert.deepEqual(invocations.map(x=>[x.engine,x.role]),[['codex','worker'],['claude','critic'],['codex','worker'],['claude','critic']]);
  assert.deepEqual(invocations.map(x=>x.model),['gpt-5.6-terra','opus','gpt-5.6-terra','opus']);
  assert.ok(invocations[1].argv.includes('dontAsk'));
  const [delivered]=lines(path.join(root,'delivery'));
  assert.equal(lines(path.join(root,'ci')).some(x=>x.commit===delivered.commit),true);
  assert.equal(lines(path.join(root,'final-review')).some(x=>x.headCommit===delivered.commit),true);
  const worktree=path.join(worktreeRoot,'issue-5');
  const historical=git(worktree,'log','--format=','--name-only','HEAD').split('\n');
  for(const name of ['PLAN.md','GUIDELINES.md','STATE.md'])assert.equal(historical.includes(name),false);
  const children=fs.readdirSync(path.join(queue,'r1-child-index',created.id));
  assert.equal(children.filter(name=>name.endsWith('.json')).length,1);
 }catch(e){e.message+='\nDaemon diagnostic:\n'+stderr.slice(-6000);throw e;}
 finally{
  if(daemon && daemon.exitCode===null){const exit=new Promise(resolve=>daemon.once('exit',resolve));daemon.kill('SIGTERM');await Promise.race([exit,pause(5000)]);if(daemon.exitCode===null)daemon.kill('SIGKILL');}
  fs.rmSync(root,{recursive:true,force:true});
 }
}

test('opt-in parent executes Codex FAIL -> Claude critic -> Codex correction -> Claude PASS then R1 gates', {timeout:75000}, () => runCase('accepted'));
test('rejected final critic never delivers, observes CI, or records final PR review', {timeout:75000}, () => runCase('critic-reject'));
