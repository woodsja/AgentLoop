'use strict';

const { execFile } = require('./execution-log');
const { unattendedOptions } = require('./autopilot-subprocess');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function runGh(args, executeFile, operation = 'GitHub issue discovery', maxBuffer = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    try {
      executeFile('gh', args, unattendedOptions({ encoding: 'utf8', maxBuffer, shell: false }), (error, stdout, stderr) => {
        if (error) {
          const failure = new Error(`${operation} failed: gh exited unsuccessfully${stderr ? `: ${String(stderr).trim()}` : ''}`);
          // Keep the transport result structured for callers which need to
          // decide whether an operation may safely be retried.
          failure.code = 'AUTOPILOT_GITHUB_TRANSPORT';
          failure.retryable = true;
          // Adapters which expose an HTTP status (including test adapters)
          // retain it without scraping the human-oriented gh stderr text.
          if (Number.isInteger(error.statusCode)) failure.statusCode = error.statusCode;
          else if (Number.isInteger(error.status)) failure.statusCode = error.status;
          else {
            // Real `gh api` failures expose the HTTP status only in stderr,
            // for example `gh: Head branch was modified. (HTTP 409)`.
            const status = /\(HTTP (\d{3})\)/.exec(String(stderr || ''));
            if (status) failure.statusCode = Number(status[1]);
          }
          reject(failure);
          return;
        }
        resolve(String(stdout));
      });
    } catch (error) {
      reject(new Error(`${operation} failed: unable to execute gh: ${error.message}`));
    }
  });
}

function normalizeIssue(issue) {
  if (!isPlainObject(issue)
    || !Number.isSafeInteger(issue.number)
    || issue.number < 1
    || typeof issue.title !== 'string'
    || issue.state !== 'OPEN') {
    throw new Error('GitHub issue discovery failed: gh returned an unexpected issue shape');
  }

  if (typeof issue.body !== 'string') {
    throw new Error('GitHub issue discovery failed: gh returned an unexpected issue shape');
  }

  return { number: issue.number, title: issue.title, body: issue.body };
}

/**
 * Lists the configured repository's open issues carrying its ready label.
 * This function is intentionally read-only and invokes gh directly, never via a shell.
 */
async function discoverReadyIssues(project, { execFile: executeFile = execFile } = {}) {
  if (!isPlainObject(project) || typeof project.repo !== 'string' || !project.repo.trim()
    || typeof project.readyLabel !== 'string' || !project.readyLabel.trim()) {
    throw new TypeError('GitHub issue discovery requires a project with repo and readyLabel');
  }

  if (typeof executeFile !== 'function') {
    throw new TypeError('GitHub issue discovery requires an execFile function');
  }

  const args = [
    'issue', 'list',
    '--repo', project.repo,
    '--state', 'open',
    '--label', project.readyLabel,
    '--json', 'number,title,body,state',
    '--limit', '1000',
  ];
  const output = await runGh(args, executeFile);
  let response;
  try {
    response = JSON.parse(output);
  } catch (error) {
    throw new Error(`GitHub issue discovery failed: gh returned malformed JSON: ${error.message}`);
  }

  if (!Array.isArray(response)) {
    throw new Error('GitHub issue discovery failed: gh returned an unexpected response shape');
  }

  return response.map(normalizeIssue).sort((left, right) => left.number - right.number);
}

function selectReadyIssue(issues) {
  if (!Array.isArray(issues)) {
    throw new TypeError('Ready issues must be an array');
  }
  return issues.length === 0 ? null : [...issues].sort((left, right) => left.number - right.number)[0];
}

function normalizeWorkflowRun(run) {
  if (!isPlainObject(run) || !Number.isSafeInteger(run.databaseId) || run.databaseId < 1
    || typeof run.status !== 'string' || !run.status) {
    throw new Error('GitHub Actions observation failed: gh returned an unexpected workflow run shape');
  }
  const optionalString = field => run[field] === null || run[field] === undefined || typeof run[field] === 'string';
  if (!optionalString('conclusion') || !optionalString('name') || !optionalString('workflowName')
    || !optionalString('url') || !optionalString('startedAt') || !optionalString('updatedAt')) {
    throw new Error('GitHub Actions observation failed: gh returned an unexpected workflow run shape');
  }
  return {
    databaseId: run.databaseId,
    status: run.status,
    conclusion: run.conclusion ?? null,
    name: run.name ?? null,
    workflowName: run.workflowName ?? null,
    url: run.url ?? null,
    startedAt: run.startedAt ?? null,
    updatedAt: run.updatedAt ?? null,
  };
}

