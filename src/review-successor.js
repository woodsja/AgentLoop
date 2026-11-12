#!/usr/bin/env node
'use strict';

// Explicit review-only successor. Never imports the runner or writes job state.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withExecution } = require('./execution-log');
const { createClaudeReviewAdapter } = require('./autopilot-review');
const { observePullRequestCi } = require('./autopilot-github');
const { hasPassingVerification } = require('./autopilot-state');

async function reviewSuccessor({ sourcePath, directory, projectName, project, issueNumber, signal }, dependencies = {}) {
  const sourceBytes = fs.readFileSync(sourcePath);
  const source = JSON.parse(sourceBytes);
  const evidence = source.evidence;
  const commit = evidence?.commit;
  const prNumber = evidence?.ci?.prNumber;
  if (source.status !== 'blocked' || source.project !== projectName || !source.id
    || !Number.isSafeInteger(issueNumber) || issueNumber < 1
    || !Number.isSafeInteger(prNumber) || prNumber < 1
    || !/^[a-f0-9]{40}$/i.test(commit || '')
    || !hasPassingVerification(evidence?.verification, commit)
    || !evidence.reviewHistory?.some(entry => entry.commit === commit
      && ['invalid_verdict', 'failed', 'timed_out', 'interrupted'].includes(entry.status))) {
    throw new Error('Successor requires an original blocked R1 result with failed review and exact-SHA verification');
  }
  // mkdir is an exclusive reservation, including after interruption. Reusing
  // this directory never invokes the provider or modifies previous evidence.
  fs.mkdirSync(directory, { recursive: false });
  const journalPath = path.join(directory, 'execution.ndjson');
  fs.closeSync(fs.openSync(journalPath, 'wx', 0o600));
  const record = (event, details = {}) => {
    // A terminating child may emit its final pipe/exit records after the
    // adapter rejects. Keep recording those bytes after successor_blocked.
    const fd = fs.openSync(journalPath, 'a');
    try {
      fs.writeSync(fd, JSON.stringify({ ...details, event, at: new Date().toISOString() }) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  };
  const context = { project: { ...project, reviewModel: 'opus', autoMerge: false },
    issue: { number: issueNumber }, pullRequest: { number: prNumber }, headCommit: commit,
    verification: evidence.verification, reviewHistory: evidence.reviewHistory };
  try {
    record('successor_reserved', { sourcePath: path.resolve(sourcePath), sourceId: source.id,
      sourceSha256: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
      project: projectName, repo: project.repo, issueNumber, prNumber, commit,
      maxInvocations: 1, autoMerge: false, source });
    return await withExecution(record, async () => {
      const observe = dependencies.observeCi || observePullRequestCi;
      const assertCi = async () => {
        const ci = await observe(context.project, { number: prNumber, commit });
        record('ci_observation', { ci });
        if (ci.state !== 'green' || ci.prNumber !== prNumber || ci.headCommit !== commit) throw new Error('Successor requires green required CI for the exact PR head');
        return ci;
      };
      context.ci = await assertCi();
      if (signal?.aborted) throw new Error('Successor interrupted');
      const review = dependencies.review || createClaudeReviewAdapter({ signal });
      const prepared = await review.prepare(context);
      if (signal?.aborted) throw new Error('Successor interrupted');
      record('review_running', { reviewer: 'claude:opus', commit, attempt: 1 });
      const verdict = await review({ prepared });
      // Both head (adapter) and required CI must still match after inference.
      await assertCi();
      if (signal?.aborted) throw new Error('Successor interrupted');
      record('review_completed', { review: verdict, mergeAuthorized: false });
      return verdict;
    });
  } catch (error) {
    record('successor_blocked', { message: error.message, stack: error.stack });
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 5) throw new Error('Usage: node src/review-successor.js PROJECTS_JSON PROJECT ISSUE_NUMBER BLOCKED_RESULT_JSON NEW_EVIDENCE_DIRECTORY');
  const [projectsPath, projectName, issue, sourcePath, directory] = argv;
  const project = require('./autopilot-config').loadProjectConfig(projectName, { configPath: projectsPath });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { console.log(JSON.stringify(await reviewSuccessor({ sourcePath, directory, projectName, project, issueNumber: Number(issue), signal: controller.signal }))); }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { reviewSuccessor, main };
