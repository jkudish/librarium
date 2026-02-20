import type { Command } from 'commander';
import { getProviderMeta, initializeProviders } from '../adapters/index.js';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';

export function registerLsCommand(program: Command): void {
  program
    .command('ls')
    .description('List all available providers')
    .option('--json', 'Output JSON')
    .action(async (opts) => {
      try {
        await initializeProviders();

        const globalConfig = loadConfig();
        const projectConfig = loadProjectConfig(process.cwd());
        const config = mergeConfigs(globalConfig, projectConfig);

        const meta = getProviderMeta(config.providers);

        if (opts.json) {
          console.log(JSON.stringify(meta, null, 2));
          return;
        }

        if (meta.length === 0) {
          console.log(
            'No providers registered. Run `librarium init` to get started.',
          );
          return;
        }

        // Table header
        const header = [
          'ID'.padEnd(20),
          'Name'.padEnd(28),
          'Tier'.padEnd(16),
          'Enabled'.padEnd(10),
          'API Key'.padEnd(10),
        ].join('  ');

        console.log(`\n${header}`);
        console.log('-'.repeat(header.length));

        for (const p of meta) {
          const enabled = p.enabled ? 'Yes' : 'No';
          const apiKey = p.hasApiKey ? 'Set' : 'Missing';
          const row = [
            p.id.padEnd(20),
            p.displayName.padEnd(28),
            p.tier.padEnd(16),
            enabled.padEnd(10),
            apiKey.padEnd(10),
          ].join('  ');
          console.log(row);
        }

        console.log('');

        // Summary
        const enabledCount = meta.filter((p) => p.enabled).length;
        const keyCount = meta.filter((p) => p.hasApiKey).length;
        console.log(
          `${meta.length} providers, ${enabledCount} enabled, ${keyCount} with API keys`,
        );
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}