// A workflow re-triggered for the same commit produces a newer run; only the
// newest run of each workflow describes the commit's current CI result.
function latestRunPerWorkflow(runs) {
  const latest = new Map();
  for (const run of runs) {
    const key = run.workflowName || run.name || `run ${run.databaseId}`;
    const existing = latest.get(key);
    if (!existing || run.databaseId > existing.databaseId) latest.set(key, run);
  }
  return [...latest.values()];
}

const GREEN_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

function ciStateForRuns(allRuns, requiredWorkflow) {
  const runs = latestRunPerWorkflow(allRuns);
  // Only the owner-configured test workflow can make a commit green; another
  // successful workflow (such as an advisory review) never substitutes for it.
  const required = runs.find(run => run.workflowName === requiredWorkflow);
  if (!required || required.status !== 'completed' || !required.conclusion) return 'pending';
  if (required.conclusion !== 'success') return 'red';
  // A run which has not reached a completed conclusion is deliberately
  // pending, even when another workflow has already failed or passed. This
  // prevents an in-flight retry from being reported as a final red result.
  if (runs.length === 0 || runs.some(run => run.status !== 'completed' || !run.conclusion)) return 'pending';
  return runs.every(run => GREEN_CONCLUSIONS.has(run.conclusion)) ? 'green' : 'red';
}

function ciDetails(commit, runs, requiredWorkflow) {
  const listed = runs.map(run => {
    const label = run.workflowName || run.name || `run ${run.databaseId}`;
    return `${label} (#${run.databaseId}): ${run.status}${run.conclusion ? `/${run.conclusion}` : ''}`;
  }).join('; ');
  if (runs.some(run => run.workflowName === requiredWorkflow)) return listed;
  return `Required CI workflow "${requiredWorkflow}" has not run for ${commit}.${listed ? ` Other runs: ${listed}` : ''}`;
}

/**
 * Reads the Actions workflow runs attached to the delivered head commit and
 * reduces GitHub's many statuses to the scheduler's three stable CI states.
 * `gh run list` is read-only and is injected for deterministic tests.
 */
async function observePullRequestCi(project, { number, commit }, { execFile: executeFile = execFile } = {}) {
  if (!isPlainObject(project) || typeof project.repo !== 'string' || !project.repo.trim()
    || !Number.isSafeInteger(number) || number < 1 || typeof commit !== 'string' || !commit.trim()) {
    throw new TypeError('GitHub Actions observation requires a project, pull request, and head commit');
  }
  if (typeof executeFile !== 'function') throw new TypeError('GitHub Actions observation requires an execFile function');
  // Without a required test workflow nothing can prove CI passed: fail closed.
  if (typeof project.ciWorkflow !== 'string' || !project.ciWorkflow.trim()) {
    return {
      state: 'pending',
      details: `No required CI workflow (ciWorkflow) is configured for ${project.repo}; CI cannot be green.`,
      prNumber: number,
      headCommit: commit,
      runs: [],
    };
  }

  const output = await runGh([
    'run', 'list',
    '--repo', project.repo,
    '--commit', commit,
    '--json', 'databaseId,status,conclusion,name,workflowName,url,startedAt,updatedAt',
    '--limit', '100',
  ], executeFile, 'GitHub Actions observation');
  let response;
  try {
    response = JSON.parse(output);
  } catch (error) {
    throw new Error(`GitHub Actions observation failed: gh returned malformed JSON: ${error.message}`);
  }
  if (!Array.isArray(response)) {
    throw new Error('GitHub Actions observation failed: gh returned an unexpected response shape');
  }
  const runs = response.map(normalizeWorkflowRun).sort((left, right) => left.databaseId - right.databaseId);
  return {
    state: ciStateForRuns(runs, project.ciWorkflow),
    details: ciDetails(commit, runs, project.ciWorkflow),
    prNumber: number,
    headCommit: commit,
    runs,
  };
}

