// Hold the detached group leader until the command closes. The parent persists
// its Linux process identity before sending start, so recovery owns descendants.
const { spawn } = require('node:child_process');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  if (input !== 'start\n') process.exit(1);
  const child = spawn(process.argv[2], process.argv.slice(3), { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  // Inheriting Node's nonblocking stdout/stderr socket can make native tools
  // abort on EAGAIN during bursts (observed with uv's install summary). Give
  // the command blocking child endpoints and forward with backpressure.
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on('error', error => { console.error(error.stack); process.exitCode = 1; });
  child.on('close', (code, signal) => {
    if (signal) {
      // close means child streams ended, but forwarded writes may still be
      // queued. Flush them before mirroring a signal, which exits immediately.
      let pending = 2;
      const flushed = () => { if (--pending === 0) process.kill(process.pid, signal); };
      process.stdout.write('', flushed);
      process.stderr.write('', flushed);
    } else process.exitCode = code ?? 1;
  });
});
