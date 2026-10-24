const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const publicHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const replayHtml = fs.readFileSync(path.join(root, 'replay', 'index.html'), 'utf8');
const replaySource = fs.readFileSync(path.join(root, 'replay', 'replay.js'), 'utf8');

function style(html) {
  return html.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\r\n/g, '\n');
}

function scripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(source => source.trim());
}

function ids(html) {
  return [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
}

function markup(html) {
  return html.slice(html.indexOf('<body>'), html.lastIndexOf('<script>'))
    .replace('<script src="replay.js"></script>', '')
    .replace(/\r\n/g, '\n')
    .trim();
}

test('Dashboard sources compile and stay aligned', () => {
  assert.ok(replayHtml.indexOf('<script src="replay.js"></script>') >= 0);
  assert.ok(replayHtml.indexOf('<script src="replay.js"></script>') < replayHtml.indexOf('<script>'));
  assert.equal(style(publicHtml), style(replayHtml));
  assert.equal(markup(publicHtml), markup(replayHtml));
  assert.match(publicHtml, /<aside id="rail"/);
  assert.match(publicHtml, /class="duo duo-main"/);
  assert.match(publicHtml, /<form id="taskForm"/);
  assert.match(publicHtml, /<select id="lProject" required disabled>/);
  assert.match(publicHtml, /<select id="tProject" required disabled>/);
  assert.match(publicHtml, /<select id="lWorkerEngine">/);
  assert.match(publicHtml, /<select id="lCriticEngine">/);
  assert.ok(publicHtml.includes("body.workerEngine = $('#lWorkerEngine').value"));
  assert.ok(publicHtml.includes("body.criticEngine = $('#lCriticEngine').value"));
  assert.match(publicHtml, /fetch\('\/api\/projects', \{cache: 'no-store'\}\)/);
  assert.match(publicHtml, /body\.project = project/);
  assert.doesNotMatch(publicHtml, /body\.cwd = project/);
  assert.match(publicHtml, /<link rel="icon" type="image\/png"/);
  assert.match(publicHtml, /<span class="bw">/);

  const publicScripts = scripts(publicHtml);
  const replayScripts = scripts(replayHtml);
  assert.equal(publicScripts.length, replayScripts.length);
  publicScripts.forEach((source, index) => {
    const replaySource = replayScripts[index].replace(' * (window.__replayRate ?? 1)', '');
    assert.equal(source.replace(/\r\n/g, '\n'), replaySource.replace(/\r\n/g, '\n'));
  });

  for (const [name, html] of [['public', publicHtml], ['replay', replayHtml]]) {
    const pageIds = ids(html);
    assert.equal(new Set(pageIds).size, pageIds.length, name + ' has duplicate ids');
    scripts(html).forEach((source, index) => new vm.Script(source, {filename: name + '-inline-' + index}));
  }

  new vm.Script(replaySource, {filename: 'replay.js'});
});


test('raw execution records render complete inert text with paths and token values', () => {
  const source = scripts(publicHtml).join('\n');
  const start = source.indexOf('function executionRecordHtml(');
  assert.ok(start >= 0, 'owner raw renderer exists');
  const end = source.indexOf('function mountExecutionLog(', start);
  const context = { TextDecoder, Uint8Array, atob, esc: value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const raw = 'token=owner-secret /tmp/private/file\n<script>alert(1)</script>\x1b[31m' + 'x'.repeat(20000);
  const html = context.executionRecordHtml(JSON.stringify({event:'output',role:'critic',childId:'t-child',base64:Buffer.from(raw).toString('base64')}));
  assert.ok(html.includes('token=owner-secret /tmp/private/file'));
  assert.ok(html.includes('x'.repeat(20000)));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('t-child'));
});

test('decision status drawer renders owner records as inert text without changing authority', async () => {
  const source = scripts(publicHtml).join('\n');
  const start = source.indexOf('async function mountDecisionStatus('), end = source.indexOf('function mountExecutionLog(', start);
  let section, route;
  const context = {
    drawerTaskId: 't-1234abcd',
    document: { createElement() { section = {}; return section; } },
    fetch: async value => { route = value; return { ok: true, json: async () => ({
      nextAction: { reason: 'Await ADR guarded merge' }, evidence: { decisions: [{
        decisionIssue: { number: 15 }, originatingIssue: { number: 10 }, state: 'paused', action: 'deliver_adr_then_request_resume',
        blockedReason: '<script>spoofed approval</script>', scopeCheck: { status: 'not_checked' },
      }] },
    }) }; },
    esc: value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  let mounted;
  await context.mountDecisionStatus({ prepend: value => { mounted = value; } }, context.drawerTaskId);
  assert.equal(route, '/api/r1/jobs/t-1234abcd');
  assert.equal(mounted, section);
  assert.match(section.innerHTML, /Decision #15/); assert.match(section.innerHTML, /implementation #10/);
  assert.match(section.innerHTML, /not_checked/); assert.match(section.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(section.innerHTML, /<script>/);
});
