#!/usr/bin/env node
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { projectCommand } = require('./project-registration');

function parseArguments(argv) {
  const [group, action, ...rest] = argv;
  if (!['project', 'grant'].includes(group)) throw new Error('Usage: ralph project add|check|activate owner/repository [--yes] [--config path] [--projects path] [--checkout-root path] [--worktree-root path] [--base-branch name] [--ci-workflow name] [--worker codex|claude] [--ready-label label]; project recover; ralph grant draft|inspect|activate ID [--input JSON --spec file] [--digest SHA256 --yes] [--config path] [--projects path]');
  const options = {}, positional = [];
  const flags = { '--input': 'inputPath', '--spec': 'specPath', '--digest': 'digest', '--config': 'configPath', '--projects': 'projectsPath', '--checkout-root': 'checkoutRoot', '--worktree-root': 'worktreeRoot', '--base-branch': 'baseBranch', '--ci-workflow': 'ciWorkflow', '--worker': 'worker', '--ready-label': 'readyLabel' };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--yes') options.yes = true;
    else if (flags[rest[i]]) {
      if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`Missing value for ${rest[i]}`);
      options[flags[rest[i]]] = rest[++i];
    } else if (rest[i].startsWith('--')) throw new Error(`Unknown option ${rest[i]}`);
    else positional.push(rest[i]);
  }
  if (positional.length !== (group === 'project' && action === 'recover' ? 0 : 1)) throw new Error(group === 'grant' ? 'Supply one grant ID.' : 'Supply one owner/repository identifier (none for recover).');
  if (group === 'grant') {
    if (!['draft', 'inspect', 'activate'].includes(action)) throw new Error('Usage: ralph grant draft|inspect|activate ID');
    if (action === 'draft' && (!options.inputPath || !options.specPath)) throw new Error('Draft requires --input JSON and --spec file.');
    const allowed = ['configPath', 'projectsPath', ...(action === 'draft' ? ['inputPath', 'specPath'] : action === 'activate' ? ['digest', 'yes'] : [])];
    if (Object.keys(options).some(key => !allowed.includes(key))) throw new Error('Option is not valid for this grant command.');
  } else if (options.inputPath || options.specPath || options.digest) throw new Error('Grant options require the grant command.');
  if (options.worker && !['codex', 'claude'].includes(options.worker)) throw new Error('Worker must be codex or claude.');
  options.configPath = path.resolve(options.configPath || process.env.AGENTLOOP_CONFIG_PATH || path.join(__dirname, '../config.json'));
  options.projectsPath = path.resolve(options.projectsPath || process.env.AGENTLOOP_PROJECTS_PATH || path.join(__dirname, '../autopilot-projects.json'));
  options.checkoutRoot ||= path.join(os.homedir(), 'repositories');
  options.worktreeRoot ||= path.join(os.homedir(), 'worktrees');
  return { group, action, repo: positional[0], options };
}

async function main(argv = process.argv.slice(2)) {
  // Lazy import respects the same owner state/config environment as the daemon.
  const store = require('./store');
  const options = { logId: `onboarding-${crypto.randomUUID()}` };
  console.log(`Owner diagnostics: /api/log/${options.logId}?download=1\n${store.executionPath(options.logId)}`);
  options.record = (event, details = {}) => {
    store.appendExecution(options.logId, { event, ...details });
    if (event === 'output') process[details.stream === 'stderr' ? 'stderr' : 'stdout'].write(Buffer.from(details.base64, 'base64'));
    else console.log(JSON.stringify({ event, ...details }, null, event === 'preview' ? 2 : 0));
  };
  options.recordExecution = options.record;
  options.approve = async message => {
    if (options.yes) return true;
    if (!process.stdin.isTTY) throw new Error('Owner approval requires a terminal or explicit --yes after inspecting settings.');
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try { return /^y(?:es)?$/i.test((await prompt.question(`${message} [y/N] `, { signal: controller.signal })).trim()); }
    finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); prompt.close(); }
  };
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  options.isCancelled = () => cancelled;
  options.record('onboarding_start', { argv, path: process.env.PATH, node: process.execPath });
  try {
    const parsed = parseArguments(argv);
    Object.assign(options, parsed.options);
    const command = parsed.group === 'grant' ? require('./milestone-grants').grantCommand : projectCommand;
    const result = await command(parsed.action, parsed.repo, options);
    options.record('onboarding_result', { result });
    return result;
  } catch (error) {
    options.record('onboarding_failure', { message: error.message, stack: error.stack, outcome: error.outcome });
    throw error;
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { main, parseArguments };
