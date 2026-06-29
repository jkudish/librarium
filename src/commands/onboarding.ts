import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as p from '@clack/prompts';
import {
  getAllProviders,
  initializeProviders,
} from '../adapters/node-registry.js';
import { computeInitProviderChoices, PROVIDER_ENV_VARS } from '../constants.js';
import {
  loadConfig,
  loadProjectConfig,
  mergeConfigs,
  saveConfig,
} from '../core/config.js';
import {
  type CredentialContext,
  hasCredential,
  keychainCredentialRef,
} from '../core/credentials.js';
import {
  getProviderCatalogEntry,
  providerTierLabel,
  recommendedProviderCatalogEntries,
  sortedProviderCatalogEntries,
} from '../core/provider-catalog.js';
import { usableProviderIds } from '../core/provider-selection.js';
import {
  createNodeCredentialContext,
  isKeychainAvailable,
  writeKeychainCredential,
} from '../node-credentials.js';
import type { Config, Provider } from '../types.js';
import { executeRun } from './run.js';

type CredentialStorage = 'keychain' | 'env' | 'config';

interface KeyPrompt {
  envVar: string;
  providerIds: string[];
  label: string;
  setupUrl?: string;
}

interface OnboardingWizardOptions {
  welcome?: boolean;
  offerFirstRun?: boolean;
}

interface ShellProfile {
  path: string;
  shell: 'fish' | 'sh';
}

function cancel(): void {
  p.cancel('Cancelled.');
  process.exitCode = 130;
}

function loadMergedConfig(): Config {
  return mergeConfigs(loadConfig(), loadProjectConfig(process.cwd()));
}

function providerHint(provider: Provider): string {
  const catalog = getProviderCatalogEntry(provider.id);
  const parts = [
    providerTierLabel(provider.tier),
    catalog?.bestFor ?? catalog?.description,
  ].filter(Boolean);
  return parts.join(' · ');
}

function providerLabel(provider: Provider): string {
  const catalog = getProviderCatalogEntry(provider.id);
  return catalog
    ? `${catalog.family}: ${catalog.displayName}`
    : provider.displayName;
}

function optionForProvider(provider: Provider) {
  return {
    value: provider.id,
    label: providerLabel(provider),
    hint: providerHint(provider),
  };
}

function providersByIds(ids: string[], providers: Provider[]): Provider[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return ids
    .map((id) => byId.get(id))
    .filter((provider): provider is Provider => Boolean(provider));
}

function selectedKeyPrompts(selected: Provider[]): KeyPrompt[] {
  const byEnvVar = new Map<string, KeyPrompt>();
  for (const provider of selected) {
    const envVar = PROVIDER_ENV_VARS[provider.id] ?? provider.envVar;
    if (!envVar) continue;
    const catalog = getProviderCatalogEntry(provider.id);
    const existing = byEnvVar.get(envVar);
    if (existing) {
      existing.providerIds.push(provider.id);
      continue;
    }
    byEnvVar.set(envVar, {
      envVar,
      providerIds: [provider.id],
      label: catalog?.family ?? provider.displayName,
      setupUrl: catalog?.setupUrl,
    });
  }
  return [...byEnvVar.values()];
}

function providerEnvVar(provider: Provider): string {
  return PROVIDER_ENV_VARS[provider.id] ?? provider.envVar;
}

