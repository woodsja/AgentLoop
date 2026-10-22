'use strict';
// Local Git transport for daemon fixtures that mock only GitHub/model APIs.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
module.exports = function prepareRemote(project, root) {
  if (!git(project.checkout, 'remote').split('\n').includes('origin')) {
    const origin = path.join(root, 'origin.git');
    git(root, 'init', '--bare', '--initial-branch=main', origin);
    git(project.checkout, 'remote', 'add', 'origin', origin);
    git(project.checkout, 'push', 'origin', project.baseBranch);
  }
  return async (_project, number) => {
    const branch = git(project.checkout, 'for-each-ref', '--format=%(refname:short)', `refs/heads/ralph/issue-${number}-*`);
    return { number, state: 'OPEN', isCrossRepository: false, headRefName: branch,
      headRefOid: git(project.checkout, 'rev-parse', `refs/heads/${branch}`), baseRefName: project.baseBranch };
  };
};
