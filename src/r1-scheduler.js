#!/usr/bin/env node
// Explicit one-shot entrypoint intended for a systemd timer.  It never installs
// a timer or polls by itself.
const fs = require('node:fs');
const path = require('node:path');
const { admitOne, ghIssues } = require('./r1-admission');
const store = require('./store');

// The durable daemon queue is the existing execution path.  Keeping this tiny
// adapter here makes a direct one-shot invocation useful without creating a
// second scheduler or worker framework.
function submitR1Job(request) {
  const task = store.enqueueTask({
    title: `R1 #${request.issue.number}: ${request.issue.title || ''}`,
    prompt: `Implement GitHub issue #${request.issue.number} for ${request.project.repository}. Preserve reviewPolicy always and autoMerge false.`,
    projectPath: request.project.worktree,
    source: 'r1-admission',
    r1JobId: request.id,
    reviewPolicy: 'always',
    autoMerge: false,
  });
  return { id: request.id, taskId: task.id };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] || null;
}

async function main(options = {}) {
  const projectId = options.projectId || argument('--project') || 'ralph';
  // The installed config is the authority.  A command-line worktree/repository
  // is intentionally not accepted, so this command cannot self-register work.
  const project = options.project || (store.config.r1Projects || []).find((candidate) => candidate?.id === projectId);
  if (!project) throw new Error(`No owner-registered R1 project named ${projectId}.`);
  const issuesFile = options.issuesFile || argument('--issues');
  const issues = options.issues || (issuesFile
    ? JSON.parse(fs.readFileSync(path.resolve(issuesFile), 'utf8'))
    : await (options.discoverIssues || ghIssues)(project.repository));
  const dryRun = options.dryRun ?? process.argv.includes('--dry-run');
  const result = await admitOne({ project, issues, dryRun, submitR1Job: options.submitR1Job || submitR1Job, storeImpl: options.storeImpl });
  return result;
}

if (require.main === module) {
  main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, submitR1Job };
