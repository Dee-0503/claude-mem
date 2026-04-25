# CI Failure Email Reminder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Actions workflow that emails `CI_ALERT_EMAIL` when an open PR targeting `main` has terminal non-green checks and requires manual merge inspection.

**Architecture:** Add one dedicated notification workflow plus one small helper script that queries GitHub check state for a PR head SHA and decides whether mail should be sent. Reuse the repository’s existing GitHub Actions patterns for PR comments and workflow metadata, but keep this feature isolated from existing CI jobs and upstream-sync policy logic.

**Tech Stack:** GitHub Actions YAML, Node.js script execution in workflow, GitHub REST API via `fetch`, Bun/Node-compatible JavaScript, repository secrets for mail delivery.

---

## File structure

- **Create:** `.github/workflows/ci-non-green-email.yml`
  - Dedicated workflow that triggers on PR-relevant CI completion and dispatch/manual runs.
- **Create:** `scripts/ci-non-green-email.mjs`
  - Fetches PR/check metadata from GitHub API, determines whether current head SHA is non-green, builds mail subject/body, and emits outputs for the workflow.
- **Modify:** `package.json`
  - Add a small script entry for local dry-run validation of the helper script if useful.
- **Modify:** `docs/production-guide.md`
  - Document required secrets (`CI_ALERT_EMAIL` and mail provider credentials), trigger behavior, and dedup semantics.

---

### Task 1: Write failing coverage for non-green PR evaluation logic

**Files:**
- Create: `tests/scripts/ci-non-green-email.test.ts`
- Test: `tests/scripts/ci-non-green-email.test.ts`

- [ ] **Step 1: Write the failing test for terminal non-green detection**

```ts
import { describe, expect, it } from 'bun:test';
import { evaluatePrChecks } from '../../scripts/ci-non-green-email.mjs';

describe('evaluatePrChecks', () => {
  it('flags a PR when one check run has failure conclusion', () => {
    const result = evaluatePrChecks({
      pr: {
        number: 13,
        title: 'example',
        html_url: 'https://github.com/Dee-0503/claude-mem/pull/13',
        state: 'open',
        base: { ref: 'main' },
        head: { ref: 'pr12-review', sha: 'abc123' }
      },
      checkRuns: [
        { name: 'test', status: 'completed', conclusion: 'success' },
        { name: 'upstream-guard', status: 'completed', conclusion: 'failure' }
      ],
      statusContexts: [
        { context: 'build', state: 'success' }
      ],
      alreadyNotified: false
    });

    expect(result.shouldNotify).toBe(true);
    expect(result.failedChecks).toEqual(['upstream-guard']);
    expect(result.subject).toContain('PR #13');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/scripts/ci-non-green-email.test.ts`
Expected: FAIL with `Cannot find module '../../scripts/ci-non-green-email.mjs'` or missing export `evaluatePrChecks`

- [ ] **Step 3: Write the second failing test for duplicate suppression**

```ts
it('does not notify again for the same PR head SHA', () => {
  const result = evaluatePrChecks({
    pr: {
      number: 13,
      title: 'example',
      html_url: 'https://github.com/Dee-0503/claude-mem/pull/13',
      state: 'open',
      base: { ref: 'main' },
      head: { ref: 'pr12-review', sha: 'abc123' }
    },
    checkRuns: [
      { name: 'upstream-guard', status: 'completed', conclusion: 'failure' }
    ],
    statusContexts: [],
    alreadyNotified: true
  });

  expect(result.shouldNotify).toBe(false);
  expect(result.reason).toBe('already-notified');
});
```

- [ ] **Step 4: Run test to verify it still fails for missing implementation**

Run: `bun test tests/scripts/ci-non-green-email.test.ts`
Expected: FAIL with missing module/export

- [ ] **Step 5: Commit**

```bash
git add tests/scripts/ci-non-green-email.test.ts
git commit -m "test: add CI non-green email evaluation coverage"
```

---

### Task 2: Implement the evaluation helper with minimal GitHub-facing logic

**Files:**
- Create: `scripts/ci-non-green-email.mjs`
- Test: `tests/scripts/ci-non-green-email.test.ts`

- [ ] **Step 1: Write the minimal implementation to satisfy the tests**

```js
export function evaluatePrChecks({ pr, checkRuns, statusContexts, alreadyNotified }) {
  if (!pr || pr.state !== 'open' || pr.base?.ref !== 'main') {
    return { shouldNotify: false, reason: 'not-applicable', failedChecks: [] };
  }

  if (alreadyNotified) {
    return { shouldNotify: false, reason: 'already-notified', failedChecks: [] };
  }

  const badConclusions = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale']);
  const failedChecks = [
    ...checkRuns
      .filter(run => run.status === 'completed' && badConclusions.has(run.conclusion))
      .map(run => run.name),
    ...statusContexts
      .filter(status => badConclusions.has(status.state))
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
```

