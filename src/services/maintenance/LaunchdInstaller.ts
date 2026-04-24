import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LAUNCHD_LABELS = {
  scheduled: 'com.claude-mem.scheduled-maintenance',
  healthCheck: 'com.claude-mem.health-check',
} as const;

export interface LaunchdInstallResult {
  scheduled: boolean;
  healthCheck: boolean;
}

const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const DATA_DIR = join(homedir(), '.claude-mem');
const LOGS_DIR = join(DATA_DIR, 'logs');

function plistPath(label: string): string {
  return join(LAUNCH_AGENTS_DIR, `${label}.plist`);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function basePlist(label: string, runnerPath: string, mode: 'scheduled' | 'health-check', triggerXml: string, stdoutPath: string, stderrPath: string): string {
  const nodePath = resolveNodePath();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(runnerPath)}</string>
    <string>${mode}</string>
  </array>
${triggerXml}
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

export function resolveNodePath(): string {
  try {
    const nodePath = execFileSync('which', ['node'], { encoding: 'utf-8' }).trim();
    return nodePath || '/usr/local/bin/node';
  } catch {
    return '/usr/local/bin/node';
  }
}

export function resolveRunnerScript(): string | null {
  const cacheBase = join(homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');
  if (!existsSync(cacheBase)) return null;

  const versions = readdirSync(cacheBase)
    .filter((entry) => existsSync(join(cacheBase, entry, 'scripts', 'maintenance-runner.js')))
    .sort();
  const latest = versions[versions.length - 1];
  if (!latest) return null;

  return join(cacheBase, latest, 'scripts', 'maintenance-runner.js');
}

export function generateScheduledPlist(runnerPath: string, hour: number, minute: number): string {
  return basePlist(
    LAUNCHD_LABELS.scheduled,
    runnerPath,
    'scheduled',
    `  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>`,
    join(LOGS_DIR, 'launchd-scheduled.out'),
    join(LOGS_DIR, 'launchd-scheduled.err'),
  );
}

export function generateHealthCheckPlist(runnerPath: string): string {
  return basePlist(
    LAUNCHD_LABELS.healthCheck,
    runnerPath,
    'health-check',
    `  <key>StartInterval</key>
  <integer>3600</integer>`,
    join(LOGS_DIR, 'launchd-health.out'),
    join(LOGS_DIR, 'launchd-health.err'),
  );
}

function bootstrap(plistFile: string): boolean {
  try {
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, plistFile], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function bootout(plistFile: string): boolean {
  try {
    execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, plistFile], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function installLaunchd(hour = 4, minute = 0): LaunchdInstallResult {
  const result: LaunchdInstallResult = { scheduled: false, healthCheck: false };
  if (process.platform !== 'darwin') return result;

  const runnerPath = resolveRunnerScript();
  if (!runnerPath) return result;

  mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  const scheduledPath = plistPath(LAUNCHD_LABELS.scheduled);
  const healthCheckPath = plistPath(LAUNCHD_LABELS.healthCheck);

  writeFileSync(scheduledPath, generateScheduledPlist(runnerPath, hour, minute));
  writeFileSync(healthCheckPath, generateHealthCheckPlist(runnerPath));

  result.scheduled = bootstrap(scheduledPath);
  result.healthCheck = bootstrap(healthCheckPath);
  return result;
}

export function uninstallLaunchd(): LaunchdInstallResult {
  const result: LaunchdInstallResult = { scheduled: false, healthCheck: false };
  const entries = [
    ['scheduled', plistPath(LAUNCHD_LABELS.scheduled)] as const,
    ['healthCheck', plistPath(LAUNCHD_LABELS.healthCheck)] as const,
  ];

  for (const [key, path] of entries) {
    bootout(path);
    try {
      rmSync(path, { force: true });
      result[key] = !existsSync(path);
    } catch {
      result[key] = false;
    }
  }

  return result;
}

export function isLaunchdInstalled(): LaunchdInstallResult {
  return {
    scheduled: existsSync(plistPath(LAUNCHD_LABELS.scheduled)),
    healthCheck: existsSync(plistPath(LAUNCHD_LABELS.healthCheck)),
  };
}
