#!/usr/bin/env node
// Explicit one-shot entrypoint intended for a systemd timer.  It never installs
// a timer or polls by itself.
const fs = require('node:fs');
const path = require('node:path');
const { admitOne, ghIssues } = require('./r1-admission');
const store = require('./store');

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
  const submitR1Job = options.submitR1Job;
  const result = await admitOne({ project, issues, dryRun, submitR1Job, storeImpl: options.storeImpl });
  return result;
}

if (require.main === module) {
  main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
