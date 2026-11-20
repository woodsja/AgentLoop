'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
// systemd human-formatted timespans, including systemd 255's '1min'. Infinity,
// zero, unknown units and malformed/trailing text fail closed.
function duration(text) {
  const units = { us: 0.001, ms: 1, s: 1000, min: 60000, h: 3600000 };
  let total = 0, remaining = text.trim();
  while (remaining) {
    const m = /^(\d+(?:\.\d+)?)(us|ms|min|s|h)(?:\s+|$)/.exec(remaining);
    if (!m) throw Error('invalid systemd timespan: ' + text);
    total += Number(m[1]) * units[m[2]]; remaining = remaining.slice(m[0].length);
  }
  if (!(total > 0) || !Number.isFinite(total)) throw Error('unbounded systemd timespan');
  return total;
}
function idle(job) {
  if (job === '' || /^(?:0|0 \/)$/.test(job)) return true;
  if (/^[1-9][0-9]*$/.test(job) || /^[1-9][0-9]* \/org\/freedesktop\/systemd1\/job\/[1-9][0-9]*$/.test(job)
    || /^\/org\/freedesktop\/systemd1\/job\/[1-9][0-9]*$/.test(job)) return false;
  throw Error('unknown systemd Job value: ' + JSON.stringify(job));
}
async function guardian(action, systemctl = '/usr/bin/systemctl') {
  if (!['restart','settle','check'].includes(action)) throw Error('invalid guardian action');
  let bytes = 0, calls = 0;
  function audit(fd, data) {
    if (!data?.length) return;
    fs.writeFileSync(fd,data); fs.fsyncSync(fd); bytes += Buffer.byteLength(data);
  }
  const run = args => {
    if (++calls > 1500 || bytes >= 4 * 1024 * 1024) throw Error('guardian command/audit budget exhausted');
    audit(1, JSON.stringify({ time: new Date().toISOString(), command: [systemctl,'--user',...args] }) + '\n');
    const result = spawnSync(systemctl,['--user',...args], { timeout:5000, killSignal:'SIGKILL', maxBuffer:65536, stdio:['ignore','pipe','pipe',3] });
    let failure;
    // Retain both captured streams even if the first crosses the threshold or
    // its fsync fails. Threshold admission affects the NEXT producer only.
    for (const [fd,data] of [[1,result.stdout],[2,result.stderr]]) {
      try { audit(fd,data); } catch (e) { failure ||= e; }
    }
    try { audit(1, JSON.stringify({ exitCode: result.status, signal: result.signal, error: result.error?.stack }) + '\n'); }
    catch (e) { failure ||= e; }
    if (failure) throw failure;
    if (bytes > 4 * 1024 * 1024) throw Error('guardian audit budget exhausted');
    if (result.error || result.status !== 0) throw result.error || Error('systemctl exit ' + result.status);
    return result.stdout.toString().trim();
  };
  audit(1, 'guardian pid=' + process.pid + '\n');
  const show = property => run(['show','agentloop.service','--property='+property,'--value']);
  const jobMs = duration(show('JobTimeoutUSec'));
  if (jobMs < 1000 || jobMs > 60000 || jobMs % 1000) throw Error('bounded JobTimeoutSec=1..60 bootstrap required');
  for (const p of ['TimeoutStartUSec','TimeoutStopUSec']) {
    const ms = duration(show(p));
    if (ms < 1000 || ms > 20000 || ms % 1000) throw Error('bounded start/stop timeout bootstrap required');
  }
  if (show('SendSIGKILL') !== 'yes') throw Error('SendSIGKILL bootstrap required');
  if (action === 'check') return;
  let submissionError;
  if (action === 'restart') try { run(['--no-block','--job-mode=fail','restart','agentloop.service']); } catch (e) { submissionError = e; }
  const until = Date.now() + jobMs + 5000;
  do {
    let stable = false;
    try {
      const job = show('Job'), active = show('ActiveState');
      stable = idle(job) && ['active','inactive','failed'].includes(active);
    } catch (e) {
      try { audit(2,e.stack + '\n'); } catch (auditError) {
        // Disk/output failure must never release fd 3 during a pending job.
        await new Promise(r => setTimeout(r,Math.max(0,until-Date.now())));
        throw auditError;
      }
      if (calls >= 1500 || bytes > 4 * 1024 * 1024) {
        await new Promise(r => setTimeout(r,Math.max(0,until-Date.now())));
        throw e;
      }
    }
    if (stable) {
      if (submissionError) throw submissionError;
      audit(1, 'guardian job settled\n'); return;
    }
    await new Promise(r => setTimeout(r,100));
  } while (Date.now() < until);
  throw Error('systemd job exceeded authoritative deadline');
}
if (require.main === module) guardian(process.argv[2]).catch(e => { fs.writeSync(2,e.stack+'\n'); fs.fsyncSync(2); process.exitCode=1; });
module.exports = { guardian, duration, idle };
