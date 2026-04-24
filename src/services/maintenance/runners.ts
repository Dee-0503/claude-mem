import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadMaintenancePolicy } from './MaintenancePolicy.js';
import {
  acquireLock,
  checkWorkerHealth,
  cleanupFailedPendingMessages,
  countFailedPendingMessages,
  maintenanceLog,
  releaseLock,
  restartWorkerGracefully,
  rotateLog,
  shouldRestart,
  waitForNetwork,
} from './WorkerMaintenance.js';

export interface RunnerPaths {
  dataDir: string;
  logsDir: string;
  dbPath: string;
  settingsPath: string;
  healthCheckLock: string;
  scheduledLock: string;
  lastScheduledRestart: string;
  healthLogFile: string;
  scheduledLogFile: string;
}

export function resolveRunnerPaths(): RunnerPaths {
  const dataDir = join(homedir(), '.claude-mem');
  const logsDir = join(dataDir, 'logs');
  return {
    dataDir,
    logsDir,
    dbPath: join(dataDir, 'claude-mem.db'),
    settingsPath: join(dataDir, 'settings.json'),
    healthCheckLock: '/tmp/claude-mem-healthcheck.lock',
    scheduledLock: '/tmp/claude-mem-restart.lock',
    lastScheduledRestart: join(dataDir, 'last-scheduled-restart'),
    healthLogFile: join(logsDir, 'maintenance-health.log'),
    scheduledLogFile: join(logsDir, 'maintenance-scheduled.log'),
  };
}

function resolveWorkerPaths(): { workerScript: string; bunRunner: string } | null {
  const cacheBase = join(homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');
  if (!existsSync(cacheBase)) return null;

  const versions = readdirSync(cacheBase).sort();
  const latest = versions[versions.length - 1];
  if (!latest) return null;

  const scriptsDir = join(cacheBase, latest, 'scripts');
  const workerScript = join(scriptsDir, 'worker-service.cjs');
  const bunRunner = join(scriptsDir, 'bun-runner.js');

  if (!existsSync(workerScript)) return null;
  return { workerScript, bunRunner };
}

export async function runHealthCheck(): Promise<void> {
  const paths = resolveRunnerPaths();
  const log = (msg: string) => maintenanceLog(paths.healthLogFile, msg);

  rotateLog(paths.healthLogFile);

  if (!acquireLock(paths.healthCheckLock)) {
    log('SKIP: Health check already running');
    return;
  }

  try {
    const policy = loadMaintenancePolicy(paths.settingsPath);
    const health = await checkWorkerHealth();

    if (!health.reachable) {
      log('ALERT: Worker not responding, attempting restart');
      const wp = resolveWorkerPaths();
      if (wp) {
        const ok = await restartWorkerGracefully(wp.workerScript, wp.bunRunner);
        log(ok ? 'OK: Worker restarted successfully' : 'CRITICAL: Worker restart failed');
      } else {
        log('ERROR: Cannot find worker script');
      }
      return;
    }

    health.failedPendingCount = countFailedPendingMessages(paths.dbPath);
    const reason = shouldRestart(health, policy);

    if (!reason) {
      log(`OK: Health check passed (failed_msgs=${health.failedPendingCount})`);
      return;
    }

    log(`ALERT: Restart needed — reason=${reason}`);

    if (reason === 'failed_queue') {
      const cleanup = cleanupFailedPendingMessages(paths.dbPath, policy);
      if (cleanup.archivedCount > 0) {
        log(`OK: Archived ${cleanup.archivedCount} failed messages to ${cleanup.archivePath}`);
      }
    }

    const wp = resolveWorkerPaths();
    if (wp) {
      const ok = await restartWorkerGracefully(wp.workerScript, wp.bunRunner);
      log(ok ? `OK: Worker restarted (reason=${reason})` : `CRITICAL: Restart failed (reason=${reason})`);
    } else {
      log('ERROR: Cannot find worker script');
    }
  } finally {
    releaseLock(paths.healthCheckLock);
  }
}

export async function runScheduledMaintenance(): Promise<void> {
  const paths = resolveRunnerPaths();
  const log = (msg: string) => maintenanceLog(paths.scheduledLogFile, msg);

  rotateLog(paths.scheduledLogFile);

  if (!acquireLock(paths.scheduledLock)) {
    log('SKIP: Another scheduled maintenance instance running');
    return;
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    if (existsSync(paths.lastScheduledRestart)) {
      const lastDate = readFileSync(paths.lastScheduledRestart, 'utf-8').trim();
      if (lastDate === today) {
        log(`SKIP: Already ran today (${today})`);
        return;
      }
    }

    log('=== Scheduled maintenance start ===');
    const policy = loadMaintenancePolicy(paths.settingsPath);

    if (!(await waitForNetwork(policy))) {
      log('WARN: First network probe round failed, waiting 60s...');
      try {
        const { execSync } = await import('node:child_process');
        execSync('/bin/sleep 60');
      } catch {
        // Best-effort delay before the second probe.
      }
      if (!(await waitForNetwork(policy))) {
        log('ERROR: Network not ready, skipping (health-check will catch it)');
        return;
      }
    }

    log('Network ready, restarting worker...');
    const wp = resolveWorkerPaths();
    if (!wp) {
      log('ERROR: Cannot find worker script');
      return;
    }

    const ok = await restartWorkerGracefully(wp.workerScript, wp.bunRunner);
    writeFileSync(paths.lastScheduledRestart, today);
    log(ok ? 'OK: Worker restarted successfully' : 'ERROR: Worker restart failed');
    log('=== Scheduled maintenance end ===');
  } finally {
    releaseLock(paths.scheduledLock);
  }
}
