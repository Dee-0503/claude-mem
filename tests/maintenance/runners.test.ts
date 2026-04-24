import { describe, expect, it } from 'bun:test';
import { resolveRunnerPaths } from '../../src/services/maintenance/runners.js';

describe('resolveRunnerPaths', () => {
  it('returns paths with expected structure', () => {
    const paths = resolveRunnerPaths();
    expect(paths.dataDir).toContain('.claude-mem');
    expect(paths.logsDir).toContain('logs');
    expect(paths.dbPath).toContain('claude-mem.db');
    expect(typeof paths.healthCheckLock).toBe('string');
    expect(typeof paths.scheduledLock).toBe('string');
    expect(typeof paths.lastScheduledRestart).toBe('string');
    expect(typeof paths.healthLogFile).toBe('string');
    expect(typeof paths.scheduledLogFile).toBe('string');
  });
});
