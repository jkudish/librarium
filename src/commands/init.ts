import type { Command } from 'commander';
import { initializeProviders } from '../adapters/node-registry.js';
import { parseProviders } from '../cli-parsers.js';
import {
  computeInitProviderChoices,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_ENV_VARS,
  resolveProviderId,
} from '../constants.js';
import {
  authoredGlobalGroups,
  loadConfig,
  saveConfig,
} from '../core/config.js';
import type { EnvRecord } from '../core/credentials.js';
import { createNodeCredentialContext } from '../node-credentials.js';
import type { Config } from '../types.js';
import { runOnboardingWizard } from './onboarding.js';

export interface InitProviderPlanInput {
  readonly providers: Config['providers'];
  readonly customProviderIds: readonly string[];
  readonly env: EnvRecord;
  /** `--auto`: enable every keyed provider whose descriptor permits it. */
  readonly auto: boolean;
  /** `--enable`: providers the user explicitly opted into, including opt-in ones. */
  readonly enable: readonly string[];
}

export interface InitProviderPlan {
  readonly providers: Config['providers'];
  readonly lines: readonly string[];
  readonly enabledCount: number;
  /** `--enable` ids that name no built-in or configured custom provider. */
  readonly unknown: readonly string[];
}

/**
 * Decide the provider entries `init --auto` and `init --enable` write. Pure, so
 * the descriptor opt-in policy and explicit enablement are testable without a
 * terminal. Existing provider settings (model, options, fallback) are kept;
 * only the credential reference and `enabled` flag are set.
 */
export function planInitProviders(
  input: InitProviderPlanInput,
): InitProviderPlan {
  const providers: Config['providers'] = { ...input.providers };
  const lines: string[] = [];
  const unknown: string[] = [];
  const explicit = new Set<string>();
  for (const raw of input.enable) {
    const id = resolveProviderId(raw);
    if (PROVIDER_ENV_VARS[id] || input.customProviderIds.includes(id)) {
      explicit.add(id);
    } else {
      unknown.push(raw);
    }
  }
  let enabledCount = 0;
  const enable = (id: string, envVar: string | undefined) => {
    const existing = providers[id];
    providers[id] = {
      ...existing,
      ...(existing?.apiKey === undefined &&
        envVar !== undefined && { apiKey: `$${envVar}` }),
      enabled: true,
    };
    enabledCount++;
  };

  for (const choice of computeInitProviderChoices(input.env)) {
    const { id, envVar, keyPresent, isOptIn, enableByDefault } = choice;
    const displayName = PROVIDER_DISPLAY_NAMES[id] || id;
    if (explicit.has(id)) {
      enable(id, envVar);
      lines.push(
        keyPresent
          ? `  [+] ${displayName} — enabled`
          : `  [+] ${displayName} — enabled; set ${envVar} before running it`,
      );
      continue;
    }
    if (!input.auto) continue;
    if (enableByDefault) {
      enable(id, envVar);
      lines.push(`  [+] ${displayName} — ${envVar} found, enabled`);
    } else if (keyPresent && isOptIn && !providers[id]) {
      // Descriptor-marked providers are opt-in: credential discovery never
      // enables them. Say exactly how to opt in instead of leaving the user
      // to edit the config file.
      lines.push(
        `  [ ] ${displayName} — ${envVar} found, but this provider is opt-in (enable with \`librarium init --enable ${id}\`)`,
      );
    } else if (providers[id]) {
      lines.push(`  [~] ${displayName}: using existing config`);
    } else {
      lines.push(`  [ ] ${displayName} — ${envVar} not found`);
    }
  }

  for (const id of input.customProviderIds) {
    if (!explicit.has(id)) continue;
    enable(id, undefined);
    lines.push(`  [+] ${id} — enabled`);
  }

  return { providers, lines, enabledCount, unknown };
}

/**
 * The config `init` writes: the planned providers plus only the groups the
 * user authored. Built-in rosters are injected at load time; writing them back
 * would turn them into custom groups that shadow the built-in workflows.
 */
export function initConfigToSave(
  existing: Config,
  plan: Pick<InitProviderPlan, 'providers'>,
): Config {
  return {
    ...existing,
    providers: plan.providers,
    groups: authoredGlobalGroups(existing),
  };
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize librarium configuration')
    .option(
      '--auto',
      'Auto-discover environment variables and enable matching providers',
    )
    .option(
      '--enable <ids>',
      'Enable these providers, including opt-in ones (comma-separated provider IDs)',
      parseProviders,
    )
    .action(async (opts: { auto?: boolean; enable?: string[] }) => {
      try {
        const credentials = createNodeCredentialContext();
        await initializeProviders({ credentials });

        const existingConfig = loadConfig();

        if (opts.auto || opts.enable) {
          if (opts.auto) {
            console.log('\nAuto-discovering provider API keys...\n');
          }
          const plan = planInitProviders({
            providers: existingConfig.providers,
            customProviderIds: Object.keys(existingConfig.customProviders),
            env: process.env,
            auto: Boolean(opts.auto),
            enable: opts.enable ?? [],
          });
          if (plan.unknown.length > 0) {
            console.error(
              `Unknown provider ID${plan.unknown.length === 1 ? '' : 's'}: ${plan.unknown.join(', ')}. Run \`librarium ls\` to see provider IDs.`,
            );
            process.exitCode = 1;
            return;
          }
          for (const line of plan.lines) console.log(line);

          saveConfig(initConfigToSave(existingConfig, plan));
          console.log(
            `\nConfig saved. ${plan.enabledCount} providers enabled.`,
          );
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
