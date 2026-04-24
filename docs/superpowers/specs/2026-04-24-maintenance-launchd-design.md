# Maintenance & LaunchD Source Integration

## Goal

After a fresh `npx claude-mem install` on any Mac, the user automatically gets:
1. Hourly worker health-check with auto-recovery
2. Daily 4 AM scheduled maintenance restart with sleep-wake catch-up
3. All patch logic (self-healing, failed queue cleanup, stale detection) built into the product

No manual scripts, no hand-written plist, no crontab entries.

## Current State (local machine only)

### Local assets NOT in source
- `~/.claude-mem/scheduled-restart.sh` — daily 4 AM restart with network wait, graceful stop, health verify
- `~/.claude-mem/health-check.sh` — hourly check: worker responsive, initialized, stale interaction, failed pending cleanup
- `~/Library/LaunchAgents/com.ceemac.claude-mem-restart.plist` — launchd for 4 AM
- crontab entry: `0 * * * * ~/.claude-mem/health-check.sh`

### Source already has (partial)
- `src/supervisor/health-checker.ts` — only prunes process registry (every 30s)
- `src/services/worker-service.ts` — internal stale session reap, failed message purge, WAL checkpoint (every 2 min)
- `src/services/infrastructure/HealthMonitor.ts` — basic health state
- `src/npx-cli/commands/runtime.ts` — start/stop/restart/status commands
- `src/npx-cli/commands/install.ts` — install flow

## Design

### 1. New source module: `src/services/maintenance/WorkerMaintenance.ts`

Consolidates all maintenance logic from local scripts into testable TypeScript:

```
checkWorkerHealth(): Promise<HealthResult>
  - GET http://localhost:37777/api/health
  - Parse initialized, mcpReady, uptime, lastInteraction

shouldRestart(health: HealthResult, policy: MaintenancePolicy): RestartReason | null
  - worker_unresponsive: health endpoint unreachable
  - init_stuck: initialized=false && uptime > policy.initGraceMinutes
  - stale_interaction: lastInteraction > policy.staleInteractionHours ago
  - failed_queue: failed pending_messages count >= policy.failedPendingThreshold
  - scheduled: called from daily maintenance path

restartWorkerGracefully(): Promise<boolean>
  - Find worker PIDs via pgrep "worker-service"
  - SIGTERM, wait 5s
  - If still alive: SIGKILL, wait 2s
  - Spawn new worker via bun worker-service.cjs start
  - Poll health for 30s (6 checks × 5s)
  - Return success/failure

cleanupFailedPendingMessages(dbPath: string): Promise<CleanupResult>
  - Count failed messages
  - If >= threshold: archive to JSON file, delete from DB
  - Prune archive files older than 30 days

runHealthCheck(): Promise<void>
  - Acquire lock (/tmp/claude-mem-healthcheck.lock)
  - checkWorkerHealth()
  - shouldRestart() with health-check policy
  - If restart needed: cleanupFailedPendingMessages() if reason is failed_queue, then restartWorkerGracefully()
  - Log results

runScheduledMaintenance(): Promise<void>
  - Acquire lock (/tmp/claude-mem-restart.lock)
  - Check last-scheduled-restart date file — skip if already ran today
  - Wait for network (macOS: ipconfig getifaddr en0, scutil -r, ping)
  - restartWorkerGracefully()
  - Write today's date to last-scheduled-restart
  - Log results
```

### 2. New source module: `src/services/maintenance/MaintenancePolicy.ts`

```typescript
interface MaintenancePolicy {
  dailyRestartHour: number;        // default: 4
  dailyRestartMinute: number;      // default: 0
  initGraceMinutes: number;        // default: 5
  staleInteractionHours: number;   // default: 48
  failedPendingThreshold: number;  // default: 30
  archiveRetentionDays: number;    // default: 30
  networkProbeMaxAttempts: number;  // default: 12
  networkProbeIntervalSec: number; // default: 5
}
```

Loaded from `~/.claude-mem/settings.json` with sensible defaults.

### 3. New source module: `src/services/maintenance/LaunchdInstaller.ts`

Manages macOS launchd registration:

