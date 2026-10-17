// Only owner configuration supplies dependency identities and sources. No shell,
// repository bootstrap scripts, ambient pip configuration, or user-site packages.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('./execution-log');
const { pathToFileURL } = require('node:url');
const { startTime, terminatePriorR1Worker } = require('./r1-process-claim');

const reasons = {
  policy: 'Owner must configure a valid pinned Python setup policy.',
  unsafe_path: 'Owner must restore canonical local environment and dependency paths.',
  interpreter_missing: 'Owner must provide the configured Python interpreter with venv support.',
  dependency_incompatible: 'Owner must supply the complete compatible pinned dependency set and installed commands.',
  offline_bundle_invalid: 'Owner must restore the approved wheelhouse with exactly the pinned wheel files and SHA-256 digests.',
  package_index_transport: 'Configured package index is unreachable; owner may restore connectivity or approve an offline wheelhouse.',
  timeout: 'Python preparation exceeded the owner time limit.',
  output_limit: 'Python setup emitted too much diagnostic output; the owner should inspect the installer output policy.',
  prior_process_unresolved: 'Prior Python setup process ownership is unresolved; owner intervention is required before cleanup or retry.',
  cancelled: 'Python preparation was cancelled before worker admission.',
};
function blocked(reason) {
  const outcome = { status: 'blocked', category: 'infrastructure', reason, message: reasons[reason], at: new Date().toISOString() };
  return Object.assign(new Error(outcome.message), { code: 'PYTHON_PREFLIGHT_BLOCKED', outcome });
}
function validatePythonPolicy(p) {
  if (!p || typeof p !== 'object' || !path.isAbsolute(p.interpreter || '')
    || !Number.isInteger(p.timeoutMs) || p.timeoutMs < 100 || p.timeoutMs > 600000
    || !Array.isArray(p.dependencies) || p.dependencies.length < 2 || p.dependencies.length > 200
    || !Array.isArray(p.commands) || p.commands.length > 40
    || p.commands.some(x => typeof x !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(x))
    || p.dependencies.some(d => !d || !/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(d.name || '')
      || !/^[a-zA-Z0-9][a-zA-Z0-9.!+_-]*$/.test(d.version || '') || !/^[a-f0-9]{64}$/.test(d.sha256 || '')
      || !/^[a-zA-Z0-9][a-zA-Z0-9_.+-]*\.whl$/.test(d.wheel || ''))
    || new Set(p.dependencies.map(d => d.name.replace(/[-_.]+/g, '-'))).size !== p.dependencies.length
    || new Set(p.dependencies.map(d => d.wheel)).size !== p.dependencies.length
    || !['pytest', 'ruff'].every(n => p.dependencies.some(d => d.name === n))
    || (p.wheelhouse ? !path.isAbsolute(p.wheelhouse) || p.indexUrl !== undefined : !p.indexUrl)) throw blocked('policy');
  if (!p.wheelhouse) {
    try { const url = new URL(p.indexUrl); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw 0; }
    catch { throw blocked('policy'); }
  }
  return p;
}
function canonical(location) {
  if (fs.realpathSync(location) !== path.resolve(location)) throw blocked('unsafe_path');
}
function localEnvironment(root, interpreter) {
  canonical(root);
  const venv = path.join(root, '.venv');
  if (fs.existsSync(venv) || fs.lstatSync(root).isSymbolicLink()) {
    canonical(venv);
    if (!fs.statSync(venv).isDirectory()) throw blocked('unsafe_path');
    const pending = [venv];
    let examined = 0;
    while (pending.length) {
      const parent = pending.pop();
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (++examined > 100000) throw blocked('unsafe_path');
        const candidate = path.join(parent, entry.name);
        if (entry.isSymbolicLink()) {
          const target = fs.realpathSync(candidate);
          if (!target.startsWith(venv + path.sep) && !(path.dirname(candidate) === path.join(venv, 'bin')
            && /^python(?:[0-9.]*)$/.test(entry.name) && target === fs.realpathSync(interpreter))) throw blocked('unsafe_path');
        } else if (entry.isDirectory()) pending.push(candidate);
      }
    }
    for (const child of ['bin', 'pyvenv.cfg']) {
      if (fs.existsSync(path.join(venv, child))) canonical(path.join(venv, child));
    }
  } else {
    // existsSync follows symlinks, including dangling ones.
    try { if (fs.lstatSync(venv).isSymbolicLink()) throw blocked('unsafe_path'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return venv;
}
const probe = String.raw`
import sys, os, json, importlib.metadata as m
root, expected, commands = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])
assert os.path.realpath(sys.prefix) == root and sys.prefix != sys.base_prefix
assert not any(('site-packages' in p or 'dist-packages' in p) and not os.path.realpath(p).startswith(root + os.sep) for p in sys.path)
normalize = lambda n: n.lower().replace('_','-').replace('.','-')
installed = {normalize(d.metadata['Name']): d.version for d in m.distributions()}
assert all(normalize(n) in installed and (v is None or installed[normalize(n)] == v) for n,v in expected.items())
assert any(v is None for v in expected.values()) or set(installed) <= {normalize(n) for n in expected} | {'pip','setuptools','wheel'}
for name in commands + ['pytest', 'ruff']:
    executable = os.path.join(root, 'bin', name)
    assert os.access(executable, os.X_OK)
    assert os.path.realpath(executable).startswith(root + os.sep)
    with open(executable, 'rb') as f:
        first = f.read(4)
        if first != b'\x7fELF':
            f.seek(0)
            first = f.readline(512).strip()
    assert first.startswith(b'\x7fELF') or first in [('#!' + os.path.join(root,'bin', p)).encode() for p in ['python','python3']]
`;
async function preparePythonInternal(root, policy, options = {}) {
  const p = options.checkOnly ? policy : validatePythonPolicy(policy);
  const execute = options.execFile || execFile;
  const deadline = Date.now() + p.timeoutMs;
  const cancelled = () => { try { return options.isCancelled?.() === true; } catch { return true; } };
  const check = () => { if (cancelled()) throw blocked('cancelled'); if (Date.now() >= deadline) throw blocked('timeout'); };
  const command = (file, args, reason, indexInstall = false) => new Promise((resolve, reject) => {
    try { check(); } catch (e) { reject(e); return; }
    let timer;
    let completed = false;
    let child;
    let claim;
    const terminate = () => {
      try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); else child?.kill('SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') child?.kill('SIGKILL'); }
    };
    // An allowlist prevents PIP_*, PYTHONPATH, proxies, credentials, and household
    // data configuration from influencing package selection or reaching logs.
    const env = { TMPDIR: root, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONNOUSERSITE: '1', PIP_CONFIG_FILE: '/dev/null', PIP_NO_INPUT: '1' };
    const guarded = execute === execFile;
    child = execute(guarded ? process.execPath : file, guarded ? [path.join(__dirname, 'python-preflight-runner.js'), file, ...args] : args, { cwd: root, env, shell: false, encoding: 'utf8',
      detached: true, timeout: Math.max(1, deadline - Date.now()), maxBuffer: 16384, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      completed = true;
      clearInterval(timer);
      if (child?.pid) {
        if (!claim || !terminatePriorR1Worker({ r1Child: true, workerPid: claim.pid, workerStartTime: claim.startTime })) {
          reject(blocked(cancelled() ? 'cancelled' : Date.now() >= deadline ? 'timeout' : 'prior_process_unresolved')); return;
        }
      }
      try { options.onProcess?.(null); } catch (e) { reject(cancelled() ? blocked('cancelled') : e); return; }
      try { check(); } catch (e) { reject(e); return; }
      if (!error) { resolve(); return; }
      if (error.killed || error.code === 'ETIMEDOUT') reject(blocked('timeout'));
      else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(blocked('output_limit'));
      else if (indexInstall && /(?:temporary failure in name resolution|name or service not known|newconnectionerror|connecttimeouterror|readtimeouterror|max retries exceeded|sslerror|failed to establish a new connection|network is unreachable|connection (?:timed out|refused)|could not fetch url)/i.test(String(stderr))) reject(blocked('package_index_transport'));
      else reject(blocked(error.code === 'ENOENT' || String(stderr).includes('interpreter_missing') ? 'interpreter_missing' : reason));
    });
    if (completed) return;
    try { if (child?.pid) {
      claim = { pid: child.pid, startTime: startTime(child.pid) };
      if (!claim.startTime) throw blocked('prior_process_unresolved');
      options.onProcess?.(claim);
    } }
    catch (e) { terminate(); reject(e); return; }
    if (guarded) { child.stdin.on('error', () => {}); child.stdin.end('start\n'); }
    timer = setInterval(() => { if (cancelled() || Date.now() >= deadline) terminate(); }, 100);
    // Test adapters may complete synchronously.
    timer.unref();
  });
  let venv;
  try { venv = localEnvironment(root, p.interpreter); } catch (e) { throw e.code === 'PYTHON_PREFLIGHT_BLOCKED' ? e : blocked('unsafe_path'); }
  const python = path.join(venv, 'bin/python');
  const receipt = path.join(venv, 'ralph-python-policy.json');
  const identity = crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex');
  const verify = () => {
    localEnvironment(root, p.interpreter);
    if (fs.readFileSync(path.join(venv, 'pyvenv.cfg'), 'utf8').split(/\r?\n/).filter(line => /^include-system-site-packages\s*=/i.test(line)).join('') !== 'include-system-site-packages = false') throw blocked('unsafe_path');
    return command(python, ['-I', '-c', probe, venv, JSON.stringify(Object.fromEntries(p.dependencies.map(d => [d.name, d.version]))), JSON.stringify(p.commands)], 'dependency_incompatible');
  };
  // Validate offline inventory even for an already prepared environment: stale
  // or withdrawn owner approval must not be hidden by a local cache hit.
  let wheels;
  if (p.wheelhouse) {
    try {
      canonical(p.wheelhouse);
      const relative = path.relative(root, p.wheelhouse);
      if (!relative.startsWith(`..${path.sep}`) && relative !== '..') throw 0;
      const names = fs.readdirSync(p.wheelhouse).sort();
      if (JSON.stringify(names) !== JSON.stringify(p.dependencies.map(d => d.wheel).sort())) throw 0;
      wheels = [];
      for (const d of p.dependencies) {
        const file = path.join(p.wheelhouse, d.wheel); canonical(file);
        if (!fs.statSync(file).isFile()) throw 0;
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(file)) { check(); hash.update(chunk); }
        if (hash.digest('hex') !== d.sha256) throw 0;
        wheels.push(file);
      }
    } catch (e) { throw e.code === 'PYTHON_PREFLIGHT_BLOCKED' ? e : blocked('offline_bundle_invalid'); }
  }
  check();
  if (options.checkOnly) {
    if (!fs.existsSync(python)) throw blocked('policy');
    try {
      await verify();
      await command(python, ['-I', '-m', 'pytest', '--version'], 'dependency_incompatible');
      await command(python, ['-I', '-m', 'ruff', '--version'], 'dependency_incompatible');
      await command(python, ['-I', '-m', 'pip', '--isolated', 'check'], 'dependency_incompatible');
    } catch (e) { throw e.code === 'PYTHON_PREFLIGHT_BLOCKED' ? e : blocked('dependency_incompatible'); }
    return { status: 'ready', category: 'infrastructure', reused: true, policy: 'legacy-check-only', at: new Date().toISOString() };
  }
  if (fs.existsSync(python)) {
    try {
      if (!fs.existsSync(receipt) || fs.lstatSync(receipt).isSymbolicLink() || fs.readFileSync(receipt, 'utf8') !== identity) throw blocked('dependency_incompatible');
      await verify();
      await command(python, ['-I', '-m', 'pytest', '--version'], 'dependency_incompatible');
      await command(python, ['-I', '-m', 'ruff', '--version'], 'dependency_incompatible');
      await command(python, ['-I', '-m', 'pip', '--isolated', 'check'], 'dependency_incompatible');
      return { status: 'ready', category: 'infrastructure', reused: true, at: new Date().toISOString() }; }
    catch (e) {
      if (e.outcome?.reason !== 'dependency_incompatible') throw e;
      // A new policy can remove distributions. Reinstalling into the old
      // environment would retain them and prevent the exact-inventory probe.
      check();
      localEnvironment(root, p.interpreter);
      fs.rmSync(venv, { recursive: true });
    }
  }
  if (!fs.existsSync(python)) {
    await command(p.interpreter, ['-I', '-m', 'venv', '.venv'], 'interpreter_missing');
  }
  try {
    localEnvironment(root, p.interpreter);
    if (fs.readFileSync(path.join(venv, 'pyvenv.cfg'), 'utf8').split(/\r?\n/).filter(line => /^include-system-site-packages\s*=/i.test(line)).join('') !== 'include-system-site-packages = false') throw 0;
    await command(python, ['-I', '-c', "import sys,os; assert os.path.realpath(sys.prefix) == sys.argv[1] and sys.prefix != sys.base_prefix; assert not any(('site-packages' in p or 'dist-packages' in p) and not os.path.realpath(p).startswith(sys.argv[1] + os.sep) for p in sys.path)", venv], 'unsafe_path');
  } catch (e) { throw e.code === 'PYTHON_PREFLIGHT_BLOCKED' ? e : blocked('unsafe_path'); }
  // Pass a hash-locked requirement file to pip. --isolated suppresses ambient
  // pip policy; --no-deps requires the owner to enumerate the full closure.
  const requirements = path.join(venv, 'ralph-requirements.txt');
  try {
    localEnvironment(root, p.interpreter);
    try {
      if (!fs.lstatSync(requirements).isFile() || fs.lstatSync(requirements).isSymbolicLink()) throw blocked('unsafe_path');
      fs.unlinkSync(requirements);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const content = p.dependencies.map((d, i) => `${wheels ? pathToFileURL(wheels[i]).href : `${d.name}==${d.version}`} --hash=sha256:${d.sha256}`).join('\n');
    fs.writeFileSync(requirements, content, { flag: 'wx', mode: 0o600 });
    await command(python, ['-I', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--no-cache-dir', '--no-deps', '--force-reinstall', '--require-hashes',
      ...(wheels ? ['--no-index'] : ['--index-url', p.indexUrl, '--only-binary=:all:', '--retries', '0']), '-r', requirements], 'dependency_incompatible', !wheels);
    await verify();
    await command(python, ['-I', '-m', 'pytest', '--version'], 'dependency_incompatible');
    await command(python, ['-I', '-m', 'ruff', '--version'], 'dependency_incompatible');
    await command(python, ['-I', '-m', 'pip', '--isolated', 'check'], 'dependency_incompatible');
    try { fs.unlinkSync(receipt); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const fd = fs.openSync(receipt, 'wx', 0o600);
    try { fs.writeFileSync(fd, identity); } finally { fs.closeSync(fd); }
    return { status: 'ready', category: 'infrastructure', reused: false, at: new Date().toISOString() };
  } finally { if (fs.existsSync(requirements) && !fs.lstatSync(requirements).isSymbolicLink()) fs.unlinkSync(requirements); }
}
async function preparePython(root, policy, options) {
  try { return await preparePythonInternal(root, policy, options); }
  catch (error) { throw error.code === 'PYTHON_PREFLIGHT_BLOCKED' ? error : blocked('unsafe_path'); }
}
module.exports = { preparePython, validatePythonPolicy, blocked };
