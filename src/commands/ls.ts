import type { Command } from 'commander';
import {
  getProviderMeta,
  initializeProviders,
} from '../adapters/node-registry.js';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import { createNodeCredentialContext } from '../node-credentials.js';
import { dimText, isColorEnabled } from './run-format.js';

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
        const credentials = createNodeCredentialContext();
        const initResult = await initializeProviders({
          ...config,
          credentials,
        });
        for (const warning of initResult.warnings) {
          console.error(`[librarium] warning: ${warning}`);
        }

        const meta = getProviderMeta(config.providers, credentials);

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
        const meteringWidth = Math.max(
          'Metering'.length,
          ...meta.map((p) => (p.meteringKind ?? '').length),
        );
        const sourceWidth = Math.max(
          'Source'.length,
          ...meta.map((p) => p.source.length),
        );
        const enabledWidth = Math.max('Enabled'.length, 'Yes'.length);
        const apiKeyWidth = Math.max('API Key'.length, 'Not configured'.length);
        const credentialSourceWidth = Math.max(
          'Credential'.length,
          'Keychain'.length,
          'Environment'.length,
          'Config file'.length,
          'Missing'.length,
        );
        const targetWidth = Math.max(
          'Target'.length,
          ...meta.map((p) => targetLabel(p.target).length),
        );
        const color = isColorEnabled(process.stdout);

        // Table header
        const header = [
          'ID'.padEnd(idWidth),
          'Name'.padEnd(nameWidth),
          'Tier'.padEnd(tierWidth),
          'Metering'.padEnd(meteringWidth),
          'Source'.padEnd(sourceWidth),
          'Enabled'.padEnd(enabledWidth),
          'API Key'.padEnd(apiKeyWidth),
          'Credential'.padEnd(credentialSourceWidth),
          'Target'.padEnd(targetWidth),
        ].join('  ');

        console.log(`\n${header}`);
        console.log('-'.repeat(header.length));

        for (const p of meta) {
          // Providers without a config entry (e.g. builtins added after the
          // user last ran init) are listed but dimmed.
          const configured = p.configured !== false;
          const enabled = p.enabled ? 'Yes' : 'No';
          const apiKey = p.hasApiKey
            ? 'Set'
            : configured
              ? 'Missing'
              : 'Not configured';
          const credentialSource =
            p.credentialSource === 'keychain'
              ? 'Keychain'
              : p.credentialSource === 'env'
                ? 'Environment'
                : p.credentialSource === 'literal'
                  ? 'Config file'
                  : 'Missing';
          const row = [
            p.id.padEnd(idWidth),
            p.displayName.padEnd(nameWidth),
            p.tier.padEnd(tierWidth),
            (p.meteringKind ?? '').padEnd(meteringWidth),
            p.source.padEnd(sourceWidth),
            enabled.padEnd(enabledWidth),
            apiKey.padEnd(apiKeyWidth),
            credentialSource.padEnd(credentialSourceWidth),
            targetLabel(p.target).padEnd(targetWidth),
          ].join('  ');
          console.log(configured ? row : dimText(row, color));
        }

        console.log('');

        // Summary
        const enabledCount = meta.filter((p) => p.enabled).length;
        const keyCount = meta.filter((p) => p.hasApiKey).length;
        const unconfigured = meta.filter((p) => p.configured === false).length;
        console.log(
          `${meta.length} providers, ${enabledCount} enabled, ${keyCount} with API keys`,
        );
        if (unconfigured > 0) {
          console.log(
            `${unconfigured} provider(s) not in your config yet: run \`librarium init --auto\` to add them`,
          );
        }
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}

function targetLabel(
  target:
    | {
        primary: { model_selection: string; kind?: string; target_id?: string };
        underlying?: {
          model_selection: string;
          kind?: string;
          target_id?: string;
        };
      }
    | undefined,
): string {
  if (!target) return 'Custom';
  const slotLabel = (slot: typeof target.primary): string =>
    slot.target_id ?? slot.kind ?? slot.model_selection;
  const primary = slotLabel(target.primary);
  const underlying = target.underlying
    ? slotLabel(target.underlying)
    : undefined;
  return underlying ? `${primary} + ${underlying}` : primary;
}
