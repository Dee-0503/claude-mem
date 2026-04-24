# Maintenance & LaunchD Source Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After `npx claude-mem install` on any Mac, launchd agents are auto-registered for daily 4 AM scheduled maintenance and hourly health-check with full self-healing — no manual scripts needed.

**Architecture:** New `src/services/maintenance/` module houses all maintenance logic as testable TypeScript. A thin `plugin/scripts/maintenance-runner.js` entry point is what launchd calls. `src/npx-cli/commands/maintenance.ts` provides CLI subcommands. Install/uninstall flows auto-register/remove launchd agents on macOS.

**Tech Stack:** TypeScript, Node.js child_process, macOS launchd plist XML, existing worker-utils/paths infrastructure.

---

### Task 1: MaintenancePolicy — Configuration & Defaults

**Files:**
- Create: `src/services/maintenance/MaintenancePolicy.ts`
- Test: `tests/maintenance/maintenance-policy.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/maintenance/maintenance-policy.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/maintenance/maintenance-policy.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/services/maintenance/MaintenancePolicy.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/maintenance/maintenance-policy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/maintenance/MaintenancePolicy.ts tests/maintenance/maintenance-policy.test.ts
git commit -m "feat(maintenance): add MaintenancePolicy with defaults and settings loading"
```

---

### Task 2: WorkerMaintenance — Health Check & Restart Logic

**Files:**
- Create: `src/services/maintenance/WorkerMaintenance.ts`
- Test: `tests/maintenance/worker-maintenance.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/maintenance/worker-maintenance.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/maintenance/worker-maintenance.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/services/maintenance/WorkerMaintenance.ts
import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, appendFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { MaintenancePolicy } from './MaintenancePolicy.js';

export type RestartReason =
  | 'worker_unresponsive'
  | 'init_stuck'
  | 'stale_interaction'
  | 'failed_queue'
  | 'scheduled';

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

const DATA_DIR = join(homedir(), '.claude-mem');
const LOGS_DIR = join(DATA_DIR, 'logs');
const DB_PATH = join(DATA_DIR, 'claude-mem.db');
const WORKER_PORT = 37777;

export function shouldRestart(health: HealthResult, policy: MaintenancePolicy): RestartReason | null {
  if (!health.reachable) return 'worker_unresponsive';

  if (!health.initialized && health.uptimeMs > policy.initGraceMinutes * 60 * 1000) {
    return 'init_stuck';
  }

  if (health.lastInteractionTimestamp) {
    const lastMs = new Date(health.lastInteractionTimestamp).getTime();
    const diffHours = (Date.now() - lastMs) / (3600 * 1000);
    if (diffHours >= policy.staleInteractionHours) return 'stale_interaction';
  }

  if (health.failedPendingCount >= policy.failedPendingThreshold) return 'failed_queue';

  return null;
}

export async function checkWorkerHealth(): Promise<HealthResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`http://127.0.0.1:${WORKER_PORT}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { reachable: false, initialized: false, mcpReady: false, uptimeMs: 0, lastInteractionTimestamp: null, failedPendingCount: 0 };
    }

    const data = await response.json() as Record<string, unknown>;
    const lastTs = (data.lastInteraction as Record<string, unknown>)?.timestamp as string | undefined;

    return {
      reachable: true,
      initialized: !!data.initialized,
      mcpReady: !!data.mcpReady,
      uptimeMs: (data.uptime as number) ?? 0,
      lastInteractionTimestamp: lastTs ?? null,
      failedPendingCount: 0, // will be filled by caller from DB query
    };
  } catch {
    return { reachable: false, initialized: false, mcpReady: false, uptimeMs: 0, lastInteractionTimestamp: null, failedPendingCount: 0 };
  }
}

