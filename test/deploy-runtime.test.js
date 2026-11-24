'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const {spawn, execFileSync} = require('node:child_process');
const {hash} = require('../src/deploy-files');
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
function request(port, route, body) {
  return new Promise((resolve,reject)=>{
    const data = body ? JSON.stringify(body) : undefined;
    const req=http.request({host:'127.0.0.1',port,path:route,method:body?'POST':'GET',
      headers: data ? {'content-type':'application/json','content-length':Buffer.byteLength(data)} : {}},res=>{
      let bytes='';res.on('data',b=>bytes+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(bytes)}));
    });
    req.setTimeout(2000,()=>req.destroy(Error('disposable daemon request timeout')));
    req.on('error',reject);req.end(data);
  });
}
test('disposable daemon loads external-only project config and attests sealed runtime identity; drift refuses R1', {timeout:20000}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deploy-runtime-'));
  const checkout=path.join(root,'source');fs.mkdirSync(checkout);
  execFileSync('/usr/bin/git',['-C',checkout,'init','--template=','--initial-branch=ralph-dev'],{stdio:'ignore'});
  const projectFile=path.join(root,'external-projects.json'),configFile=path.join(root,'daemon-config.json');
  const projects={externalonly:{enabled:false,repo:'fixture/offline',checkout,worktreeRoot:path.join(root,'worktrees'),stateDir:path.join(root,'project-state'),baseBranch:'ralph-dev',readyLabel:'ready',humanLabel:'human',worker:'codex',verification:'npm test',reviewPolicy:'always',autoMerge:true}};
  const bytes=JSON.stringify(projects);fs.writeFileSync(projectFile,bytes);
  fs.writeFileSync(configFile,JSON.stringify({dashboardPort:0,allowedProjects:{externalonly:checkout},enginePaths:{codex:'/bin/false',claude:'/bin/false',gemini:'/bin/false'}}));
  const configBytes=fs.readFileSync(configFile);
  const child=spawn(process.execPath,['-e',`console.error=(...args)=>require('fs').writeSync(2,args.join(' ')+'\\n');require(${JSON.stringify(require.resolve('../src/daemon'))}).start()`],{env:{...process.env,AGENTLOOP_CONFIG_PATH:configFile,AGENTLOOP_STATE_DIR:path.join(root,'daemon-state'),AGENTLOOP_PROJECTS_PATH:projectFile},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',exited=false,exitInfo;child.on('error',e=>stderr+=e.stack);child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const closed=new Promise(resolve=>child.on('close',(code,signal)=>{exitInfo={code,signal};exited=true;resolve();}));
  t.after(async()=>{
    if(!exited)child.kill('SIGTERM');await closed;
    fs.writeFileSync(path.join(root,'worker.stdout'),stdout);fs.writeFileSync(path.join(root,'worker.stderr'),stderr);
    if(process.env.RALPH_DEPLOY_TEST_AUDIT_DIR)fs.cpSync(root,path.join(process.env.RALPH_DEPLOY_TEST_AUDIT_DIR,path.basename(root)),{recursive:true});
    fs.rmSync(root,{recursive:true,force:true});
  });
  const deadline=Date.now()+10000;
  while(!/Dashboard: http:\/\/127.0.0.1:(\d+)/.test(stdout)) {
    if (exited && stderr.includes('listen EPERM') && process.env.RALPH_DEPLOY_REQUIRE_NATIVE !== '1') {
      t.skip('sandbox refuses loopback listen EPERM; strict native gate remains required'); return;
    }
    assert.ok(!exited && Date.now()<deadline,'disposable daemon failed to listen: '+JSON.stringify(exitInfo)+' '+stdout+'\n'+stderr);await pause(40);
  }
  const port=Number(/Dashboard: http:\/\/127.0.0.1:(\d+)/.exec(stdout)[1]);
  const state=await request(port,'/api/state');assert.equal(state.status,200);
  assert.equal(state.body.daemon.pid,child.pid);
  assert.deepEqual(state.body.daemon.projectConfig,{pathHash:hash(projectFile),hash:hash(bytes)});
  const submit=()=>request(port,'/api/development/jobs',{project:'externalonly',issue:30});
  const refused=await submit();assert.equal(refused.status,400);
  assert.match(refused.body.error,/enabled Codex project with independent review/);
  fs.appendFileSync(projectFile,' ');
  const drift=await submit();assert.equal(drift.status,400);assert.match(drift.body.error,/Runtime project configuration changed/);
  const degraded=await request(port,'/api/state');assert.equal(degraded.status,200);
  assert.equal(degraded.body.daemon.projectConfig.degraded,true);
  assert.equal(degraded.body.daemon.projectConfig.hash,null);
  assert.match(fs.readFileSync(path.join(root,'daemon-state/project-config.ndjson'),'utf8'),/PROJECT_CONFIG_DEGRADED/);
  fs.writeFileSync(projectFile,bytes);
  assert.match((await submit()).body.error,/enabled Codex project with independent review/);
  assert.deepEqual(fs.readFileSync(configFile),configBytes);assert.equal(fs.readFileSync(projectFile,'utf8'),bytes);
  t.diagnostic('Disposable daemon PID '+child.pid+' verified external-only R1 loading, identity and drift refusal; owner fixture bytes preserved.');
});

test('runtime external config refuses noncanonical aliases before reading',t=>{
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-alias-'));
  t.after(()=>fs.rmSync(state,{recursive:true,force:true}));
  assert.throws(()=>execFileSync(process.execPath,['-e',`require(${JSON.stringify(require.resolve('../src/autopilot-config'))}).loadProjectConfig('ralph')`],{
    env:{...process.env,AGENTLOOP_STATE_DIR:state,AGENTLOOP_PROJECTS_PATH:'/tmp/other/../projects.json'},stdio:['ignore','pipe','pipe']}),error=>/canonical absolute/.test(error.stderr.toString()));
});

test('disposable process routes R1 through external-only config and preserves pinned identity without a listener', t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deploy-runtime-routes-'));
  t.after(()=>{if(process.env.RALPH_DEPLOY_TEST_AUDIT_DIR)fs.cpSync(root,path.join(process.env.RALPH_DEPLOY_TEST_AUDIT_DIR,path.basename(root)),{recursive:true});fs.rmSync(root,{recursive:true,force:true});});
  const checkout=path.join(root,'source');fs.mkdirSync(checkout);
  execFileSync('/usr/bin/git',['-C',checkout,'init','--template='],{stdio:'ignore'});
  const projects=path.join(root,'projects.json'),config=path.join(root,'config.json');
  const original=JSON.stringify({externalonly:{enabled:false,repo:'fixture/offline',checkout,worktreeRoot:path.join(root,'worktrees'),baseBranch:'ralph-dev',readyLabel:'ready',humanLabel:'human',worker:'codex',verification:'npm test',reviewPolicy:'always',autoMerge:true}});
  fs.writeFileSync(projects,original);fs.writeFileSync(config,JSON.stringify({allowedProjects:{externalonly:checkout}}));
  const worker=path.join(root,'routes.js');
  fs.writeFileSync(worker,`
    const fs=require('fs'),{PassThrough}=require('stream'),assert=require('assert/strict');
    const daemon=require(${JSON.stringify(require.resolve('../src/daemon'))}),configuration=require(${JSON.stringify(require.resolve('../src/autopilot-config'))});
    const server=daemon.createHttpServer();
    const identity=configuration.runtimeProjectConfigIdentity();
    assert.equal(identity.path,${JSON.stringify(projects)});
    async function submit(){
      const req=new PassThrough();req.method='POST';req.url='/api/development/jobs';req.socket={localPort:1234};req.headers={host:'127.0.0.1:1234'};
      const response=new Promise(resolve=>{let status;server.emit('request',req,{writeHead:code=>status=code,end:body=>resolve({status,body:JSON.parse(body)})});});
      req.end(JSON.stringify({project:'externalonly',issue:30}));return response;
    }
    (async()=>{
      const first=await submit();assert.equal(first.status,400);assert.match(first.body.error,/enabled Codex project with independent review/);
      const attestation=configuration.runtimeProjectConfigAttestation();
      fs.appendFileSync(identity.path,' ');const drift=await submit();assert.equal(drift.status,400);assert.match(drift.body.error,/Runtime project configuration changed/);
      assert.throws(()=>configuration.runtimeProjectConfigAttestation(),/Runtime project configuration changed/);
      fs.writeFileSync(identity.path,${JSON.stringify(original)});assert.deepEqual(configuration.runtimeProjectConfigAttestation(),attestation);
      fs.writeSync(1,JSON.stringify({first,drift,attestation,pid:process.pid}));
    })().catch(e=>{fs.writeSync(2,e.stack);process.exitCode=1;});
  `);
  const result=execFileSync(process.execPath,[worker],{env:{...process.env,AGENTLOOP_PROJECTS_PATH:projects,AGENTLOOP_CONFIG_PATH:config,AGENTLOOP_STATE_DIR:path.join(root,'state')},stdio:['ignore','pipe','pipe']});
  fs.writeFileSync(path.join(root,'worker.stdout'),result);
  const records=JSON.parse(result);
  assert.deepEqual(records.attestation,{pathHash:hash(projects),hash:hash(original)});
  assert.equal(fs.readFileSync(projects,'utf8'),original);
});


