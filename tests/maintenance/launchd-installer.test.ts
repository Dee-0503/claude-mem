import { describe, expect, it } from 'bun:test';
import { generateScheduledPlist, generateHealthCheckPlist, LAUNCHD_LABELS } from '../../src/services/maintenance/LaunchdInstaller.js';

describe('LaunchdInstaller', () => {
  it('generates scheduled plist with correct hour', () => {
    const xml = generateScheduledPlist('/path/to/runner.js', 4, 0);
    expect(xml).toContain('<integer>4</integer>');
    expect(xml).toContain('<integer>0</integer>');
    expect(xml).toContain(LAUNCHD_LABELS.scheduled);
    expect(xml).toContain('/path/to/runner.js');
    expect(xml).toContain('scheduled');
  });

  it('generates health-check plist with 3600s interval', () => {
    const xml = generateHealthCheckPlist('/path/to/runner.js');
    expect(xml).toContain('<integer>3600</integer>');
    expect(xml).toContain(LAUNCHD_LABELS.healthCheck);
    expect(xml).toContain('health-check');
  });

  it('has correct label constants', () => {
    expect(LAUNCHD_LABELS.scheduled).toBe('com.claude-mem.scheduled-maintenance');
    expect(LAUNCHD_LABELS.healthCheck).toBe('com.claude-mem.health-check');
  });
});
