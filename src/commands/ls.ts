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
        const globalConfig = loadConfig();
        const projectConfig = loadProjectConfig(process.cwd());
        const config = mergeConfigs(globalConfig, projectConfig);
        await initializeProviders(config.providers);

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

        const idWidth = Math.max('ID'.length, ...meta.map((p) => p.id.length));
        const nameWidth = Math.max(
          'Name'.length,
          ...meta.map((p) => p.displayName.length),
        );
        const tierWidth = Math.max(
          'Tier'.length,
          ...meta.map((p) => p.tier.length),
        );
        const enabledWidth = Math.max('Enabled'.length, 'Yes'.length);
        const apiKeyWidth = Math.max('API Key'.length, 'Missing'.length);

        // Table header
        const header = [
          'ID'.padEnd(idWidth),
          'Name'.padEnd(nameWidth),
          'Tier'.padEnd(tierWidth),
          'Enabled'.padEnd(enabledWidth),
          'API Key'.padEnd(apiKeyWidth),
        ].join('  ');

        console.log(`\n${header}`);
        console.log('-'.repeat(header.length));

        for (const p of meta) {
          const enabled = p.enabled ? 'Yes' : 'No';
          const apiKey = p.hasApiKey ? 'Set' : 'Missing';
          const row = [
            p.id.padEnd(idWidth),
            p.displayName.padEnd(nameWidth),
            p.tier.padEnd(tierWidth),
            enabled.padEnd(enabledWidth),
            apiKey.padEnd(apiKeyWidth),
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
