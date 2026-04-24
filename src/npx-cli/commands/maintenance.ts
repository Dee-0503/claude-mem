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