export function countFailedPendingMessages(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  try {
    const output = execSync(
      `sqlite3 "${dbPath}" "SELECT COUNT(*) FROM pending_messages WHERE status='failed';"`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    return parseInt(output, 10) || 0;
  } catch {
    return 0;
  }
}

export function cleanupFailedPendingMessages(dbPath: string, policy: MaintenancePolicy): CleanupResult {
  const count = countFailedPendingMessages(dbPath);
  if (count < policy.failedPendingThreshold) {
    return { archivedCount: 0, archivePath: null, prunedArchives: 0 };
  }

  mkdirSync(LOGS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = join(LOGS_DIR, `failed_messages_${timestamp}.json`);

  try {
    const archived = execSync(
      `sqlite3 "${dbPath}" "SELECT json_group_array(json_object('id',id,'session_id',session_id,'status',status,'created_at',created_at,'content',content)) FROM pending_messages WHERE status='failed';"`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    writeFileSync(archivePath, archived);
    execSync(`sqlite3 "${dbPath}" "DELETE FROM pending_messages WHERE status='failed';"`, { timeout: 10000 });
  } catch {
    return { archivedCount: 0, archivePath: null, prunedArchives: 0 };
  }

  // Prune old archives
  let prunedArchives = 0;
  const cutoff = Date.now() - policy.archiveRetentionDays * 86400 * 1000;
  try {
    for (const f of readdirSync(LOGS_DIR)) {
      if (!f.startsWith('failed_messages_') || !f.endsWith('.json')) continue;
      const full = join(LOGS_DIR, f);
      if (statSync(full).mtimeMs < cutoff) {
        unlinkSync(full);
        prunedArchives++;
      }
    }
  } catch { /* best effort */ }

  return { archivedCount: count, archivePath, prunedArchives };
}

export function restartWorkerGracefully(workerScriptPath: string, bunPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Kill existing workers
    try {
      const pids = execSync('pgrep -f "worker-service"', { encoding: 'utf-8', timeout: 3000 }).trim();
      if (pids) {
        for (const pid of pids.split('\n')) {
          try { process.kill(parseInt(pid, 10), 'SIGTERM'); } catch { /* already dead */ }
        }
      }
    } catch { /* no workers running */ }

    // Wait for graceful shutdown
    setTimeout(() => {
      // Force kill survivors
      try {
        const remaining = execSync('pgrep -f "worker-service"', { encoding: 'utf-8', timeout: 3000 }).trim();
        if (remaining) {
          for (const pid of remaining.split('\n')) {
            try { process.kill(parseInt(pid, 10), 'SIGKILL'); } catch { /* already dead */ }
          }
        }
      } catch { /* none remaining */ }

      // Start new worker
      setTimeout(() => {
        const child = spawn('node', [bunPath, workerScriptPath, 'start'], {
          stdio: 'ignore',
          detached: true,
          env: process.env,
        });
        child.unref();

        // Poll health for 30s (6 checks × 5s)
        let checks = 0;
        const interval = setInterval(async () => {
          checks++;
          try {
            const health = await checkWorkerHealth();
            if (health.initialized && health.mcpReady) {
              clearInterval(interval);
              resolve(true);
            }
          } catch { /* still starting */ }

          if (checks >= 6) {
            clearInterval(interval);
            resolve(false);
          }
        }, 5000);
      }, 2000);
    }, 5000);
  });
}

// --- Log rotation ---

export function rotateLog(logPath: string, maxBytes = 1048576, keepLines = 500): void {
  if (!existsSync(logPath)) return;
  try {
    const stat = statSync(logPath);
    if (stat.size <= maxBytes) return;
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');
    writeFileSync(logPath, lines.slice(-keepLines).join('\n'));
  } catch { /* best effort */ }
}

export function maintenanceLog(logFile: string, message: string): void {
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
}

// --- Lock file ---

export function acquireLock(lockPath: string): boolean {
  if (existsSync(lockPath)) {
    try {
      const pid = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 0); return false; } catch { /* stale lock */ }
      }
    } catch { /* unreadable lock */ }
  }
  writeFileSync(lockPath, String(process.pid));
  return true;
}

export function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* best effort */ }
}

// --- Network readiness (macOS) ---

