const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const engines = require('./engines');

function buildWorkerPrompt(task) {
  return [
    `Task ID: ${task.id}`,
    `Goal: ${task.goal}`,
    'Acceptance criteria:',
    ...task.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
    '',
    'Make the necessary edits in the project to satisfy the goal and acceptance criteria.',
    'Ralph will perform final deterministic verification after you exit.',
    'Do not fail merely because you cannot run tests or shell commands; complete the edits you can make.',
  ].join('\n');
}

function createCliWorker(options = {}) {
  const {
    config = {},
    timeoutMs = 45 * 60 * 1000,
    spawnImpl = spawn,
    tempDir = os.tmpdir(),
  } = options;

  return async function runWorker(projectPath, task) {
    const engine = engines.get(task.worker);
    if (!engine) throw new Error(`Unknown worker engine: ${task.worker}`);

    const model = engines.modelFor(engine, config, task.model);
    const executable = engines.binary(engine, config.enginePaths);
    if (!executable) throw new Error(`${engine.label} CLI not found (${engine.command})`);

    const outputPath = engine.usesOutputFile
      ? path.join(tempDir, `ralph-worker-${randomUUID()}.txt`)
      : null;
    const args = engine.args({ model, outputPath });
    const prompt = buildWorkerPrompt(task);

    try {
      return await new Promise((resolve, reject) => {
        let child;
        try {
          child = spawnImpl(executable, args, {
            cwd: projectPath,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: engine.env ? engine.env(process.env) : process.env,
          });
        } catch (error) {
          reject(error);
          return;
        }

        let stdout = '';
        let stderr = '';
        let partialLine = '';
        let lastText = '';
        let resultText = '';
        let costUsd;
        let timedOut = false;
        let settled = false;
        let timeout;
        let timeoutFallback;

        const parseLine = line => {
          const parsed = engine.parseLine(line.replace(/\r$/, '')) || {};
          if (typeof parsed.text === 'string' && parsed.text.trim()) lastText = parsed.text;
          if (typeof parsed.result === 'string') resultText = parsed.result;
          if (typeof parsed.costUsd === 'number') costUsd = parsed.costUsd;
        };
        const finish = (error, exitCode = null, signal = null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          clearTimeout(timeoutFallback);
          if (error) {
            reject(error);
            return;
          }
          if (partialLine) parseLine(partialLine);
          if (engine.usesOutputFile) {
            try {
              resultText = fs.readFileSync(outputPath, 'utf8').trim() || lastText;
            } catch {
              resultText = lastText;
            }
          } else {
            resultText = resultText || lastText;
          }
          resolve({
            engine: engine.id,
            model,
            exitCode,
            signal,
            timedOut,
            resultText,
            stdout,
            stderr,
            ...(costUsd !== undefined ? { costUsd } : {}),
          });
        };

        child.stdout.on('data', chunk => {
          const text = String(chunk);
          stdout += text;
          partialLine += text;
          const lines = partialLine.split('\n');
          partialLine = lines.pop();
          for (const line of lines) parseLine(line);
        });
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        child.once('error', error => finish(error));
        child.once('close', (code, signal) => finish(null, code, signal));
        child.stdin.on('error', error => finish(error));

        timeout = setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGTERM');
          } catch (error) {
            finish(error);
            return;
          }
          // A child that ignores termination must not keep the adapter pending.
          timeoutFallback = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
            finish(null, null, 'SIGKILL');
          }, 1000);
        }, timeoutMs);

        try {
          child.stdin.end(prompt);
        } catch (error) {
          finish(error);
        }
      });
    } finally {
      if (outputPath) fs.rmSync(outputPath, { force: true });
    }
  };
}

module.exports = { buildWorkerPrompt, createCliWorker };