```
installLaunchd(policy: MaintenancePolicy): void
  - Generate plist for daily scheduled maintenance
  - Generate plist for hourly health-check  
  - Write to ~/Library/LaunchAgents/
  - launchctl bootstrap gui/<uid> <plist-path>

uninstallLaunchd(): void
  - launchctl bootout gui/<uid> <plist-path>
  - Remove plist files

isLaunchdInstalled(): { scheduled: boolean, healthCheck: boolean }
  - Check plist existence + launchctl list
```

Plist labels:
- `com.claude-mem.scheduled-maintenance`
- `com.claude-mem.health-check`

Plist program arguments:
- `["/usr/local/bin/node", "<cache-path>/scripts/maintenance-runner.js", "scheduled"]`
- `["/usr/local/bin/node", "<cache-path>/scripts/maintenance-runner.js", "health-check"]`

### 4. New built script: `plugin/scripts/maintenance-runner.js`

Thin entry point that launchd calls. Does:
1. Resolve plugin root (same logic as smart-install.js)
2. Ensure PATH includes bun/node
3. Import and call `runScheduledMaintenance()` or `runHealthCheck()`

This replaces both `scheduled-restart.sh` and `health-check.sh`.

### 5. CLI commands: `src/npx-cli/commands/maintenance.ts`

```
npx claude-mem maintenance health-check    — run health check once
npx claude-mem maintenance scheduled       — run scheduled maintenance once
npx claude-mem maintenance install         — install launchd agents
npx claude-mem maintenance uninstall       — remove launchd agents
npx claude-mem maintenance status          — show launchd agent status
```

### 6. Install flow integration

In `src/npx-cli/commands/install.ts`, after successful plugin install:
- On macOS: automatically call `LaunchdInstaller.installLaunchd()`
- Print confirmation: "Maintenance agents registered (daily restart + hourly health check)"

In `src/npx-cli/commands/uninstall.ts`:
- Call `LaunchdInstaller.uninstallLaunchd()`

### 7. Log rotation

Both maintenance paths rotate their own log files:
- `~/.claude-mem/logs/maintenance-scheduled.log`
- `~/.claude-mem/logs/maintenance-health.log`
- Truncate to last 500 lines when > 1MB

### 8. Network readiness (macOS only)

For scheduled maintenance only (not health-check):
- Check en0 IP via `ipconfig getifaddr en0`
- Check route via `scutil -r 8.8.8.8`
- Ping test (configurable target, default: `1.1.1.1`)
- Up to 12 attempts × 5s interval
- If first round fails: wait 60s, retry
- If still fails: skip this run (health-check will catch it)

## Files to create/modify

### New files
- `src/services/maintenance/WorkerMaintenance.ts`
- `src/services/maintenance/MaintenancePolicy.ts`
- `src/services/maintenance/LaunchdInstaller.ts`
- `src/services/maintenance/index.ts`
- `src/npx-cli/commands/maintenance.ts`
- `plugin/scripts/maintenance-runner.js`
- `tests/maintenance/worker-maintenance.test.ts`
- `tests/maintenance/launchd-installer.test.ts`

### Modified files
- `src/npx-cli/index.ts` — add `maintenance` command routing
- `src/npx-cli/commands/install.ts` — call LaunchdInstaller on macOS after install
- `src/npx-cli/commands/uninstall.ts` — call LaunchdInstaller.uninstall on macOS
- `scripts/build-hooks.js` — include maintenance-runner.js in build output

## What is NOT included

- Cross-platform support (Linux systemd, Windows Task Scheduler)
- ANTHROPIC_BASE_URL or proxy configuration (user's env, not product default)
- Hardcoded paths to `/Users/ceemac/` or `thedotmack`
- Network probe target `223.5.5.5` (use `1.1.1.1` as neutral default)

## Success criteria

1. Fresh `npx claude-mem install` on a new Mac → launchd agents registered
2. `launchctl list | grep claude-mem` shows both agents
3. At 4:00 AM (or on wake after missing it): worker restarts, health verified
4. Every hour: health check runs, auto-recovers if needed
5. `npx claude-mem maintenance status` shows agent state
6. `npx claude-mem uninstall` removes launchd agents
7. All maintenance logic is testable TypeScript, not shell
