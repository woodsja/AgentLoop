'use strict';

// Bootstrap installer for the one Ralph-only deployment unit.  It intentionally
// does not enable a timer: completed R1 merges explicitly start this service.
const fs = require('node:fs');
const path = require('node:path');
const { quoteExecArgument, escapeEnvironmentValue, userUnitDirectory, defaultExec, describeFailure } = require('./autopilot-systemd');

const UNIT_NAME = 'ralph-deploy.service';
const ROOT = path.resolve(__dirname, '..');

function renderService({ root = ROOT, nodePath = process.execPath, pathEnv = process.env.PATH } = {}) {
  const lines = ['[Unit]', 'Description=Deploy an approved Ralph AgentLoop merge', 'After=network-online.target', '', '[Service]', 'Type=oneshot',
    `WorkingDirectory=${root.replace(/%/g, '%%')}`, `ExecStart=${[nodePath, path.join(root, 'src', 'ralph-deploy.js')].map(quoteExecArgument).join(' ')}`];
  if (pathEnv) lines.push(`Environment="PATH=${escapeEnvironmentValue(pathEnv)}"`);
  lines.push(''); return lines.join('\n');
}

function install({ root = ROOT } = {}, dependencies = {}) {
  const env = dependencies.env || process.env; const directory = dependencies.unitDirectory || userUnitDirectory(env);
  const exec = dependencies.exec || defaultExec; const fileSystem = dependencies.fs || fs;
  if (!fileSystem.existsSync(path.join(root, 'src', 'ralph-deploy.js'))) throw new Error(`No Ralph deployer found at ${root}`);
  fileSystem.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, UNIT_NAME); fileSystem.writeFileSync(file, renderService({ root, pathEnv: env.PATH }), 'utf8');
  const result = exec('systemctl', ['--user', 'daemon-reload']);
  if (result.status !== 0) throw new Error(describeFailure('systemctl', ['--user', 'daemon-reload'], result));
  return { servicePath: file };
}

if (require.main === module) {
  try { const result = install(); process.stdout.write(`Wrote ${result.servicePath}\n`); }
  catch (error) { process.stderr.write(`Ralph deploy install failed: ${error.message}\n`); process.exitCode = 1; }
}
module.exports = { UNIT_NAME, renderService, install };
