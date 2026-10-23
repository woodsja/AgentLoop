// Grant mutations are owner CLI only. Admission reuses the read-only registration identity helper.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { locked } = require('./project-registration');
const STATES = Object.freeze(['draft', 'active', 'expired', 'paused', 'revoked', 'completed']);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function save(file, value, options) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    options.beforeCommit?.();
    fs.renameSync(temp, file);
    syncDirectory(path.dirname(file));
  } finally { fs.rmSync(temp, { force: true }); }
}
function text(value, name, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
}
function registration(project, repo, options) {
  const config = read(options.configPath), projects = read(options.projectsPath);
  const own = (obj, key) => obj && Object.hasOwn(obj, key) ? obj[key] : undefined;
  const entry = own(config.allowedProjects, project), registered = own(projects, project);
  const matches = Object.entries(projects).filter(([, p]) => typeof p?.repo === 'string' && p.repo.toLowerCase() === repo.toLowerCase());
  if (!entry || !registered || matches.length !== 1 || matches[0][0] !== project || registered.repo !== repo) throw new Error('Require a unique registered project/repository identity.');
  const root = fs.realpathSync(path.resolve(path.dirname(options.configPath), typeof entry === 'string' ? entry : entry.root));
  const checkout = fs.realpathSync(path.resolve(path.dirname(options.projectsPath), registered.checkout));
  if (root !== checkout) throw new Error('Registered project checkout mismatch.');
  const aliases = Object.entries(config.allowedProjects).filter(([, p]) => {
    const value = typeof p === 'string' ? p : p?.root;
    return value && fs.realpathSync(path.resolve(path.dirname(options.configPath), value)) === root;
  });
  if (aliases.length !== 1) throw new Error('Ambiguous registered project aliases.');
  return { project, repo, checkout: root, configPath: fs.realpathSync(options.configPath), projectsPath: fs.realpathSync(options.projectsPath) };
}
function proposal(options) {
  const p = read(options.inputPath);
  const keys = ['project', 'repo', 'spec', 'objective', 'allowedCategories', 'exclusions', 'revision', 'ticketLimit', 'expiresAt', 'concurrencyLimit'];
  if (!p || Array.isArray(p) || Object.keys(p).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(p, k))) throw new Error('Supply exactly the documented grant fields.');
  text(p.project, 'project', 100); text(p.repo, 'repo', 200); text(p.objective, 'objective');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p.repo)) throw new Error('Invalid repository.');
  if (!p.spec || Object.keys(p.spec).sort().join(',') !== 'digest,identity' || !/^[a-f0-9]{64}$/.test(p.spec.digest)) throw new Error('Require specification identity and SHA-256 digest.');
  text(p.spec.identity, 'spec identity', 500);
  for (const key of ['allowedCategories', 'exclusions']) {
    if (!Array.isArray(p[key]) || (key === 'allowedCategories' && !p[key].length) || p[key].length > 50 || new Set(p[key]).size !== p[key].length) throw new Error(`Invalid ${key}.`);
    for (const item of p[key]) {
      text(item, key, 500);
      if (key === 'allowedCategories' && (!/^[a-z][a-z0-9-]{0,63}$/.test(item) || ['all', 'any', 'everything', 'unlimited'].includes(item))) throw new Error('Allowed categories must be specific names, without wildcards.');
    }
  }
  if (!Number.isSafeInteger(p.revision) || p.revision < 1) throw new Error('Invalid revision.');
  if (!Number.isSafeInteger(p.ticketLimit) || p.ticketLimit < 1 || p.ticketLimit > 100) throw new Error('Ticket limit must be 1..100.');
  if (!Number.isSafeInteger(p.concurrencyLimit) || p.concurrencyLimit < 1 || p.concurrencyLimit > Math.min(10, p.ticketLimit)) throw new Error('Concurrency limit must be 1..10 and no greater than ticket limit.');
  const expiry = Date.parse(p.expiresAt), now = Date.now();
  if (typeof p.expiresAt !== 'string' || !Number.isFinite(expiry) || new Date(expiry).toISOString() !== p.expiresAt || expiry <= now || expiry > now + 366 * 86400000) throw new Error('Expiration must be a future ISO timestamp within 366 days.');
  const bytes = fs.readFileSync(options.specPath);
  if (hash(bytes) !== p.spec.digest) throw new Error('Specification digest mismatch.');
  // Construct in fixed order so retries do not depend on input JSON key order.
  const terms = Object.fromEntries(keys.map(k => [k, p[k]]));
  terms.spec = { identity: p.spec.identity, digest: p.spec.digest, contentBase64: bytes.toString('base64') };
  terms.registration = registration(p.project, p.repo, options);
  return terms;
}
async function grantCommand(action, id, options) {
  if (!['draft', 'inspect', 'activate', 'pause', 'resume', 'amend', 'revoke', 'expire', 'complete'].includes(action)) throw new Error('Unknown grant action.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id || '')) throw new Error('Supply a grant ID (1..80 letters, digits, underscores or hyphens).');
  const state = path.resolve(options.stateDir || process.env.AGENTLOOP_STATE_DIR || path.join(__dirname, '../state'));
  fs.mkdirSync(state, { recursive: true }); syncDirectory(state); syncDirectory(path.dirname(state));
  const file = path.join(fs.realpathSync(state), 'milestone-grants.json');
  const files = [fs.realpathSync(options.configPath), fs.realpathSync(options.projectsPath), file];
  if (new Set(files).size !== 3) throw new Error('Grant store and owner configuration paths must be distinct.');
  return locked(files, async () => {
    let expected = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const db = expected === null ? { version: 1, grants: {} } : JSON.parse(expected);
    if (db.version !== 1 || !db.grants || typeof db.grants !== 'object' || Array.isArray(db.grants)) throw new Error('Invalid grant store; preserve and reconcile it.');
    const commit = () => {
      if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null) !== expected) throw new Error('Grant store changed outside the shared lock.');
      save(file, db, { ...options, beforeCommit() {
        options.beforeCommit?.();
        if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null) !== expected) throw new Error('Grant store changed outside the shared lock.');
      } }); expected = fs.readFileSync(file, 'utf8');
    };
    const actor = os.userInfo().username;
    let grant = Object.hasOwn(db.grants, id) ? db.grants[id] : undefined;
    const event = (type, details = {}) => { const at = new Date().toISOString(); grant.updatedAt = at; grant.events.push({ type, at, actor, revision: grant.revision, digest: grant.digest, ...details }); };
    if (action === 'draft') {
      const terms = proposal(options), digest = hash(JSON.stringify(terms));
      if (grant) {
        if (grant.digest !== digest) throw new Error('Grant ID already exists with different immutable terms; use a new ID for a revision.');
        return grant;
      }
      const now = new Date().toISOString();
      grant = { id, ...terms, digest, state: 'draft', actor, createdAt: now, updatedAt: now, activatedAt: null, events: [] };
      Object.defineProperty(db.grants, id, { value: grant, enumerable: true, writable: true, configurable: true });
      event('drafted'); commit();
      options.record('preview', { grant }); return grant;
    }
    if (!grant) throw new Error('Unknown grant.');
    if (!STATES.includes(grant.state)) throw new Error('Invalid lifecycle state.');
    // Inspection and activation persist expiry; terminal states remain distinguishable.
    if (['draft', 'active', 'paused'].includes(grant.state) && Date.parse(grant.expiresAt) <= require('./milestone-clock').currentTime(state)) {
      grant.state = 'expired'; event('expired'); commit();
    }
    const receipts = Object.values(grant.receipts || {});
    let jobs = [], inspectionError = null;
    try { jobs = require('./autopilot-state').createJobStore(require('./autopilot-state').resolveStateDir(grant.project, read(options.projectsPath)[grant.project], state)).list(); }
    catch (error) { inspectionError = error.message; } // Damaged job diagnostics must never prevent revocation.
    const inspection = { inspectionError, totalIssued: receipts.length, quotaRemaining: Math.max(0, grant.ticketLimit - receipts.length),
      work: receipts.map(r => { const job = jobs.find(j => j.issue.number === r.request.issue);
        return { issue: r.request.issue, status: job?.status || 'not_started', terminal: job?.terminal || false,
          blocked: !!inspectionError || grant.state !== 'active' || r.revision !== grant.revision || !!job?.authorizationBlocked,
          reason: inspectionError || (grant.state !== 'active' ? `Grant is ${grant.state}.` : r.revision !== grant.revision ? 'Receipt requires owner re-evaluation.' : job?.authorizationBlocked?.message || null) }; }) };
    inspection.blockedWork = inspection.work.filter(work => work.blocked && !work.terminal).length;
    inspection.activeWork = inspection.work.filter(work => !work.blocked && !work.terminal && work.status !== 'not_started').length;
    options.record('preview', { grant, inspection });
    if (action === 'inspect') return grant;
    if (!['activate'].includes(action)) {
      if (['resume', 'amend'].includes(action) && !require('./milestone-tickets').grantIntegrity(grant)) throw new Error('Grant terms changed; reconcile before restoring authority.');
      const terms = action === 'amend' ? proposal(options) : null;
      const digest = hash(JSON.stringify({ action, id, state: grant.state, lifecycleVersion: grant.lifecycleVersion || 0, revision: grant.revision, digest: grant.digest, terms }));
      // A confirmed retry is inert, even if subsequent actions changed state.
      if (options.digest && grant.events.some(e => e.type === 'owner_action' && e.action === action && e.actionDigest === options.digest)) return grant;
      if (terms && (terms.project !== grant.project || terms.repo !== grant.repo || JSON.stringify(terms.registration) !== JSON.stringify(grant.registration))) throw new Error('Amendment cannot change project or registration identity.');
      const target = { pause: 'paused', resume: 'active', revoke: 'revoked', expire: 'expired', complete: 'completed', amend: grant.state }[action];
      const allowed = { pause: ['active', 'paused'], resume: ['paused', 'active'], revoke: ['draft', 'active', 'paused', 'expired', 'revoked'], expire: ['draft', 'active', 'paused', 'expired'], complete: ['active', 'paused', 'completed'], amend: ['active', 'paused'] }[action];
      if (!allowed.includes(grant.state)) throw new Error(`Cannot ${action} ${grant.state} grant.`);
      if (terms && (terms.revision !== grant.revision + 1 || terms.ticketLimit < receipts.length)) throw new Error('Amendment requires the next revision and must retain issued quota.');
      const preview = { action, digest, grant, proposedTerms: terms, inspection };
      options.record('preview', preview);
      if (!options.digest) return preview;
      if (options.digest !== digest) throw new Error('Action requires --digest matching this exact preview.');
      const priorRevision = terms ? structuredClone(grant) : null;
      if (priorRevision) delete priorRevision.history;
      event('action_requested', { action, actionDigest: digest }); commit();
      try {
        if (!await options.approve(`Confirm ${action} grant ${id}, revision ${grant.revision}, action ${digest}?`) || options.isCancelled?.()) throw new Error('Grant action cancelled.');
        if (action === 'resume' || terms) {
          if (JSON.stringify(registration(grant.project, grant.repo, options)) !== JSON.stringify(grant.registration)) throw new Error('Grant registration identity changed.');
          if (Date.parse(terms?.expiresAt || grant.expiresAt) <= require('./milestone-clock').currentTime(state)) throw new Error('Grant expired during approval.');
        }
      } catch (error) { event('action_failed', { action, message: error.message }); commit(); throw error; }
      if (terms) {
        grant.history ||= []; grant.history.push(priorRevision);
        Object.assign(grant, terms, { digest: hash(JSON.stringify(terms)) });
        // Existing receipts stay immutable and fail the new digest/revision checks.
        event('activated', { approval: 'amendment', actionDigest: digest });
      }
      grant.state = target; grant.lifecycleVersion = (grant.lifecycleVersion || 0) + 1;
      event('owner_action', { action, actionDigest: digest }); commit();
      return grant;
    }
    if (options.digest !== grant.digest) throw new Error('Activation requires --digest matching the inspected grant digest.');
    if (!['draft', 'active'].includes(grant.state)) throw new Error(`Cannot activate ${grant.state} grant.`);
    const checkRegistration = () => {
      if (JSON.stringify(registration(grant.project, grant.repo, options)) !== JSON.stringify(grant.registration)) throw new Error('Grant registration identity changed.');
    };
    checkRegistration();
    if (grant.state === 'active') return grant;
    event('approval_requested'); commit();
    try {
      if (!await options.approve(`Activate grant ${id}, revision ${grant.revision}, digest ${grant.digest}?`) || options.isCancelled?.()) throw new Error('Grant activation cancelled.');
      checkRegistration();
      if (Date.parse(grant.expiresAt) <= require('./milestone-clock').currentTime(state)) throw new Error('Grant expired during approval.');
    } catch (error) {
      event('approval_failed', { message: error.message }); commit(); throw error;
    }
    // Active state and its complete approval event share one atomic durable write.
    grant.state = 'active'; grant.activatedAt = new Date().toISOString();
    event('activated'); commit();
    return grant;
  });
}
module.exports = { grantCommand, STATES, registration, save };
