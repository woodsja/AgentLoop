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
  assert.equal(style(publicHtml), style(replayHtml));
  assert.equal(markup(publicHtml), markup(replayHtml));
  assert.match(publicHtml, /<aside id="rail"/);
  assert.match(publicHtml, /class="duo duo-main"/);
  assert.match(publicHtml, /<form id="taskForm"/);
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

test('role pickers retain independent choices when availability is refreshed', () => {
  const selectors = {
    '#lWorkerEngine': { value: '' }, '#lCriticEngine': { value: '' }, '#tEngine': { value: '' },
  };
  const context = vm.createContext({ $: id => selectors[id], esc: value => value });
  const source = scripts(publicHtml).join('\n');
  const pickers = source.slice(source.indexOf('const ENGINES ='), source.indexOf('/* ----- mcp connector ----- */'));
  vm.runInContext(pickers, context);
  const available = [{ id: 'codex', installed: true }, { id: 'claude', installed: true }];
  context.engines = { selected: 'claude', available };
  vm.runInContext('renderEngines(engines)', context);
  assert.equal(selectors['#lWorkerEngine'].value, 'claude');
  assert.equal(selectors['#lCriticEngine'].value, 'claude');
  selectors['#lWorkerEngine'].value = 'codex';
  context.engines = { selected: 'codex', available };
  vm.runInContext('renderEngines(engines)', context);
  assert.equal(selectors['#lWorkerEngine'].value, 'codex');
  assert.equal(selectors['#lCriticEngine'].value, 'claude');
  context.engines = { selected: 'codex', available: [{ id: 'codex', installed: true }, { id: 'claude', installed: false }] };
  vm.runInContext('renderEngines(engines)', context);
  assert.match(selectors['#lCriticEngine'].innerHTML, /value="claude" disabled/);
  assert.match(source, /body\.workerEngine = \$\('#lWorkerEngine'\)\.value/);
  assert.match(source, /body\.criticEngine = \$\('#lCriticEngine'\)\.value/);
});

test('Start loop stays disabled until both role engines are selectable', () => {
  for (const html of [publicHtml, replayHtml]) {
    const submit = { disabled: false };
    const selectors = {
      '#lWorkerEngine': { value: '' }, '#lCriticEngine': { value: '' }, '#tEngine': { value: '' },
      '#loopForm button[type="submit"]': submit,
    };
    const context = vm.createContext({ $: id => selectors[id], esc: value => value });
    const source = scripts(html).join('\n');
    vm.runInContext(source.slice(source.indexOf('const ENGINES ='), source.indexOf('/* ----- mcp connector ----- */')), context);
    context.engines = { selected: 'codex', available: [{ id: 'codex', installed: false }, { id: 'claude', installed: false }] };
    vm.runInContext('renderEngines(engines)', context);
    assert.equal(selectors['#lWorkerEngine'].value, '');
    assert.equal(submit.disabled, true);
    context.engines = { selected: 'codex', available: [{ id: 'codex', installed: true }, { id: 'claude', installed: false }] };
    vm.runInContext('renderEngines(engines)', context);
    assert.equal(submit.disabled, false);
    selectors['#lCriticEngine'].value = '';
    vm.runInContext('syncLoopStart()', context);
    assert.equal(submit.disabled, true);
    selectors['#lCriticEngine'].value = 'codex';
    vm.runInContext('loopSubmitting = true; syncLoopStart()', context);
    assert.equal(submit.disabled, true, 'an in-flight submit keeps the button disabled');
    vm.runInContext('loopSubmitting = false; syncLoopStart()', context);
    assert.equal(submit.disabled, false);
    assert.match(source, /submit\.disabled \|\| !loopEnginesChosen\(\)/);
    assert.match(source, /\['#lWorkerEngine', '#lCriticEngine'\]\) \$\(id\)\.addEventListener\('change', syncLoopStart\)/);
  }
});
