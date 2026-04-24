#!/usr/bin/env node
/**
 * Thin entry point for launchd / cron to call.
 * Resolves the plugin root and delegates to the maintenance CLI.
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

// Delegate to the npx CLI maintenance subcommand
// This is the most reliable path since it goes through the installed npm package
try {
  execSync(`npx claude-mem maintenance ${command}`, {
    stdio: 'inherit',
    timeout: command === 'scheduled' ? 300000 : 120000,
    env: process.env,
  });
} catch (err) {
  console.error(`[maintenance-runner] Failed: ${err.message}`);
  process.exit(1);
}
