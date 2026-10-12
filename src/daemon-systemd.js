'use strict';

// Installs the long-running AgentLoop daemon as a systemd *user* service.
// This deliberately has no timer: daemon.js owns its own queue processing.

const fs = require('node:fs');
const path = require('node:path');
const {
  quoteExecArgument,
  escapeEnvironmentValue,
  userUnitDirectory,
  defaultExec,
  describeFailure,
} = require('./autopilot-systemd');

const REPO_ROOT = path.resolve(__dirname, '..');
const UNIT_NAME = 'agentloop.service';
const USAGE = 'Usage: node src/daemon-systemd.js [--root <dir>] [--dry-run | --install]';

function parseArguments(argv) {
  const options = { root: REPO_ROOT, install: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.install = false;
    else if (argument === '--install') options.install = true;
    else if (argument === '--root' && typeof argv[index + 1] === 'string' && argv[index + 1].trim()) {
      options.root = argv[index + 1];
      index += 1;
    } else {
      throw new Error(USAGE);
    }
  }

  options.root = path.resolve(options.root);
  return options;
}

function renderService({ root, nodePath, pathEnv }) {
  const script = path.join(root, 'src', 'daemon.js');
  const lines = [
    '[Unit]',
    'Description=AgentLoop daemon',
    'Wants=network-online.target',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${root.replace(/%/g, '%%')}`,
    `ExecStart=${[nodePath, script].map(quoteExecArgument).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=5s',
  ];
  if (pathEnv) lines.push(`Environment="PATH=${escapeEnvironmentValue(pathEnv)}"`);
  lines.push('', '[Install]', 'WantedBy=default.target', '');
  return lines.join('\n');
}

function install(options, dependencies = {}) {
  const fileSystem = dependencies.fs || fs;
  const env = dependencies.env || process.env;
  const exec = dependencies.exec || defaultExec;
  const write = dependencies.write || (line => process.stdout.write(`${line}\n`));
  const unitDirectory = dependencies.unitDirectory || userUnitDirectory(env);
  const nodePath = dependencies.nodePath || process.execPath;
  const pathEnv = Object.hasOwn(dependencies, 'pathEnv') ? dependencies.pathEnv : env.PATH;
  const servicePath = path.join(unitDirectory, UNIT_NAME);

  if (!fileSystem.existsSync(path.join(options.root, 'src', 'daemon.js'))) {
    throw new Error(`No AgentLoop daemon found at ${options.root}`);
  }

  const service = renderService({ root: options.root, nodePath, pathEnv });
  if (!options.install) {
    write(`# ${servicePath}\n${service}`);
    return { servicePath, service, dryRun: true };
  }

  fileSystem.mkdirSync(unitDirectory, { recursive: true });
  fileSystem.writeFileSync(servicePath, service, 'utf8');
  write(`Wrote ${servicePath}`);

  const systemctl = args => {
    const result = exec('systemctl', ['--user', ...args]);
    if (result.status !== 0) throw new Error(describeFailure('systemctl', ['--user', ...args], result));
  };
  systemctl(['daemon-reload']);
  // Enable for future user-manager starts.  Do not start or restart a daemon
  // during installation; the owner starts it explicitly with systemctl.
  systemctl(['enable', UNIT_NAME]);
  write(`Enabled ${UNIT_NAME}; start it with systemctl --user start ${UNIT_NAME}`);
  return { servicePath, service, dryRun: false };
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

if (require.main === module) process.exitCode = main();

module.exports = {
  REPO_ROOT,
  UNIT_NAME,
  USAGE,
  parseArguments,
  renderService,
  install,
  main,
};