export function waitForNetwork(policy: MaintenancePolicy): boolean {
  if (process.platform !== 'darwin') return true;

  for (let attempt = 0; attempt < policy.networkProbeMaxAttempts; attempt++) {
    try {
      const ip = execSync('/usr/sbin/ipconfig getifaddr en0 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim();
      if (!ip) { execSync(`/bin/sleep ${policy.networkProbeIntervalSec}`); continue; }

      const reachable = execSync('scutil -r 8.8.8.8 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim();
      if (!reachable.includes('Reachable')) { execSync(`/bin/sleep ${policy.networkProbeIntervalSec}`); continue; }

      try {
        execSync('/sbin/ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1', { timeout: 5000 });
        return true;
      } catch { /* ping failed */ }
    } catch { /* probe error */ }
    try { execSync(`/bin/sleep ${policy.networkProbeIntervalSec}`); } catch { /* */ }
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/maintenance/worker-maintenance.test.ts`
Expected: 6 PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/maintenance/WorkerMaintenance.ts tests/maintenance/worker-maintenance.test.ts
git commit -m "feat(maintenance): add WorkerMaintenance with health check, restart, and cleanup logic"
```

---

### Task 3: Maintenance Runner Entry Points — health-check & scheduled

**Files:**
- Create: `src/services/maintenance/index.ts`
- Create: `src/services/maintenance/runners.ts`
- Test: `tests/maintenance/runners.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/maintenance/runners.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/maintenance/runners.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write runners.ts and index.ts**

```typescript
// src/services/maintenance/runners.ts
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { loadMaintenancePolicy } from './MaintenancePolicy.js';
import {
  checkWorkerHealth,
  countFailedPendingMessages,
  shouldRestart,
  cleanupFailedPendingMessages,
  restartWorkerGracefully,
  rotateLog,
  maintenanceLog,
  acquireLock,
  releaseLock,
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

    if (!waitForNetwork(policy)) {
      log('WARN: First network probe round failed, waiting 60s...');
      try { const { execSync: es } = await import('node:child_process'); es('/bin/sleep 60'); } catch {}
      if (!waitForNetwork(policy)) {
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
```

```typescript
// src/services/maintenance/index.ts
export { loadMaintenancePolicy, DEFAULT_MAINTENANCE_POLICY } from './MaintenancePolicy.js';
export type { MaintenancePolicy } from './MaintenancePolicy.js';
export { shouldRestart, checkWorkerHealth, restartWorkerGracefully, cleanupFailedPendingMessages } from './WorkerMaintenance.js';
export type { HealthResult, RestartReason, CleanupResult } from './WorkerMaintenance.js';
export { runHealthCheck, runScheduledMaintenance, resolveRunnerPaths } from './runners.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/maintenance/runners.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/maintenance/runners.ts src/services/maintenance/index.ts tests/maintenance/runners.test.ts
git commit -m "feat(maintenance): add health-check and scheduled maintenance runner entry points"
```

---

### Task 4: LaunchdInstaller — plist generation, install, uninstall

**Files:**
- Create: `src/services/maintenance/LaunchdInstaller.ts`
- Test: `tests/maintenance/launchd-installer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/maintenance/launchd-installer.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/maintenance/launchd-installer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/services/maintenance/LaunchdInstaller.ts
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const LAUNCHD_LABELS = {
  scheduled: 'com.claude-mem.scheduled-maintenance',
  healthCheck: 'com.claude-mem.health-check',
} as const;

const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const DATA_DIR = join(homedir(), '.claude-mem');
const LOGS_DIR = join(DATA_DIR, 'logs');

function plistPath(label: string): string {
  return join(LAUNCH_AGENTS_DIR, `${label}.plist`);
}

function resolveNodePath(): string {
  try {
    return execSync('which node', { encoding: 'utf-8', timeout: 3000 }).trim();
  } catch {
    return '/usr/local/bin/node';
  }
}

function resolveRunnerScript(): string | null {
  const cacheBase = join(homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');
  if (!existsSync(cacheBase)) return null;

  const versions = readdirSync(cacheBase).sort();
  const latest = versions[versions.length - 1];
  if (!latest) return null;

  const runner = join(cacheBase, latest, 'scripts', 'maintenance-runner.js');
  return existsSync(runner) ? runner : null;
}

export function generateScheduledPlist(runnerPath: string, hour: number, minute: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCHD_LABELS.scheduled}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${resolveNodePath()}</string>
      <string>${runnerPath}</string>
      <string>scheduled</string>
    </array>

    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>
      <integer>${hour}</integer>
      <key>Minute</key>
      <integer>${minute}</integer>
    </dict>

    <key>StandardOutPath</key>
    <string>${LOGS_DIR}/launchd-scheduled.out</string>
    <key>StandardErrorPath</key>
    <string>${LOGS_DIR}/launchd-scheduled.err</string>
  </dict>
</plist>`;
}

export function generateHealthCheckPlist(runnerPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCHD_LABELS.healthCheck}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${resolveNodePath()}</string>
      <string>${runnerPath}</string>
      <string>health-check</string>
    </array>

    <key>StartInterval</key>
    <integer>3600</integer>

    <key>StandardOutPath</key>
    <string>${LOGS_DIR}/launchd-health.out</string>
    <key>StandardErrorPath</key>
    <string>${LOGS_DIR}/launchd-health.err</string>
  </dict>
</plist>`;
}

export function installLaunchd(hour = 4, minute = 0): { scheduled: boolean; healthCheck: boolean } {
  if (process.platform !== 'darwin') return { scheduled: false, healthCheck: false };

  const runnerPath = resolveRunnerScript();
  if (!runnerPath) return { scheduled: false, healthCheck: false };

  mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  const uid = process.getuid?.() ?? execSync('id -u', { encoding: 'utf-8' }).trim();
  const results = { scheduled: false, healthCheck: false };

  // Scheduled maintenance
  try {
    const path = plistPath(LAUNCHD_LABELS.scheduled);
    try { execSync(`launchctl bootout gui/${uid} "${path}" 2>/dev/null`); } catch { /* not loaded */ }
    writeFileSync(path, generateScheduledPlist(runnerPath, hour, minute));
    execSync(`launchctl bootstrap gui/${uid} "${path}"`);
    results.scheduled = true;
  } catch { /* install failed */ }

  // Health check
  try {
    const path = plistPath(LAUNCHD_LABELS.healthCheck);
    try { execSync(`launchctl bootout gui/${uid} "${path}" 2>/dev/null`); } catch { /* not loaded */ }
    writeFileSync(path, generateHealthCheckPlist(runnerPath));
    execSync(`launchctl bootstrap gui/${uid} "${path}"`);
    results.healthCheck = true;
  } catch { /* install failed */ }

  return results;
}

export function uninstallLaunchd(): { scheduled: boolean; healthCheck: boolean } {
  if (process.platform !== 'darwin') return { scheduled: false, healthCheck: false };

  const uid = process.getuid?.() ?? (() => { try { return execSync('id -u', { encoding: 'utf-8' }).trim(); } catch { return '501'; } })();
  const results = { scheduled: false, healthCheck: false };

  for (const [key, label] of Object.entries(LAUNCHD_LABELS)) {
    const path = plistPath(label);
    try { execSync(`launchctl bootout gui/${uid} "${path}" 2>/dev/null`); } catch { /* not loaded */ }
    if (existsSync(path)) {
      try { unlinkSync(path); (results as any)[key] = true; } catch { /* */ }
    }
  }

  return results;
}

export function isLaunchdInstalled(): { scheduled: boolean; healthCheck: boolean } {
  return {
    scheduled: existsSync(plistPath(LAUNCHD_LABELS.scheduled)),
    healthCheck: existsSync(plistPath(LAUNCHD_LABELS.healthCheck)),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/maintenance/launchd-installer.test.ts`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/maintenance/LaunchdInstaller.ts tests/maintenance/launchd-installer.test.ts
git commit -m "feat(maintenance): add LaunchdInstaller for macOS plist generation and registration"
```

---

### Task 5: maintenance-runner.js — launchd entry point script

**Files:**
- Create: `plugin/scripts/maintenance-runner.js`

- [ ] **Step 1: Write the entry point script**

```javascript
// plugin/scripts/maintenance-runner.js
#!/usr/bin/env node
/**
 * Thin entry point for launchd / cron to call.
 * Resolves the plugin root and delegates to the maintenance module.
 *
 * Usage:
 *   node maintenance-runner.js scheduled
 *   node maintenance-runner.js health-check
 */
const { existsSync, readdirSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');
const { execSync } = require('child_process');

// Ensure PATH includes common tool locations
for (const d of [
  join(homedir(), '.bun', 'bin'),
  join(homedir(), '.local', 'bin'),
  '/usr/local/bin',
]) {
  if (existsSync(d) && !process.env.PATH.includes(d)) {
    process.env.PATH = `${d}:${process.env.PATH}`;
  }
}

const command = process.argv[2];
if (!command || !['scheduled', 'health-check'].includes(command)) {
  console.error('Usage: node maintenance-runner.js <scheduled|health-check>');
  process.exit(1);
}

// Find the latest cached plugin version to import maintenance module
const cacheBase = join(homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');
let pluginRoot = null;

if (existsSync(cacheBase)) {
  const versions = readdirSync(cacheBase).sort();
  const latest = versions[versions.length - 1];
  if (latest) pluginRoot = join(cacheBase, latest);
}

// Fallback to marketplace directory
if (!pluginRoot) {
  const marketplace = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
  if (existsSync(join(marketplace, 'plugin'))) pluginRoot = join(marketplace, 'plugin');
}

if (!pluginRoot) {
  console.error('[maintenance-runner] Cannot find claude-mem plugin');
  process.exit(1);
}

// Use bun to run the actual maintenance since the module uses ESM imports
const bunRunner = join(pluginRoot, 'scripts', 'bun-runner.js');
const workerScript = join(pluginRoot, 'scripts', 'worker-service.cjs');

// For now, delegate to the worker-service.cjs maintenance subcommand
// This will be updated when the TS modules are built into the plugin bundle
try {
  if (command === 'health-check') {
    // Import and run directly via dynamic import (Node 18+)
    import(join(pluginRoot, '..', '..', '..', '..', '..', 'src', 'services', 'maintenance', 'index.js'))
      .then(m => m.runHealthCheck())
      .catch(() => {
        // Fallback: use the built CLI
        execSync(`npx claude-mem maintenance health-check`, {
          stdio: 'inherit',
          timeout: 120000,
          env: process.env,
        });
      });
  } else {
    import(join(pluginRoot, '..', '..', '..', '..', '..', 'src', 'services', 'maintenance', 'index.js'))
      .then(m => m.runScheduledMaintenance())
      .catch(() => {
        execSync(`npx claude-mem maintenance scheduled`, {
          stdio: 'inherit',
          timeout: 300000,
          env: process.env,
        });
      });
  }
} catch (err) {
  console.error(`[maintenance-runner] Failed: ${err.message}`);
  process.exit(1);
}
```

- [ ] **Step 2: Verify the script is valid Node.js**

Run: `node -c plugin/scripts/maintenance-runner.js`
Expected: no syntax errors

- [ ] **Step 3: Commit**

```bash
git add plugin/scripts/maintenance-runner.js
git commit -m "feat(maintenance): add maintenance-runner.js entry point for launchd"
```

---

### Task 6: CLI Commands — `npx claude-mem maintenance`

**Files:**
- Create: `src/npx-cli/commands/maintenance.ts`
- Modify: `src/npx-cli/index.ts`

- [ ] **Step 1: Write the CLI command module**

```typescript
// src/npx-cli/commands/maintenance.ts
import pc from 'picocolors';

export async function runMaintenanceCommand(subCommand: string | undefined): Promise<void> {
  switch (subCommand) {
    case 'health-check': {
      console.log(pc.cyan('Running health check...'));
      const { runHealthCheck } = await import('../../services/maintenance/index.js');
      await runHealthCheck();
      console.log(pc.green('Health check complete.'));
      break;
    }

    case 'scheduled': {
      console.log(pc.cyan('Running scheduled maintenance...'));
      const { runScheduledMaintenance } = await import('../../services/maintenance/index.js');
      await runScheduledMaintenance();
      console.log(pc.green('Scheduled maintenance complete.'));
      break;
    }

    case 'install': {
      if (process.platform !== 'darwin') {
        console.error(pc.red('Maintenance agents are only supported on macOS.'));
        process.exit(1);
      }
      const { installLaunchd } = await import('../../services/maintenance/LaunchdInstaller.js');
      const { loadMaintenancePolicy } = await import('../../services/maintenance/MaintenancePolicy.js');
      const { join } = await import('node:path');
      const { homedir } = await import('node:os');
      const policy = loadMaintenancePolicy(join(homedir(), '.claude-mem', 'settings.json'));
      const result = installLaunchd(policy.dailyRestartHour, policy.dailyRestartMinute);
      if (result.scheduled) console.log(pc.green('✓ Daily scheduled maintenance agent installed'));
      else console.error(pc.red('✗ Failed to install scheduled maintenance agent'));
      if (result.healthCheck) console.log(pc.green('✓ Hourly health check agent installed'));
      else console.error(pc.red('✗ Failed to install health check agent'));
      break;
    }

    case 'uninstall': {
      if (process.platform !== 'darwin') {
        console.error(pc.red('Maintenance agents are only supported on macOS.'));
        process.exit(1);
      }
      const { uninstallLaunchd } = await import('../../services/maintenance/LaunchdInstaller.js');
      const result = uninstallLaunchd();
      console.log(result.scheduled || result.healthCheck
        ? pc.green('Maintenance agents removed.')
        : pc.dim('No maintenance agents found.'));
      break;
    }

    case 'status': {
      if (process.platform !== 'darwin') {
        console.log(pc.dim('Maintenance agents are only supported on macOS.'));
        return;
      }
      const { isLaunchdInstalled } = await import('../../services/maintenance/LaunchdInstaller.js');
      const status = isLaunchdInstalled();
      console.log(`Scheduled maintenance: ${status.scheduled ? pc.green('installed') : pc.red('not installed')}`);
      console.log(`Hourly health check:   ${status.healthCheck ? pc.green('installed') : pc.red('not installed')}`);
      break;
    }

    default:
      console.error(pc.red(`Unknown maintenance subcommand: ${subCommand ?? '(none)'}`));
      console.error(`Usage: npx claude-mem maintenance <health-check|scheduled|install|uninstall|status>`);
      process.exit(1);
  }
}
```

- [ ] **Step 2: Add routing in index.ts**

In `src/npx-cli/index.ts`, add a new case in the `switch (command)` block before the `default:` case:

```typescript
    // -- Maintenance -------------------------------------------------------
    case 'maintenance': {
      const { runMaintenanceCommand } = await import('./commands/maintenance.js');
      await runMaintenanceCommand(args[1]?.toLowerCase());
      break;
    }
```

Also add to the help text in `printHelp()`:

```typescript
${pc.bold('Maintenance Commands')} (macOS only):
  ${pc.cyan('npx claude-mem maintenance status')}        Show launchd agent status
  ${pc.cyan('npx claude-mem maintenance install')}       Install launchd agents
  ${pc.cyan('npx claude-mem maintenance uninstall')}     Remove launchd agents
  ${pc.cyan('npx claude-mem maintenance health-check')}  Run health check once
  ${pc.cyan('npx claude-mem maintenance scheduled')}     Run scheduled maintenance once
```

- [ ] **Step 3: Verify syntax**

Run: `npx tsc --noEmit src/npx-cli/commands/maintenance.ts 2>&1 || true`

- [ ] **Step 4: Commit**

```bash
git add src/npx-cli/commands/maintenance.ts src/npx-cli/index.ts
git commit -m "feat(maintenance): add CLI commands for maintenance health-check, scheduled, install, uninstall, status"
```

---

### Task 7: Install/Uninstall Integration — auto-register launchd on macOS

**Files:**
- Modify: `src/npx-cli/commands/install.ts`
- Modify: `src/npx-cli/commands/uninstall.ts`

- [ ] **Step 1: Add launchd install step to install.ts**

In `src/npx-cli/commands/install.ts`, inside the `runTasks([...])` array (after the 'Setting up Bun and uv' task around line 518), add a new task:

```typescript
      {
        title: 'Registering maintenance agents',
        task: async (message) => {
          if (process.platform !== 'darwin') {
            return `Maintenance agents skipped (macOS only) ${pc.dim('—')}`;
          }
          message('Installing launchd agents...');
          try {
            const { installLaunchd } = await import('../../services/maintenance/LaunchdInstaller.js');
            const { loadMaintenancePolicy } = await import('../../services/maintenance/MaintenancePolicy.js');
            const policy = loadMaintenancePolicy(join(homedir(), '.claude-mem', 'settings.json'));
            const result = installLaunchd(policy.dailyRestartHour, policy.dailyRestartMinute);
            if (result.scheduled && result.healthCheck) {
              return `Maintenance agents registered ${pc.green('OK')}`;
            }
            return `Maintenance agents partially registered ${pc.yellow('!')}`;
          } catch {
            return `Maintenance agents skipped ${pc.yellow('!')}`;
          }
        },
      },
```

Add `import { homedir } from 'node:os';` and `import { join } from 'node:path';` at the top if not already present.

- [ ] **Step 2: Add launchd uninstall step to uninstall.ts**

In `src/npx-cli/commands/uninstall.ts`, add to the `ideCleanups` array (around line 198):

```typescript
    { label: 'Maintenance agents', fn: async () => {
      if (process.platform !== 'darwin') return 0;
      const { uninstallLaunchd } = await import('../../services/maintenance/LaunchdInstaller.js');
      const result = uninstallLaunchd();
      return (result.scheduled || result.healthCheck) ? 1 : 0;
    }},
```

- [ ] **Step 3: Verify build**

Run: `npm run build 2>&1 | tail -5`

- [ ] **Step 4: Commit**

```bash
git add src/npx-cli/commands/install.ts src/npx-cli/commands/uninstall.ts
git commit -m "feat(maintenance): auto-register launchd agents during install, remove during uninstall"
```

---

### Task 8: Build Integration — include maintenance-runner.js

**Files:**
- Modify: `scripts/build-hooks.js`

- [ ] **Step 1: Add maintenance-runner.js to build outputs**

In `scripts/build-hooks.js`, find the array/list of files that get copied to `plugin/scripts/` and add `maintenance-runner.js`. The exact change depends on the build script structure — look for where `worker-service.cjs`, `bun-runner.js`, or `smart-install.js` are listed and add `maintenance-runner.js` alongside them.

- [ ] **Step 2: Verify build includes the file**

Run: `npm run build && ls -la plugin/scripts/maintenance-runner.js`
Expected: file exists

- [ ] **Step 3: Commit**

```bash
git add scripts/build-hooks.js
git commit -m "build: include maintenance-runner.js in plugin build output"
```

---

### Task 9: Full Integration Test

**Files:**
- No new files — verification only

- [ ] **Step 1: Run all maintenance tests**

Run: `bun test tests/maintenance/`
Expected: All pass (maintenance-policy, worker-maintenance, runners, launchd-installer)

- [ ] **Step 2: Run existing test suite for regressions**

Run: `bun test tests/worker/agents/response-processor.test.ts tests/worker/process-registry.test.ts tests/infrastructure/process-manager.test.ts tests/services/sqlite/observations/store-subagent-label.test.ts`
Expected: All pass

- [ ] **Step 3: Verify CLI commands work**

Run: `npx claude-mem maintenance status`
Expected: Shows installed/not-installed status for both agents

- [ ] **Step 4: Verify install registers agents**

Run: `npx claude-mem maintenance install && launchctl list | grep claude-mem`
Expected: Both `com.claude-mem.scheduled-maintenance` and `com.claude-mem.health-check` appear

- [ ] **Step 5: Verify uninstall removes agents**

Run: `npx claude-mem maintenance uninstall && launchctl list | grep claude-mem`
Expected: No claude-mem agents listed

- [ ] **Step 6: Commit all remaining changes**

```bash
git add -A
git commit -m "test: verify full maintenance & launchd integration"
```

---

### Task 10: Clean up old local scripts

**Files:**
- No source changes — local machine cleanup

- [ ] **Step 1: Remove old crontab entry**

Run: `crontab -l | grep -v "claude-mem/health-check.sh" | crontab -`

- [ ] **Step 2: Unload old launchd agent**

Run: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ceemac.claude-mem-restart.plist 2>/dev/null; rm -f ~/Library/LaunchAgents/com.ceemac.claude-mem-restart.plist`

- [ ] **Step 3: Verify new agents are active**

Run: `npx claude-mem maintenance install && npx claude-mem maintenance status`
Expected: Both agents installed

- [ ] **Step 4: Archive old scripts (don't delete yet)**

Run: `mkdir -p ~/.claude-mem/archived-scripts && mv ~/.claude-mem/scheduled-restart.sh ~/.claude-mem/health-check.sh ~/.claude-mem/archived-scripts/ 2>/dev/null; echo "Archived"`
