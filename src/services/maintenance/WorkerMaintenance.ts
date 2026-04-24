import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import type { MaintenancePolicy } from './MaintenancePolicy.js';

export type RestartReason = 'worker_unresponsive' | 'init_stuck' | 'stale_interaction' | 'failed_queue' | 'scheduled';

export interface HealthResult {
  reachable: boolean;
  initialized: boolean;
  mcpReady: boolean;
  uptimeMs: number;
  lastInteractionTimestamp: string | null;
  failedPendingCount: number;
}

export interface CleanupResult {
  archivedCount: number;
  archivePath: string | null;
  prunedArchives: number;
}

const HEALTH_URL = 'http://127.0.0.1:37777/api/health';
const LOG_DIR = join(homedir(), '.claude-mem', 'logs');

export function shouldRestart(health: HealthResult, policy: MaintenancePolicy): RestartReason | null {
  if (!health.reachable) return 'worker_unresponsive';

  if (!health.initialized && health.uptimeMs > policy.initGraceMinutes * 60_000) {
    return 'init_stuck';
  }

  if (health.lastInteractionTimestamp) {
    const lastInteraction = Date.parse(health.lastInteractionTimestamp);
    const staleAfterMs = policy.staleInteractionHours * 3_600_000;
    if (!Number.isNaN(lastInteraction) && Date.now() - lastInteraction > staleAfterMs) {
      return 'stale_interaction';
    }
  }

  if (health.failedPendingCount >= policy.failedPendingThreshold) return 'failed_queue';

  return null;
}

export async function checkWorkerHealth(): Promise<HealthResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch(HEALTH_URL, { signal: controller.signal });
    if (!response.ok) return unreachableHealth();

    const raw = await response.json() as Partial<HealthResult>;
    return {
      reachable: true,
      initialized: Boolean(raw.initialized),
      mcpReady: Boolean(raw.mcpReady),
      uptimeMs: Number(raw.uptimeMs ?? 0),
      lastInteractionTimestamp: raw.lastInteractionTimestamp ?? null,
      failedPendingCount: Number(raw.failedPendingCount ?? 0),
    };
  } catch {
    return unreachableHealth();
  } finally {
    clearTimeout(timeout);
  }
}

export function countFailedPendingMessages(dbPath: string): number {
  try {
    const output = execSync(`sqlite3 ${shellQuote(dbPath)} "SELECT COUNT(*) FROM pending_messages WHERE status='failed';"`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Number.parseInt(output.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export function cleanupFailedPendingMessages(dbPath: string, policy: MaintenancePolicy): CleanupResult {
  const failedCount = countFailedPendingMessages(dbPath);
  let prunedArchives = 0;

  mkdirSync(LOG_DIR, { recursive: true });
  prunedArchives = pruneOldArchives(LOG_DIR, policy.archiveRetentionDays);

  if (failedCount < policy.failedPendingThreshold) {
    return { archivedCount: 0, archivePath: null, prunedArchives };
  }

  const archivePath = join(LOG_DIR, `failed-pending-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  let archivedCount = failedCount;

  try {
    const rows = execSync(`sqlite3 -json ${shellQuote(dbPath)} "SELECT * FROM pending_messages WHERE status='failed';"`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = rows.trim() ? JSON.parse(rows) : [];
    archivedCount = Array.isArray(parsed) ? parsed.length : failedCount;
    writeFileSync(archivePath, JSON.stringify(parsed, null, 2));
    execSync(`sqlite3 ${shellQuote(dbPath)} "DELETE FROM pending_messages WHERE status='failed';"`, {
      stdio: 'ignore',
    });
  } catch {
    return { archivedCount: 0, archivePath: null, prunedArchives };
  }

  return { archivedCount, archivePath, prunedArchives };
}

export async function restartWorkerGracefully(workerScriptPath: string, bunRunner: string): Promise<boolean> {
  const pids = getWorkerPids();

  for (const pid of pids) safeKill(pid, 'SIGTERM');
  await delay(5_000);

  for (const pid of getWorkerPids()) safeKill(pid, 'SIGKILL');
  if (pids.length > 0) await delay(2_000);

  const child = spawn('node', [bunRunner, workerScriptPath, 'start'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await delay(5_000);
    const health = await checkWorkerHealth();
    if (health.initialized && health.mcpReady) return true;
  }

  return false;
}

export function rotateLog(logPath: string, maxBytes = 1_048_576, keepLines = 500): void {
  try {
    if (!existsSync(logPath) || statSync(logPath).size <= maxBytes) return;

    const lines = readFileSync(logPath, 'utf-8').split('\n');
    writeFileSync(logPath, lines.slice(-keepLines).join('\n'));
  } catch {
    // Best-effort maintenance utility.
  }
}

export function maintenanceLog(logFile: string, message: string): void {
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
}

export function acquireLock(lockPath: string): boolean {
  try {
    if (existsSync(lockPath)) {
      const pid = Number.parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
      if (pid && isPidAlive(pid)) return false;
    }

    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // Best-effort cleanup.
  }
}

export async function waitForNetwork(policy: MaintenancePolicy): Promise<boolean> {
  if (platform() !== 'darwin') return true;

  for (let attempt = 0; attempt < policy.networkProbeMaxAttempts; attempt += 1) {
    if (hasNetwork()) return true;
    if (attempt < policy.networkProbeMaxAttempts - 1) {
      await delay(policy.networkProbeIntervalSec * 1_000);
    }
  }

  return false;
}

function unreachableHealth(): HealthResult {
  return {
    reachable: false,
    initialized: false,
    mcpReady: false,
    uptimeMs: 0,
    lastInteractionTimestamp: null,
    failedPendingCount: 0,
  };
}

function pruneOldArchives(logDir: string, retentionDays: number): number {
  try {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const files = execSync(`find ${shellQuote(logDir)} -name 'failed-pending-*.json' -type f`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').filter(Boolean);

    let pruned = 0;
    for (const file of files) {
      try {
        if (statSync(file).mtimeMs < cutoff) {
          unlinkSync(file);
          pruned += 1;
        }
      } catch {
        // Continue pruning other archives.
      }
    }
    return pruned;
  } catch {
    return 0;
  }
}

function getWorkerPids(): number[] {
  try {
    const output = execSync('pgrep -f worker-service', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split('\n')
      .map((pid) => Number.parseInt(pid.trim(), 10))
      .filter((pid) => pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

function safeKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Process already exited or cannot be signaled.
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hasNetwork(): boolean {
  try {
    execSync('ipconfig getifaddr en0', { stdio: 'ignore' });
    execSync('scutil -r 1.1.1.1', { stdio: 'ignore' });
    execSync('ping -c 1 -W 1000 1.1.1.1', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
