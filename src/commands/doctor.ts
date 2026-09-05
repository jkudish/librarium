import type { Command } from 'commander';
import ora from 'ora';
import {
  getAllProviders,
  initializeProviders,
} from '../adapters/node-registry.js';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import { providerHasCredential } from '../core/provider-selection.js';
import { createNodeCredentialContext } from '../node-credentials.js';

interface DoctorResult {
  id: string;
  displayName: string;
  enabled: boolean;
  hasApiKey: boolean;
  connectivity: 'pass' | 'fail' | 'skip' | 'unchecked' | 'no-test';
  error?: string;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check provider configuration and credential presence offline')
    .option('--json', 'Output JSON')
    .option(
      '--live',
      'Test provider connectivity (makes network requests and may incur provider charges)',
    )
    .action(async (opts) => {
      const spinner = ora(
        opts.live
          ? 'Running live provider checks...'
          : 'Running offline checks...',
      ).start();

      try {
        const globalConfig = loadConfig();
        const projectConfig = loadProjectConfig(process.cwd());
        const config = mergeConfigs(globalConfig, projectConfig);
        const credentials = createNodeCredentialContext();
        const initResult = await initializeProviders({
          ...config,
          credentials,
        });
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
            ? providerHasCredential(provider, providerConfig, credentials)
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

          if (!opts.live) {
            results.push({
              id: provider.id,
              displayName: provider.displayName,
              enabled: true,
              hasApiKey: true,
              connectivity: 'unchecked',
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

        // Builtin providers with no entry in config at all: usually a config
        // created before newer adapters shipped.
        const missingFromConfig = providers
          .filter(
            (provider) =>
              (provider.source ?? 'builtin') === 'builtin' &&
              config.providers[provider.id] === undefined,
          )
          .map((provider) => provider.id);
        const passCount = results.filter(
          (r) => r.connectivity === 'pass',
        ).length;
        const failCount = results.filter(
          (r) => r.connectivity === 'fail',
        ).length;

        if (failCount > 0) {
          process.exitCode = 1;
        }

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
            case 'unchecked':
              statusIcon = '[----]';
              statusText = 'Credential present; connectivity not tested';
              break;
            case 'no-test':
              statusIcon = '[----]';
              statusText = 'Credential present; no connectivity test available';
              break;
          }

          console.log(
            `  ${statusIcon} ${r.displayName.padEnd(28)} ${statusText}`,
          );
        }

        if (opts.live) {
          console.log(`\n${passCount} passed, ${failCount} failed\n`);
        } else {
          console.log(
            `\nOffline check only; connectivity was not tested. Use \`librarium doctor --live\` to make live requests (provider charges may apply).\n`,
          );
        }

        if (missingFromConfig.length > 0) {
          console.log(
            `[WARN] ${missingFromConfig.length} builtin provider(s) missing from your config: ${missingFromConfig.join(', ')}`,
          );
          console.log('       Run `librarium init --auto` to add them.\n');
        }
      } catch (e) {
        spinner.fail(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}
