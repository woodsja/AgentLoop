'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createDevelopmentJobs } = require('../src/development-jobs');
const { createJobStore } = require('../src/autopilot-state');
const { configuredProjects } = require('../src/project-registry');

for (const change of ['forged checkout', 'other repository', 'changed repository config', 'stale attempt', 'cancelled parent']) {
  test(`R1 transport vetoes ${change} at the worker launch boundary`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-worker-auth-'));
    let jobs;
    t.after(async () => { await jobs?.stop(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
    const checkout = path.join(root, 'repo'); fs.mkdirSync(checkout);
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    for (const dir of [checkout, path.join(root, 'alien')]) {
      fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '-b', 'main');
      git(dir, 'config', 'user.name', 'Fixture'); git(dir, 'config', 'user.email', 'fixture@example.invalid');
      fs.writeFileSync(path.join(dir, 'README'), 'fixture'); git(dir, 'add', '.'); git(dir, 'commit', '-m', 'initial');
    }
    const project = { enabled: true, repo: 'owner/demo', checkout, worktreeRoot: path.join(root, 'worktrees'),
      stateDir: path.join(root, 'jobs'), worker: 'codex', reviewPolicy: 'always', baseBranch: 'main',
      implementationStrategy: 'worker-critic-loop', verification: 'true' };
    const configPath = path.join(root, 'config.json'); fs.writeFileSync(configPath, '{}');
    const stages = { pending: [], running: [], done: [] }, events = [];
    const store = { paths: { config: configPath, state: root }, config: {
      allowedProjects: configuredProjects({ demo: { root: checkout, worktreeRoot: project.worktreeRoot } }, configPath),
      enginePaths: { codex: '/nonexistent/unauthorized-codex', claude: '/nonexistent/unauthorized-critic' },
    }, enqueueTask(value) { const task = { id: 't-0000abcd', ...value }; stages.pending.push(task); return task; },
      readTask(id, stage) { const task = stages[stage].find(x => x.id === id); if (!task) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return structuredClone(task); },
      writeTask(task, stage) { stages[stage] = [...stages[stage].filter(x => x.id !== task.id), structuredClone(task)]; },
      listTasks: stage => stages[stage], listR1ChildLoops: () => [], appendLogLine() {},
      appendExecution(id, event) { events.push(event); },
      moveTask(id, from, to) { const task = store.readTask(id, from); stages[from] = stages[from].filter(x => x.id !== id); stages[to].push(task); },
    };
    const durable = createJobStore(project.stateDir); let transitioned = false;
    jobs = createDevelopmentJobs(store, { autopilotDependencies: {
      loadProjectConfig: () => project, discoverReadyIssues: async () => [{ number: 5, title: 'Test', body: '## Acceptance criteria\n- Test' }],
      findOpenIssuePullRequests: async () => [], readRepositoryInstructions: async () => [], prepareRepositoryEnvironment: async () => {}, cleanupIssueWorkspace: async () => {},
      prepareIssueWorkspace: async (_project, _issue, options) => {
        const worktreePath = path.join(project.worktreeRoot, 'issue-5');
        git(checkout, 'worktree', 'add', '-b', options.branch, worktreePath);
        return { worktreePath, branch: options.branch, baseRef: 'main' };
      },
      ralphOptions: {
        onPhaseChange: async phase => {
          if (phase !== 'implementation') return;
          transitioned = true;
          if (change === 'forged checkout') project.checkout = path.join(root, 'alien');
          if (change === 'other repository') {
            const cwd = durable.load(5).worktreePath;
            git(checkout, 'worktree', 'remove', '--force', cwd);
            git(path.join(root, 'alien'), 'worktree', 'add', '-b', 'alien', cwd);
          }
          if (change === 'changed repository config') project.repo = 'owner/alien';
          if (change === 'stale attempt') { const job = durable.load(5); job.runs++; durable.save(job); }
          if (change === 'cancelled parent') { const task = store.readTask('t-0000abcd', 'running'); task.cancelRequested = true; store.writeTask(task, 'running'); }
        },
      },
    } });
    const task = await jobs.submit({ project: 'demo', issue: 5 }); store.moveTask(task.id, 'pending', 'running'); jobs.advance(task);
    const deadline = Date.now() + 3000;
    const denied = () => durable.load(5)?.failures?.some(f => /Canonical worker authorization changed|Authorized worktree does not belong to the registered repository|Owner requested delivery cancellation/.test(f.message));
    while (!denied() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.equal(transitioned, true, 'test must reach the canonical implementation boundary');
    assert.equal(events.filter(x => x.event === 'command' && x.command === '/nonexistent/unauthorized-codex').length, 0, 'no CLI command may be launched');
    assert.ok(denied(), 'durable canonical checkpoint must record this policy veto before any CLI launch');
    assert.equal(durable.load(5).implementationChildren?.[0]?.cycles.length, 0);
  });
}
