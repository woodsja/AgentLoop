// Wait for the durable parent process claim before starting any installer.
// EOF on daemon death before authorization leaves the environment untouched.
const { spawn } = require('node:child_process');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  if (input !== 'start\n') process.exit(1);
  // pip can print many lines for a valid owner-approved dependency closure.
  // Never pipe that unbounded output into the parent execFile maxBuffer.
  // Retain only a small bounded stderr diagnostic for transport classification.
  const child = spawn(process.argv[2], process.argv.slice(3), { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
  let diagnostics = '';
  child.stderr.on('data', chunk => {
    diagnostics = (diagnostics + chunk.toString('utf8')).slice(-4096);
  });
  child.stderr.on('end', () => {
    if (diagnostics) process.stderr.write(diagnostics);
  });
  child.on('error', error => { process.stderr.write(error.code === 'ENOENT' ? 'interpreter_missing' : 'process_failed'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
});
