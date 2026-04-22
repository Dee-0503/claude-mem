# CI failure email reminder design

Date: 2026-04-21

## Goal

When a pull request targeting `main` has CI that is not fully green, automatically send an email reminder instructing the user to manually inspect whether the PR is safe to merge.

## Scope

This design adds a dedicated GitHub Actions notification workflow for the fork repository. It does not change merge rules, branch protection, or existing CI job logic. It only evaluates current PR check state and sends notification email when the state is non-green.

## Constraints

- GitHub Actions cannot reliably read the user's private GitHub account email address.
- The target email address must therefore be supplied via repository secrets as `CI_ALERT_EMAIL`.
- The workflow should only apply to PRs targeting `main`.
- Notifications must avoid repeated emails for the same PR head SHA.
- The reminder should only fire when a PR is open and its current checks are not fully green.

## Recommended approach

Use a dedicated workflow that reacts to PR-related CI completion and evaluates the full current check state for the PR head SHA. If any required or relevant check is in a non-success conclusion, the workflow sends a single email for that SHA saying manual merge inspection is required.

### Why this approach

- Centralizes notification logic in one place instead of duplicating mail steps across many workflows.
- Allows evaluation of aggregate PR state instead of per-job local failure state.
- Makes de-duplication straightforward by keying on PR number + head SHA.
- Keeps the existing CI workflows unchanged.

## Workflow design

### Trigger

Create a dedicated GitHub Actions workflow that listens for PR check-state changes. The workflow should respond to events that let it reevaluate the PR after CI progresses, such as completion of CI workflows relevant to pull requests.

The workflow must immediately exit unless:

- the PR is open
- the base branch is `main`
- the event is associated with a PR head SHA that can be mapped back to an open PR

### Evaluation

The workflow queries the current check status for the PR head SHA and gathers both check runs and workflow conclusions that GitHub exposes for that commit.

Treat the PR as **non-green** if any current relevant check has one of these conclusions or statuses:

- `failure`
- `cancelled`
- `timed_out`
- `action_required`
- `stale`

Checks that are still in progress should not send mail yet unless the design later expands to a delayed reminder path. For this first version, email is sent only once CI has produced at least one terminal non-success result.

### Reminder content

The email should include:

- PR number and title
- PR URL
- base branch and head branch
- head SHA
- a list of non-green checks
- a direct statement that the PR requires manual inspection before merge

Example subject:

`[claude-mem] PR #13 CI not green — manual merge inspection required`

Example body language:

`CI is not fully green for this PR. Please manually inspect whether it is safe to merge.`

## De-duplication

Only send one email per PR number + head SHA.

Recommended implementation:

- store a lightweight marker artifact, issue comment marker, or workflow cache key derived from `pr-<number>-<sha>`
- before sending email, check whether that key was already recorded
- if already recorded, exit without sending
- if not recorded, send email and record the key

If the PR gets new commits, the head SHA changes and the workflow may send a new reminder for the new SHA.

If the PR later becomes fully green without a new SHA, no new email is sent.

## Mail delivery

Recipient:

- `CI_ALERT_EMAIL` repository secret

Sender:

- use a maintained GitHub Action that supports SMTP or transactional email APIs
- credentials must come from repository secrets

Required secrets depend on chosen provider, but the design assumes at minimum:

- `CI_ALERT_EMAIL`
- provider credential secrets appropriate for the selected mail action

## Files likely involved

- `.github/workflows/ci-non-green-email.yml` — new notification workflow
- optional helper script under `scripts/` if check aggregation logic becomes too large inline
- docs update describing required secrets and behavior

## Error handling

- If PR lookup fails, log and exit without blocking CI.
- If mail credentials are missing, fail the notification workflow clearly so the configuration issue is visible.
- If GitHub API returns partial check data, treat the available non-success terminal results as authoritative and include that in logs.

## Testing strategy

1. Open a PR against `main`.
2. Force one tracked CI job to fail.
3. Confirm one email is sent to `CI_ALERT_EMAIL`.
4. Re-run the same failed checks without changing head SHA and confirm no duplicate email is sent.
5. Push a new commit that still fails and confirm a new email is sent for the new SHA.
6. Push a commit that turns the PR fully green and confirm no email is sent.

## Acceptance criteria

- An open PR targeting `main` triggers a notification email when CI reaches a non-green terminal state.
- The email explicitly says manual merge inspection is required.
- The email contains the PR link and non-green checks.
- Duplicate reminders are suppressed for the same PR head SHA.
- A new head SHA can trigger a new reminder.
- Fully green PRs do not send email.
