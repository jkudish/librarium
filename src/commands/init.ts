import type { Command } from 'commander';
import { initializeProviders } from '../adapters/node-registry.js';
import {
  computeInitProviderChoices,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_ENV_VARS,
} from '../constants.js';
import { loadConfig, saveConfig } from '../core/config.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize librarium configuration')
    .option(
      '--auto',
      'Auto-discover environment variables and enable matching providers',
    )
    .action(async (opts) => {
      try {
        await initializeProviders({ credentials: { env: process.env } });

        const existingConfig = loadConfig();

        if (opts.auto) {
          // Auto-discover mode
          console.log('\nAuto-discovering provider API keys...\n');
          let enabledCount = 0;

          for (const choice of computeInitProviderChoices(process.env)) {
            const { id, envVar, keyPresent, isLlm, enableByDefault } = choice;
            const displayName = PROVIDER_DISPLAY_NAMES[id] || id;

            if (enableByDefault) {
              existingConfig.providers[id] = {
                apiKey: `$${envVar}`,
                enabled: true,
              };
              console.log(`  [+] ${displayName} — ${envVar} found, enabled`);
              enabledCount++;
            } else if (keyPresent && isLlm) {
              // llm-tier providers are ungrounded and opt-in: never enabled by
              // --auto even when their (shared) API key is present. Leave any
              // existing config untouched.
              if (!existingConfig.providers[id]) {
                console.log(
                  `  [ ] ${displayName} — ${envVar} found, but ungrounded (opt-in; enable with \`-p ${id}\` or \`--group llm\`)`,
                );
              } else {
                console.log(`  [~] ${displayName}: using existing config`);
              }
            } else {
              // Don't override existing config for providers without env vars
              if (!existingConfig.providers[id]) {
                console.log(`  [ ] ${displayName} — ${envVar} not found`);
              } else {
                console.log(`  [~] ${displayName}: using existing config`);
              }
            }
          }

          saveConfig(existingConfig);
          console.log(`\nConfig saved. ${enabledCount} providers enabled.`);
          console.log('Edit ~/.config/librarium/config.json to customize.\n');
          return;
        }

        // Interactive mode
        const { checkbox } = await import('@inquirer/prompts');

        console.log('\nWelcome to librarium!\n');
        console.log('This will set up your provider configuration.\n');

        // Show available providers and their env var status
        const providerChoices: Array<{
          name: string;
          value: string;
          checked: boolean;
        }> = [];

        for (const choice of computeInitProviderChoices(process.env)) {
          const { id, keyPresent, isLlm, enableByDefault } = choice;
          const displayName = PROVIDER_DISPLAY_NAMES[id] || id;
          const status = keyPresent ? ' (API key found)' : ' (API key missing)';
          // llm-tier providers are listed but left unchecked, with an
          // "ungrounded" hint, so the user must opt in explicitly.
          const hint = isLlm ? ' [ungrounded]' : '';
          providerChoices.push({
            name: `${displayName}${status}${hint}`,
            value: id,
            checked: enableByDefault,
          });
        }

        const selectedProviders = await checkbox({
          message: 'Select providers to enable:',
          choices: providerChoices,
        });

        // Build provider configs
        for (const id of selectedProviders) {
          const envVar = PROVIDER_ENV_VARS[id];
          existingConfig.providers[id] = {
            apiKey: `$${envVar}`,
            enabled: true,
          };
        }

        // Disable unselected providers that were previously enabled
        for (const id of Object.keys(PROVIDER_ENV_VARS)) {
          if (existingConfig.providers[id] && !selectedProviders.includes(id)) {
            existingConfig.providers[id].enabled = false;
          }
        }

        saveConfig(existingConfig);

        console.log(
          `\nConfig saved with ${selectedProviders.length} providers enabled.`,
        );
        console.log('Config location: ~/.config/librarium/config.json');
        console.log('\nRun `librarium doctor` to verify connectivity.\n');
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}
