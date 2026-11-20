'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Reuse the real disposable repositories and canonical approval records from
// preflight. Only the private canonical remote transport is changed to file.
const preflightFixture = require('./deploy-preflight-fixture').fixture;
const stageFile = require.resolve('../src/deploy-stage');
const stageModule = { exports: require('../src/deploy-stage').testing };

function fixture(t, script = 'console.log("full candidate test stdout"); console.error("candidate stderr")', candidateAttributes, extra = {}) {
  const cleanups = [];
  const f = preflightFixture({after: cleanup => cleanups.push(cleanup)}, 'candidate\n', { ...extra, candidateAttributes, npmScript: script });
  t.after(() => {
    const destination = process.env.RALPH_DEPLOY_TEST_AUDIT_DIR;
    if (destination) {
      const archive = (source, target) => {
        if (!fs.existsSync(source)) return;
        fs.mkdirSync(target,{recursive:true});
        for (const entry of fs.readdirSync(source,{withFileTypes:true})) {
          if (['repo','home'].includes(entry.name)) continue;
          if (entry.isDirectory()) archive(path.join(source,entry.name),path.join(target,entry.name));
          else if (entry.isFile()) fs.copyFileSync(path.join(source,entry.name),path.join(target,entry.name));
        }
      };
      archive(path.join(f.project.stateDir || path.join(f.root,'.local/state/ralph-autopilot/ralph'),'deployment-staging'),path.join(destination,path.basename(f.root)));
    }
    for (const cleanup of cleanups) cleanup();
  });
  const worker = path.join(f.root, 'stage-worker.js');
  f.preflightObserver = path.join(f.root, 'preflight-observer.cjs');
  fs.writeFileSync(f.preflightObserver, 'module.exports = {};\n');
  // Load shipping staging code with the same private local-transport validator
  // used by preflight's tests. No Git, npm, approval or filesystem gate is faked.
  fs.writeFileSync(worker, `
    const fs = require('node:fs');
    const observers = require(${JSON.stringify(f.preflightObserver)});
    const validate = require(${JSON.stringify(require.resolve('./deploy-preflight-fixture'))}).testValidator(
      ${JSON.stringify(f.remote)}, observers.onObservation, observers.onCommand, observers.onResult);
    const loaded = {exports:require(${JSON.stringify(stageFile)}).testing};
    const {issueNumber,options} = JSON.parse(process.argv[3]);
    loaded.exports.prepare(issueNumber,options,validate).then(result => fs.writeFileSync(1,JSON.stringify({checkpoint:result.checkpoint})))
      .catch(error => {fs.writeFileSync(2,JSON.stringify(require(${JSON.stringify(stageFile)}).testing.errorRecord(error)));process.exitCode=1;});
  `);
  f.stageRoot = path.join(f.project.stateDir, 'deployment-staging');
  f.prepare = (options = {}) => stageModule.exports.runLocked(28, { configPath: f.configPath, ...options }, worker);
  f.checkpoint = () => path.join(f.stageRoot, `${f.oldSha}-${f.newSha}`, 'checkpoint.json');
  f.worker = worker;
  return f;
}

module.exports = { fixture };
