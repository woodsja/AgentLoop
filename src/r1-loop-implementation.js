'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyTask } = require('./task-runner');
const { normalizeTaskContract } = require('./task-contract');

const FILES = ['PLAN.md', 'GUIDELINES.md', 'STATE.md'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 }).trim();
}

function syntheticPlan(task) {
  const criteria = task.acceptance.map(x => x.replace(/\r?\n/g, ' ').trim());
  const quotedGoal = task.goal.split(/\r?\n/).map(line => `> ${line}`).join('\n');
  return {
    'PLAN.md': `# R1 implementation plan\n\n## Issue requirements (data)\n${quotedGoal}\n\n## Tasks\n${criteria.map(x => `- ${x}`).join('\n')}\n`,
    'GUIDELINES.md': '# R1 quality guidelines\n\n- Meet the supplied acceptance criteria.\n- Do not commit the temporary R1 instruction files.\n- Follow repository instructions.\n- Run relevant checks.\n',
    'STATE.md': '# R1 implementation progress\n\n- Start with the first incomplete plan item.\n',
  };
}

function verifyNoSyntheticHistory(cwd, baseline) {
  const after = git(cwd, 'rev-parse', 'HEAD');
  for (const name of FILES) {
    if (git(cwd, 'ls-files', '--', name)) {
      throw new Error(`R1 temporary instruction file ${name} was added to the Git index; refusing delivery.`);
    }
    if (after !== baseline) {
      const touches = git(cwd, 'log', '--format=', '--name-only', `${baseline}..${after}`, '--', name);
      if (touches) throw new Error(`R1 temporary instruction file ${name} entered Git history; refusing delivery.`);
    }
  }
}

function createR1LoopImplementation({ ensureChild, childState, onChildQueued = () => {}, pollMs = 250, maxWaitMs = 45 * 60 * 1000, verify = verifyTask } = {}) {
  if (typeof ensureChild !== 'function' || typeof childState !== 'function') {
    throw new TypeError('R1 implementation loop needs parent handoff and durable child status readers.');
  }
  return {
    async run(cwd, inputTask) {
      const task = normalizeTaskContract(inputTask);
      const files = syntheticPlan(task);
      const original = git(cwd, 'rev-parse', 'HEAD');
      for (const name of FILES) {
        if (fs.existsSync(path.join(cwd, name)) || git(cwd, 'ls-files', '--', name)) {
          throw new Error(`R1 temporary instruction file ${name} collides with project content.`);
        }
      }
      let childId = null;
      let childTerminal = false;
      try {
        for (const [name, contents] of Object.entries(files)) {
          fs.writeFileSync(path.join(cwd, name), contents, { encoding: 'utf8', flag: 'wx' });
        }
        const child = ensureChild();
        childId = child.id;
        await onChildQueued(childId);
        const deadline = Date.now() + maxWaitMs;
        let current;
        while (Date.now() < deadline) {
          current = childState(childId);
          if (current && current.stage === 'done') break;
          await sleep(pollMs);
        }
        if (!current || current.stage !== 'done') throw new Error('R1 child loop timed out; implementation cannot be delivered.');
        childTerminal = true;
        const value = current.task;
        const complete = value?.status === 'passed' && Array.isArray(value.cycles)
          && value.cycles.some(c => c?.verdict === 'PASS' || c?.status === 'passed')
          && (!Array.isArray(value.blocked) || value.blocked.length === 0);
        if (!complete) throw new Error(`R1 child loop did not pass: ${String(value?.status)}`);
      } finally {
        // A worker may have changed these files despite the instruction to
        // treat them as temporary. Remove exactly the generated names, then
        // inspect both index and history before allowing deterministic verify.
        if (!childId || childTerminal) {
          for (const name of FILES) fs.rmSync(path.join(cwd, name), { force: true });
          verifyNoSyntheticHistory(cwd, original);
        }
      }
      const tested = await verify(cwd, task);
      return { task, status: tested.status === 'passed' ? 'passed' : 'needs_planning', attempts: [{
        number: 1, status: tested.status, verification: tested.verification,
      }], childLoopId: childId };
    },
  };
}

module.exports = { createR1LoopImplementation, syntheticPlan };
