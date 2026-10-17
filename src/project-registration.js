// Owner-only onboarding: the existing two configuration files remain authoritative.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readContract } = require('./project-preflight');
const { preparationCommands } = require('./project-preflight-command');
const { prepareRepositoryEnvironment } = require('./autopilot-environment');

function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function durable(file, text) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { fs.rmSync(temp, { force: true }); }
}
function removeJournal(file) {
  fs.unlinkSync(file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function encode(value) { return JSON.stringify(value, null, 2) + '\n'; }

// All onboarding writers take both locks in canonical order. External editor
// changes are detected before replace/rollback; never overwrite a divergent file.
async function locked(files, fn) {
  const acquired = [];
  try {
    for (const file of [...files].sort()) {
      const lock = `${file}.project-lock`;
      try { fs.mkdirSync(lock); } catch (e) {
        if (e.code === 'EEXIST') throw new Error(`Concurrent onboarding or interrupted operation: ${lock}. Retry after completion; for an abandoned lock verify its owner process is stopped before removing it.`);
        throw e;
      }
      acquired.push(lock);
      fs.writeFileSync(path.join(lock, 'owner.json'), encode({ pid: process.pid, startTime: require('./r1-process-claim').startTime(process.pid), at: new Date().toISOString() }));
    }
    return await fn();
  } finally { for (const lock of acquired.reverse()) fs.rmSync(lock, { recursive: true }); }
}
function transaction(files, values, options = {}) {
  const journal = `${files[0]}.project-transaction`;
  if (fs.existsSync(journal)) throw new Error(`Interrupted registration: run project recover with these same config paths (${journal}).`);
  const entries = files.map((file, i) => ({ file, before: options.expected?.[i] ?? fs.readFileSync(file, 'utf8'), after: encode(values[i]) }));
  for (const entry of entries) if (fs.readFileSync(entry.file, 'utf8') !== entry.before) throw new Error(`Concurrent owner edit: ${entry.file}`);
  durable(journal, encode(entries));
  try {
    entries.forEach((entry, i) => {
      if (fs.readFileSync(entry.file, 'utf8') !== entry.before) throw new Error(`Concurrent owner edit: ${entry.file}`);
      durable(entry.file, entry.after);
      options.afterWrite?.(i);
    });
    removeJournal(journal);
  } catch (error) {
    try { rollback(journal); } catch (failure) { error.message += `\nRollback requires owner reconciliation: ${failure.message}`; }
    throw error;
  }
}
function rollback(journal) {
  const entries = read(journal);
  for (const entry of entries) {
    const current = fs.readFileSync(entry.file, 'utf8');
    if (current !== entry.before && current !== entry.after) throw new Error(`Owner edit preserved in ${entry.file}; inspect ${journal}`);
  }
  for (const entry of entries.reverse()) if (fs.readFileSync(entry.file, 'utf8') !== entry.before) durable(entry.file, entry.before);
  removeJournal(journal);
}
function diagnosticProjects(configPath) {
  const config = read(configPath);
  return Object.entries(config.allowedProjects || {}).filter(([, p]) => p?.onboarding).map(([name, p]) => ({ name, ...p.onboarding }));
}

async function projectCommand(action, repo, options) {
  const { configPath, projectsPath, record, approve } = options;
  if (path.resolve(configPath) === path.resolve(projectsPath)) throw new Error('Owner config and autopilot config must be different files.');
  const files = [fs.realpathSync(configPath), fs.realpathSync(projectsPath)];
  return locked(files, async () => {
    if (action === 'recover') {
      const journal = `${files[0]}.project-transaction`;
      if (read(journal).some((entry, i) => entry.file !== files[i])) throw new Error('Recovery requires the original two config paths.');
      rollback(journal); return { status: 'rolled_back' };
    }
    if (fs.existsSync(`${files[0]}.project-transaction`)) throw new Error('Interrupted registration requires project recover before retry.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo || '')) throw new Error('Use an owner/repository identifier.');
    const name = repo.toLowerCase().replace('/', '--');
    let expected = files.map(file => fs.readFileSync(file, 'utf8'));
    const config = JSON.parse(expected[0]), projects = JSON.parse(expected[1]);
    config.allowedProjects ||= {};
    const prior = projects[name], registered = config.allowedProjects[name];
    const aliases = Object.entries(projects).filter(([key, p]) => key !== name && p.repo?.toLowerCase() === repo.toLowerCase());
    if (aliases.length) throw new Error(`Repository already configured as ${aliases[0][0]}; preserve its owner settings.`);
    if (Boolean(prior) !== Boolean(registered) || (prior && (!prior.onboarding || !registered.onboarding
      || prior.repo?.toLowerCase() !== repo.toLowerCase() || prior.checkout !== registered.root || prior.worktreeRoot !== registered.worktreeRoot))) throw new Error('Conflicting existing owner registration; reconcile both stores without replacing owner edits.');
    const save = () => {
      transaction(files, [config, projects], { ...options, expected });
      expected = files.map(file => fs.readFileSync(file, 'utf8'));
    };
    if (action !== 'add') {
      if (!prior) throw new Error('Register the repository staged with project add first.');
      if (action === 'activate') {
        if (prior.onboarding.readiness?.status !== 'ready' || prior.onboarding.readiness.runtime !== prior.runtime) throw new Error('Run project check successfully before activation.');
        const { command } = preparationCommands(prior.checkout, options);
        const sha = (await command('git', ['rev-parse', `${prior.baseBranch}^{commit}`], 'repository_invalid')).trim();
        if (sha !== prior.onboarding.commit) throw new Error('Base branch changed; repeat project check before activation.');
        record('preview', { project: prior });
        if (!await approve('Activate issue admission with the displayed owner settings?')) throw new Error('Activation cancelled by owner.');
        if (options.isCancelled?.()) throw new Error('Activation cancelled.');
        prior.enabled = true;
        prior.onboarding.activation = 'active';
        prior.onboarding.registration = 'registered';
        registered.activation = 'active';
      } else if (action === 'check') {
        if (prior.enabled) throw new Error('Readiness checks here require a staged project.');
        const { command } = preparationCommands(prior.checkout, options);
        const oldClaim = prior.onboarding.process;
        if (oldClaim && !require('./r1-process-claim').terminatePriorR1Worker({ r1Child: true, workerPid: oldClaim.pid, workerStartTime: oldClaim.startTime })) throw new Error('Prior setup process unresolved; preserve worktree and diagnostics.');
        const worktree = path.join(prior.worktreeRoot, 'onboarding');
        // A unique fresh worktree makes repeated setup independent of failed installs.
        const target = `${worktree}-${crypto.randomUUID()}`;
        fs.mkdirSync(prior.worktreeRoot, { recursive: true });
        try {
          await command('git', ['worktree', 'add', '--detach', target, prior.baseBranch], 'repository_invalid');
          prior.onboarding.commit = (await command('git', ['-C', target, 'rev-parse', 'HEAD'], 'repository_invalid')).trim();
          prior.onboarding.readiness = { status: 'preparing' };
          prior.onboarding.worktree = target;
          const contract = readContract(target, prior.runtime);
          record('preview', { project: prior, worktree: target, install: prior.onboarding.preview.install,
            check: contract.runtime === 'python' ? `export VIRTUAL_ENV="$PWD/.venv"; export PATH="$PWD/.venv/bin:$PATH"; ${contract.verification}` : `npm run ${contract.verification}`,
            environment: contract.runtime === 'python' ? { UV_PROJECT_ENVIRONMENT: path.join(target, '.venv'), VIRTUAL_ENV: path.join(target, '.venv') } : {},
          });
          prior.onboarding.logId = options.logId;
          registered.onboarding = { ...prior.onboarding };
          save();
          prior.onboarding.readiness = await prepareRepositoryEnvironment(target, prior, { ...options, onProcess: claim => {
            prior.onboarding.process = claim;
            registered.onboarding = { ...prior.onboarding };
            save();
          } });
        } catch (error) {
          prior.onboarding.readiness = error.outcome || { status: 'blocked', message: error.stack || error.message };
          throw error;
        } finally {
          registered.onboarding = { ...prior.onboarding };
          save();
          // Preserve failed setup contents and all logs for owner diagnosis.
          record('workspace', { path: target, retained: true });
        }
      } else throw new Error('Expected project add, check, activate or recover.');
      prior.onboarding.logId = options.logId;
      registered.onboarding = { ...prior.onboarding };
      save();
      return prior;
    }
    if (prior) { record('preview', { project: prior, duplicate: true }); return prior; }
    const checkout = path.resolve(options.checkoutRoot, name);
    const worktreeRoot = path.resolve(options.worktreeRoot, name);
    const { command } = preparationCommands(path.dirname(checkout), options);
    fs.mkdirSync(path.dirname(checkout), { recursive: true });
    if (!fs.existsSync(checkout)) {
      try { await command('git', ['clone', ...(options.baseBranch ? ['--branch', options.baseBranch] : []), '--', options.source || `https://github.com/${repo}.git`, checkout], 'clone_failed'); }
      catch (error) {
        error.message += `\nInspect the retained checkout at ${checkout}; repair it or move it aside before retrying. No owner registration was changed.`;
        if (error.outcome) error.outcome.message = error.message;
        throw error;
      }
    }
    const git = args => command('git', ['-C', checkout, ...args], 'repository_invalid');
    const origin = (await git(['remote', 'get-url', 'origin'])).trim();
    if (origin !== (options.source || `https://github.com/${repo}.git`)) throw new Error(`Checkout origin conflicts: ${origin}`);
    const branch = options.baseBranch || (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim().replace(/^origin\//, '');
    await git(['check-ref-format', '--branch', branch]);
    const commit = (await git(['rev-parse', `${branch}^{commit}`])).trim();
    if ((await git(['rev-parse', 'HEAD'])).trim() !== commit || (await git(['status', '--porcelain'])).trim()) throw new Error('Checkout must be clean at the selected committed base branch. Preserve owner work and retry.');
    const target = path.join(worktreeRoot, `inspection-${crypto.randomUUID()}`);
    fs.mkdirSync(worktreeRoot, { recursive: true });
    await git(['worktree', 'add', '--detach', target, commit]);
    record('workspace', { path: target, retained: true });
    const contract = readContract(target);
    if (!fs.existsSync(path.join(checkout, contract.lockfile))) throw new Error(`Missing ${contract.lockfile}; commit a native lockfile matching project metadata and retry.`);
    const lock = await git(['show', `HEAD:${contract.lockfile}`]);
    if (lock !== fs.readFileSync(path.join(checkout, contract.lockfile), 'utf8')) throw new Error(`Commit ${contract.lockfile} before registration.`);
    await git(['show', 'HEAD:.ralph/project.json']);
    if (contract.runtime === 'node') {
      const pkg = read(path.join(checkout, 'package.json')), parsed = JSON.parse(lock);
      if (![1, 2, 3].includes(parsed.lockfileVersion) || (parsed.lockfileVersion >= 2 && !parsed.packages?.[''])) throw new Error('Invalid package-lock.json; commit a compatible npm lockfile.');
      if (!pkg.scripts?.[contract.verification]) throw new Error(`Define npm script ${contract.verification} before registration.`);
    } else await git(['show', 'HEAD:pyproject.toml']);
    const verification = contract.runtime === 'node' ? `npm run ${contract.verification}` : contract.verification;
    const onboarding = { registration: 'staged', activation: 'inactive', readiness: { status: 'unchecked' }, commit, worktree: target, logId: options.logId };
    const project = { enabled: false, repo, checkout, worktreeRoot, baseBranch: branch, runtime: contract.runtime,
      readyLabel: options.readyLabel || 'ready-for-agent', humanLabel: 'ready-for-human', worker: options.worker || 'codex',
      maxAttempts: 2, verification, ciWorkflow: options.ciWorkflow || 'CI', reviewPolicy: 'always', reviewModel: 'opus', autoMerge: false, onboarding };
    const preview = { ...project, contract, install: contract.runtime === 'node' ? 'npm ci --foreground-scripts --no-audit --no-fund' : 'uv sync --locked',
      check: contract.runtime === 'python' ? `export VIRTUAL_ENV="$PWD/.venv"; export PATH="$PWD/.venv/bin:$PATH"; ${verification}` : verification,
      testScript: contract.runtime === 'node' ? read(path.join(target, 'package.json')).scripts[contract.verification] : contract.verification,
      pythonEnvironment: contract.runtime === 'python' ? `${target}/.venv` : null,
      worktree: target, models: config.models || {}, enginePaths: config.enginePaths || {},
      tools: Object.fromEntries(['git', 'node', 'npm', 'uv', 'python3', project.worker, 'claude'].map(tool => [tool, require('./engines').findOnPath(tool)])) };
    delete preview.onboarding;
    onboarding.preview = preview;
    record('preview', preview);
    if (options.isCancelled?.()) throw new Error('Registration cancelled.');
    if (!await approve('Register this repository STAGED with these settings?') || options.isCancelled?.()) throw new Error('Registration cancelled by owner.');
    projects[name] = project;
    config.allowedProjects[name] = { root: checkout, worktreeRoot, activation: 'inactive', onboarding };
    save();
    return project;
  });
}
module.exports = { projectCommand, diagnosticProjects, transaction, rollback, locked };
