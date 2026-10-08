'use strict';

const { execFile } = require('node:child_process');
const { unattendedOptions } = require('./autopilot-subprocess');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function runGh(args, executeFile, operation = 'GitHub issue discovery', maxBuffer = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    try {
      executeFile('gh', args, unattendedOptions({ encoding: 'utf8', maxBuffer, shell: false }), (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${operation} failed: gh exited unsuccessfully${stderr ? `: ${String(stderr).trim()}` : ''}`));
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

function ciStateForRuns(allRuns) {
  const runs = latestRunPerWorkflow(allRuns);
  // A run which has not reached a completed conclusion is deliberately
  // pending, even when another workflow has already failed or passed. This
  // prevents an in-flight retry from being reported as a final red result.
  if (runs.length === 0 || runs.some(run => run.status !== 'completed' || !run.conclusion)) return 'pending';
  return runs.every(run => GREEN_CONCLUSIONS.has(run.conclusion)) ? 'green' : 'red';
}

function ciDetails(commit, runs) {
  if (runs.length === 0) return `No GitHub Actions workflow runs found yet for ${commit}.`;
  return runs.map(run => {
    const label = run.workflowName || run.name || `run ${run.databaseId}`;
    return `${label} (#${run.databaseId}): ${run.status}${run.conclusion ? `/${run.conclusion}` : ''}`;
  }).join('; ');
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
    state: ciStateForRuns(runs),
    details: ciDetails(commit, runs),
    prNumber: number,
    headCommit: commit,
    runs,
  };
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
  ciStateForRuns,
  collectCiFailureDiagnostics,
};
