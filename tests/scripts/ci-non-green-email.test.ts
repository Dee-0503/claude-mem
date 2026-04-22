import { describe, expect, it } from 'bun:test';
import { evaluatePrChecks, findExistingNotificationMarker } from '../../scripts/ci-non-green-email.mjs';

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
});

describe('findExistingNotificationMarker', () => {
  it('detects an existing notification marker for the same SHA', () => {
    const found = findExistingNotificationMarker([
      { body: 'CI reminder marker: pr=13 sha=abc123' },
      { body: 'other comment' }
    ], 13, 'abc123');

    expect(found).toBe(true);
  });
});
