const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const engines = require('../src/engines');

const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon.js'), 'utf8');
const engineSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'engines.js'), 'utf8');

function argsFor(id) {
  const engine = engines.get(id);
  return engine.args({ model: 'test-model', outputPath: 'out.tmp' });
}

function pairFollowing(args, flag) {
  return args[args.indexOf(flag) + 1];
}

test('no engine bypasses its approval layer', () => {
  for (const source of [daemonSource, engineSource]) {
    assert.doesNotMatch(source, /--dangerously-bypass-approvals-and-sandbox/);
    assert.doesNotMatch(source, /--dangerously-skip-permissions/);
  }
});

test('Codex sessions use workspace sandboxing', () => {
  const args = argsFor('codex');

  assert.equal(pairFollowing(args, '--sandbox'), 'workspace-write');
  assert.ok(args.includes('approval_policy="on-request"'));
  assert.ok(args.includes('approvals_reviewer="auto_review"'));
  assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
});

test('Claude workers use automatic permission review without inheriting operator config', () => {
  const args = argsFor('claude');

  assert.equal(pairFollowing(args, '--permission-mode'), 'auto');
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--strict-mcp-config'));
  const denied = pairFollowing(args, '--disallowedTools').split(',');
  for (const tool of [
    'WebFetch', 'WebSearch', 'RemoteTrigger', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup',
    'SendMessage', 'ListAgents', 'EnterWorktree', 'ExitWorktree', 'PushNotification', 'DesignSync',
  ]) {
    assert.ok(denied.includes(tool), `worker must not get ${tool}`);
  }
  for (const tool of ['Bash', 'Edit', 'Write', 'Read']) {
    assert.ok(!denied.includes(tool), `worker needs ${tool}`);
  }
});

test('Claude workers do not inherit a parent Claude Code session', () => {
  const env = engines.get('claude').env({ PATH: '/usr/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '9' });

  assert.equal(env.PATH, '/usr/bin');
  assert.equal('CLAUDECODE' in env, false);
  assert.equal('CLAUDE_CODE_ENTRYPOINT' in env, false);
  assert.equal('CLAUDE_CODE_SSE_PORT' in env, false);
});

test('every engine passes the selected model through', () => {
  for (const id of engines.ids()) {
    assert.equal(pairFollowing(argsFor(id), '--model'), 'test-model', `${id} drops the model`);
  }
});

test('Codex critics cannot approve escape from the read-only sandbox', () => {
  const args = engines.get('codex').args({ model: 'test', outputPath: 'out.tmp', role: 'critic' });
  assert.equal(pairFollowing(args, '--sandbox'), 'read-only');
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(!args.includes('approvals_reviewer="auto_review"'));
});

test('Claude critics expose only file reading tools and deny permission requests and MCP', () => {
  const args = engines.get('claude').args({ model: 'test', role: 'critic' });
  assert.equal(pairFollowing(args, '--tools'), 'Read,Glob,Grep');
  assert.equal(pairFollowing(args, '--permission-mode'), 'dontAsk');
  assert.equal(pairFollowing(args, '--disallowedTools'), 'WebFetch,WebSearch,mcp__*');
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--resume'));
  assert.ok(!args.includes('--continue'));
});

test('config-isolation flags apply to critics only', () => {
  const isolation = { codex: ['--ignore-user-config', '--ignore-rules'], claude: ['--restricted'] };
  for (const [id, flags] of Object.entries(isolation)) {
    const engine = engines.get(id);
    const critic = engine.args({ model: 'test', outputPath: 'out.tmp', role: 'critic' });
    for (const role of ['worker', undefined]) {
      const worker = engine.args({ model: 'test', outputPath: 'out.tmp', role });
      for (const flag of flags) {
        assert.ok(critic.includes(flag), `${id} critic lacks ${flag}`);
        assert.ok(!worker.includes(flag), `${id} worker gained ${flag}`);
      }
    }
  }
  const claudeCritic = engines.get('claude').args({ model: 'test', role: 'critic' });
  for (const kept of ['--safe-mode', '--strict-mcp-config']) {
    assert.ok(claudeCritic.includes(kept), `claude critic dropped ${kept}`);
  }
  const codexCritic = engines.get('codex').args({ model: 'test', outputPath: 'out.tmp', role: 'critic' });
  assert.equal(pairFollowing(codexCritic, '--sandbox'), 'read-only');
});

test('worker arguments keep their implementation permissions', () => {
  const codexWorker = engines.get('codex').args({ model: 'test', outputPath: 'out.tmp', role: 'worker' });
  assert.equal(pairFollowing(codexWorker, '--sandbox'), 'workspace-write');
  assert.ok(codexWorker.includes('approvals_reviewer="auto_review"'));
  const claudeWorker = engines.get('claude').args({ model: 'test', role: 'worker' });
  assert.equal(pairFollowing(claudeWorker, '--permission-mode'), 'auto');
  assert.ok(!claudeWorker.includes('--tools'));
});

test('unattended Claude workers retain permission review instead of blanket shell approval', () => {
  for (const role of ['worker', undefined]) {
    const args = engines.get('claude').args({ model: 'opus', role });
    assert.equal(pairFollowing(args, '--permission-mode'), 'auto');
    assert.ok(!args.includes('--allowedTools'));
    assert.ok(!args.includes('--allow-dangerously-skip-permissions'));
    assert.ok(!args.includes('bypassPermissions'));
    assert.ok(args.includes('--safe-mode'));
    assert.ok(args.includes('--strict-mcp-config'));
  }
  // The already-accepted primary workflow keeps exactly its existing launch permissions.
  assert.deepEqual(engines.get('claude').args({ model: 'opus', role: 'critic' }), [
    '-p', '--output-format', 'stream-json', '--verbose', '--safe-mode', '--strict-mcp-config',
    '--restricted', '--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep',
    '--disallowedTools', 'WebFetch,WebSearch,mcp__*', '--model', 'opus',
  ]);
});
