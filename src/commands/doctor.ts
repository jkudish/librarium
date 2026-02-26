import type { Command } from 'commander';
import ora from 'ora';
import { getAllProviders, initializeProviders } from '../adapters/index.js';
import {
  hasApiKey,
  loadConfig,
  loadProjectConfig,
  mergeConfigs,
} from '../core/config.js';

interface DoctorResult {
  id: string;
  displayName: string;
  enabled: boolean;
  hasApiKey: boolean;
  connectivity: 'pass' | 'fail' | 'skip' | 'no-test';
  error?: string;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Health check: test provider API connectivity')
    .option('--json', 'Output JSON')
    .action(async (opts) => {
      const spinner = ora('Running health checks...').start();

      try {
        const globalConfig = loadConfig();
        const projectConfig = loadProjectConfig(process.cwd());
        const config = mergeConfigs(globalConfig, projectConfig);
        const initResult = await initializeProviders(config);
        for (const warning of initResult.warnings) {
          console.error(`[librarium] warning: ${warning}`);
        }

        const providers = getAllProviders();
        const results: DoctorResult[] = [];

        for (const provider of providers) {
          const providerConfig = config.providers[provider.id];
          const enabled = providerConfig?.enabled ?? false;
          const requiresApiKey = provider.requiresApiKey ?? true;
          const keyPresent = requiresApiKey
            ? providerConfig
              ? hasApiKey(providerConfig.apiKey)
              : !!process.env[provider.envVar]
            : true;

          if (!enabled) {
            results.push({
              id: provider.id,
              displayName: provider.displayName,
              enabled: false,
              hasApiKey: keyPresent,
              connectivity: 'skip',
            });
            continue;
          }

          if (!keyPresent) {
            results.push({
              id: provider.id,
              displayName: provider.displayName,
              enabled: true,
              hasApiKey: false,
              connectivity: 'fail',
              error: 'API key not set',
            });
            continue;
          }

          if (!provider.test) {
            results.push({
              id: provider.id,
              displayName: provider.displayName,
              enabled: true,
              hasApiKey: true,
              connectivity: 'no-test',
            });
            continue;
          }

          spinner.text = `Testing ${provider.displayName}...`;

          try {
            const testResult = await provider.test();
            results.push({
              id: provider.id,
              displayName: provider.displayName,
              enabled: true,
              hasApiKey: true,
              connectivity: testResult.ok ? 'pass' : 'fail',
              error: testResult.error,
            });
          } catch (e) {
            results.push({
              id: provider.id,
              displayName: provider.displayName,
              enabled: true,
              hasApiKey: true,
              connectivity: 'fail',
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }

        console.log('\nProvider Health Check:\n');

        for (const r of results) {
          let statusIcon: string;
          let statusText: string;

          switch (r.connectivity) {
            case 'pass':
              statusIcon = '[PASS]';
              statusText = 'Connected';
              break;
            case 'fail':
              statusIcon = '[FAIL]';
              statusText = r.error || 'Connection failed';
              break;
            case 'skip':
              statusIcon = '[SKIP]';
              statusText = 'Not enabled';
              break;
            case 'no-test':
              statusIcon = '[----]';
              statusText = 'No test endpoint';
              break;
          }

          console.log(
            `  ${statusIcon} ${r.displayName.padEnd(28)} ${statusText}`,
          );
        }

        const passCount = results.filter(
          (r) => r.connectivity === 'pass',
        ).length;
        const failCount = results.filter(
          (r) => r.connectivity === 'fail',
        ).length;
        console.log(`\n${passCount} passed, ${failCount} failed\n`);

        if (failCount > 0) {
          process.exitCode = 1;
        }
      } catch (e) {
        spinner.fail(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}
