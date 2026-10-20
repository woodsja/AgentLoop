const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { preparationCommands } = require('../src/project-preflight-command');

test('native tools receive blocking output endpoints and burst output survives forwarding', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-setup-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const records = [];
  const { command } = preparationCommands(root, { recordExecution: (event, details) => records.push({ event, ...details }) });
  const script = "import os\nassert os.get_blocking(1) and os.get_blocking(2), 'native output endpoints must block'\nfor i in range(20000):\n os.write(1, b'out\\n')\n os.write(2, b'err\\n')\n";
  const stdout = await command('python3', ['-c', script], 'native_failed');
  assert.equal(stdout, 'out\n'.repeat(20000));
  for (const [stream, expected] of [['stdout', 'out\n'], ['stderr', 'err\n']]) {
    const bytes = Buffer.concat(records.filter(r => r.event === 'output' && r.stream === stream).map(r => Buffer.from(r.base64, 'base64')));
    assert.equal(bytes.toString(), expected.repeat(20000));
  }
});

test('a signalled native command flushes both forwarded streams before the runner mirrors its signal', async () => {
  const records = [];
  const { command } = preparationCommands(os.tmpdir(), { recordExecution: (event, details) => records.push({ event, ...details }) });
  const script = "import os,signal\nos.write(1,b'x'*200000)\nos.write(2,b'y'*200000)\nos.kill(os.getpid(),signal.SIGTERM)";
  await assert.rejects(command('python3', ['-c', script], 'expected_signal'), error => error.outcome?.signal === 'SIGTERM');
  for (const [stream, letter] of [['stdout', 'x'], ['stderr', 'y']]) {
    const bytes = Buffer.concat(records.filter(r => r.event === 'output' && r.stream === stream).map(r => Buffer.from(r.base64, 'base64')));
    assert.equal(bytes.toString(), letter.repeat(200000));
  }
});
