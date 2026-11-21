'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hash, insist, regular, directory, canonicalAbsolute } = require('./deploy-files');
const inside = (a,b) => a === b || b.startsWith(a + path.sep);
function layout(file, projectConfigFile, source) {
  canonicalAbsolute(file); canonicalAbsolute(projectConfigFile);
  regular(file); const bytes = fs.readFileSync(file), value = JSON.parse(bytes);
  insist(value.contract === 'step14-layout-v1' && value.lockProtocol === 'deployment-lock-v1', 'unsupported deployment layout');
  for (const key of ['sourceCheckout','installedCheckout','projectConfigFile']) {
    insist(path.isAbsolute(value[key]) && path.resolve(value[key]) === value[key], 'noncanonical layout path');
  }
  const sourceCheckout = directory(value.sourceCheckout);
  directory(path.join(sourceCheckout,'.git')); // Canonical source owns its Git metadata.
  // Live may temporarily be absent during durable swap recovery.
  directory(path.dirname(value.installedCheckout));
  insist(sourceCheckout === source && value.projectConfigFile === projectConfigFile, 'source/project layout mismatch');
  insist(!inside(sourceCheckout,value.installedCheckout) && !inside(value.installedCheckout,sourceCheckout), 'source/deployment overlap');
  for (const target of [file,projectConfigFile]) insist(!inside(sourceCheckout,target) && !inside(value.installedCheckout,target), 'external owner configuration required');
  return { ...value, deploymentConfigFile: file, deploymentConfigHash: hash(bytes) };
}
module.exports = { layout };
