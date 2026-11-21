'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const { duration, idle } = require('../src/deploy-systemd-guardian');
const pause = ms => new Promise(r => setTimeout(r,ms));
async function until(check, message, ms = 12000) {
  const end = Date.now()+ms;
  while (!(await check())) { assert.ok(Date.now()<end,message); await pause(50); }
}
test('systemd 255 formatted values and pending job object paths', () => {
  for (const [text,ms] of [['1min',60000],['20s',20000],['1min 2s',62000],['500ms',500],['1s 500ms',1500]]) assert.equal(duration(text),ms);
  for (const text of ['infinity','','0','0s','1min garbage','NaNs','-1s']) assert.throws(()=>duration(text));
  for (const text of ['', '0', '0 /']) assert.equal(idle(text),true);
  for (const text of ['7','7 /org/freedesktop/systemd1/job/7','/org/freedesktop/systemd1/job/7']) assert.equal(idle(text),false);
  assert.throws(()=>idle('unknown'));
});
for (const mode of ['complete','deadline']) test(`shipping command guardian survives worker SIGKILL, file diagnostics and lock: ${mode}`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'shipping-guardian-'));
  const fake = path.join(root,'systemctl'), queued = path.join(root,'queued'), complete = path.join(root,'complete');
  fs.writeFileSync(fake, `#!${process.execPath}
    const fs=require('fs'),args=process.argv.slice(2);
    if(args.includes('restart')) {
      if(!args.includes('--no-block')||!args.includes('--job-mode=fail'))process.exit(2);
      fs.writeFileSync(${JSON.stringify(queued)},'queued');fs.writeSync(2,'submission diagnostic\\n');process.exit(0);
    }
    const p=args.find(x=>x.startsWith('--property='))?.slice(11);
    const pending=fs.existsSync(${JSON.stringify(queued)})&&!fs.existsSync(${JSON.stringify(complete)});
    if(p==='Job'&&pending&&!fs.existsSync(${JSON.stringify(queued+'-observed')})){fs.writeFileSync(${JSON.stringify(queued+'-observed')},'observed');fs.writeSync(2,'transient show failure\\n');process.exit(1);}
    const fields={JobTimeoutUSec:${JSON.stringify(mode === 'deadline' ? '1s' : '1min')},TimeoutStartUSec:'20s',TimeoutStopUSec:'20s',SendSIGKILL:'yes',Job:pending?'7':'',ActiveState:pending?'activating':'active'};
    fs.writeSync(1,fields[p]+'\\n');
  `,{mode:0o755});
  const guardian = path.join(root,'guardian-test-entry.js');
  fs.writeFileSync(guardian, `require(${JSON.stringify(require.resolve('../src/deploy-systemd-guardian'))}).guardian(process.argv[2],${JSON.stringify(fake)}).catch(e=>{require('fs').writeSync(2,e.stack+'\\n');require('fs').fsyncSync(2);process.exitCode=1;});`);
  const worker = path.join(root,'worker.js'), record = path.join(root,'worker-audit.jsonl');
  fs.writeFileSync(worker, `
    const fs=require('fs');const audit=fs.openSync(${JSON.stringify(record)},'a');
    const command=require(${JSON.stringify(require.resolve('../src/deploy-command'))}).createCommand({location:${JSON.stringify(root)},env:process.env,record:e=>{fs.writeSync(audit,JSON.stringify(e)+'\\n');fs.fsyncSync(audit);}});
    require(${JSON.stringify(require.resolve('../src/deploy-update'))}).testing.systemd('restart',command,'/fake/deployment',${JSON.stringify(guardian)}).catch(e=>{console.error(e);process.exitCode=1;});
  `);
  const lock = path.join(root,'deployment.lock'), fd = fs.openSync(lock,'a+');
  // Pipes deliberately mirror the updater's caller: SIGKILL closes these pipes.
  const child = spawn('/bin/sh',['-c','/usr/bin/flock -n 3 || exit 75\nexec "$@"','test',process.execPath,worker],{stdio:['ignore','pipe','pipe',fd]});
  fs.closeSync(fd); child.stdout.resume(); let stderr='';child.stderr.on('data',b=>stderr+=b);
  const closed = new Promise(r=>child.on('close',r)); let guardianPid;
  t.after(()=>{child.kill('SIGKILL'); if(guardianPid)try{process.kill(guardianPid,'SIGKILL');}catch{} if (process.env.RALPH_DEPLOY_TEST_AUDIT_DIR) fs.cpSync(root,path.join(process.env.RALPH_DEPLOY_TEST_AUDIT_DIR,path.basename(root)),{recursive:true}); fs.rmSync(root,{recursive:true,force:true});});
  await until(()=>fs.existsSync(queued),'guardian did not queue: '+stderr);
  const event=fs.readFileSync(record,'utf8').trim().split('\n').map(JSON.parse).find(e=>e.persistent);
  const probe=()=>new Promise(r=>{const p=spawn('/usr/bin/flock',['-n',lock,'/bin/true'],{stdio:'ignore'});p.on('close',r);});
  child.kill('SIGKILL'); await closed;
  await pause(5200);
  assert.notEqual(await probe(),0,'guardian must retain lock beyond five seconds while job pending');
  assert.match(fs.readFileSync(event.stdout,'utf8'),/\n7\n/);
  assert.doesNotMatch(fs.readFileSync(event.stderr,'utf8'), /unknown systemd Job/);
  // stdout and stderr survive their worker; stderr from successful systemctl is captured too.
  assert.match(fs.readFileSync(event.stderr,'utf8'),/submission diagnostic/);
  assert.match(fs.readFileSync(event.stderr,'utf8'),/transient show failure/);
  guardianPid = Number(/guardian pid=(\d+)/.exec(fs.readFileSync(event.stdout,'utf8'))?.[1]);
  assert.ok(guardianPid>0);
  if(mode==='complete') fs.writeFileSync(complete,'complete');
  await until(async()=>await probe()===0,'guardian did not release bounded lock',10000);
  if(mode==='complete') assert.match(fs.readFileSync(event.stdout,'utf8'),/guardian job settled/);
  else assert.match(fs.readFileSync(event.stderr,'utf8'),/authoritative deadline/);
  await until(()=>!fs.existsSync('/proc/'+guardianPid),'guardian left a zombie',3000);
});
test('shipping timeout has a bounded kill-after even for TERM-ignoring descendants', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'guardian-kill-after-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const worker=path.join(root,'worker.js');
  fs.writeFileSync(worker, `const command=require(${JSON.stringify(require.resolve('../src/deploy-command'))}).createCommand({location:${JSON.stringify(root)},env:process.env,record:()=>{}});command(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],'0.3s',{persistent:true}).then(()=>process.exit(2),()=>process.exit(0));`);
  const fd=fs.openSync(path.join(root,'lock'),'a+'), start=Date.now();
  const child=spawn(process.execPath,[worker],{stdio:['ignore','ignore','ignore',fd]});fs.closeSync(fd);
  const result=await new Promise(r=>child.on('close',r));
  assert.equal(result,0);assert.ok(Date.now()-start>=2000);assert.ok(Date.now()-start<6000);
});

