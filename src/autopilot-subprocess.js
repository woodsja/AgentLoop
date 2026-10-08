'use strict';

// These commands run unattended in the supervisor.  A credential prompt or a
// stalled remote must therefore become a bounded, ordinary command failure.
const COMMAND_TIMEOUT_MS = 60 * 1000;

function unattendedOptions(options = {}) {
  return {
    ...options,
    timeout: COMMAND_TIMEOUT_MS,
    killSignal: 'SIGTERM',
    env: {
      ...process.env,
      ...(options.env || {}),
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  };
}

module.exports = { COMMAND_TIMEOUT_MS, unattendedOptions };
