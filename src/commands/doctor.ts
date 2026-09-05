import type { Command } from 'commander';
import ora from 'ora';
import {
  getAllProviders,
  initializeProviders,
} from '../adapters/node-registry.js';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import {
  redactCredentialText,
  resolveCredential,
} from '../core/credentials.js';
import { BUILTIN_PROVIDER_DEFINITIONS_IN_REGISTRATION_ORDER } from '../core/provider-descriptor.js';
import {
  providerCredentialRef,
  providerHasCredential,
} from '../core/provider-selection.js';
import { createNodeCredentialContext } from '../node-credentials.js';
import type { Config, Provider } from '../types.js';

interface DoctorResult {
  id: string;
  displayName: string;
  enabled: boolean;
  hasApiKey: boolean | null;
  credentialStatus: 'present' | 'missing' | 'not-required' | 'unknown';
  connectivity: 'pass' | 'fail' | 'skip' | 'unchecked' | 'no-test';
  error?: string;
}

function safeInitializationWarning(warning: string): string {
  const failedCustomProvider = warning.match(
    /^Failed to load custom provider "([^"]+)":/,
  );
  return failedCustomProvider
    ? `Failed to load custom provider "${failedCustomProvider[1]}"`
    : warning;
}

function configuredCredentials(
  config: Config,
  credentials: ReturnType<typeof createNodeCredentialContext>,
): (string | undefined)[] {
  return Object.values(config.providers).map((provider) =>
    provider.apiKey
      ? resolveCredential(provider.apiKey, credentials)
      : undefined,
  );
}

function offlineResults(
  config: Config,
  credentials: ReturnType<typeof createNodeCredentialContext>,
): DoctorResult[] {
  const results: DoctorResult[] = [];
  const builtinIds = new Set<string>();

  for (const definition of BUILTIN_PROVIDER_DEFINITIONS_IN_REGISTRATION_ORDER) {
    if (definition.internal === true) continue;
    builtinIds.add(definition.id);
    const providerConfig = config.providers[definition.id];
    const enabled = providerConfig?.enabled ?? false;
    const hasApiKey = providerHasCredential(
      {
        envVar: definition.credential.envVar,
        requiresApiKey: definition.credential.required,
      },
      providerConfig,
      credentials,
    );

    results.push({
      id: definition.id,
      displayName: definition.display.name,
      enabled,
      hasApiKey,
      credentialStatus: hasApiKey ? 'present' : 'missing',
      connectivity: !enabled ? 'skip' : hasApiKey ? 'unchecked' : 'fail',
      ...(!hasApiKey && enabled ? { error: 'API key not set' } : {}),
    });
  }

  for (const [id, source] of Object.entries(config.customProviders)) {
    if (builtinIds.has(id)) continue;
    const providerConfig = config.providers[id];
    const enabled = providerConfig?.enabled ?? false;
    const credential = source.executionProfile?.credential;
    const credentialRequired =
      source.executionProfile === undefined
        ? undefined
        : credential !== undefined;
    const hasApiKey =
      source.executionProfile === undefined
        ? null
        : credential
          ? providerHasCredential(
              { envVar: credential.envVar, requiresApiKey: true },
              providerConfig,
              credentials,
            )
          : true;
    const credentialStatus =
      credentialRequired === undefined
        ? 'unknown'
        : credentialRequired
          ? hasApiKey
            ? 'present'
            : 'missing'
          : 'not-required';

    results.push({
      id,
      displayName: id,
      enabled,
      hasApiKey,
      credentialStatus,
      connectivity:
        !enabled || !config.trustedProviderIds.includes(id)
          ? 'skip'
          : hasApiKey === false
            ? 'fail'
            : 'unchecked',
      ...(!config.trustedProviderIds.includes(id) && enabled
        ? { error: 'Custom provider is not trusted' }
        : hasApiKey === false && enabled
          ? { error: 'API key not set' }
          : {}),
    });
  }

  return results;
}

async function liveResults(
  providers: Provider[],
  config: Config,
  credentials: ReturnType<typeof createNodeCredentialContext>,
  spinner: ReturnType<typeof ora>,
): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];

  for (const provider of providers) {
    const providerConfig = config.providers[provider.id];
    const enabled = providerConfig?.enabled ?? false;
    const requiresApiKey = provider.requiresApiKey ?? true;
    const keyPresent = requiresApiKey
      ? providerHasCredential(provider, providerConfig, credentials)
      : true;
    const credentialRef = requiresApiKey
      ? providerCredentialRef(provider, providerConfig)
      : undefined;
    const knownCredential = credentialRef
      ? resolveCredential(credentialRef, credentials)
      : undefined;
    const credentialStatus = requiresApiKey
      ? keyPresent
        ? 'present'
        : 'missing'
      : 'not-required';

    if (!enabled) {
      results.push({
        id: provider.id,
        displayName: provider.displayName,
        enabled: false,
        hasApiKey: keyPresent,
        credentialStatus,
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
        credentialStatus: 'missing',
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
        credentialStatus,
        connectivity: 'no-test',
      });
      continue;
    }

    spinner.text = `Testing ${provider.displayName}...`;

    try {
      const testResult = await provider.test();
      const error =
        testResult.ok || !testResult.error
          ? undefined
          : redactCredentialText(testResult.error, [knownCredential]);
      results.push({
        id: provider.id,
        displayName: provider.displayName,
        enabled: true,
        hasApiKey: true,
        credentialStatus,
        connectivity: testResult.ok ? 'pass' : 'fail',
        error,
      });
    } catch (error) {
      results.push({
        id: provider.id,
        displayName: provider.displayName,
        enabled: true,
        hasApiKey: true,
        credentialStatus,
        connectivity: 'fail',
        error: redactCredentialText(
          error instanceof Error ? error.message : String(error),
          [knownCredential],
        ),
      });
    }
  }

  return results;
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
        let results: DoctorResult[];

        if (opts.live) {
          let initResult: Awaited<ReturnType<typeof initializeProviders>>;
          try {
            initResult = await initializeProviders({
              ...config,
              credentials,
            });
          } catch {
            spinner.fail('Unable to initialize providers for live checks');
            process.exitCode = 1;
            return;
          }
          const knownCredentials = configuredCredentials(config, credentials);
          for (const warning of initResult.warnings) {
            console.error(
              `[librarium] warning: ${redactCredentialText(
                safeInitializationWarning(warning),
                knownCredentials,
              )}`,
            );
          }
          results = await liveResults(
            getAllProviders(),
            config,
            credentials,
            spinner,
          );
        } else {
          results = offlineResults(config, credentials);
        }

        spinner.stop();

        // Builtin providers with no entry in config at all: usually a config
        // created before newer adapters shipped.
        const missingFromConfig =
          BUILTIN_PROVIDER_DEFINITIONS_IN_REGISTRATION_ORDER.filter(
            (provider) =>
              provider.internal !== true &&
              config.providers[provider.id] === undefined,
          ).map((provider) => provider.id);
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
              statusText = r.error || 'Not enabled';
              break;
            case 'unchecked':
              statusIcon = '[----]';
              statusText =
                r.credentialStatus === 'unknown'
                  ? 'Credential requirements unknown; connectivity not tested'
                  : r.credentialStatus === 'not-required'
                    ? 'No credential required; connectivity not tested'
                    : 'Credential present; connectivity not tested';
              break;
            case 'no-test':
              statusIcon = '[----]';
              statusText =
                r.credentialStatus === 'not-required'
                  ? 'No credential required; no connectivity test available'
                  : 'Credential present; no connectivity test available';
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
