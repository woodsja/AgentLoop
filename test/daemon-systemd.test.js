'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArguments, renderService, install, UNIT_NAME } = require('../src/daemon-systemd');

const REPO_ROOT = path.resolve(__dirname, '..');
const temporaryDirectories = new Set();

test.afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-systemd-'));
  temporaryDirectories.add(directory);
  return directory;
}

test('renders a persistent AgentLoop daemon service, not a scheduler', () => {
  const service = renderService({
    root: '/opt/Agent Loop', nodePath: '/usr/local/bin/node', pathEnv: '/opt/bin:/usr/bin:/bin',
  });
  assert.match(service, /^WorkingDirectory=\/opt\/Agent Loop$/m);
  assert.match(service, /^ExecStart=\/usr\/local\/bin\/node "\/opt\/Agent Loop\/src\/daemon\.js"$/m);
  assert.match(service, /^Environment="PATH=\/opt\/bin:\/usr\/bin:\/bin"$/m);
  assert.match(service, /^Restart=on-failure$/m);
  assert.match(service, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(service, /\[Timer\]|OnCalendar|autopilot\.js|ralph-finance-autopilot/);
});

test('installation explicitly writes and enables only agentloop.service', () => {
  const unitDirectory = temporaryDirectory();
  const calls = [];
  const result = install(parseArguments(['--install']), {
    unitDirectory,
    nodePath: '/usr/bin/node',
    pathEnv: '/usr/bin:/bin',
    exec(command, args) {
      calls.push(`${command} ${args.join(' ')}`);
      return { status: 0, stdout: '', stderr: '' };
    },
    write: () => {},
  });

  assert.equal(result.dryRun, false);
  assert.deepEqual(fs.readdirSync(unitDirectory), [UNIT_NAME]);
  assert.match(fs.readFileSync(path.join(unitDirectory, UNIT_NAME), 'utf8'), /src\/daemon\.js/);
  assert.equal(fs.existsSync(path.join(unitDirectory, 'ralph-finance-autopilot.timer')), false);
  assert.deepEqual(calls, [
    'systemctl --user daemon-reload',
    'systemctl --user enable agentloop.service',
  ]);
});

test('dry run is the default and does not write files or call systemd', () => {
  const unitDirectory = path.join(temporaryDirectory(), 'systemd-user');
  const calls = [];
  const result = install(parseArguments(['--dry-run']), {
    unitDirectory,
    exec(command, args) {
      calls.push(`${command} ${args.join(' ')}`);
      return { status: 0, stdout: '', stderr: '' };
    },
    write: () => {},
  });
  assert.equal(result.dryRun, true);
  assert.equal(fs.existsSync(unitDirectory), false);
  assert.deepEqual(calls, []);
  assert.equal(parseArguments([]).install, false);
  assert.throws(() => parseArguments(['--unit', 'finance']), /Usage:/);
});