function normalizePullRequestObservation(value) {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.number) || value.number < 1
    || typeof value.url !== 'string' || !value.url
    || typeof value.state !== 'string' || !['OPEN', 'CLOSED', 'MERGED'].includes(value.state)
    || typeof value.headRefName !== 'string' || !value.headRefName
    || typeof value.headRefOid !== 'string' || !value.headRefOid
    || typeof value.baseRefName !== 'string' || !value.baseRefName
    || !(value.mergeCommit === null || (isPlainObject(value.mergeCommit) && typeof value.mergeCommit.oid === 'string' && value.mergeCommit.oid))) {
    throw new Error('GitHub pull request observation failed: gh returned an unexpected pull request shape');
  }
  return { number: value.number, url: value.url, state: value.state, headRefName: value.headRefName,
    headRefOid: value.headRefOid, baseRefName: value.baseRefName,
    mergeCommit: value.mergeCommit ? value.mergeCommit.oid : null };
}

async function observePullRequest(project, number, { execFile: executeFile = execFile } = {}) {
  if (!isPlainObject(project) || typeof project.repo !== 'string' || !project.repo.trim()
    || !Number.isSafeInteger(number) || number < 1 || typeof executeFile !== 'function') {
    throw new TypeError('GitHub pull request observation requires a project and pull request number');
  }
  let response;
  try {
    response = JSON.parse(await runGh(['pr', 'view', String(number), '--repo', project.repo,
      '--json', 'number,url,state,headRefName,headRefOid,baseRefName,mergeCommit'], executeFile, 'GitHub pull request observation'));
  } catch (error) {
    if (error.message.includes('GitHub pull request observation failed:')) throw error;
    throw new Error(`GitHub pull request observation failed: gh returned malformed JSON: ${error.message}`);
  }
  return normalizePullRequestObservation(response);
}

async function mergePullRequest(project, { number, headCommit }, { execFile: executeFile = execFile } = {}) {
  if (!isPlainObject(project) || typeof project.repo !== 'string' || !project.repo.trim()
    || !Number.isSafeInteger(number) || number < 1 || typeof headCommit !== 'string' || !headCommit
    || typeof executeFile !== 'function') throw new TypeError('GitHub pull request merge requires a project, number, and expected head commit');
  let response;
  try {
    response = JSON.parse(await runGh(['api', '--method', 'PUT', `repos/${project.repo}/pulls/${number}/merge`, '-f', `sha=${headCommit}`], executeFile, 'GitHub pull request merge'));
  } catch (error) {
    // runGh errors retain their retryability.  A malformed successful response
    // is not a transport retry: it is ambiguous and must be reconciled first.
    if (error && error.code === 'AUTOPILOT_GITHUB_TRANSPORT') {
      // Rate limiting and request timeouts are transient; other client errors
      // (405 not mergeable, 409 head changed, 422 invalid) are permanent.
      if (error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 408 && error.statusCode !== 429) {
        error.code = 'AUTOPILOT_MERGE_REJECTED';
        error.retryable = false;
      }
      throw error;
    }
    const malformed = new Error(`GitHub pull request merge failed: gh returned malformed JSON: ${error.message}`);
    malformed.code = 'AUTOPILOT_MERGE_UNCONFIRMED';
    throw malformed;
  }
  if (!isPlainObject(response) || response.merged !== true || typeof response.sha !== 'string' || !response.sha) {
    const rejected = new Error('GitHub pull request merge failed: GitHub did not confirm a merge commit');
    // A completed API response which does not confirm a SHA is ambiguous, not
    // a proof that no merge happened.  The runner re-observes before deciding.
    rejected.code = 'AUTOPILOT_MERGE_UNCONFIRMED';
    throw rejected;
  }
  return { mergeCommit: response.sha };
}

