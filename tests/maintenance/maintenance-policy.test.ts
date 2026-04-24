import { describe, expect, it } from 'bun:test';
import { loadMaintenancePolicy, DEFAULT_MAINTENANCE_POLICY } from '../../src/services/maintenance/MaintenancePolicy.js';

describe('MaintenancePolicy', () => {
  it('returns sensible defaults when no settings exist', () => {
    const policy = loadMaintenancePolicy('/nonexistent/settings.json');
    expect(policy.dailyRestartHour).toBe(4);
    expect(policy.dailyRestartMinute).toBe(0);
    expect(policy.initGraceMinutes).toBe(5);
    expect(policy.staleInteractionHours).toBe(48);
    expect(policy.failedPendingThreshold).toBe(30);
    expect(policy.archiveRetentionDays).toBe(30);
    expect(policy.networkProbeMaxAttempts).toBe(12);
    expect(policy.networkProbeIntervalSec).toBe(5);
  });

  it('DEFAULT_MAINTENANCE_POLICY is frozen', () => {
    expect(Object.isFrozen(DEFAULT_MAINTENANCE_POLICY)).toBe(true);
  });
});
