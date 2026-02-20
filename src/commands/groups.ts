import type { Command } from 'commander';
import { loadConfig, saveConfig } from '../core/config.js';

export function registerGroupsCommand(program: Command): void {
  const groupsCmd = program
    .command('groups')
    .description('List and manage provider groups');

  // Default action: list groups
  groupsCmd.option('--json', 'Output JSON').action((opts) => {
    try {
      const config = loadConfig();
      const groups = config.groups;

      if (opts.json) {
        console.log(JSON.stringify(groups, null, 2));
        return;
      }

      const groupNames = Object.keys(groups);
      if (groupNames.length === 0) {
        console.log('No groups configured.');
        return;
      }

      console.log('\nProvider Groups:\n');
      for (const name of groupNames) {
        const members = groups[name];
        console.log(`  ${name}`);
        console.log(`    ${members.join(', ')}`);
        console.log('');
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

  // Sub-command: add group
  groupsCmd
    .command('add')
    .description('Add or update a custom provider group')
    .argument('<name>', 'Group name')
    .argument('<providers...>', 'Provider IDs to include')
    .action((name: string, providers: string[]) => {
      try {
        const config = loadConfig();
        config.groups[name] = providers;
        saveConfig(config);
        console.log(
          `Group "${name}" saved with providers: ${providers.join(', ')}`,
        );
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });

  // Sub-command: remove group
  groupsCmd
    .command('remove')
    .description('Remove a custom group')
    .argument('<name>', 'Group name')
    .action((name: string) => {
      try {
        const config = loadConfig();
        if (!config.groups[name]) {
          console.error(`Group "${name}" not found.`);
          process.exitCode = 1;
          return;
        }
        delete config.groups[name];
        saveConfig(config);
        console.log(`Group "${name}" removed.`);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}
