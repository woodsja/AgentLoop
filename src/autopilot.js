'use strict';

const { loadProjectConfig } = require('./autopilot-config');
const { discoverReadyIssues, selectReadyIssue } = require('./autopilot-github');

const USAGE = 'Usage: node src/autopilot.js --project <name> --dry-run';

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 || argv[0] !== '--project'
    || typeof argv[1] !== 'string' || !argv[1].trim() || argv[2] !== '--dry-run') {
    throw new Error(USAGE);
  }
  return { projectName: argv[1] };
}

async function run(argv, dependencies = {}) {
  const { projectName } = parseArguments(argv);
  const loadConfig = dependencies.loadProjectConfig || loadProjectConfig;
  const discover = dependencies.discoverReadyIssues || discoverReadyIssues;
  const choose = dependencies.selectReadyIssue || selectReadyIssue;
  const write = dependencies.write || (line => process.stdout.write(`${line}\n`));
  const project = loadConfig(projectName);
  const candidate = choose(await discover(project));

  if (!candidate) {
    write(`Dry run: no ready-for-agent issue found for project ${projectName} in ${project.repo}.`);
    return null;
  }

  write(`Dry run: project ${projectName}; repository ${project.repo}; issue #${candidate.number}: ${candidate.title}; worker ${project.worker}; action is dry-run only.`);
  return candidate;
}

async function main(argv = process.argv.slice(2), dependencies) {
  try {
    await run(argv, dependencies);
    return 0;
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n${USAGE}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then(exitCode => { process.exitCode = exitCode; });
}

module.exports = { USAGE, parseArguments, run, main };