test('guardian checks real formatted bootstrap properties without submitting or polling a job', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'guardian-bootstrap-'));
  t.after(()=>{if(process.env.RALPH_DEPLOY_TEST_AUDIT_DIR)fs.cpSync(root,path.join(process.env.RALPH_DEPLOY_TEST_AUDIT_DIR,path.basename(root)),{recursive:true});fs.rmSync(root,{recursive:true,force:true});});
  const fake=path.join(root,'systemctl'), settings=path.join(root,'settings.json'), calls=path.join(root,'calls');
  fs.writeFileSync(fake,`#!${process.execPath}
    const fs=require('fs'),args=process.argv.slice(2),p=args.find(x=>x.startsWith('--property='))?.slice(11);
    fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
    const fields=JSON.parse(fs.readFileSync(${JSON.stringify(settings)}));
    if(!p||!(p in fields))process.exit(9);fs.writeSync(1,fields[p]+'\\n');
  `,{mode:0o755});
  const worker=path.join(root,'worker.js');
  fs.writeFileSync(worker,`require(${JSON.stringify(require.resolve('../src/deploy-systemd-guardian'))}).guardian('check',${JSON.stringify(fake)}).catch(e=>{console.error(e.stack);process.exitCode=1;});`);
  const passing={JobTimeoutUSec:'1min',TimeoutStartUSec:'20s',TimeoutStopUSec:'20s',SendSIGKILL:'yes'};
  for(const mismatch of [{JobTimeoutUSec:'infinity'},{TimeoutStartUSec:'90s'},{TimeoutStopUSec:'0s'},{SendSIGKILL:'no'},{}]){
    fs.writeFileSync(settings,JSON.stringify({...passing,...mismatch}));
    const fd=fs.openSync(path.join(root,'lock'),'a+'),out=fs.openSync(path.join(root,'stdout'),'a'),err=fs.openSync(path.join(root,'stderr'),'a');
    const child=spawn(process.execPath,[worker],{stdio:['ignore',out,err,fd]});
    for(const descriptor of [fd,out,err])fs.closeSync(descriptor);
    const code=await new Promise(r=>child.on('close',r));
    assert.equal(code,Object.keys(mismatch).length?1:0);
  }
  const captured=fs.readFileSync(calls,'utf8');assert.doesNotMatch(captured,/restart|--property=Job"|ActiveState/);
  assert.match(captured,/JobTimeoutUSec/);assert.match(captured,/SendSIGKILL/);
});
