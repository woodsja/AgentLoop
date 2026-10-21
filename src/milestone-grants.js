// Owner CLI only. No daemon, issue ingestion or model-output path calls this module.
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
  if (!['draft', 'inspect', 'activate'].includes(action)) throw new Error('Expected grant draft, inspect or activate.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id || '')) throw new Error('Supply a grant ID (1..80 letters, digits, underscores or hyphens).');
  const state = path.resolve(options.stateDir || process.env.AGENTLOOP_STATE_DIR || path.join(__dirname, '../state'));
  fs.mkdirSync(state, { recursive: true }); syncDirectory(state); syncDirectory(path.dirname(state));
  const file = path.join(fs.realpathSync(state), 'milestone-grants.json');
  const files = [fs.realpathSync(options.configPath), fs.realpathSync(options.projectsPath), file];
  if (new Set(files).size !== 3) throw new Error('Grant store and owner configuration paths must be distinct.');
  return locked(files, async () => {
    const db = fs.existsSync(file) ? read(file) : { version: 1, grants: {} };
    if (db.version !== 1 || !db.grants || typeof db.grants !== 'object' || Array.isArray(db.grants)) throw new Error('Invalid grant store; preserve and reconcile it.');
    const commit = () => save(file, db, options);
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
    if (['draft', 'active', 'paused'].includes(grant.state) && Date.parse(grant.expiresAt) <= Date.now()) {
      grant.state = 'expired'; event('expired'); commit();
    }
    options.record('preview', { grant });
    if (action === 'inspect') return grant;
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
      if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error('Grant expired during approval.');
    } catch (error) {
      event('approval_failed', { message: error.message }); commit(); throw error;
    }
    // Active state and its complete approval event share one atomic durable write.
    grant.state = 'active'; grant.activatedAt = new Date().toISOString();
    event('activated'); commit();
    return grant;
  });
}
module.exports = { grantCommand, STATES };
