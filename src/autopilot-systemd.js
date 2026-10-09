'use strict';

// Installs the autopilot as a systemd *user* service plus timer.  The service
// is a single oneshot `autopilot.js --project <name>` pass; the timer fires it
// roughly every five minutes and catches up on missed runs (Persistent=true).
// Only the user systemd instance is touched; the AgentLoop daemon is never
// started.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PROJECT = 'finance-dashboard';
const DEFAULT_UNIT_NAME = 'ralph-finance-autopilot';
const USAGE = 'Usage: node src/autopilot-systemd.js [--root <dir>] [--project <name>] [--unit <name>] [--run-once] [--dry-run]';

function parseArguments(argv) {
  const options = { root: REPO_ROOT, project: DEFAULT_PROJECT, unitName: DEFAULT_UNIT_NAME, runOnce: false, dryRun: false };
  const valued = { '--root': 'root', '--project': 'project', '--unit': 'unitName' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--run-once') options.runOnce = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (Object.hasOwn(valued, argument) && typeof argv[index + 1] === 'string' && argv[index + 1].trim()) {
      options[valued[argument]] = argv[index + 1];
      index += 1;
    } else {
      throw new Error(USAGE);
    }
  }
  if (!/^[A-Za-z0-9._-]+$/.test(options.project)) throw new Error(`Invalid project name: ${options.project}`);
  if (!/^[A-Za-z0-9._@-]+$/.test(options.unitName)) throw new Error(`Invalid unit name: ${options.unitName}`);
  options.root = path.resolve(options.root);
  return options;
}

// systemd splits ExecStart on whitespace and expands `%` and `$`; quote and
// escape so arbitrary install paths survive intact.
function quoteExecArgument(value) {
  const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$');
  return /[\s"'\\]/.test(value) ? `"${escaped}"` : escaped;
}

// Environment= expands `%` specifiers but not `$` variables.
function escapeEnvironmentValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
}

function renderService({ root, project, nodePath, pathEnv }) {
  const script = path.join(root, 'src', 'autopilot.js');
  const lines = [
    '[Unit]',
    `Description=Ralph autopilot single pass for ${project}`,
    'Wants=network-online.target',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    `WorkingDirectory=${root.replace(/%/g, '%%')}`,
    `ExecStart=${[nodePath, script, '--project', project].map(quoteExecArgument).join(' ')}`,
  ];
  if (pathEnv) lines.push(`Environment="PATH=${escapeEnvironmentValue(pathEnv)}"`);
  lines.push('Nice=10', '');
  return `${lines.join('\n')}\n`;
}

function renderTimer({ project, unitName }) {
  return [
    '[Unit]',
    `Description=Run the Ralph autopilot for ${project} about every five minutes`,
    '',
    '[Timer]',
    'OnCalendar=*:0/5',
    'AccuracySec=30s',
    'Persistent=true',
    `Unit=${unitName}.service`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

function userUnitDirectory(env = process.env) {
  const configHome = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : path.join(env.HOME || os.homedir(), '.config');
  return path.join(configHome, 'systemd', 'user');
}

function defaultExec(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout || '',
    stderr: result.error ? result.error.message : (result.stderr || ''),
  };
}

function describeFailure(command, args, result) {
  const detail = `${result.stderr || ''}${result.stdout || ''}`.trim();
  return `${command} ${args.join(' ')} failed (exit ${result.status})${detail ? `: ${detail}` : ''}`;
}

// Lingering lets the user manager (and so the timer) start at boot without an
// interactive login.  Enabling it may require polkit/root; a refusal is
// reported verbatim and leaves everything else installed.
function ensureLinger(user, exec, write) {
  const shown = exec('loginctl', ['show-user', user, '--property=Linger', '--value']);
  if (shown.status === 0 && shown.stdout.trim() === 'yes') {
    write(`Lingering already enabled for ${user}.`);
    return { enabled: true, changed: false };
  }
  const enabled = exec('loginctl', ['enable-linger', user]);
  if (enabled.status === 0) {
    write(`Enabled lingering for ${user}.`);
    return { enabled: true, changed: true };
  }
  const reason = describeFailure('loginctl', ['enable-linger', user], enabled);
  write(`Lingering NOT enabled for ${user}; permission boundary: ${reason}`);
  return { enabled: false, changed: false, error: reason };
}

function install(options, dependencies = {}) {
  const env = dependencies.env || process.env;
  const exec = dependencies.exec || defaultExec;
  const write = dependencies.write || (line => process.stdout.write(`${line}\n`));
  const fileSystem = dependencies.fs || fs;
  const user = dependencies.user || env.USER || os.userInfo().username;
  const unitDirectory = dependencies.unitDirectory || userUnitDirectory(env);
  const nodePath = dependencies.nodePath || process.execPath;
  const pathEnv = Object.hasOwn(dependencies, 'pathEnv') ? dependencies.pathEnv : env.PATH;

  if (!fileSystem.existsSync(path.join(options.root, 'src', 'autopilot.js'))) {
    throw new Error(`No autopilot found at ${options.root}`);
  }
  const service = renderService({ root: options.root, project: options.project, nodePath, pathEnv });
  const timer = renderTimer(options);
  const servicePath = path.join(unitDirectory, `${options.unitName}.service`);
  const timerPath = path.join(unitDirectory, `${options.unitName}.timer`);

  if (options.dryRun) {
    write(`# ${servicePath}\n${service}`);
    write(`# ${timerPath}\n${timer}`);
    return { servicePath, timerPath, service, timer, dryRun: true };
  }

  fileSystem.mkdirSync(unitDirectory, { recursive: true });
  fileSystem.writeFileSync(servicePath, service);
  fileSystem.writeFileSync(timerPath, timer);
  write(`Wrote ${servicePath}`);
  write(`Wrote ${timerPath}`);

  const systemctl = args => {
    const result = exec('systemctl', ['--user', ...args]);
    if (result.status !== 0) throw new Error(describeFailure('systemctl', ['--user', ...args], result));
    return result;
  };
  systemctl(['daemon-reload']);
  systemctl(['enable', '--now', `${options.unitName}.timer`]);
  write(`Enabled and started ${options.unitName}.timer`);
  if (options.runOnce) {
    // `start` on a oneshot blocks until the pass finishes and fails if it does.
    systemctl(['start', `${options.unitName}.service`]);
    write(`Ran ${options.unitName}.service once successfully`);
  }
  const linger = ensureLinger(user, exec, write);
  return { servicePath, timerPath, service, timer, linger, dryRun: false };
}

function main(argv = process.argv.slice(2), dependencies) {
  try {
    install(parseArguments(argv), dependencies);
    return 0;
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n${USAGE}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  DEFAULT_PROJECT,
  DEFAULT_UNIT_NAME,
  USAGE,
  parseArguments,
  quoteExecArgument,
  escapeEnvironmentValue,
  renderService,
  renderTimer,
  userUnitDirectory,
  defaultExec,
  describeFailure,
  ensureLinger,
  install,
  main,
};