async function reconcileIssueClosure(project, issueNumber, { execFile: executeFile = execFile } = {}) {
  if (!isPlainObject(project) || typeof project.repo !== 'string' || !project.repo.trim()
    || !Number.isSafeInteger(issueNumber) || issueNumber < 1 || typeof executeFile !== 'function') {
    throw new TypeError('GitHub issue reconciliation requires a project and issue number');
  }
  const endpoint = `repos/${project.repo}/issues/${issueNumber}`;
  const sameIssue = value => {
    if (!isPlainObject(value) || value.number !== issueNumber
      || typeof value.repository_url !== 'string' || Object.hasOwn(value, 'pull_request')) return false;
    try {
      // GitHub may redirect a transferred issue. Its original number alone
      // cannot prove that the returned issue still belongs to this repository.
      const url = new URL(value.repository_url);
      const repoPath = url.pathname.toLowerCase().replace(/\/+$/, '');
      const expectedRepo = project.repo.toLowerCase();
      // GH_HOST is the GitHub CLI's explicit Enterprise host override.
      const ghHost = String(process.env.GH_HOST || 'github.com').toLowerCase();
      const allowedApiHosts = ghHost === 'github.com' ? ['api.github.com'] : [ghHost, `api.${ghHost}`];
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        && (url.port === '' || url.port === '443') && allowedApiHosts.includes(url.hostname.toLowerCase())
        && (repoPath === `/repos/${expectedRepo}` || repoPath === `/api/v3/repos/${expectedRepo}`);
    } catch { return false; }
  };
  // A merged PR may already have closed its linked issue. Read GitHub's current
  // state instead of re-issuing a write whose now-redundant PATCH can return 422.
  const observeState = async () => {
    let response;
    try {
      response = JSON.parse(await runGh(['api', endpoint], executeFile, 'GitHub issue reconciliation'));
    } catch (error) {
      if (error.message.includes('GitHub issue reconciliation failed:')) throw error;
      throw new Error(`GitHub issue reconciliation failed: gh returned malformed JSON: ${error.message}`);
    }
    if (!sameIssue(response) || !['open', 'closed'].includes(response.state)) {
      throw new Error('GitHub issue reconciliation failed: GitHub did not confirm issue identity and state');
    }
    return response.state;
  };
  if (await observeState() === 'closed') return { number: issueNumber, state: 'closed' };
  let response;
  try {
    response = JSON.parse(await runGh(['api', '--method', 'PATCH', endpoint, '-f', 'state=closed'], executeFile, 'GitHub issue reconciliation'));
  } catch (error) {
    // GitHub may close the issue while the PATCH is in flight. Only treat an
    // unsuccessful write as complete when a *fresh* read confirms closure.
    // A still-open, malformed or unavailable observation remains a failure.
    const initial = error.message.includes('GitHub issue reconciliation failed:')
      ? error : new Error(`GitHub issue reconciliation failed: gh returned malformed JSON: ${error.message}`, { cause: error });
    let observed;
    try { observed = await observeState(); }
    catch (readError) {
      // Preserve both independent failures in the owner's durable diagnostics.
      const failure = new Error(`${initial.message}; subsequent GitHub issue observation failed: ${readError.message}`, { cause: initial });
      failure.code = readError.code ?? initial.code;
      failure.statusCode = readError.statusCode ?? initial.statusCode;
      throw failure;
    }
    // The caller persists the original failure alongside its recovered outcome.
    if (observed === 'closed') return { number: issueNumber, state: 'closed', reconciledAfterError: initial };
    const failure = new Error(`${initial.message}; subsequent GitHub issue observation confirmed the issue remains open`, { cause: initial });
    failure.code = initial.code;
    failure.statusCode = initial.statusCode;
    throw failure;
  }
  if (!sameIssue(response) || response.state !== 'closed') {
    throw new Error('GitHub issue reconciliation failed: GitHub did not confirm issue closure');
  }
  return { number: issueNumber, state: 'closed' };
}

const MAX_DIAGNOSTIC_RUNS = 5;
const MAX_RUN_LOG_LENGTH = 6000;
const LOG_BUFFER = 16 * 1024 * 1024;

function tail(text, limit) {
  return text.length <= limit ? text : `…${text.slice(text.length - limit + 1)}`;
}

// Strip terminal colour codes and the per-line Actions timestamp so the same
// failed run always yields byte-identical diagnostics.
function normalizeLog(text) {
  return String(text)
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split('\n')
    .map(line => line.replace(/^([^\t]*\t[^\t]*\t)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/, '$1').trimEnd())
    .join('\n')
    .trim();
}

