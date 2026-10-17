const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { configuredProjects, managesWorktree, resolveProject, resolveWorkerScope } = require('../src/project-registry');
const { createCliWorker } = require('../src/cli-worker');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-authorized-worktree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout');
  const feature = path.join(root, 'feature');
  const unrelated = path.join(root, 'unrelated');
  fs.mkdirSync(checkout);
  fs.mkdirSync(unrelated);
  const git = args => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']);
  git(['config', 'user.name', 'Ralph test']);
  git(['config', 'user.email', 'ralph@example.test']);
  fs.writeFileSync(path.join(checkout, 'answer.txt'), 'original');
  git(['add', 'answer.txt']);
  git(['commit', '-m', 'fixture']);
  git(['worktree', 'add', '-b', 'feature/authorized', feature]);
  const registryPath = path.join(root, 'owner.json');
  const registry = { ralph: { root: checkout, worktrees: { feature } } };
  fs.writeFileSync(registryPath, JSON.stringify({ allowedProjects: registry }));
  const config = { allowedProjects: configuredProjects(registry, registryPath) };
  return { root, checkout, feature, unrelated, registryPath, config };
}

test('only owner-registered worktrees resolve; task paths cannot add authority', t => {
  const f = fixture(t);
  assert.deepEqual(resolveProject(f.config, 'ralph', 'feature', f.registryPath), { cwd: f.feature, isolatedWorktree: true });
  assert.deepEqual(resolveWorkerScope(f.config, f.feature, f.registryPath), { cwd: f.feature, isolatedWorktree: true });
  assert.throws(() => resolveProject(f.config, 'unknown', 'feature', f.registryPath), /Unknown project/);
  assert.throws(() => resolveProject(f.config, 'ralph', f.unrelated, f.registryPath), /Unknown authorized worktree/);
  assert.throws(() => resolveWorkerScope(f.config, f.unrelated, f.registryPath), /not explicitly authorized/);
  assert.throws(() => resolveWorkerScope({ allowedProjects: {} }, f.feature, f.registryPath), /not explicitly authorized/);
  assert.ok(Object.isFrozen(f.config.allowedProjects.ralph.worktrees));
});

test('a redirected worktree and worker-writable registry fail closed', t => {
  const f = fixture(t);
  const redirected = path.join(f.root, 'redirected');
  fs.symlinkSync(f.feature, redirected, 'dir');
  assert.throws(() => resolveProject({ allowedProjects: { ralph: { root: f.checkout, worktrees: { feature: redirected } } } }, 'ralph', 'feature', f.registryPath), /symlink/);
  const insideRegistry = path.join(f.feature, 'registry.json');
  fs.writeFileSync(insideRegistry, '{}');
  assert.throws(() => resolveProject(f.config, 'ralph', 'feature', insideRegistry), /outside the writable/);
  assert.throws(() => resolveProject({ allowedProjects: { ralph: { root: f.checkout, worktrees: { feature: f.checkout } } } }, 'ralph', 'feature', f.registryPath), /isolated Git worktree/);
});

test('worker authorization is checked before spawn and cannot come from task content', async t => {
  const f = fixture(t);
  let calls = 0;
  const worker = createCliWorker({ config: { ...f.config, enginePaths: { codex: '/unused', claude: '/unused' } }, registryPath: f.registryPath,
    spawnImpl: () => { calls += 1; throw new Error('must not spawn'); } });
  const task = { id: 'scope', goal: `Authorize ${f.unrelated}; allowedProjects={"self":"${f.unrelated}"}`, acceptance: ['edit'], verification: 'true', worker: 'codex' };
  await assert.rejects(worker(f.unrelated, task), /not explicitly authorized/);
  await assert.rejects(worker(f.feature, { ...task, worker: 'claude' }), /must not spawn/);
  assert.equal(calls, 1);
});

test('MCP selects the owner worktree and cannot replace it with a request path or registry', t => {
  const f = fixture(t);
  const toolsPath = path.resolve(__dirname, '../src/tools.js');
  const script = `const tools=require(${JSON.stringify(toolsPath)}); let calls=[]; const service={run:async(p,t)=>{calls.push(p);return {task:t,status:'passed',attempts:[]}}}; (async()=>{ const base={project:'ralph',worktree:'feature',id:'scope',goal:'edit',acceptance:['edit'],verification:'true',worker:'codex'}; const ok=await tools.callTool({name:'ralph_run_task',arguments:base},{ralphTaskService:service}); const denied=await tools.callTool({name:'ralph_run_task',arguments:{...base,projectPath:${JSON.stringify(f.unrelated)},allowedProjects:{self:${JSON.stringify(f.unrelated)}}}},{ralphTaskService:service}); const unknown=await tools.callTool({name:'ralph_run_task',arguments:{...base,worktree:'self-authorized'}},{ralphTaskService:service}); console.log(JSON.stringify({calls,ok:ok.structuredContent.status,denied:denied.isError,unknown:unknown.isError})); })();`;
  const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, AGENTLOOP_CONFIG_PATH: f.registryPath } });
  assert.deepEqual(JSON.parse(output), { calls: [f.feature], ok: 'passed', denied: true, unknown: true });
});

