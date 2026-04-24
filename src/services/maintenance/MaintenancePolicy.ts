import { existsSync, readFileSync } from 'node:fs';

export interface MaintenancePolicy {
  dailyRestartHour: number;
  dailyRestartMinute: number;
  initGraceMinutes: number;
  staleInteractionHours: number;
  failedPendingThreshold: number;
  archiveRetentionDays: number;
  networkProbeMaxAttempts: number;
  networkProbeIntervalSec: number;
}

export const DEFAULT_MAINTENANCE_POLICY: Readonly<MaintenancePolicy> = Object.freeze({
  dailyRestartHour: 4,
  dailyRestartMinute: 0,
  initGraceMinutes: 5,
  staleInteractionHours: 48,
  failedPendingThreshold: 30,
  archiveRetentionDays: 30,
  networkProbeMaxAttempts: 12,
  networkProbeIntervalSec: 5,
});

export function loadMaintenancePolicy(settingsPath: string): MaintenancePolicy {
  const defaults = { ...DEFAULT_MAINTENANCE_POLICY };
  if (!existsSync(settingsPath)) return defaults;

  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return {
      dailyRestartHour: raw.CLAUDE_MEM_MAINTENANCE_RESTART_HOUR ?? defaults.dailyRestartHour,
      dailyRestartMinute: raw.CLAUDE_MEM_MAINTENANCE_RESTART_MINUTE ?? defaults.dailyRestartMinute,
      initGraceMinutes: raw.CLAUDE_MEM_MAINTENANCE_INIT_GRACE_MIN ?? defaults.initGraceMinutes,
      staleInteractionHours: raw.CLAUDE_MEM_MAINTENANCE_STALE_HOURS ?? defaults.staleInteractionHours,
      failedPendingThreshold: raw.CLAUDE_MEM_MAINTENANCE_FAILED_THRESHOLD ?? defaults.failedPendingThreshold,
      archiveRetentionDays: raw.CLAUDE_MEM_MAINTENANCE_ARCHIVE_DAYS ?? defaults.archiveRetentionDays,
      networkProbeMaxAttempts: raw.CLAUDE_MEM_MAINTENANCE_NET_PROBE_MAX ?? defaults.networkProbeMaxAttempts,
      networkProbeIntervalSec: raw.CLAUDE_MEM_MAINTENANCE_NET_PROBE_INTERVAL ?? defaults.networkProbeIntervalSec,
    };
  } catch {
    return defaults;
  }
}