function detectShellProfile(): ShellProfile | null {
  const shell = process.env.SHELL ?? '';
  if (shell.endsWith('/fish')) {
    return {
      path: join(homedir(), '.config', 'fish', 'config.fish'),
      shell: 'fish',
    };
  }
  if (shell.endsWith('/bash'))
    return { path: join(homedir(), '.bashrc'), shell: 'sh' };
  if (shell.endsWith('/zsh'))
    return { path: join(homedir(), '.zshrc'), shell: 'sh' };
  return { path: join(homedir(), '.profile'), shell: 'sh' };
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function exportLine(
  envVar: string,
  value: string,
  shell: 'fish' | 'sh',
): string {
  return shell === 'fish'
    ? `set -gx ${envVar} ${quoteForShell(value)}`
    : `export ${envVar}=${quoteForShell(value)}`;
}

function envFilePath(shell: ShellProfile['shell']): string {
  return join(
    homedir(),
    '.config',
    'librarium',
    shell === 'fish' ? 'env.fish' : 'env',
  );
}

function sourceLine(path: string, shell: ShellProfile['shell']): string {
  return shell === 'fish'
    ? `source ${quoteForShell(path)}`
    : `[ -f ${quoteForShell(path)} ] && . ${quoteForShell(path)}`;
}

async function maybeAppendEnvExports(
  keys: Map<string, string>,
): Promise<boolean> {
  const profile = detectShellProfile();
  if (!profile) return true;

  const destination = envFilePath(profile.shell);
  const lines = [...keys.entries()].map(([envVar, value]) =>
    exportLine(envVar, value, profile.shell),
  );
  const variables = [...keys.keys()].join(', ');
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(
    destination,
    `# librarium provider API keys\n${lines.join('\n')}\n`,
    { mode: 0o600 },
  );
  chmodSync(destination, 0o600);

  p.log.message(
    `Saved ${lines.length} API key export(s) to ${destination} with owner-only permissions.`,
  );
  const source = sourceLine(destination, profile.shell);
  const append = await p.confirm({
    message: `Load these variables from ${profile.path} automatically?`,
    initialValue: false,
  });
  if (p.isCancel(append)) {
    cancel();
    return false;
  }
  if (!append) {
    p.note(
      [
        'Librarium did not print raw API keys to the terminal.',
        `To load ${variables}, add this line to your shell profile:`,
        source,
      ].join('\n'),
      'Manual shell setup',
    );
    return true;
  }

  mkdirSync(dirname(profile.path), { recursive: true });
  const existingProfile = existsSync(profile.path)
    ? readFileSync(profile.path, 'utf8')
    : '';
  if (!existingProfile.includes(source)) {
    appendFileSync(
      profile.path,
      `\n# librarium provider API keys\n${source}\n`,
    );
  }
  p.log.success(
    `Updated ${profile.path}. Open a new shell or run source ${profile.path}.`,
  );
  return true;
}

async function selectProviders(
  providers: Provider[],
): Promise<string[] | null> {
  const selectionMode = await p.select<string>({
    message: 'Choose providers to configure',
    options: [
      {
        value: 'recommended',
        label: 'Recommended starters',
        hint: 'A short list for a successful first run',
      },
      {
        value: 'all',
        label: 'Browse all providers',
        hint: 'Grouped by tier and provider family',
      },
      {
        value: 'auto',
        label: 'Configure from existing environment variables',
        hint: 'Use keys already present in this shell',
      },
    ],
  });
  if (p.isCancel(selectionMode)) return null;

  if (selectionMode === 'auto') {
    return computeInitProviderChoices(process.env)
      .filter((choice) => choice.enableByDefault)
      .map((choice) => choice.id);
  }

  const catalogEntries =
    selectionMode === 'recommended'
      ? recommendedProviderCatalogEntries()
      : sortedProviderCatalogEntries().sort((a, b) =>
          a.displayName.localeCompare(b.displayName),
        );
  const catalogIds = catalogEntries.map((entry) => entry.id);
  const choices = providersByIds(catalogIds, providers).map(optionForProvider);

  const picked = await p.multiselect<string>({
    message:
      selectionMode === 'recommended'
        ? 'Select recommended providers'
        : 'Select providers',
    options: choices,
    required: true,
  });
  if (p.isCancel(picked)) return null;
  return picked;
}

async function selectCredentialStorage(): Promise<CredentialStorage | null> {
  const options: Array<{
    value: CredentialStorage;
    label: string;
    hint: string;
  }> = [];

  if (isKeychainAvailable()) {
    options.push({
      value: 'keychain',
      label: 'OS keychain',
      hint: 'Recommended, stores secrets outside config',
    });
  }

  options.push(
    {
      value: 'env',
      label: 'Shell environment variables',
      hint: 'Portable, stores exports in a private shell env file',
    },
    {
      value: 'config',
      label: 'Config file',
      hint: 'Stores keys in ~/.config/librarium/config.json',
    },
  );

  const storage = await p.select<CredentialStorage>({
    message: 'How should Librarium store API keys?',
    options,
  });
  if (p.isCancel(storage)) return null;
  return storage;
}

async function promptForKeys(
  prompts: KeyPrompt[],
): Promise<Map<string, string> | null> {
  const keys = new Map<string, string>();
  for (const prompt of prompts) {
    const providerList = prompt.providerIds.join(', ');
    if (prompt.setupUrl) {
      p.log.message(`${prompt.label}: ${prompt.setupUrl}`);
    }
    const value = await p.password({
      message: `Enter ${prompt.envVar} for ${providerList}`,
      validate: (input) =>
        input?.trim().length ? undefined : 'Enter an API key',
    });
    if (p.isCancel(value)) return null;
    keys.set(prompt.envVar, value.trim());
  }
  return keys;
}

function enableSelectedProviders(
  config: Config,
  selected: Provider[],
  storage: CredentialStorage,
  keys: Map<string, string>,
  credentials: CredentialContext,
): void {
  for (const provider of selected) {
    const envVar = providerEnvVar(provider);
    const key = keys.get(envVar);

    let apiKey: string | undefined;
    if (key) {
      if (storage === 'keychain') {
        apiKey = keychainCredentialRef(envVar);
      } else if (storage === 'env') {
        apiKey = `$${envVar}`;
      } else {
        apiKey = key;
      }
    } else {
      apiKey = reusableCredentialRef(config, selected, envVar, credentials);
    }
    if (!apiKey) continue;

    config.providers[provider.id] = {
      ...config.providers[provider.id],
      apiKey,
      enabled: true,
    };
  }
}

export function reusableCredentialRef(
  config: Config,
  selected: Provider[],
  envVar: string,
  credentials: CredentialContext,
): string | undefined {
  for (const provider of selected) {
    if (providerEnvVar(provider) !== envVar) continue;
    const configuredRef = config.providers[provider.id]?.apiKey;
    if (configuredRef && hasCredential(configuredRef, credentials)) {
      return configuredRef;
    }
  }

  const envRef = `$${envVar}`;
  return hasCredential(envRef, credentials) ? envRef : undefined;
}

export function firstQueryGuidance(providerId?: string): string {
  const providerFlag = providerId ? ` -p ${providerId}` : '';
  return [
    'Run `librarium` any time to open the guided research wizard.',
    '',
    'Or start directly with:',
    `  librarium run "compare flutter vs react native"${providerFlag}`,
  ].join('\n');
}

function showFirstQueryGuidance(providerId?: string): void {
  p.note(firstQueryGuidance(providerId), 'Try your first query');
}

async function offerFirstQuery(
  usableSelected: string[],
  offerFirstRun: boolean,
): Promise<void> {
  const firstProvider = usableSelected[0];
  if (!offerFirstRun) {
    showFirstQueryGuidance(firstProvider);
    return;
  }

  const firstRun = await p.confirm({
    message: 'Run a first query now?',
    initialValue: true,
  });
  if (p.isCancel(firstRun)) return cancel();
  if (!firstRun) {
    showFirstQueryGuidance(firstProvider);
    return;
  }

  const query = await p.text({
    message: 'What should Librarium research first?',
    placeholder: 'e.g. compare flutter vs react native',
    validate: (value) => (value?.trim().length ? undefined : 'Enter a query'),
  });
  if (p.isCancel(query)) return cancel();
  await executeRun(query.trim(), {
    providers: [firstProvider],
    mode: 'sync',
    skipPreflightConfirm: true,
  });
}

export async function runOnboardingWizard(
  options: OnboardingWizardOptions = {},
): Promise<void> {
  const welcome = options.welcome ?? true;
  const offerFirstRun = options.offerFirstRun ?? true;

  if (welcome) {
    p.intro('Welcome to Librarium');
    p.log.message(
      "Let's get you to a first successful research run. Librarium uses provider APIs to search, answer, and research in parallel, so setup starts by connecting at least one API key.",
    );
    p.log.message(
      'You can start with a recommended provider, browse the full list, and choose where secrets are stored: OS keychain, shell environment variables, or the config file.',
    );

    const explain = await p.confirm({
      message: 'Want a quick explainer before setup?',
      initialValue: false,
    });
    if (p.isCancel(explain)) return cancel();
    if (explain) {
      p.note(
        [
          'Librarium is a research fan-out CLI. You ask one question, it sends that query to multiple search, grounded-answer, and deep-research providers, then writes a structured run directory with provider outputs, deduped sources, summaries, and optional reports.',
          '',
          'Docs: https://librarium.agentsy.build',
        ].join('\n'),
        'What Librarium Does',
      );
    }
  } else {
    p.intro('Provider setup');
  }

  const globalConfig = loadConfig();
  const config = loadMergedConfig();
  const credentials = createNodeCredentialContext();
  const initResult = await initializeProviders({ ...config, credentials });
  for (const warning of initResult.warnings) {
    console.error(`[librarium] warning: ${warning}`);
  }

  const providers = getAllProviders();
  const selectedIds = await selectProviders(providers);
  if (!selectedIds) return cancel();

  if (selectedIds.length === 0) {
    p.log.warn('No provider API keys were found in your environment.');
    return;
  }

  const selected = providersByIds(selectedIds, providers);
  const keyPrompts = selectedKeyPrompts(selected).filter((prompt) => {
    return !reusableCredentialRef(
      globalConfig,
      selected,
      prompt.envVar,
      credentials,
    );
  });

  if (keyPrompts.length === 0) {
    for (const provider of selected) {
      const envVar = providerEnvVar(provider);
      globalConfig.providers[provider.id] = {
        ...globalConfig.providers[provider.id],
        apiKey:
          reusableCredentialRef(globalConfig, selected, envVar, credentials) ??
          `$${envVar}`,
        enabled: true,
      };
    }
    saveConfig(globalConfig);
    p.log.success('Selected providers were already configured.');
    const updatedConfig = loadMergedConfig();
    const updatedCredentials = createNodeCredentialContext();
    await initializeProviders({
      ...updatedConfig,
      credentials: updatedCredentials,
    });
    const usable = usableProviderIds(
      updatedConfig,
      getAllProviders(),
      updatedCredentials,
    );
    const usableSelected = selected
      .map((provider) => provider.id)
      .filter((id) => usable.includes(id));
    if (usableSelected.length > 0) {
      await offerFirstQuery(usableSelected, offerFirstRun);
    } else {
      showFirstQueryGuidance(selected[0]?.id);
    }
    p.outro('setup complete');
    return;
  }

  const storage = await selectCredentialStorage();
  if (!storage) return cancel();

  const keys = await promptForKeys(keyPrompts);
  if (!keys) return cancel();

  for (const [envVar, key] of keys) {
    if (storage === 'keychain') {
      writeKeychainCredential(envVar, key);
    }
    if (storage === 'env') {
      process.env[envVar] = key;
    }
  }

  if (storage === 'env') {
    const envReady = await maybeAppendEnvExports(keys);
    if (!envReady) return;
  }

  enableSelectedProviders(globalConfig, selected, storage, keys, credentials);
  saveConfig(globalConfig);

  const updatedConfig = loadMergedConfig();
  const updatedCredentials = createNodeCredentialContext();
  await initializeProviders({
    ...updatedConfig,
    credentials: updatedCredentials,
  });
  const usable = usableProviderIds(
    updatedConfig,
    getAllProviders(),
    updatedCredentials,
  );
  const usableSelected = selected
    .map((provider) => provider.id)
    .filter((id) => usable.includes(id));

  if (usableSelected.length === 0) {
    p.log.warn(
      'Configuration was saved, but no selected provider has a usable key in this shell. Run `librarium doctor` after refreshing your environment.',
    );
    p.outro('setup incomplete');
    return;
  }

  p.log.success(
    `${usableSelected.length} provider(s) configured: ${usableSelected.join(', ')}`,
  );

  await offerFirstQuery(usableSelected, offerFirstRun);

  p.outro('setup complete');
}
