import fs from 'node:fs';

const BAD_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale']);
const BAD_STATUS_STATES = new Set(['failure', 'error']);

export function evaluatePrChecks({ pr, checkRuns, statusContexts, alreadyNotified }) {
  if (!pr || pr.state !== 'open' || pr.base?.ref !== 'main') {
    return { shouldNotify: false, reason: 'not-applicable', failedChecks: [] };
  }

  if (alreadyNotified) {
    return { shouldNotify: false, reason: 'already-notified', failedChecks: [] };
  }

  const failedChecks = [
    ...checkRuns
      .filter(run => run.status === 'completed' && BAD_CONCLUSIONS.has(run.conclusion))
      .map(run => run.name),
    ...statusContexts
      .filter(status => BAD_STATUS_STATES.has(status.state))
      .map(status => status.context)
  ];

  const uniqueFailedChecks = [...new Set(failedChecks)];
  if (uniqueFailedChecks.length === 0) {
    return { shouldNotify: false, reason: 'all-green', failedChecks: [] };
  }

  return {
    shouldNotify: true,
    reason: 'non-green',
    failedChecks: uniqueFailedChecks,
    subject: `[claude-mem] PR #${pr.number} CI not green — manual merge inspection required`,
    body: [
      `PR: #${pr.number} ${pr.title}`,
      `URL: ${pr.html_url}`,
      `Base: ${pr.base.ref}`,
      `Head: ${pr.head.ref}`,
      `SHA: ${pr.head.sha}`,
      '',
      'CI is not fully green for this PR. Please manually inspect whether it is safe to merge.',
      '',
      'Non-green checks:',
      ...uniqueFailedChecks.map(name => `- ${name}`)
    ].join('\n')
  };
}

export function findExistingNotificationMarker(comments, prNumber, sha) {
  const marker = `CI reminder marker: pr=${prNumber} sha=${sha}`;
  return comments.some(comment => typeof comment.body === 'string' && comment.body.includes(marker));
}

function setGithubOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  fs.appendFileSync(outputPath, `${name}<<EOF\n${value}\nEOF\n`);
}

async function githubRequest(path, options = {}) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;

  if (!repo || !token) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  }

  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'claude-mem-ci-non-green-email',
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed: ${response.status}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function loadChecksForSha(sha) {
  const [checkRuns, status] = await Promise.all([
    githubRequest(`/commits/${sha}/check-runs`),
    githubRequest(`/commits/${sha}/status`)
  ]);

  return {
    checkRuns: checkRuns.check_runs ?? [],
    statusContexts: status.statuses ?? []
  };
}

async function loadPrComments(prNumber) {
  const allComments = [];
  let page = 1;
  while (true) {
    const batch = await githubRequest(`/issues/${prNumber}/comments?per_page=100&page=${page}`);
    if (!batch || batch.length === 0) break;
    allComments.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return allComments;
}

async function resolvePullRequest(event) {
  if (event.pull_request) {
    return event.pull_request;
  }

  const manualPrNumber = process.env.INPUT_PR_NUMBER;
  if (manualPrNumber) {
    return githubRequest(`/pulls/${manualPrNumber}`);
  }

  const workflowRunPr = event.workflow_run?.pull_requests?.[0];
  if (workflowRunPr?.number) {
    return githubRequest(`/pulls/${workflowRunPr.number}`);
  }

  return null;
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    setGithubOutput('should_notify', 'false');
    setGithubOutput('reason', 'no-event');
    return;
  }

  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const pr = await resolvePullRequest(event);

  if (!pr) {
    setGithubOutput('should_notify', 'false');
    setGithubOutput('reason', 'no-pr');
    return;
  }

  const { checkRuns, statusContexts } = await loadChecksForSha(pr.head.sha);
  const comments = await loadPrComments(pr.number);
  const alreadyNotified = findExistingNotificationMarker(comments, pr.number, pr.head.sha);
  const result = evaluatePrChecks({
    pr,
    checkRuns,
    statusContexts,
    alreadyNotified
  });

  setGithubOutput('should_notify', result.shouldNotify ? 'true' : 'false');
  setGithubOutput('reason', result.reason);
  setGithubOutput('subject', result.subject ?? '');
  setGithubOutput('body', result.body ?? '');
  setGithubOutput('pr_number', String(pr.number));
  setGithubOutput('head_sha', pr.head.sha);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