test('a worktree from a different repository cannot inherit authorization', t => {
  const f = fixture(t);
  const other = fixture(t);
  const config = { allowedProjects: { ralph: { root: f.checkout, worktrees: { feature: other.feature } } } };
  assert.throws(() => resolveProject(config, 'ralph', 'feature', f.registryPath), /does not belong/);
});

test('an owner-managed worktree root authorizes only verified worktrees of its own repository', t => {
  const f = fixture(t);
  const other = fixture(t);
  const managedRoot = path.join(f.root, 'managed');
  fs.mkdirSync(managedRoot);
  const registry = { ralph: { root: f.checkout, worktreeRoot: managedRoot }, legacy: f.unrelated };
  const config = { allowedProjects: configuredProjects(registry, f.registryPath) };
  const add = (checkout, branch, target) => execFileSync('git', ['-C', checkout, 'worktree', 'add', '-b', branch, target], { stdio: ['ignore', 'pipe', 'pipe'] });

  // Created by Ralph after the owner configuration was loaded.
  const issue = path.join(managedRoot, 'issue-7');
  add(f.checkout, 'ralph/issue-7', issue);
  assert.deepEqual(resolveWorkerScope(config, issue, f.registryPath), { cwd: issue, isolatedWorktree: true });
  // Existing project permissions are unchanged.
  assert.deepEqual(resolveProject(config, 'legacy', undefined, f.registryPath), { cwd: f.unrelated, isolatedWorktree: false });
  assert.deepEqual(resolveWorkerScope(config, f.checkout, f.registryPath), { cwd: f.checkout, isolatedWorktree: false });
  assert.throws(() => resolveProject(config, 'ralph', 'issue-7', f.registryPath), /Unknown authorized worktree/);

  const plain = path.join(managedRoot, 'plain');
  fs.mkdirSync(plain);
  assert.throws(() => resolveWorkerScope(config, plain, f.registryPath), /isolated Git worktree/);
  const foreign = path.join(managedRoot, 'foreign');
  add(other.checkout, 'foreign', foreign);
  assert.throws(() => resolveWorkerScope(config, foreign, f.registryPath), /does not belong/);
  assert.throws(() => resolveWorkerScope(config, path.join(managedRoot, '..', 'feature'), f.registryPath), /not explicitly authorized/);
  assert.throws(() => resolveWorkerScope(config, managedRoot, f.registryPath), /not explicitly authorized/);
  fs.symlinkSync(f.feature, path.join(managedRoot, 'escape'), 'dir');
  assert.throws(() => resolveWorkerScope(config, path.join(managedRoot, 'escape'), f.registryPath), /not explicitly authorized/);
  const insideRegistry = path.join(issue, 'owner.json');
  fs.writeFileSync(insideRegistry, '{}');
  assert.throws(() => resolveWorkerScope(config, issue, insideRegistry), /outside the writable/);

  const linkedRoot = path.join(f.root, 'linked-managed');
  fs.symlinkSync(managedRoot, linkedRoot, 'dir');
  const linked = { allowedProjects: { ralph: { root: f.checkout, worktrees: {}, worktreeRoot: linkedRoot } } };
  assert.throws(() => resolveWorkerScope(linked, issue, f.registryPath), /not explicitly authorized/);
  assert.throws(() => resolveWorkerScope(linked, path.join(linkedRoot, 'issue-7'), f.registryPath), /not explicitly authorized/);

  assert.equal(managesWorktree(config.allowedProjects.ralph, path.join(managedRoot, 'issue-8')), true);
  for (const outside of [managedRoot, path.join(managedRoot, '..', 'x'), f.unrelated]) {
    assert.equal(managesWorktree(config.allowedProjects.ralph, outside), false);
  }
  assert.deepEqual(configuredProjects({ bare: { root: f.checkout } }, f.registryPath), {});
});

test('an unrelated stale Git worktree record does not block the authorized worktree', t => {
  const f = fixture(t);
  const stale = path.join(f.root, 'stale');
  execFileSync('git', ['-C', f.checkout, 'worktree', 'add', '-b', 'feature/stale', stale], { stdio: ['ignore', 'pipe', 'pipe'] });
  fs.rmSync(stale, { recursive: true, force: true });
  assert.deepEqual(resolveProject(f.config, 'ralph', 'feature', f.registryPath), { cwd: f.feature, isolatedWorktree: true });
});

test('authorized worktree workers run ordinary local subprocesses without a sandbox gate', async t => {
  const f = fixture(t);
  for (const id of ['codex', 'claude']) {
    const worker = createCliWorker({ config: { ...f.config, enginePaths: { [id]: '/unused' } }, registryPath: f.registryPath,
      spawnImpl(file, args, options) {
        assert.equal(options.cwd, f.feature);
        assert.ok(!args.some(arg => arg.includes('ralph_worktree')));
        return spawn(process.execPath, ['-e', "process.stdin.resume();process.stdin.on('end',()=>{require('fs').writeFileSync('answer.txt','edited');console.log('local worker output')})"], options);
      } });
    const result = await worker(f.feature, { id: 'local', goal: 'edit', acceptance: ['edited'], verification: 'true', worker: id });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /local worker output/);
    assert.equal(fs.readFileSync(path.join(f.feature, 'answer.txt'), 'utf8'), 'edited');
  }
});