function describeFailedJobs(output) {
  let response;
  try {
    response = JSON.parse(output);
  } catch (error) {
    throw new Error(`GitHub Actions diagnostics failed: gh returned malformed JSON: ${error.message}`);
  }
  if (!isPlainObject(response) || !Array.isArray(response.jobs)) {
    throw new Error('GitHub Actions diagnostics failed: gh returned an unexpected jobs shape');
  }
  return response.jobs
    .filter(job => isPlainObject(job) && typeof job.conclusion === 'string' && job.conclusion
      && !GREEN_CONCLUSIONS.has(job.conclusion))
    .map(job => {
      const steps = Array.isArray(job.steps) ? job.steps : [];
      const failedSteps = steps
        .filter(step => isPlainObject(step) && typeof step.conclusion === 'string' && step.conclusion
          && !GREEN_CONCLUSIONS.has(step.conclusion))
        .map(step => `${String(step.name)} (${step.conclusion})`);
      return `- job ${String(job.name)}: ${job.conclusion}${failedSteps.length ? `; failed steps: ${failedSteps.join(', ')}` : ''}`;
    });
}

/**
 * Gathers read-only, deterministic diagnostics for a red CI observation: the
 * failed jobs/steps and failed-step logs of the newest run of each failing
 * workflow.  Nothing is re-run; only `gh run view` is invoked.
 */
async function collectCiFailureDiagnostics(project, observation, { execFile: executeFile = execFile } = {}) {
  if (!isPlainObject(project) || typeof project.repo !== 'string' || !project.repo.trim() || !isPlainObject(observation)) {
    throw new TypeError('GitHub Actions diagnostics require a project and a CI observation');
  }
  if (typeof executeFile !== 'function') throw new TypeError('GitHub Actions diagnostics require an execFile function');
  const runs = Array.isArray(observation.runs) ? observation.runs : [];
  const failed = latestRunPerWorkflow(runs)
    .filter(run => run.status === 'completed' && run.conclusion && !GREEN_CONCLUSIONS.has(run.conclusion))
    .sort((left, right) => left.databaseId - right.databaseId);
  const sections = [
    `CI ${observation.state} for ${observation.headCommit ? `commit ${observation.headCommit}` : 'the delivered commit'}`
      + `${observation.prNumber ? ` (PR #${observation.prNumber})` : ''}: ${observation.details || 'no details'}`,
  ];
  if (failed.length === 0) sections.push('No failed GitHub Actions run was reported; no logs are available.');
  for (const run of failed.slice(0, MAX_DIAGNOSTIC_RUNS)) {
    const label = run.workflowName || run.name || `run ${run.databaseId}`;
    const id = String(run.databaseId);
    // A cancelled or expired Actions run can retain its conclusion while its
    // detailed jobs or log endpoint is no longer available.  The run header
    // is still actionable context, so keep collecting the other source and
    // record a stable marker instead of losing all diagnostics to one read.
    let jobs = null;
    let log = null;
    try {
      jobs = describeFailedJobs(await runGh(
        ['run', 'view', id, '--repo', project.repo, '--json', 'jobs'],
        executeFile, 'GitHub Actions diagnostics', LOG_BUFFER,
      ));
    } catch {
      // The deterministic marker below deliberately does not embed a
      // transport error, whose wording may vary between gh versions.
    }
    try {
      log = normalizeLog(await runGh(
        ['run', 'view', id, '--repo', project.repo, '--log-failed'],
        executeFile, 'GitHub Actions diagnostics', LOG_BUFFER,
      ));
    } catch {
      // See the jobs read above: preserve the conclusion and any job data.
    }
    sections.push([
      `== ${label} (#${id}): ${run.conclusion}${run.url ? ` ${run.url}` : ''}`,
      ...(jobs === null ? ['- failed job details unavailable'] : jobs.length ? jobs : ['- no failed jobs were reported']),
      'Failed step log (tail):',
      log === null ? '(failed-step log unavailable)' : log ? tail(log, MAX_RUN_LOG_LENGTH) : '(no failed-step log output)',
    ].join('\n'));
  }
  if (failed.length > MAX_DIAGNOSTIC_RUNS) {
    sections.push(`${failed.length - MAX_DIAGNOSTIC_RUNS} further failed run(s) omitted.`);
  }
  return sections.join('\n\n');
}

module.exports = {
  discoverReadyIssues,
  selectReadyIssue,
  observePullRequestCi,
  observePullRequest,
  mergePullRequest,
  reconcileIssueClosure,
  ciStateForRuns,
  collectCiFailureDiagnostics,
};