test('actual daemon admission refuses atomic owner registration drift with durable audit and HTTP degraded state', {timeout:20000}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deploy-admission-'));
  const checkout=path.join(root,'checkout');fs.mkdirSync(checkout);
  const projects=path.join(root,'projects.json'),config=path.join(root,'config.json'),scans=path.join(root,'scans');
  const project={enabled:true,autoMerge:true,repo:'fixture/offline',checkout,worktreeRoot:path.join(root,'worktrees'),stateDir:path.join(root,'jobs'),baseBranch:'main',readyLabel:'ready',humanLabel:'human',worker:'codex',verification:'true',reviewPolicy:'always'};
  fs.writeFileSync(projects,JSON.stringify({externalonly:project}));
  fs.writeFileSync(config,JSON.stringify({dashboardPort:0,allowedProjects:{externalonly:checkout}}));
  const child=spawn(process.execPath,['-e',`
    const fs=require('fs');console.error=(...args)=>fs.writeSync(2,args.join(' ')+'\\n');require(${JSON.stringify(require.resolve('../src/daemon'))}).start({r1:{admitIntervalMs:0,autopilotDependencies:{discoverReadyIssues:async()=>{fs.appendFileSync(${JSON.stringify(scans)},'scan\\n');return [];}}}});
  `],{env:{...process.env,AGENTLOOP_PROJECTS_PATH:projects,AGENTLOOP_CONFIG_PATH:config,AGENTLOOP_STATE_DIR:path.join(root,'state')},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',exited=false;child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const closed=new Promise(r=>child.on('close',()=>{exited=true;r();}));
  t.after(async()=>{if(!exited)child.kill('SIGTERM');await closed;fs.writeFileSync(path.join(root,'stdout'),stdout);fs.writeFileSync(path.join(root,'stderr'),stderr);if(process.env.RALPH_DEPLOY_TEST_AUDIT_DIR)fs.cpSync(root,path.join(process.env.RALPH_DEPLOY_TEST_AUDIT_DIR,path.basename(root)),{recursive:true});fs.rmSync(root,{recursive:true,force:true});});
  const deadline=Date.now()+10000;
  while(!fs.existsSync(scans)||!/Dashboard: http:\/\/127.0.0.1:(\d+)/.test(stdout)){
    if(exited&&stderr.includes('listen EPERM')&&process.env.RALPH_DEPLOY_REQUIRE_NATIVE!=='1'){t.skip('sandbox refuses loopback listen EPERM; strict native admission gate required');return;}
    assert.ok(!exited&&Date.now()<deadline,stdout+'\n'+stderr);await pause(40);
  }
  const port=Number(/Dashboard: http:\/\/127.0.0.1:(\d+)/.exec(stdout)[1]);
  const before=fs.readFileSync(scans,'utf8');
  // Project registration publishes via atomic rename. Never accept its new
  // policy inside this process without the owner's separately scheduled restart.
  fs.writeFileSync(projects+'.new',JSON.stringify({externalonly:project,registered:{...project,enabled:false}}));fs.renameSync(projects+'.new',projects);
  await pause(1800);
  assert.equal(fs.readFileSync(scans,'utf8'),before,'drift must stop discovery before any unauthorized admission');
  assert.match(stderr,/R1 admission configuration refused.*Runtime project configuration changed/);
  const response=await request(port,'/api/state');assert.equal(response.status,200);
  assert.equal(response.body.daemon.pid,child.pid);assert.equal(response.body.daemon.projectConfig.degraded,true);
  const audit=fs.readFileSync(path.join(root,'state/project-config.ndjson'),'utf8');assert.match(audit,/PROJECT_CONFIG_DEGRADED/);assert.match(audit,/owner restart required/);
  assert.doesNotThrow(()=>process.kill(child.pid,0));
});


test('socket-free actual daemon scheduler and HTTP handler retain admission drift evidence', t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deploy-scheduler-'));
  t.after(()=>{if(process.env.RALPH_DEPLOY_TEST_AUDIT_DIR)fs.cpSync(root,path.join(process.env.RALPH_DEPLOY_TEST_AUDIT_DIR,path.basename(root)),{recursive:true});fs.rmSync(root,{recursive:true,force:true});});
  const checkout=path.join(root,'checkout');fs.mkdirSync(checkout);
  const projects=path.join(root,'projects.json'),config=path.join(root,'config.json');
  fs.writeFileSync(projects,JSON.stringify({externalonly:{enabled:true,autoMerge:true,repo:'fixture/offline',checkout,worktreeRoot:path.join(root,'worktrees'),stateDir:path.join(root,'jobs'),baseBranch:'main',readyLabel:'ready',humanLabel:'human',worker:'codex',verification:'true',reviewPolicy:'always'}}));
  fs.writeFileSync(config,JSON.stringify({allowedProjects:{externalonly:checkout}}));
  const worker=path.join(root,'worker.js');
  fs.writeFileSync(worker,`
    const fs=require('fs'),assert=require('assert/strict'),{PassThrough}=require('stream');
    console.error=(...args)=>fs.writeSync(2,args.join(' ')+'\\n');
    const daemon=require(${JSON.stringify(require.resolve('../src/daemon'))});
    let scans=0;
    daemon.testing.initializeRuntime({r1:{admitIntervalMs:0,autopilotDependencies:{discoverReadyIssues:async()=>{scans++;return [];}}}});
    const server=daemon.createHttpServer();
    const state=()=>new Promise(resolve=>{let status;const req=new PassThrough();req.method='GET';req.url='/api/state';req.socket={localPort:1234};req.headers={host:'127.0.0.1:1234'};server.emit('request',req,{writeHead:code=>{status=code;},end:body=>{assert.equal(status,200,body);resolve(JSON.parse(body));}});req.end();});
    (async()=>{
      daemon.fillSlots();await new Promise(r=>setImmediate(r));assert.equal(scans,1);
      assert.equal((await state()).daemon.projectConfig.degraded,undefined);
      const projectFile=${JSON.stringify(projects)};
      const registration=JSON.parse(fs.readFileSync(projectFile,'utf8'));registration.registered={...registration.externalonly,enabled:false};
      fs.writeFileSync(projectFile+'.new',JSON.stringify(registration));fs.renameSync(projectFile+'.new',projectFile);
      daemon.fillSlots();await new Promise(r=>setImmediate(r));assert.equal(scans,1);
      const degraded=await state();assert.equal(degraded.daemon.projectConfig.degraded,true);assert.equal(degraded.daemon.projectConfig.hash,null);
      const audit=fs.readFileSync(${JSON.stringify(path.join(root,'state/project-config.ndjson'))},'utf8');assert.match(audit,/PROJECT_CONFIG_DEGRADED/);assert.match(audit,/owner restart required/);
      daemon.fillSlots();await new Promise(r=>setImmediate(r));assert.equal(scans,1);
      assert.equal(fs.readFileSync(${JSON.stringify(path.join(root,'state/project-config.ndjson'))},'utf8'),audit,'repeat reads retain evidence without duplicate flood');
      fs.writeSync(1,JSON.stringify({scans,degraded,audit}));
    })().catch(e=>{fs.writeSync(2,e.stack);process.exitCode=1;});
  `);
  const result=require('child_process').spawnSync(process.execPath,[worker],{env:{...process.env,AGENTLOOP_PROJECTS_PATH:projects,AGENTLOOP_CONFIG_PATH:config,AGENTLOOP_STATE_DIR:path.join(root,'state')},encoding:'utf8'});
  fs.writeFileSync(path.join(root,'stdout'),result.stdout||'');fs.writeFileSync(path.join(root,'stderr'),result.stderr||'');
  assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/R1 admission configuration refused/);
});
