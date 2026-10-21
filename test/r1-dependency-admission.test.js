'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createR1Jobs } = require('../src/r1-jobs');
const { configuredProjects } = require('../src/project-registry');

const fixture = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-dependency-admission-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'repo');
  fs.mkdirSync(checkout);
  execFileSync('git', ['init', '-q', checkout]);
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, '{}');
  const names = ['ralph', 'other'];
  const projects = Object.fromEntries(names.map(name => [name, {
    enabled: true, autoMerge: true, repo: 'woodsja/AgentLoop', checkout,
    worktreeRoot: path.join(root, 'worktrees'), baseBranch: 'main',
    worker: 'codex', reviewPolicy: 'always', readyLabel: 'ready-for-agent',
  }]));
  const selected = [];
  let issueList = [];
  const store = {
    paths: { config: configPath },
    config: { allowedProjects: configuredProjects(Object.fromEntries(names.map(name => [name,
      { root: checkout, worktreeRoot: path.join(root, 'worktrees') }])), configPath) },
    listTasks: () => [],
    enqueueTask: task => { selected.push(task); return { ...task, id: 't-12345678' }; },
    appendLogLine: () => {}, writeTask: () => {},
  };
  const jobs = createR1Jobs(store, { admitIntervalMs: 0, autopilotDependencies: {
    loadProjectConfig: name => projects[name], discoverReadyIssues: async () => issueList,
  } });
  return { jobs, selected, setIssues: issues => { issueList = issues; }, projects };
};

test('real R1 admission skips a blocked first issue and admits the independent next issue', async t => {
  const f = fixture(t);
  f.projects.other.enabled = false;
  f.setIssues([{ number: 2, title: 'Blocked', body: 'Depends on: #1' },
    { number: 3, title: 'Free', body: 'No prerequisites for this sufficiently specified issue' }]);
  await f.jobs.admit();
  assert.equal(f.selected.length, 1);
  assert.equal(f.selected[0].issue, 3);
  assert.equal(f.selected[0].project, 'ralph');
});
