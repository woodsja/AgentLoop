// Separate fake GitHub process: its durable side effects survive an abrupt
// publisher exit, just as remote GitHub writes do. Never contacts GitHub.
const fs = require('node:fs');
const path = require('node:path');
const { batchCommand } = require('../../src/milestone-batches');
const [root, action, crash] = process.argv.slice(2);
const remote = path.join(root, 'fake-github.json');
const state = JSON.parse(fs.readFileSync(remote));
state.native ||= {};
const issueFor = number => state.issues.find(i => i.number === number)
  || { id: number + 1000, number, html_url: `https://github.com/owner/demo/issues/${number}`, state: 'closed' };
const persist = kind => {
  state.writes.push(kind);
  fs.writeFileSync(remote, JSON.stringify(state));
  if (crash === kind) process.exit(73);
};
const options = { stateDir: root, configPath: path.join(root, 'config.json'), projectsPath: path.join(root, 'projects.json'), inputPath: path.join(root, 'input.json') };
options.execFile = (file, args, opts, cb) => {
  const endpoint = args.find(a => a.startsWith('repos/'));
  const number = Number(/issues\/(\d+)/.exec(endpoint)?.[1]);
  let out;
  if (endpoint.includes('/dependencies/')) {
    if (args.includes('POST')) {
      const blocker = Number(args.find(a => a.startsWith('issue_id=')).slice(9)) - 1000;
      state.native[number] = [...(state.native[number] || []), blocker];
      out = issueFor(blocker); persist('blocker');
    } else out = [(state.native[number] || []).map(issueFor)];
  }
  else if (endpoint.endsWith('/labels')) {
    if (crash === 'receipt') process.exit(73); // receipt committed, no label yet
    const issue = state.issues.find(i => i.number === number);
    issue.labels = [{ name: 'custom-ready' }]; out = issue.labels; persist('label');
  } else if (args.includes('POST')) {
    const number = state.issues.length + 200;
    out = { id: number + 1000, number, html_url: `https://github.com/owner/demo/issues/${number}`, state: 'open', labels: [], title: args.find(a => a.startsWith('title=')).slice(6), body: args.find(a => a.startsWith('body=')).slice(5) };
    state.issues.push(out); persist('create');
  } else if (number) out = issueFor(number);
  else out = [state.issues];
  cb(null, JSON.stringify(out), '');
};
batchCommand(action, 'g1', options).then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
