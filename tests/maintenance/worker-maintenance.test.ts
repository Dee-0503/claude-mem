import { describe, expect, it } from 'bun:test';
import { shouldRestart, type HealthResult } from '../../src/services/maintenance/WorkerMaintenance.js';
import { DEFAULT_MAINTENANCE_POLICY } from '../../src/services/maintenance/MaintenancePolicy.js';

const policy = DEFAULT_MAINTENANCE_POLICY;

function makeHealth(overrides: Partial<HealthResult> = {}): HealthResult {
  return {
    reachable: true,
    initialized: true,
    mcpReady: true,
    uptimeMs: 600_000,
    lastInteractionTimestamp: new Date().toISOString(),
    failedPendingCount: 0,
    ...overrides,
  };
}

describe('shouldRestart', () => {
  it('returns null for healthy worker', () => {
    expect(shouldRestart(makeHealth(), policy)).toBeNull();
  });

  it('returns worker_unresponsive when unreachable', () => {
    expect(shouldRestart(makeHealth({ reachable: false }), policy)).toBe('worker_unresponsive');
  });

  it('returns init_stuck when not initialized past grace period', () => {
    const health = makeHealth({ initialized: false, uptimeMs: 6 * 60 * 1000 });
    expect(shouldRestart(health, policy)).toBe('init_stuck');
  });

  it('returns null when not initialized but within grace period', () => {
    const health = makeHealth({ initialized: false, uptimeMs: 2 * 60 * 1000 });
    expect(shouldRestart(health, policy)).toBeNull();
  });

  it('returns stale_interaction when last interaction is old', () => {
    const old = new Date(Date.now() - 49 * 3600 * 1000).toISOString();
    expect(shouldRestart(makeHealth({ lastInteractionTimestamp: old }), policy)).toBe('stale_interaction');
  });

  it('returns failed_queue when too many failed messages', () => {
    expect(shouldRestart(makeHealth({ failedPendingCount: 31 }), policy)).toBe('failed_queue');
  });
});
