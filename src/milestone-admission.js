// Read-only authorization at the existing execution seams. Never releases labels.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { registration } = require('./milestone-grants');
const { ticketDigest, grantIntegrity } = require('./milestone-tickets');
const { runGh } = require('./autopilot-github');
const { execFile } = require('./execution-log');
const { eligibleIssues } = require('./r1-dependencies');
const { eligible: householdEligible } = require('./household-dependencies');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function admissionBlock(projectName, number, cause, options = {}) {
  const state = options.stateDir || process.env.AGENTLOOP_STATE_DIR || path.join(__dirname, '../state');
  const error = new Error(`Milestone authorization blocked ${projectName}#${number}: ${cause.message}`, { cause });
  error.code = 'MILESTONE_AUTHORIZATION_BLOCKED';
  error.decision = cause.decision || 'DENY';
  try {
    fs.mkdirSync(state, { recursive: true });
    const fd = fs.openSync(path.join(state, 'milestone-admission.ndjson'), 'a', 0o600);
    try { fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), project: projectName, issue: number, code: error.code, decision: error.decision, message: error.message }) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const directory = fs.openSync(state, 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch (diagnosticError) {
    error.message += ` Diagnostic persistence failed: ${diagnosticError.message}`;
  }
  return error;
}
async function checkMilestoneAdmission(projectName, project, number, options = {}) {
  if (project.milestoneAuthorization !== true) return null;
  const state = options.stateDir || process.env.AGENTLOOP_STATE_DIR || path.join(__dirname, '../state');
  const configPath = options.configPath || process.env.AGENTLOOP_CONFIG_PATH || path.join(__dirname, '../config.json');
  const projectsPath = options.projectsPath || path.join(__dirname, '../autopilot-projects.json');
  const file = path.join(state, 'milestone-grants.json');
  try {
    const raw = fs.readFileSync(file, 'utf8'), db = JSON.parse(raw);
    const configRaw = fs.readFileSync(configPath, 'utf8'), projectsRaw = fs.readFileSync(projectsPath, 'utf8');
    if (db.version !== 1 || !object(db.grants)) throw new Error('Invalid grant store.');
    const matches = Object.entries(db.grants).filter(([, g]) => g?.project === projectName && g?.repo === project.repo
      && object(g.receipts) && Object.hasOwn(g.receipts, `${project.repo}#${number}`));
    if (matches.length !== 1) throw Object.assign(new Error('Require one exact ticket receipt.'), { decision: matches.length === 0 ? 'NEEDS_APPROVAL' : 'DENY' });
    const [id, g] = matches[0], r = g.receipts[`${project.repo}#${number}`], q = r?.request;
    if (g.id !== id || g.state !== 'active') throw new Error(`Grant is ${g.state || 'invalid'}, not active.`);
    if (!Number.isFinite(Date.parse(g.activatedAt)) || !Array.isArray(g.events)
      || !g.events.some(e => e?.type === 'activated' && e.digest === g.digest && e.revision === g.revision
        && typeof e.actor === 'string' && e.actor.trim() && Number.isFinite(Date.parse(e.at)))) throw new Error('Missing owner activation evidence.');
    if (!Number.isFinite(Date.parse(g.expiresAt)) || Date.parse(g.expiresAt) <= require('./milestone-clock').currentTime(state)) throw new Error('Grant expired.');
    if (!grantIntegrity(g)) throw new Error('Grant terms or specification changed.');
    if (JSON.stringify(registration(projectName, project.repo, { configPath, projectsPath })) !== JSON.stringify(g.registration)) throw new Error('Registered identity changed.');
    const registered = JSON.parse(fs.readFileSync(projectsPath, 'utf8'))[projectName];
    if (registered.readyLabel !== project.readyLabel) throw new Error('Configured ready label changed.');
    if (!object(r) || Object.keys(r).sort().join() !== 'at,digest,grantDigest,grantId,id,issue,request,revision'
      || typeof r.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(r.id) || typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at)) || !object(q)
      || Object.keys(q).sort().join() !== 'category,grantDigest,issue,reason,repo,revision,scope,spec,ticketDigest'
      || r.grantId !== id || r.grantDigest !== g.digest || r.revision !== g.revision
      || q.repo !== project.repo || q.issue !== number || q.grantDigest !== g.digest || q.revision !== g.revision
      || q.spec?.identity !== g.spec.identity || q.spec?.digest !== g.spec.digest
      || q.scope !== 'in-scope' || !g.allowedCategories.includes(q.category)
      || !r.issue || r.issue.number !== number || ticketDigest(r.issue) !== q.ticketDigest
      || r.digest !== hash({ grant: id, ...q, readyLabel: project.readyLabel })) throw new Error('Invalid exact ticket receipt.');
    const approval = g.ticketApprovals?.[r.digest];
    if (!approval || approval.digest !== r.digest || JSON.stringify(approval.request) !== JSON.stringify(q)
      || typeof approval.actor !== 'string' || !approval.actor.trim() || typeof approval.at !== 'string' || !Number.isFinite(Date.parse(approval.at))) throw Object.assign(new Error('Missing exact owner scope approval.'), { decision: 'NEEDS_APPROVAL' });
    if (!Array.isArray(g.ticketEvents) || !g.ticketEvents.some(e => e.type === 'authorized'
      && e.receiptId === r.id && e.digest === r.digest && e.grantId === id && e.grantDigest === g.digest && e.revision === g.revision)) throw new Error('Missing durable receipt authorization event.');
    const authorization = { grantId: id, receiptId: r.id, grantDigest: g.digest, ticketDigest: q.ticketDigest };
    if (options.expectedAuthorization && Object.keys(authorization).some(key => authorization[key] !== options.expectedAuthorization[key])) {
      const old = options.expectedAuthorization;
      // Only a new explicit owner-approved receipt replacing this job's archived
      // receipt can rebind retained work after an amendment.
      if (old.grantId !== id || !g.receiptHistory?.some(previous => previous.id === old.receiptId
        && previous.grantDigest === old.grantDigest && previous.request.issue === number
        && previous.request.ticketDigest === old.ticketDigest && previous.revision < g.revision)) throw new Error('Job authorization receipt changed.');
    }
    if (!object(g.receipts) || Object.keys(g.receipts).length > g.ticketLimit) throw new Error('Invalid receipt quota.');
    const issue = JSON.parse(await runGh(['api', `repos/${project.repo}/issues/${number}`], options.execFile || execFile, 'Milestone admission'));
    if (options.expectedIssue && ticketDigest(options.expectedIssue) !== q.ticketDigest) throw new Error('Selected issue title/body differs from the authorized revision.');
    if (!issue || issue.number !== number || issue.state !== 'open' || issue.pull_request
      || issue.html_url !== `https://github.com/${project.repo}/issues/${number}`
      || typeof issue.title !== 'string' || typeof issue.body !== 'string' || ticketDigest(issue) !== q.ticketDigest
      || !Array.isArray(issue.labels) || !issue.labels.some(l => l?.name === project.readyLabel)) throw new Error('Issue identity, content, state or ready label changed.');
    if (Object.hasOwn(r.issue, 'nativeBlockers')) {
      if (!Array.isArray(r.issue.nativeBlockers)) throw new Error('Invalid receipted native blocker evidence.');
      const actual = await require('./milestone-blockers').nativeBlockers(project.repo, number,
        async args => JSON.parse(await runGh(args, options.execFile || execFile, 'Milestone native blockers')));
      const expected = require('./r1-dependencies').dependencies(issue).sort((a, b) => a - b);
      if (JSON.stringify(actual) !== JSON.stringify(expected) || JSON.stringify(actual) !== JSON.stringify(r.issue.nativeBlockers)) throw new Error('Authorized native blocker set changed.');
    }
    let dependencyError;
    const eligible = project.dependencyFormat === 'household-blocked-by' ? householdEligible : eligibleIssues;
    if (!eligible([issue], typeof options.jobs === 'function' ? options.jobs() : options.jobs || [], projectName, project.repo, (_, message) => { dependencyError = message; }).length) throw Object.assign(new Error(dependencyError), { decision: 'WAIT' });
    // Owner edits during the GitHub read must not be accepted as stale authority.
    if (fs.readFileSync(file, 'utf8') !== raw
      || fs.readFileSync(configPath, 'utf8') !== configRaw || fs.readFileSync(projectsPath, 'utf8') !== projectsRaw) throw new Error('Grant store changed during authorization.');
    if (Date.parse(g.expiresAt) <= require('./milestone-clock').currentTime(state)) throw new Error('Grant expired during authorization.');
    return authorization;
  } catch (cause) {
    throw admissionBlock(projectName, number, cause, { stateDir: state });
  }
}
module.exports = { checkMilestoneAdmission, admissionBlock };
