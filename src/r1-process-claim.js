'use strict';

// Linux-specific identity for a detached child process group. PID alone is
// insufficient because the kernel can reuse it between daemon boots.
const fs = require('node:fs');
function startTime(pid) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  let raw;
  try { raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const end = raw.lastIndexOf(')');
  if (end < 0) throw new Error('Malformed process stat; refusing R1 worker admission.');
  const columns = raw.slice(end + 2).trim().split(/\s+/);
  const value = columns[19]; // /proc stat field 22, 0-based after field 3
  if (!/^\d+$/.test(value || '')) throw new Error('Missing process start time; refusing R1 worker admission.');
  return value;
}

function processGroupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function terminatePriorR1Worker(task) {
  if (!task.r1Child) return true;
  if (process.platform !== 'linux') return false;
  const pid = task.workerPid;
  const recordedStart = task.workerStartTime;
  // If no process was claimed, no agent prompt was sent: no authorized work
  // could have been started; keep the remaining ambiguity fail-closed.
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^\d+$/.test(recordedStart || '')) return false;
  const current = startTime(pid);
  if (current && current !== recordedStart) return true; // PID reused; never kill it
  if (!current && !processGroupExists(pid)) return true;
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') return false; }
  // A reclaimed child may be a zombie while its descendants still exist.
  // Only a vanished group is proof that no process can edit the worktree.
  for (let i = 0; i < 15; i++) {
    if (!processGroupExists(pid)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return false;
}

module.exports = { startTime, terminatePriorR1Worker };
