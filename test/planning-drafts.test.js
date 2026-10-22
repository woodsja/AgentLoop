'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { previewDraft, publishDraft } = require('../src/planning-drafts');
const { dependencies } = require('../src/r1-dependencies');
const draft = {
  id: 'mga-104-example', kind: 'ticket', repo: 'woodsja/AgentLoop',
  title: 'Create non-executable planning drafts', sourceSpec: '#103',
  conversation: 'Planning conversation MGA, owner message 2026-10-21',
  summary: 'Publish planning artifacts for owner review.',
  acceptanceCriteria: ['A fake GitHub operation creates an issue with zero labels.'], blockers: [90], labels: [],
};
function fake(handler) {
  const calls = [];
  return { calls, execFile(file, args, options, callback) {
    calls.push(args);
    assert.equal(file, 'gh');
    assert.equal(options.shell, false);
    assert.equal(options.env.GH_PROMPT_DISABLED, '1');
    try { callback(null, JSON.stringify(handler(args)), ''); }
    catch (error) { callback(error, '', error.message); }
  } };
}
function issue(preview, overrides = {}) {
  return { number: 200, title: preview.title, body: preview.body, labels: [], state: 'open',
    html_url: 'https://github.com/woodsja/AgentLoop/issues/200', ...overrides };
}
test('complete preview and publication reuse GitHub operations without labels or registration changes', async () => {
  const paths = ['autopilot-projects.json', 'config.json'];
  const before = paths.map(p => fs.readFileSync(p, 'utf8'));
  const input = structuredClone(draft);
  const preview = previewDraft(input);
  assert.match(preview.title, /^\[DRAFT\]/);
  for (const text of ['Source spec: #103', draft.conversation, draft.summary, '- [ ]', 'Depends on: #90', 'UNAUTHORIZED', 'Labels: none']) {
    assert.ok(preview.markdown.includes(text), text);
  }
  assert.deepEqual(dependencies({ number: 200, body: preview.body }), [90]);
  const gh = fake(args => args.includes('POST') ? issue(preview) : [[]]);
  assert.equal((await publishDraft(input, gh)).number, 200);
  assert.equal(gh.calls.length, 2);
  assert.deepEqual(gh.calls[0], ['api', '--paginate', '--slurp', 'repos/woodsja/AgentLoop/issues?state=all&per_page=100']);
  assert.deepEqual(gh.calls[1], ['api', '--method', 'POST', 'repos/woodsja/AgentLoop/issues', '-f', `title=${preview.title}`, '-f', `body=${preview.body}`]);
  assert.deepEqual(paths.map(p => fs.readFileSync(p, 'utf8')), before);
  assert.deepEqual(input, draft);
  assert.deepEqual(dependencies({ number: 200, body: previewDraft({ ...draft, kind: 'spec', blockers: [] }).body }), []);
});
test('missing or malformed metadata and accidental labels fail before GitHub access', async () => {
  const gh = fake(() => assert.fail('must not call GitHub'));
  for (const field of ['id', 'kind', 'repo', 'title', 'sourceSpec', 'conversation', 'summary', 'acceptanceCriteria', 'blockers']) {
    const input = { ...draft }; delete input[field];
    await assert.rejects(publishDraft(input, gh));
  }
  for (const patch of [
    { labels: ['ready-for-agent'] }, { labels: ['custom-executable'] }, { labels: 'ready' },
    { readyLabel: 'custom' }, { kind: 'task' }, { title: 'bad\nTitle' }, { repo: '../repo' },
    { sourceSpec: 'someday' }, { acceptanceCriteria: [] }, { acceptanceCriteria: [''] },
    { blockers: ['#90'] }, { blockers: [90, 90] }, { blockers: [0] },
    { summary: 'Depends on: #1' }, { summary: '<!-- agentloop-planning-draft:other -->' },
  ]) await assert.rejects(publishDraft({ ...draft, ...patch }, gh));
  assert.equal(gh.calls.length, 0);
});
test('retries recover identical drafts with read-only operations and reject ready labels or drift', async () => {
  const preview = previewDraft(draft);
  const gh = fake(() => [[issue(preview)]]);
  await publishDraft(draft, { ...gh, retry: true });
  await publishDraft(draft, { ...gh, retry: true });
  assert.ok(gh.calls.every(args => !args.includes('POST')));
  for (const overrides of [{ labels: [{ name: 'ready-for-agent' }] }, { labels: [{ name: 'custom-ready' }] },
    { title: 'changed' }, { state: 'closed' }, { number: 80 }, { labels: null },
    { html_url: 'https://github.com/other/repo/issues/200' }]) {
    await assert.rejects(publishDraft(draft, { ...fake(() => [[issue(preview, overrides)]]), retry: true }));
  }
  await assert.rejects(publishDraft(draft, fake(() => [[issue(preview), issue(preview)]])), /multiple/i);
});
test('failure and ambiguous creation never automatically repeat POST; retry remains read-only', async () => {
  const preview = previewDraft(draft);
  const failed = fake(args => { if (args.includes('POST')) throw new Error('connection lost'); return [[]]; });
  await assert.rejects(publishDraft(draft, failed), /connection lost/);
  assert.equal(failed.calls.filter(args => args.includes('POST')).length, 1);
  const retry = fake(() => [[]]);
  await assert.rejects(publishDraft(draft, { ...retry, retry: true }), /not found/i);
  assert.equal(retry.calls.length, 1);
  await assert.rejects(publishDraft(draft, fake(() => { throw new Error('list failed'); })), /list failed/);
  await assert.rejects(publishDraft(draft, fake(() => ({}))), /response/i);
  for (const response of [{}, issue(preview, { labels: [{ name: 'ready-for-agent' }] })]) {
    const gh = fake(args => args.includes('POST') ? response : [[]]);
    await assert.rejects(publishDraft(draft, gh));
    assert.equal(gh.calls.length, 2);
  }
});
test('unrelated empty issue bodies and pull requests do not prevent a spec draft', async () => {
  const spec = { ...draft, kind: 'spec', blockers: [] };
  const preview = previewDraft(spec);
  const gh = fake(args => args.includes('POST') ? issue(preview) : [[
    { number: 1, body: null }, { number: 2, body: 'unrelated', pull_request: {} },
  ]]);
  assert.equal((await publishDraft(spec, gh)).number, 200);
});
