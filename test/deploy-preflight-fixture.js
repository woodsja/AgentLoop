'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const state = require('../src/autopilot-state');
const { validateDeploymentCandidate } = require('../src/deploy-preflight');

// Load the private URL dependency only in tests. No observer/output is faked:
// every command, including the shipping ls-remote implementation, runs real Git.
function assertCommandResult(result, file, args) {
  // Git 2.43 can exit zero while diagnosing a missing parent. Observe the real
  // shipping result, and restrict this guard to the private ancestry command.
  if (args.includes('merge-base')) assert.doesNotMatch(result.stderr, /^(?:error|fatal|warning):/m);
}
function testValidator(remote, onObservation, onCommand = () => {}, onResult = () => {}) {
  const { testing } = require('../src/deploy-preflight');
  assert.equal(typeof testing.validateCandidate, 'function', 'explicit preflight seam drifted');
  return (issue, options) => testing.validateCandidate(issue, options, remote, { onObservation, onCommand,
    onResult(result, ...args) { onResult(result, ...args); assertCommandResult(result, ...args); },
  });
}

function fixture(t, content = 'candidate\n', { installedAttributes, candidateAttributes, npmScript, ignore, priorHistory = false, staleBase = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout');
  const remote = path.join(root, 'origin.git');
  fs.mkdirSync(checkout);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const rawGit = (...args) => spawnSync('git', ['-C', checkout, ...args], { env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout:30000 });
  git('init', '-b', 'ralph-dev');
  git('config', 'user.name', 'Preflight Test');
  git('config', 'user.email', 'preflight@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('init', '--bare', remote);
  // Writes and the real read-only observation use the disposable bare remote.
  let beforeRemote;
  let onCommand;
  let onResult;
  const results = [];
  const observations = [];
  const commands = [];
  const validate = testValidator(remote, (file, args, options) => {
    observations.push({ file, args, options });
    if (beforeRemote) beforeRemote();
  }, (file, args, options) => {
    commands.push({ file, args, options });
    if (onCommand) onCommand(file, args, options);
  }, (result, file, args, options) => {
    results.push({ result, file, args, options });
    onResult?.(result, file, args, options);
  });
  git('remote', 'add', 'origin', 'git@github.com:woodsja/AgentLoop.git');
  if (installedAttributes) fs.writeFileSync(path.join(checkout, '.gitattributes'), installedAttributes);
  const commit = text => {
    fs.writeFileSync(path.join(checkout, 'file.txt'), text);
    if (ignore !== undefined) fs.writeFileSync(path.join(checkout,'.gitignore'),ignore);
    if (npmScript !== undefined) {
      fs.writeFileSync(path.join(checkout,'binary-newline' + String.fromCharCode(10) + 'file'),Buffer.from([0,10,255,32,10,0,100]));
      fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'stage-fixture', version: '1.0.0', scripts: { test: 'node -e ' + JSON.stringify(npmScript) } }));
      fs.writeFileSync(path.join(checkout, 'package-lock.json'), JSON.stringify({ name: 'stage-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'stage-fixture', version: '1.0.0' } } }));
    }
    git('add', '.'); git('commit', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  if (priorHistory || staleBase) commit('earlier installed history\n');
  const fork = staleBase ? commit('installed\n') : undefined;
  if (staleBase) {
    fs.writeFileSync(path.join(checkout, 'base.txt'), 'another installed change\n');
    git('add', '.'); git('commit', '-m', 'base advanced after branch fork');
  }
  const oldSha = staleBase ? git('rev-parse','HEAD') : commit('installed\n');
  git('checkout', '-b', 'ralph/issue-28', ...(staleBase ? [fork] : []));
  const side = staleBase ? commit('first reviewed side commit\n') : undefined;
  if (candidateAttributes) fs.writeFileSync(path.join(checkout, '.gitattributes'), candidateAttributes);
  const head = commit(content);
  git('checkout', 'ralph-dev');
  git('merge', '--no-ff', 'ralph/issue-28', '-m', 'approved merge');
  const newSha = git('rev-parse', 'HEAD');
  const remoteRef = (...args) => execFileSync('/usr/bin/git',['--git-dir='+remote,'update-ref',...args],{env,stdio:['ignore','pipe','pipe']});
  const publish = (ref = 'ralph-dev') => {
    const copy = (source,target) => {
      fs.mkdirSync(target,{recursive:true});
      for (const entry of fs.readdirSync(source,{withFileTypes:true})) {
        const from=path.join(source,entry.name),to=path.join(target,entry.name);
        if(entry.isDirectory()) copy(from,to);
        else if(!fs.existsSync(to)) fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);
      }
    };
    copy(path.join(checkout,'.git/objects'),path.join(remote,'objects'));
    remoteRef('refs/heads/ralph-dev',git('rev-parse',ref));
  };
  const removeRemoteRef = () => remoteRef('-d','refs/heads/ralph-dev');
  publish();
  git('reset', '--hard', oldSha);
  const configPath = path.join(root, 'projects.json');
  const project = {
    enabled: true, repo: 'woodsja/AgentLoop', checkout, worktreeRoot: root,
    stateDir: path.join(root, 'state'), baseBranch: 'ralph-dev',
    readyLabel: 'ready-for-agent', humanLabel: 'ready-for-human', worker: 'codex',
    verification: 'npm test && git diff --check', ciWorkflow: 'CI', reviewPolicy: 'always', autoMerge: true,
  };
  const configure = () => fs.writeFileSync(configPath, JSON.stringify({ ralph: project }));
  configure();
  const store = state.createJobStore(project.stateDir);
  const job = state.createJob({ projectName: 'ralph', repo: project.repo, issue: { number: 28, title: 'candidate' },
    branch: 'ralph/issue-28', worktreePath: checkout, now: store.now });
  state.recordVerification(job, project.verification, { passed: true, exitCode: 0, timedOut: false, stdout: 'passed', stderr: '' });
  state.recordDelivery(job, { commit: head });
  state.recordPullRequest(job, { number: 128, url: 'https://github.com/woodsja/AgentLoop/pull/128' });
  state.recordReview(job, { reviewer: 'claude:opus', verdict: 'PASS', commit: head, policy: 'always', findings: [], attempt: state.beginReviewAttempt(job) });
  state.recordCiState(job, { state: 'green', headCommit: head, prNumber: 128, requiredWorkflow: 'CI', runs: [{
    databaseId: 1, workflowName: 'CI', status: 'completed', conclusion: 'success', name: null,
    url: null, startedAt: null, updatedAt: null,
  }] });
  state.recordMerge(job, { prNumber: 128, approvedHead: head, commit: newSha, repo: project.repo, issueClosed: true });
  state.markTerminal(job, 'merged');
  const save = () => store.save(job);
  save();
  return { root, checkout, remote, configPath,
    setBeforeRemote: callback => { beforeRemote = callback; },
    results, setOnResult: callback => { onResult = callback; },
    setOnCommand: callback => { onCommand = callback; },
    observationCount: () => observations.length, observations, commands, git, rawGit, fork, side, commit, publish, removeRemoteRef, oldSha, newSha, head, job, store, save, project, configure,
    validate: () => validate(28, { configPath }) };
}


module.exports = { fixture, testValidator, assertCommandResult };