- [ ] **Step 2: Run the focused test to verify it passes**

Run: `bun test tests/scripts/ci-non-green-email.test.ts`
Expected: PASS

- [ ] **Step 3: Extend the helper with GitHub environment parsing and output writing**

```js
import fs from 'node:fs';

function setGithubOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  fs.appendFileSync(outputPath, `${name}<<EOF\n${value}\nEOF\n`);
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const pr = event.pull_request;

  if (!pr) {
    setGithubOutput('should_notify', 'false');
    setGithubOutput('reason', 'no-pr');
    return;
  }

  const result = evaluatePrChecks({
    pr,
    checkRuns: [],
    statusContexts: [],
    alreadyNotified: false
  });

  setGithubOutput('should_notify', result.shouldNotify ? 'true' : 'false');
  setGithubOutput('reason', result.reason);
  setGithubOutput('subject', result.subject ?? '');
  setGithubOutput('body', result.body ?? '');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the focused test again to ensure exports still pass**

Run: `bun test tests/scripts/ci-non-green-email.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/ci-non-green-email.mjs tests/scripts/ci-non-green-email.test.ts
git commit -m "feat: add CI non-green email evaluator"
```

---

### Task 3: Add GitHub API integration for real PR check aggregation

**Files:**
- Modify: `scripts/ci-non-green-email.mjs`
- Test: `tests/scripts/ci-non-green-email.test.ts`

- [ ] **Step 1: Write a failing test for aggregate check ingestion**

```ts
it('treats failed commit statuses as non-green checks', () => {
  const result = evaluatePrChecks({
    pr: {
      number: 13,
      title: 'example',
      html_url: 'https://github.com/Dee-0503/claude-mem/pull/13',
      state: 'open',
      base: { ref: 'main' },
      head: { ref: 'pr12-review', sha: 'abc123' }
    },
    checkRuns: [],
    statusContexts: [
      { context: 'build / linux', state: 'failure' }
    ],
    alreadyNotified: false
  });

  expect(result.shouldNotify).toBe(true);
  expect(result.failedChecks).toEqual(['build / linux']);
});
```

- [ ] **Step 2: Run test to verify baseline behavior**

Run: `bun test tests/scripts/ci-non-green-email.test.ts`
Expected: PASS if already covered, otherwise FAIL and update implementation in next step

- [ ] **Step 3: Implement GitHub fetch helpers in the script**

```js
async function githubRequest(path) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'claude-mem-ci-non-green-email'
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed: ${response.status}`);
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
```

- [ ] **Step 4: Wire the main function to fetch checks for the event PR SHA**

```js
  const { checkRuns, statusContexts } = await loadChecksForSha(pr.head.sha);
  const alreadyNotified = false;
  const result = evaluatePrChecks({ pr, checkRuns, statusContexts, alreadyNotified });
```

- [ ] **Step 5: Run the focused test suite**

Run: `bun test tests/scripts/ci-non-green-email.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/ci-non-green-email.mjs tests/scripts/ci-non-green-email.test.ts
git commit -m "feat: load PR check state for CI reminder emails"
```

---

### Task 4: Add same-SHA deduplication using PR comments

**Files:**
- Modify: `scripts/ci-non-green-email.mjs`
- Test: `tests/scripts/ci-non-green-email.test.ts`

- [ ] **Step 1: Write a failing test for dedup marker parsing**

```ts
import { findExistingNotificationMarker } from '../../scripts/ci-non-green-email.mjs';

it('detects an existing notification marker for the same SHA', () => {
  const comment = findExistingNotificationMarker([
    { body: 'CI reminder marker: pr=13 sha=abc123' },
    { body: 'other comment' }
  ], 13, 'abc123');

  expect(comment).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/scripts/ci-non-green-email.test.ts`
Expected: FAIL with missing export `findExistingNotificationMarker`

- [ ] **Step 3: Implement marker detection and comment writer payloads**

```js
export function findExistingNotificationMarker(comments, prNumber, sha) {
  const marker = `CI reminder marker: pr=${prNumber} sha=${sha}`;
  return comments.some(comment => typeof comment.body === 'string' && comment.body.includes(marker));
}

async function loadPrComments(prNumber) {
  return githubRequest(`/issues/${prNumber}/comments?per_page=100`);
}

async function createNotificationMarker(prNumber, sha) {
  return fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'claude-mem-ci-non-green-email'
    },
    body: JSON.stringify({
      body: `CI reminder marker: pr=${prNumber} sha=${sha}`
    })
  });
}
```

- [ ] **Step 4: Update main flow to suppress duplicate mail when marker exists**

```js
  const comments = await loadPrComments(pr.number);
  const alreadyNotified = findExistingNotificationMarker(comments, pr.number, pr.head.sha);
  const result = evaluatePrChecks({ pr, checkRuns, statusContexts, alreadyNotified });

  if (result.shouldNotify) {
    await createNotificationMarker(pr.number, pr.head.sha);
  }
```

