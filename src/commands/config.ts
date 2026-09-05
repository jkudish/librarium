import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import type { Command } from 'commander';
import { parseConfigAction } from '../cli-parsers.js';
import {
  CONFIG_FILE,
  loadConfig,
  loadProjectConfig,
  mergeConfigs,
  saveConfig,
} from '../core/config.js';
import type {
  PreparationIssue,
  PreparationNotice,
} from '../core/research-request.js';
import {
  ConfigV2FileError,
  loadConfigV2,
  saveConfigV2,
} from '../node-config-v2.js';
import type { Config, Defaults } from '../types.js';
import { runOnboardingWizard } from './onboarding.js';

export function registerConfigCommand(program: Command): void {
  const configCommand = program
    .command('config')
    .description('Print or edit librarium configuration')
    .argument('[action]', 'Use "menu" to edit settings', parseConfigAction)
    .option('--json', 'Output raw JSON')
    .option('--global', 'Show only global config (ignore project config)')
    .option('--menu', 'Open the interactive config menu')
    .action(async (action, opts) => {
      try {
        if (opts.menu || action === 'menu') {
          await runConfigMenu();
          return;
        }

        const globalConfig = loadConfig();

        if (opts.global) {
          if (opts.json) {
            console.log(JSON.stringify(globalConfig, null, 2));
          } else {
            printConfig(globalConfig, 'Global Config');
          }
          return;
        }

        const projectConfig = loadProjectConfig(process.cwd());
        const merged = mergeConfigs(globalConfig, projectConfig);

        if (opts.json) {
          console.log(JSON.stringify(merged, null, 2));
          return;
        }

        printConfig(merged, 'Resolved Config (global + project)');

        if (projectConfig) {
          console.log('  (Project config detected in current directory)\n');
        }
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });

  configCommand
    .command('migrate')
    .description('Preview or explicitly write a v1-to-v2 config migration')
    .requiredOption('--from <path>', 'Path to the global v1 or v2 config')
    .option('--project <path>', 'Optional project config to merge')
    .option(
      '--output <path>',
      'Explicit destination for the migrated v2 config',
    )
    .option('--force', 'Replace an existing destination')
    .action((opts) => {
      runConfigMigration(opts);
    });
}

interface ConfigMigrationCommandOptions {
  readonly from: string;
  readonly project?: string;
  readonly output?: string;
  readonly force?: boolean;
}

function writeDiagnostics(
  level: 'issue' | 'notice',
  diagnostics: readonly (PreparationIssue | PreparationNotice)[],
): void {
  for (const diagnostic of diagnostics) {
    process.stderr.write(`${JSON.stringify({ level, ...diagnostic })}\n`);
  }
}

function commandIssue(code: string, path: string, message: string): void {
  writeDiagnostics('issue', [{ code, phase: 'migration', path, message }]);
  process.exitCode = 1;
}

function existingPathsMatch(left: string, right: string): boolean {
  const leftReal = realpathSync.native(left);
  const rightReal = realpathSync.native(right);
  const normalize =
    process.platform === 'win32'
      ? (path: string) => path.toLowerCase()
      : (path: string) => path;
  if (normalize(leftReal) === normalize(rightReal)) return true;
  if (process.platform === 'win32') return false;

  const leftStat = statSync(left);
  const rightStat = statSync(right);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

function runConfigMigration(opts: ConfigMigrationCommandOptions): void {
  const globalPath = resolve(opts.from);
  const projectPath =
    opts.project === undefined ? undefined : resolve(opts.project);
  const outputPath =
    opts.output === undefined ? undefined : resolve(opts.output);
  const result = loadConfigV2({
    global_path: globalPath,
    ...(projectPath !== undefined && { project_path: projectPath }),
  });

  writeDiagnostics('notice', result.notices);
  if (!result.ok) {
    writeDiagnostics('issue', result.issues);
    process.exitCode = 1;
    return;
  }

  if (outputPath !== undefined) {
    if (result.source_versions.global !== 1) {
      commandIssue(
        'config_migration_write_requires_v1_source',
        '/global/version',
        'Writing is supported only for a v1 global source; native v2 input is preview-only.',
      );
      return;
    }
    if (projectPath !== undefined) {
      commandIssue(
        'config_migration_project_write_refused',
        '/output',
        'Project config is supported for effective-config preview only; omit --project when writing.',
      );
      return;
    }
    if (existsSync(outputPath)) {
      try {
        if (existingPathsMatch(outputPath, globalPath)) {
          commandIssue(
            'config_migration_source_overwrite_refused',
            '/output',
            'The migration output must not replace a source configuration file.',
          );
          return;
        }
      } catch {
        commandIssue(
          'config_migration_path_identity_failed',
          '/output',
          'Unable to verify that the migration destination is distinct from its source.',
        );
        return;
      }
    }
    if (!opts.force && existsSync(outputPath)) {
      commandIssue(
        'config_migration_destination_exists',
        '/output',
        'The migration destination already exists; use --force to replace it.',
      );
      return;
    }
    try {
      saveConfigV2(result.config, { path: outputPath });
    } catch (error) {
      if (error instanceof ConfigV2FileError) {
        writeDiagnostics('issue', error.issues);
        commandIssue('config_migration_write_failed', '/output', error.message);
      } else {
        commandIssue(
          'config_migration_write_failed',
          '/output',
          'Unable to save the migrated configuration.',
        );
      }
      return;
    }
  }

  process.stdout.write(`${JSON.stringify(result.config, null, 2)}\n`);
}

function cancel(): void {
  p.cancel('Cancelled.');
  process.exitCode = 130;
}

async function runConfigMenu(): Promise<void> {
  p.intro('Librarium config');
  p.log.message(`Editing global config: ${CONFIG_FILE}`);

  let config = loadConfig();

  while (true) {
    const choice = await p.select<string>({
      message: 'What do you want to configure?',
      options: [
        {
          value: 'providers',
          label: 'Providers and API keys',
          hint: 'Add keys, enable providers, and choose secret storage',
        },
        {
          value: 'llm-web-search',
          label: `LLM web search: ${config.defaults.llmWebSearch ? 'on' : 'off'}`,
          hint: 'Use web search and citations for llm providers',
        },
        {
          value: 'mode',
          label: `Default mode: ${config.defaults.mode}`,
          hint: 'sync, async, or mixed',
        },
        {
          value: 'output-dir',
          label: 'Output directory',
          hint: config.defaults.outputDir,
        },
        {
          value: 'limits',
          label: 'Parallelism and timeouts',
          hint: `${config.defaults.maxParallel} parallel, ${config.defaults.timeout}s sync timeout`,
        },
        {
          value: 'print',
          label: 'Show current config',
          hint: 'Print the resolved global settings in this menu',
        },
        {
          value: 'done',
          label: 'Done',
          hint: 'Save and exit',
        },
      ],
    });
    if (p.isCancel(choice)) return cancel();

    if (choice === 'done') {
      p.outro('config saved');
      return;
    }

    if (choice === 'providers') {
      await runOnboardingWizard({ welcome: false, offerFirstRun: false });
      config = loadConfig();
      continue;
    }

    if (choice === 'llm-web-search') {
      const updated = await promptLlmWebSearch(config);
      if (!updated) return cancel();
      config = updated;
      continue;
    }

    if (choice === 'mode') {
      const updated = await promptMode(config);
      if (!updated) return cancel();
      config = updated;
      continue;
    }

    if (choice === 'output-dir') {
      const updated = await promptOutputDir(config);
      if (!updated) return cancel();
      config = updated;
      continue;
    }

    if (choice === 'limits') {
      const updated = await promptLimits(config);
      if (!updated) return cancel();
      config = updated;
      continue;
    }

    if (choice === 'print') {
      printConfig(
        config as unknown as Record<string, unknown>,
        'Global Config',
      );
    }
  }
}

async function promptLlmWebSearch(config: Config): Promise<Config | null> {
  const choice = await p.select<string>({
    message: 'Use web search and citations for llm providers?',
    options: [
      {
        value: 'on',
        label: 'On',
        hint: 'Default: Claude/OpenAI/Gemini/OpenRouter search when useful',
      },
      {
        value: 'off',
        label: 'Off',
        hint: 'LLM providers answer directly without web citations',
      },
    ],
    initialValue: config.defaults.llmWebSearch ? 'on' : 'off',
  });
  if (p.isCancel(choice)) return null;

  const next = {
    ...config,
    defaults: {
      ...config.defaults,
      llmWebSearch: choice === 'on',
    },
  };
  saveConfig(next);
  p.log.success(
    `LLM web search ${next.defaults.llmWebSearch ? 'enabled' : 'disabled'}.`,
  );
  return next;
}

async function promptMode(config: Config): Promise<Config | null> {
  const mode = await p.select<Defaults['mode']>({
    message: 'Choose the default execution mode',
    options: [
      {
        value: 'sync',
        label: 'sync',
        hint: 'Run providers concurrently and wait for all results',
      },
      {
        value: 'async',
        label: 'async',
        hint: 'Submit only durable research providers and return immediately',
      },
      {
        value: 'mixed',
        label: 'mixed (legacy)',
        hint: 'Migrates to async; use sync to wait for results',
      },
    ],
    initialValue: config.defaults.mode,
  });
  if (p.isCancel(mode)) return null;

  const next = {
    ...config,
    defaults: { ...config.defaults, mode },
  };
  saveConfig(next);
  p.log.success(`Default mode set to ${mode}.`);
  return next;
}

async function promptOutputDir(config: Config): Promise<Config | null> {
  const outputDir = await p.text({
    message: 'Output directory',
    placeholder: config.defaults.outputDir,
    validate: (value) =>
      value?.trim().length ? undefined : 'Enter an output directory',
  });
  if (p.isCancel(outputDir)) return null;

  const next = {
    ...config,
    defaults: { ...config.defaults, outputDir: outputDir.trim() },
  };
  saveConfig(next);
  p.log.success(`Output directory set to ${next.defaults.outputDir}.`);
  return next;
}

async function promptLimits(config: Config): Promise<Config | null> {
  const maxParallel = await promptPositiveInteger(
    'Max parallel providers',
    config.defaults.maxParallel,
  );
  if (maxParallel === null) return null;

  const timeout = await promptPositiveInteger(
    'Sync provider timeout in seconds',
    config.defaults.timeout,
  );
  if (timeout === null) return null;

  const asyncTimeout = await promptPositiveInteger(
    'Async research timeout in seconds',
    config.defaults.asyncTimeout,
  );
  if (asyncTimeout === null) return null;

  const asyncPollInterval = await promptPositiveInteger(
    'Async poll interval in seconds',
    config.defaults.asyncPollInterval,
  );
  if (asyncPollInterval === null) return null;

  const next = {
    ...config,
    defaults: {
      ...config.defaults,
      maxParallel,
      timeout,
      asyncTimeout,
      asyncPollInterval,
    },
  };
  saveConfig(next);
  p.log.success('Parallelism and timeouts updated.');
  return next;
}

async function promptPositiveInteger(
  label: string,
  currentValue: number,
): Promise<number | null> {
  const value = await p.text({
    message: `${label} (${currentValue})`,
    placeholder: String(currentValue),
    validate: (input) => {
      const trimmed = input?.trim() ?? '';
      if (!trimmed) return undefined;
      const parsed = Number(trimmed);
      return Number.isInteger(parsed) && parsed > 0
        ? undefined
        : 'Enter a positive integer';
    },
  });
  if (p.isCancel(value)) return null;
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : currentValue;
}

function printConfig(config: Record<string, unknown>, title: string): void {
  console.log(`\n${title}:\n`);

  const defaults = config.defaults as Record<string, unknown>;
  console.log('  Defaults:');
  for (const [key, value] of Object.entries(defaults)) {
    console.log(`    ${key}: ${value}`);
  }

  const providers = config.providers as Record<string, Record<string, unknown>>;
  const providerIds = Object.keys(providers);
  console.log(`\n  Providers (${providerIds.length}):`);
  if (providerIds.length === 0) {
    console.log('    (none configured)');
  } else {
    for (const [id, p] of Object.entries(providers)) {
      const enabled = p.enabled ? 'enabled' : 'disabled';
      console.log(`    ${id}: ${enabled}`);
    }
  }

  const customProviders = config.customProviders as Record<
    string,
    Record<string, unknown>
  >;
  const customProviderIds = Object.keys(customProviders);
  console.log(`\n  Custom Providers (${customProviderIds.length}):`);
  if (customProviderIds.length === 0) {
    console.log('    (none configured)');
  } else {
    for (const [id, source] of Object.entries(customProviders)) {
      const type = String(source.type ?? 'unknown');
      console.log(`    ${id}: ${type}`);
    }
  }

  const trustedProviderIds = (config.trustedProviderIds as string[]) ?? [];
  console.log(`\n  Trusted Provider IDs (${trustedProviderIds.length}):`);
  if (trustedProviderIds.length === 0) {
    console.log('    (none)');
  } else {
    console.log(`    ${trustedProviderIds.join(', ')}`);
  }

  const groups = config.groups as Record<string, string[]>;
  const groupNames = Object.keys(groups);
  console.log(`\n  Groups (${groupNames.length}):`);
  for (const [name, members] of Object.entries(groups)) {
    console.log(`    ${name}: ${(members as string[]).join(', ')}`);
  }

  console.log('');
}
