import type { Command } from 'commander';
import { initializeProviders } from '../adapters/node-registry.js';
import {
  computeInitProviderChoices,
  PROVIDER_DISPLAY_NAMES,
} from '../constants.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { createNodeCredentialContext } from '../node-credentials.js';
import { runOnboardingWizard } from './onboarding.js';

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
        const credentials = createNodeCredentialContext();
        await initializeProviders({ credentials });

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
              // llm-tier providers are opt-in: never enabled by --auto even
              // when their (shared) API key is present. Leave any existing
              // config untouched.
              if (!existingConfig.providers[id]) {
                console.log(
                  `  [ ] ${displayName} — ${envVar} found, but llm-tier providers are opt-in (enable with \`-p ${id}\` or \`--group llm\`)`,
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

        await runOnboardingWizard();
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}
