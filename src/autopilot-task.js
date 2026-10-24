'use strict';

const { formatRepositoryInstructions } = require('./autopilot-instructions');

function acceptanceFromIssue(issue) {
  const body = typeof issue.body === 'string' ? issue.body.trim() : '';
  const lines = body.split('\n');
  // GitHub templates commonly spell this heading either "Acceptance" or
  // "Acceptance Criteria", sometimes with a trailing colon.  Keep the
  // extracted criteria separate from the whole issue body while retaining
  // the latter verbatim in the task goal below.
  const isAcceptanceHeading = line => /^(?:#{1,6}\s*|\*{1,2})?acceptance(?:\s+criteria)?(?:\*{1,2})?\s*:?[ \t]*$/i.test(line.trim());
  const start = lines.findIndex(isAcceptanceHeading);
  const source = start < 0 ? '' : lines.slice(start + 1, (() => {
    const followingHeader = lines.slice(start + 1).findIndex(line => /^#{1,6}\s/.test(line));
    return followingHeader < 0 ? lines.length : start + 1 + followingHeader;
  })()).join('\n');
  const items = source.split('\n')
    .map(line => line.match(/^\s*(?:[-*+] |\d+[.)] )(?:\[[ xX]\]\s*)?(.*\S)\s*$/)?.[1])
    .filter(Boolean);
  return items.length > 0 ? items : [`Complete issue #${issue.number}: ${issue.title}`];
}

function buildAutopilotTask(project, issue, instructions) {
  if (!project || !issue || !Number.isSafeInteger(issue.number) || typeof issue.title !== 'string') {
    throw new TypeError('Autopilot task construction requires a project and a normalized issue');
  }
  const body = typeof issue.body === 'string' && issue.body.trim() ? issue.body.trim() : '(No issue body was provided.)';
  const repositoryInstructions = formatRepositoryInstructions(instructions);
  return {
    ...(project.architectureDecisions === true ? { architectureDecisions: true } : {}),
    id: `autopilot:${project.repo}#${issue.number}`,
    goal: `Implement GitHub issue #${issue.number}: ${issue.title}\n\nIssue body:\n${body}\n\nRepository instructions:\n${repositoryInstructions}`,
    acceptance: [
      ...acceptanceFromIssue(issue),
      'Follow the repository instructions included in the task goal.',
    ],
    verification: project.verification,
    worker: project.worker || 'codex',
    // Two attempts is the normal autonomous bound; a project may explicitly
    // supply a different valid limit in its own configuration.
    maxAttempts: project.maxAttempts ?? 2,
  };
}

// The single CI corrective cycle sees only the original issue, the repository
// instructions, and the persisted red-CI diagnostics.  Verification is the
// same deterministic project command as the original run.
function buildCorrectiveTask(project, issue, instructions, correction) {
  if (correction && correction.kind === 'review') {
    if (!Number.isSafeInteger(correction.cycle) || correction.cycle < 1 || correction.cycle >= (project.maxReviewRounds ?? 2) || typeof correction.reviewCommit !== 'string' || !correction.reviewCommit
      || typeof correction.reviewer !== 'string' || !correction.reviewer.trim()
      || typeof correction.findings !== 'string' || !correction.findings.trim()) {
      throw new TypeError('Reviewer corrective task construction requires an allowed cycle, reviewer identity, findings, and reviewed commit');
    }
    const original = buildAutopilotTask(project, issue, instructions);
    return {
      ...original,
      id: `${original.id}:review-correction-${correction.cycle}`,
      goal: `Address independent code review findings for GitHub issue #${issue.number}: ${issue.title}\n\n`
        + `The branch contains delivered commit ${correction.reviewCommit}, reviewed by ${correction.reviewer}. `
        + 'Make the smallest code change that addresses the findings while preserving the original issue requirements. '
        + 'Do not change CI workflow files merely to silence checks.\n\n'
        + `Reviewer findings:\n${correction.findings.trim()}\n\n${original.goal}`,
      acceptance: [...original.acceptance, 'Address the reviewer findings in the task goal with a code change on this branch.'],
    };
  }
  if (!correction || correction.cycle !== 1 || typeof correction.diagnostics !== 'string' || !correction.diagnostics.trim()
    || typeof correction.redCommit !== 'string' || !correction.redCommit) {
    throw new TypeError('Corrective task construction requires the one allowed cycle, persisted CI diagnostics, and the red commit');
  }
  const original = buildAutopilotTask(project, issue, instructions);
  return {
    ...original,
    id: `${original.id}:ci-correction-${correction.cycle}`,
    goal: `Fix the failing CI for GitHub issue #${issue.number}: ${issue.title}\n\n`
      + `The branch already contains a delivered implementation (commit ${correction.redCommit}) whose `
      + 'GitHub Actions CI is red. Make the smallest code change that makes CI pass while still satisfying '
      + 'the original issue. Do not modify CI workflow files merely to skip or silence failing checks.\n\n'
      + `CI failure diagnostics:\n${correction.diagnostics.trim()}\n\n${original.goal}`,
    acceptance: [
      ...original.acceptance,
      'Resolve the CI failures described in the task goal with a code change on this branch.',
    ],
  };
}

module.exports = { acceptanceFromIssue, buildAutopilotTask, buildCorrectiveTask };