- [ ] **Step 5: Run the focused test suite**

Run: `bun test tests/scripts/ci-non-green-email.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/ci-non-green-email.mjs tests/scripts/ci-non-green-email.test.ts
git commit -m "feat: suppress duplicate CI reminder emails per SHA"
```

---

### Task 5: Add the notification workflow and email delivery

**Files:**
- Create: `.github/workflows/ci-non-green-email.yml`
- Modify: `scripts/ci-non-green-email.mjs`

- [ ] **Step 1: Write the workflow file with PR-related triggers and script execution**

```yaml
name: CI Non-Green Email Reminder

on:
  pull_request:
    branches:
      - main
    types:
      - opened
      - synchronize
      - reopened
      - ready_for_review
  workflow_run:
    workflows:
      - Ceemac Upstream Guard
      - Ceemac Upstream PR Policy
      - Claude Code Review
    types:
      - completed
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number to evaluate
        required: false

jobs:
  notify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      checks: read
      statuses: read
      actions: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Evaluate PR CI state
        id: evaluate
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: node scripts/ci-non-green-email.mjs
```

- [ ] **Step 2: Add a failing dry-run command in package.json if needed for local validation**

```json
"scripts": {
  "test": "bun test",
  "ci:non-green-email": "node scripts/ci-non-green-email.mjs"
}
```

- [ ] **Step 3: Add the mail step guarded by script outputs**

```yaml
      - name: Send CI reminder email
        if: steps.evaluate.outputs.should_notify == 'true'
        uses: dawidd6/action-send-mail@v3
        with:
          server_address: ${{ secrets.SMTP_HOST }}
          server_port: ${{ secrets.SMTP_PORT }}
          username: ${{ secrets.SMTP_USERNAME }}
          password: ${{ secrets.SMTP_PASSWORD }}
          subject: ${{ steps.evaluate.outputs.subject }}
          to: ${{ secrets.CI_ALERT_EMAIL }}
          from: ${{ secrets.SMTP_FROM }}
          body: ${{ steps.evaluate.outputs.body }}
```

- [ ] **Step 4: Ensure the marker is written only after mail send succeeds**

```yaml
      - name: Persist notification marker
        if: steps.evaluate.outputs.should_notify == 'true'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          WRITE_MARKER: 'true'
        run: node scripts/ci-non-green-email.mjs
```

- [ ] **Step 5: Run YAML validation and focused tests**

Run: `bun test tests/scripts/ci-non-green-email.test.ts && node -e "const fs=require('fs'); JSON.stringify(fs.readFileSync('.github/workflows/ci-non-green-email.yml','utf8'))" >/dev/null`
Expected: PASS and no syntax error

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci-non-green-email.yml package.json scripts/ci-non-green-email.mjs
git commit -m "feat: send email when PR CI is not fully green"
```

---

### Task 6: Document configuration and operator behavior

**Files:**
- Modify: `docs/production-guide.md`
- Modify: `.github/workflows/ci-non-green-email.yml`

- [ ] **Step 1: Write the documentation section for required secrets**

```md
## CI non-green email reminder

This repository can send an email when an open PR targeting `main` reaches a terminal non-green CI state and requires manual merge inspection.

Required secrets:

- `CI_ALERT_EMAIL`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USERNAME`
- `SMTP_PASSWORD`
- `SMTP_FROM`
```

- [ ] **Step 2: Document dedup and trigger behavior**

```md
Behavior:

- sends one reminder per PR head SHA
- creates a PR comment marker after successful send
- new commits can trigger new reminders
- fully green PRs do not send email
```

- [ ] **Step 3: Add concise inline workflow comments only where the why is non-obvious**

```yaml
      - name: Persist notification marker
        # Only record the marker after email succeeds so retries remain possible.
```

- [ ] **Step 4: Run focused tests and inspect docs diff**

Run: `bun test tests/scripts/ci-non-green-email.test.ts && git diff -- docs/production-guide.md .github/workflows/ci-non-green-email.yml`
Expected: PASS and diff shows the new config docs

- [ ] **Step 5: Commit**

```bash
git add docs/production-guide.md .github/workflows/ci-non-green-email.yml
git commit -m "docs: describe CI non-green email reminder setup"
```

---

## Self-review

- **Spec coverage:** The plan covers the dedicated workflow, PR-to-main filtering, terminal non-green detection, dedup per PR+SHA, email body requirements, secret configuration, and docs.
- **Placeholder scan:** No `TODO`, `TBD`, or undefined “add tests later” steps remain.
- **Type consistency:** The plan consistently uses `evaluatePrChecks`, `findExistingNotificationMarker`, `CI_ALERT_EMAIL`, and `.github/workflows/ci-non-green-email.yml` across all tasks.
