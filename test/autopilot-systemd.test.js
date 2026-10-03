'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseArguments,
  quoteExecArgument,
  renderService,
  renderTimer,
  userUnitDirectory,
  ensureLinger,
  install,
} = require('../src/autopilot-systemd');

const REPO_ROOT = path.resolve(__dirname, '..');
const temporaryDirectories = new Set();

test.afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-systemd-'));
  temporaryDirectories.add(directory);
  return directory;
}

function recordingExec(responses = {}) {
  const calls = [];
  const exec = (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    calls.push(key);
    return responses[key] || { status: 0, stdout: '', stderr: '' };
  };
  return { calls, exec };
}

test('defaults target the finance-dashboard project and ralph-finance-autopilot units', () => {
  const options = parseArguments([]);
  assert.equal(options.project, 'finance-dashboard');
  assert.equal(options.unitName, 'ralph-finance-autopilot');
  assert.equal(options.root, REPO_ROOT);
  assert.equal(parseArguments(['--root', '/home/woodsja/tools/ralph-autopilot', '--run-once']).runOnce, true);
  assert.throws(() => parseArguments(['--bogus']), /Usage:/);
  assert.throws(() => parseArguments(['--root']), /Usage:/);
  assert.throws(() => parseArguments(['--project', '../x']), /Invalid project/);
});

test('timer fires about every five minutes and is persistent', () => {
  const timer = renderTimer({ project: 'finance-dashboard', unitName: 'ralph-finance-autopilot' });
  assert.match(timer, /^OnCalendar=\*:0\/5$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^Unit=ralph-finance-autopilot\.service$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
});

test('service is a oneshot autopilot pass and never the AgentLoop daemon', () => {
  const service = renderService({
    root: '/home/woodsja/tools/ralph-autopilot', project: 'finance-dashboard', nodePath: '/usr/bin/node', pathEnv: '/usr/bin:/bin',
  });
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^WorkingDirectory=\/home\/woodsja\/tools\/ralph-autopilot$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/node \/home\/woodsja\/tools\/ralph-autopilot\/src\/autopilot\.js --project finance-dashboard$/m);
  assert.match(service, /^Environment="PATH=\/usr\/bin:\/bin"$/m);
  assert.doesNotMatch(service, /daemon|bridge\.js/);
});

test('exec arguments are quoted and escaped for systemd', () => {
  assert.equal(quoteExecArgument('/plain/path'), '/plain/path');
  assert.equal(quoteExecArgument('/with space/100%'), '"/with space/100%%"');
});

test('unit directory honours XDG_CONFIG_HOME', () => {
  assert.equal(userUnitDirectory({ XDG_CONFIG_HOME: '/x/cfg', HOME: '/h' }), '/x/cfg/systemd/user');
  assert.equal(userUnitDirectory({ HOME: '/h' }), '/h/.config/systemd/user');
});

test('install writes units, reloads, enables the timer, runs once, and enables linger', () => {
  const unitDirectory = temporaryDirectory();
  const { calls, exec } = recordingExec({ 'loginctl show-user me --property=Linger --value': { status: 0, stdout: 'no\n', stderr: '' } });
  const lines = [];
  const result = install({ ...parseArguments(['--run-once']) }, {
    exec, unitDirectory, user: 'me', nodePath: '/usr/bin/node', pathEnv: '/usr/bin', write: line => lines.push(line),
  });
  assert.ok(fs.readFileSync(path.join(unitDirectory, 'ralph-finance-autopilot.timer'), 'utf8').includes('Persistent=true'));
  assert.ok(fs.readFileSync(path.join(unitDirectory, 'ralph-finance-autopilot.service'), 'utf8').includes('Type=oneshot'));
  assert.deepEqual(calls, [
    'systemctl --user daemon-reload',
    'systemctl --user enable --now ralph-finance-autopilot.timer',
    'systemctl --user start ralph-finance-autopilot.service',
    'loginctl show-user me --property=Linger --value',
    'loginctl enable-linger me',
  ]);
  assert.deepEqual(result.linger, { enabled: true, changed: true });
});

test('a failing oneshot run fails the install', () => {
  const { exec } = recordingExec({ 'systemctl --user start ralph-finance-autopilot.service': { status: 1, stdout: '', stderr: 'Job failed' } });
  assert.throws(() => install(parseArguments(['--run-once']), {
    exec, unitDirectory: temporaryDirectory(), user: 'me', write: () => {},
  }), /Job failed/);
});

test('linger already on is left alone; a refusal is reported without failing', () => {
  const on = recordingExec({ 'loginctl show-user me --property=Linger --value': { status: 0, stdout: 'yes\n', stderr: '' } });
  assert.deepEqual(ensureLinger('me', on.exec, () => {}), { enabled: true, changed: false });
  assert.deepEqual(on.calls, ['loginctl show-user me --property=Linger --value']);

  const lines = [];
  const denied = recordingExec({
    'loginctl show-user me --property=Linger --value': { status: 0, stdout: 'no\n', stderr: '' },
    'loginctl enable-linger me': { status: 1, stdout: '', stderr: 'Access denied' },
  });
  const result = ensureLinger('me', denied.exec, line => lines.push(line));
  assert.equal(result.enabled, false);
  assert.match(result.error, /Access denied/);
  assert.match(lines[0], /permission boundary: loginctl enable-linger me failed \(exit 1\): Access denied/);
});

test('dry run prints units without touching systemd or disk', () => {
  const unitDirectory = path.join(temporaryDirectory(), 'missing');
  const { calls, exec } = recordingExec();
  const result = install(parseArguments(['--dry-run']), { exec, unitDirectory, user: 'me', write: () => {} });
  assert.equal(result.dryRun, true);
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(unitDirectory), false);
});
