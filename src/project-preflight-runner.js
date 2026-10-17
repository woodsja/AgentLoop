// Hold the detached group leader until the command closes. The parent persists
// its Linux process identity before sending start, so recovery owns descendants.
const { spawn } = require('node:child_process');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  if (input !== 'start\n') process.exit(1);
  const child = spawn(process.argv[2], process.argv.slice(3), { stdio: ['ignore', 'inherit', 'inherit'], shell: false });
  child.on('error', error => { console.error(error.stack); process.exitCode = 1; });
  child.on('close', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
});
