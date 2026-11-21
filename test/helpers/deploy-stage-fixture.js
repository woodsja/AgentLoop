'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

// Reuse the real disposable repositories and canonical approval records from
// preflight. Only the private canonical remote transport is changed to file.
const stageFile = require.resolve('../../src/deploy-stage');
const stageRequire = createRequire(stageFile);
const stageModule = { exports: {} };
new Function('require', 'module', 'exports', '__filename', fs.readFileSync(stageFile, 'utf8') +
  '\nmodule.exports.runLocked = runLocked; module.exports.npmCli = npmCli;')(stageRequire, stageModule, stageModule.exports, stageFile);

function fixture(t, script = 'console.log("full candidate test stdout"); console.error("candidate stderr")', candidateAttributes) {
  const cleanups = [];
  const f = require('../deploy-preflight-fixture').fixture({ after: callback => cleanups.push(callback) }, 'candidate\n', {candidateAttributes, npmScript:script});
  t.after(() => {
    // Optional evidence capture copies every worker/Git/npm raw stream before
    // disposable fixture cleanup. Never copy the private repo or npm cache.
    if (process.env.RALPH_STAGE_TEST_AUDIT_DIR) {
      const destination = path.join(path.resolve(process.env.RALPH_STAGE_TEST_AUDIT_DIR), path.basename(f.root));
      const archive = (source, target) => {
        if (!fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink()) return;
        fs.mkdirSync(target, {recursive:true});
        for (const entry of fs.readdirSync(source, {withFileTypes:true})) {
          if (['repo','home'].includes(entry.name)) continue;
          const file = path.join(source,entry.name), output = path.join(target,entry.name);
          if (entry.isDirectory()) archive(file,output);
          else if (entry.isFile()) fs.copyFileSync(file,output);
        }
      };
      archive(path.join(f.project.stateDir || path.join(f.root, '.local/state/ralph-autopilot/ralph'), 'deployment-staging'), destination);
    }
    for (const cleanup of cleanups) cleanup();
  });
  const worker = path.join(f.root, 'stage-worker.js');
  // Load shipping staging code with the same private local-transport validator
  // used by preflight's tests. No Git, npm, approval or filesystem gate is faked.
  fs.writeFileSync(worker, `
    const fs = require('node:fs');
    const {createRequire} = require('node:module');
    const validate = require(${JSON.stringify(require.resolve('../deploy-preflight-fixture'))}).testValidator(${JSON.stringify(f.remote)});
    const stageFile = ${JSON.stringify(stageFile)};
    const realRequire = createRequire(stageFile);
    const loaded = {exports:{}};
    new Function('require','module','exports','__filename', fs.readFileSync(stageFile,'utf8') + '\\nmodule.exports.prepare = prepare;')(
      realRequire,loaded,loaded.exports,stageFile);
    const {issueNumber,options} = JSON.parse(process.argv[3]);
    loaded.exports.prepare(issueNumber,options,validate).then(result => fs.writeFileSync(1,JSON.stringify({checkpoint:result.checkpoint})))
      .catch(error => {fs.writeFileSync(2,error.stack);process.exitCode=1;});
  `);
  f.stageRoot = path.join(f.project.stateDir, 'deployment-staging');
  f.prepare = (options = {}) => stageModule.exports.runLocked(28, { configPath: f.configPath, ...options }, worker);
  f.checkpoint = () => path.join(f.stageRoot, `${f.oldSha}-${f.newSha}`, 'checkpoint.json');
  f.worker = worker;
  return f;
}
function snapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(file)) : [[file, fs.readFileSync(file).toString('base64')]];
  }));
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'fixture condition timed out'); await pause(30); }
}


module.exports = { fixture, stageFile, stageModule, snapshot, pause, until };
