'use strict';
const crypto = require('node:crypto');
const CHANNELS = ['target', 'ci', 'gate'];
const LIMIT = 20;
const deferred = message => Object.assign(new Error(message), { code: 'AUTOPILOT_GIT_DEFERRED' });
const blocked = message => Object.assign(new Error(message), { code: 'AUTOPILOT_INTEGRATION_BLOCKED' });

// These are navigation summaries. Every original observation is durably appended
// to the existing owner execution journal before a summary can replace it.
function observeIntegration(job, store, channel, current, raw) {
  store.appendIntegrationEvent(job, { event: 'integration-observation', channel, observation: raw });
  const state = job.integrationPolling ||= { channels: {}, transitions: [], transitionCount: 0 };
  const at = store.now();
  const previous = state.channels[channel];
  const changed = !previous || JSON.stringify(previous.current) !== JSON.stringify(current);
  state.channels[channel] = { current, lastCheckedAt: at,
    lastTransitionAt: changed ? at : previous.lastTransitionAt,
    pollCount: (previous?.pollCount || 0) + 1 };
  if (changed) {
    const transition = { channel, at, current };
    store.appendIntegrationEvent(job, { event: 'integration-transition', ...transition });
    state.transitions = [...state.transitions, transition].slice(-LIMIT);
    state.transitionCount++;
  }
  store.save(job);
}
function validPolling(value) {
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const keys = (v, allowed) => Object.keys(v).every(key => allowed.includes(key));
  const date = v => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
  const text = v => typeof v === 'string' && v.length > 0 && v.length <= 512;
  const current = (v, channel) => {
    if (!object(v)) return false;
    if (channel === 'ci') return keys(v, ['state', 'headSha', 'pr'])
      && ['pending', 'green', 'red'].includes(v.state) && text(v.headSha)
      && Number.isSafeInteger(v.pr) && v.pr > 0;
    if (channel === 'target') return keys(v, ['state', 'headSha', 'targetSha'])
      && ['OPEN', 'MERGED'].includes(v.state) && text(v.headSha) && text(v.targetSha);
    return keys(v, ['targetSha', 'headSha', 'integratedTargetSha', 'approvedHead'])
      && text(v.targetSha) && text(v.headSha) && text(v.approvedHead)
      && (v.integratedTargetSha === null || text(v.integratedTargetSha));
  };
  return value === undefined || (object(value) && keys(value, ['channels', 'transitions', 'transitionCount']) && object(value.channels)
    && Object.keys(value.channels).length <= CHANNELS.length
    && Object.entries(value.channels).every(([channel, entry]) => CHANNELS.includes(channel)
      && object(entry) && keys(entry, ['current', 'lastCheckedAt', 'lastTransitionAt', 'pollCount']) && current(entry.current, channel) && date(entry.lastCheckedAt) && date(entry.lastTransitionAt)
      && Number.isSafeInteger(entry.pollCount) && entry.pollCount > 0)
    && Array.isArray(value.transitions) && value.transitions.length <= LIMIT
    && Number.isSafeInteger(value.transitionCount) && value.transitionCount >= value.transitions.length
    && value.transitions.every(entry => object(entry) && keys(entry, ['channel', 'at', 'current']) && CHANNELS.includes(entry.channel) && date(entry.at) && current(entry.current, entry.channel)));
}
function validRetries(value) {
  return value === undefined || (value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length <= 32 && Object.entries(value).every(([key, entry]) => /^[a-f0-9]{64}$/.test(key)
      && entry && typeof entry === 'object' && !Array.isArray(entry)
      && Object.keys(entry).every(field => ['count', 'nextEligibleAt', 'lastFailureAt', 'diagnostic', 'operation'].includes(field))
      && Number.isSafeInteger(entry.count) && entry.count >= 1 && entry.count <= 3
      && typeof entry.nextEligibleAt === 'string' && entry.nextEligibleAt.length <= 40 && Number.isFinite(Date.parse(entry.nextEligibleAt))
      && typeof entry.lastFailureAt === 'string' && entry.lastFailureAt.length <= 40 && Number.isFinite(Date.parse(entry.lastFailureAt))
      && typeof entry.diagnostic === 'string' && entry.diagnostic.length <= 4000
      && typeof entry.operation === 'string' && entry.operation.length <= 64));
}
function permanentGitError(error, result) {
  return /authentication (?:failed|failure|required|error)|could not authenticate|permission[^\n]*denied|write access[^\n]*not granted|invalid (?:username|token|credentials)|not authorized|authorization (?:failed|required)|unauthorized|access denied|repository not found|not a git repository|could not read Username|invalid ref|bad object|host key verification|certificate (?:verify|verification|has|is|problem|error)|SSL peer certificate|issuer certificate|server certificate|HTTP(?:\/[\d.]+)?\s+(?:401|403)\b|returned error:\s*(?:401|403)\b|non-fast-forward|remote rejected|hook declined|protected branch/i.test(`${result.stderr || ''}\n${error?.message || ''}`);
}
function transient(error, result) {
  const text = `${result.stderr || ''}\n${error?.message || ''}`;
  if (permanentGitError(error, result)) return false;
  return (error?.killed === true && error?.signal === 'SIGTERM')
    || ['EAGAIN', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(error?.code)
    || /could not resolve host|could not resolve hostname|temporary failure in name resolution|connection (?:timed out|reset|refused)|network is unreachable|remote end hung up unexpectedly|unexpected disconnect|HTTP (?:408|429|50[0234])|requested URL returned error: (?:408|429|50[0234])|RPC failed; curl (?:18|28|35|52|55|56|92)|SSL_ERROR_SYSCALL|resource temporarily unavailable|TLS connection was non-properly terminated/i.test(text);
}
function operationIdentity({ job, project, cwd, args }) {
  const identity = JSON.stringify([job.project, project.repo, project.baseBranch, job.branch,
    job.integrationActive?.oldHead || job.delivery?.commit, job.integrationActive?.targetSha || null,
    job.integrationActive?.finalHead || null, cwd, args]);
  const key = crypto.createHash('sha256').update(identity).digest('hex');
  return { key, identity };
}
function clearGitRetry(context) {
  const { key } = operationIdentity(context);
  if (context.job.gitRetries?.[key]) {
    context.store.appendIntegrationEvent(context.job, { event: 'integration-push-reconciled', key });
    delete context.job.gitRetries[key];
    context.store.save(context.job);
  }
}
// Retry identity includes the relevant expected commits and the complete command.
// A retry is checkpointed before executing, so interruption cannot reset budget.
async function gitOperation({ job, store, project, cwd, args, execute, allowFailure = false }) {
  const { key, identity } = operationIdentity({ job, project, cwd, args });
  const retries = job.gitRetries ||= {};
  const retryableOperation = ['fetch', 'ls-remote', 'rev-parse', 'worktree', 'show-ref', 'status', 'show', 'ls-files', 'diff', 'merge-base', 'push'].includes(args[0]);
  let streak = retries[key];
  if (retryableOperation) {
    if (streak) {
      if (streak.count >= 3) throw blocked(`Git ${streak.operation} retry budget exhausted; inspect ${job.executionJournal?.file || 'execution journal'} (${key}). ${streak.diagnostic}`);
      if (Date.parse(store.now()) < Date.parse(streak.nextEligibleAt)) throw deferred(`Git ${streak.operation} retry eligible at ${streak.nextEligibleAt}`);
      streak.count++;
    } else {
      if (Object.keys(retries).length >= 32) throw blocked('Git retry identity capacity exhausted; inspect execution journal');
      streak = retries[key] = { count: 1, operation: args[0], lastFailureAt: store.now(),
        diagnostic: 'Git operation interrupted before a durable result was recorded.', nextEligibleAt: store.now() };
    }
    streak.nextEligibleAt = new Date(Date.parse(store.now()) + 5000 * 2 ** (streak.count - 1)).toISOString();
    store.appendIntegrationEvent(job, { event: 'integration-git-attempt', key, identity, attempt: streak.count });
    store.save(job); // reserve even the initial attempt before touching Git
  }
  const result = await execute();
  store.appendIntegrationEvent(job, { event: 'integration-git', command: ['git', ...args], cwd, ...result });
  const error = result.error || Object.assign(new Error(result.stderr), { code: result.code });
  if (result.code === 0 || allowFailure && result.code === 1 && !permanentGitError(error, result) && !transient(error, result)) {
    if (streak) { delete retries[key]; store.save(job); }
    return result;
  }
  if (!retryableOperation || !transient(error, result)) {
    throw Object.assign(blocked(`git ${args[0]} failed: ${result.stderr || error.message}`), {
      reconcilePush: args[0] === 'push' && !permanentGitError(error, result),
    });
  }
  streak.lastFailureAt = store.now();
  streak.diagnostic = (result.stderr || error.message).slice(-4000);
  streak.nextEligibleAt = new Date(Date.parse(store.now()) + 5000 * 2 ** (streak.count - 1)).toISOString();
  store.appendIntegrationEvent(job, { event: 'integration-git-retry', key, ...streak, identity });
  store.save(job);
  if (streak.count >= 3) throw Object.assign(blocked(`Git ${args[0]} retry budget exhausted after three attempts. Inspect execution journal for ${key}. ${streak.diagnostic}`), { gitTransport: true });
  throw Object.assign(deferred(`Git ${args[0]} transport failure; retry ${streak.count + 1}/3 eligible at ${streak.nextEligibleAt}`), { gitTransport: true });
}
module.exports = { observeIntegration, validPolling, validRetries, gitOperation, clearGitRetry };
