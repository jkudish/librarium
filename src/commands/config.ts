import type { Command } from 'commander';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';

export function registerConfigCommand(program: Command): void {
  program
    .command('config')
    .description('Print resolved configuration')
    .option('--json', 'Output raw JSON')
    .option('--global', 'Show only global config (ignore project config)')
    .action((opts) => {
      try {
        const globalConfig = loadConfig();

        if (opts.global) {
          if (opts.json) {
            console.log(JSON.stringify(globalConfig, null, 2));
          } else {
            printConfig(globalConfig, 'Global Config');
          }
          return;
        }

        const projectConfig = loadProjectConfig(process.cwd());
        const merged = mergeConfigs(globalConfig, projectConfig);

        if (opts.json) {
          console.log(JSON.stringify(merged, null, 2));
          return;
        }

        printConfig(merged, 'Resolved Config (global + project)');

        if (projectConfig) {
          console.log('  (Project config detected in current directory)\n');
        }
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}

function printConfig(config: Record<string, unknown>, title: string): void {
  console.log(`\n${title}:\n`);

  const defaults = config.defaults as Record<string, unknown>;
  console.log('  Defaults:');
  for (const [key, value] of Object.entries(defaults)) {
    console.log(`    ${key}: ${value}`);
  }

  const providers = config.providers as Record<string, Record<string, unknown>>;
  const providerIds = Object.keys(providers);
  console.log(`\n  Providers (${providerIds.length}):`);
  if (providerIds.length === 0) {
    console.log('    (none configured)');
  } else {
    for (const [id, p] of Object.entries(providers)) {
      const enabled = p.enabled ? 'enabled' : 'disabled';
      console.log(`    ${id}: ${enabled}`);
    }
  }

  const groups = config.groups as Record<string, string[]>;
  const groupNames = Object.keys(groups);
  console.log(`\n  Groups (${groupNames.length}):`);
  for (const [name, members] of Object.entries(groups)) {
    console.log(`    ${name}: ${(members as string[]).join(', ')}`);
  }

  console.log('');
}
