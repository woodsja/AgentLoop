'use strict';
// Durable ready-label authority for ADE only. This does not issue grants or labels.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runGh, isDecisionIssue } = require('./autopilot-github');
const { ticketDigest } = require('./milestone-tickets');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function paths(options) {
  return {
    configPath: options.configPath || process.env.AGENTLOOP_CONFIG_PATH || path.join(__dirname, '../config.json'),
    projectsPath: options.projectsPath || path.join(__dirname, '../autopilot-projects.json'),
    stateDir: options.stateDir || process.env.AGENTLOOP_STATE_DIR || path.join(__dirname, '../state'),
  };
}
function policy(project, job, options) {
  const files = paths(options);
  const config = JSON.parse(fs.readFileSync(files.configPath, 'utf8'));
  const registered = JSON.parse(fs.readFileSync(files.projectsPath, 'utf8'))[job.project];
  if (!registered || registered.milestoneAuthorization === true || registered.repo !== project.repo
    || registered.readyLabel !== project.readyLabel) throw new Error('Original ready-label project policy changed.');
  const registration = require('./milestone-grants').registration(job.project, job.repo, files);
  // Bind the owner scope and execution policy, including worker/host settings.
  return digest({ project: { ...project, worker: project.worker ?? 'codex', maxAttempts: project.maxAttempts ?? 2, maxReviewRounds: project.maxReviewRounds ?? 2 }, registered, registration, config: { ...config, allowedProjects: config.allowedProjects[job.project] } });
}
function noReceipt(job, options) {
  if (job.milestoneAuthorization || job.authorizationHistory?.length) throw new Error('Grant receipt conflicts with ready-label admission.');
  const file = path.join(paths(options).stateDir, 'milestone-grants.json');
  let db;
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (db.version !== 1 || !db.grants || typeof db.grants !== 'object' || Array.isArray(db.grants)) throw new Error('Invalid grant store; ready-label admission uncertain.');
  for (const grant of Object.values(db.grants)) {
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) throw new Error('Invalid grant record; ready-label admission uncertain.');
    if (Object.hasOwn(grant, 'receipts') && (!grant.receipts || typeof grant.receipts !== 'object' || Array.isArray(grant.receipts))) throw new Error('Invalid receipt store; ready-label admission uncertain.');
    if ((grant.receipts && Object.hasOwn(grant.receipts, `${job.repo}#${job.issue.number}`))
      || Object.values(grant.receipts || {}).some(r => r?.request?.repo === job.repo && r.request.issue === job.issue.number)
      || grant?.receiptHistory?.some(r => r.request?.repo === job.repo && r.request?.issue === job.issue.number)) throw new Error('Existing receipt conflicts with ready-label admission.');
  }
}
async function check(project, job, binding, store, options = {}) {
  if (!binding || binding.version !== 1 || binding.mode !== 'ready-label') throw new Error('Original ready-label admission metadata missing; explicit owner recovery required.');
  if (project.milestoneAuthorization === true || project.repo !== job.repo || project.readyLabel !== binding.readyLabel
    || binding.project !== job.project || binding.repo !== job.repo || binding.issue !== job.issue.number
    || binding.createdAt !== job.createdAt
    || binding.ticketDigest !== ticketDigest(job.originalIssue || job.issue)) throw new Error('Original ready-label admission identity or mode changed.');
  if (policy(project, job, options) !== binding.policy) throw new Error('Original ready-label execution policy or scope changed.');
  noReceipt(job, options);
  const issue = JSON.parse(await runGh(['api', `repos/${job.repo}/issues/${job.issue.number}`], options.execFile, 'ADE ready-label admission'));
  if (!issue || issue.number !== binding.issue || issue.html_url !== `https://github.com/${binding.repo}/issues/${binding.issue}`
    || issue.state !== 'open' || issue.pull_request || typeof issue.title !== 'string' || typeof issue.body !== 'string'
    || ticketDigest(issue) !== binding.ticketDigest || isDecisionIssue(issue)
    || !Array.isArray(issue.labels) || !issue.labels.some(l => l?.name === binding.readyLabel)) throw new Error('Original ready-label issue identity, content, state or label changed.');
  const jobs = store.dependencyJobs ? store.dependencyJobs() : store.list();
  const checks = [require('./r1-dependencies').eligibleIssues];
  if (project.dependencyFormat === 'household-blocked-by') checks.push(require('./household-dependencies').eligible);
  else if (project.dependencyFormat) throw new Error('Unsupported project dependency policy.');
  for (const eligible of checks) {
    let reason;
    if (!eligible([issue], jobs, job.project, job.repo, (_, message) => { reason = message; }).length) throw new Error(reason);
  }
  // Reject policy/receipt changes during the remote read as well.
  if (policy(project, job, options) !== binding.policy) throw new Error('Ready-label policy changed during admission.');
  noReceipt(job, options);
  return null;
}
async function capture(project, job, store, options = {}) {
  if (job.admission || project.milestoneAuthorization === true) return;
  const binding = { version: 1, mode: 'ready-label', project: job.project, repo: job.repo, issue: job.issue.number,
    createdAt: job.createdAt, readyLabel: project.readyLabel,
    ticketDigest: ticketDigest(job.originalIssue || job.issue), policy: policy(project, job, options) };
  await check(project, job, binding, store, options);
  job.admission = binding;
  store.save(job);
}
module.exports = { check, capture };
