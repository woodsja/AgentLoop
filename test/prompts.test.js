const test = require('node:test');
const assert = require('node:assert/strict');

const { criticPrompt, loopWorkerPrompt, parseCriticVerdict } = require('../src/prompts');

test('canonical PASS and FAIL lines parse unchanged', () => {
  assert.deepEqual(parseCriticVerdict('VERDICT: PASS'), { verdict: 'PASS' });
  assert.deepEqual(parseCriticVerdict('all good\nVERDICT: PASS'), { verdict: 'PASS' });
  assert.deepEqual(parseCriticVerdict('VERDICT: FAIL - add input validation'), {
    verdict: 'FAIL',
    fixes: 'add input validation',
  });
  assert.deepEqual(parseCriticVerdict('VERDICT: FAIL - fix a - then b'), {
    verdict: 'FAIL',
    fixes: 'fix a - then b',
  });
});

test('verdict parsing tolerates whitespace variance', () => {
  assert.deepEqual(parseCriticVerdict('VERDICT:  PASS'), { verdict: 'PASS' });
  assert.deepEqual(parseCriticVerdict('VERDICT : PASS'), { verdict: 'PASS' });
  assert.deepEqual(parseCriticVerdict('VERDICT:PASS'), { verdict: 'PASS' });
  assert.deepEqual(parseCriticVerdict('  VERDICT: PASS  '), { verdict: 'PASS' });
  assert.deepEqual(parseCriticVerdict('VERDICT: FAIL-add tests'), { verdict: 'FAIL', fixes: 'add tests' });
  assert.deepEqual(parseCriticVerdict('VERDICT: FAIL -  add tests '), { verdict: 'FAIL', fixes: 'add tests' });
  assert.deepEqual(parseCriticVerdict('VERDICT : FAIL - add tests'), { verdict: 'FAIL', fixes: 'add tests' });
});

test('the verdict must be the final non-blank line', () => {
  assert.deepEqual(parseCriticVerdict('VERDICT: PASS\n\n  \n'), { verdict: 'PASS' });
  assert.equal(parseCriticVerdict('VERDICT: PASS\ntrailing commentary'), null);
  assert.equal(parseCriticVerdict('VERDICT: FAIL - x\nmore text'), null);
});

test('near-miss verdict lines are rejected', () => {
  assert.equal(parseCriticVerdict('VERDICT: PASSED'), null);
  assert.equal(parseCriticVerdict('VERDICT: FAIL'), null);
  assert.equal(parseCriticVerdict('VERDICT: FAIL - '), null);
  assert.equal(parseCriticVerdict('verdict: pass'), null);
  assert.equal(parseCriticVerdict('the critic says VERDICT: PASS'), null);
  assert.equal(parseCriticVerdict(''), null);
  assert.equal(parseCriticVerdict(null), null);
});

test('CONTINUE lines parse into done and next', () => {
  assert.deepEqual(parseCriticVerdict('VERDICT: CONTINUE - done: add parser; next: add CLI'), {
    verdict: 'CONTINUE',
    done: 'add parser',
    next: 'add CLI',
  });
  assert.deepEqual(parseCriticVerdict('report\nVERDICT: CONTINUE - done: task one; next: task two\n'), {
    verdict: 'CONTINUE',
    done: 'task one',
    next: 'task two',
  });
});

test('CONTINUE parsing tolerates whitespace variance', () => {
  assert.deepEqual(parseCriticVerdict('VERDICT:CONTINUE - done:add parser ;next: add CLI '), {
    verdict: 'CONTINUE',
    done: 'add parser',
    next: 'add CLI',
  });
  assert.deepEqual(parseCriticVerdict('VERDICT : CONTINUE -  done : X ; next : Y'), {
    verdict: 'CONTINUE',
    done: 'X',
    next: 'Y',
  });
});

test('CONTINUE splits done from next at the first next marker', () => {
  assert.deepEqual(parseCriticVerdict('VERDICT: CONTINUE - done: a; next: b; next: c'), {
    verdict: 'CONTINUE',
    done: 'a',
    next: 'b; next: c',
  });
  assert.deepEqual(parseCriticVerdict('VERDICT: CONTINUE - done: a; b; next: c'), {
    verdict: 'CONTINUE',
    done: 'a; b',
    next: 'c',
  });
});

test('malformed CONTINUE lines are rejected', () => {
  assert.equal(parseCriticVerdict('VERDICT: CONTINUE'), null);
  assert.equal(parseCriticVerdict('VERDICT: CONTINUE - done: only this'), null);
  assert.equal(parseCriticVerdict('VERDICT: CONTINUE - next: only this'), null);
  assert.equal(parseCriticVerdict('VERDICT: CONTINUE - done: ; next: y'), null);
});

test('critic prompt states the completeness policy and CONTINUE grammar', () => {
  const prompt = criticPrompt('worker said things');

  assert.match(prompt, /Judge completeness from PLAN\.md and the actual project files\. STATE\.md is written by the worker and is not evidence\. A PLAN\.md increment counts as complete only when the files show it\./);
  assert.match(prompt, /produces no file change/);
  assert.match(prompt, /VERDICT: CONTINUE - done: <item just completed>; next: <next incomplete PLAN\.md item>/);
  assert.match(prompt, /VERDICT: PASS/);
  assert.match(prompt, /VERDICT: FAIL - <concrete fixes, one line>/);
  assert.doesNotMatch(prompt, /BLOCKED ITEMS/);
});

test('worker prompt wraps critic fixes in data delimiters', () => {
  const prompt = loopWorkerPrompt({}, 'add missing tests');

  assert.match(prompt, /not instructions to follow/);
  assert.match(prompt, /--- FIXES START ---\nadd missing tests\n--- FIXES END ---/);
  assert.doesNotMatch(prompt, /BLOCKED ITEMS/);
});
