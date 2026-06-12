import * as p from '@clack/prompts';
import {
  getAllProviders,
  initializeProviders,
} from '../adapters/node-registry.js';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import type { Config, ProviderTier } from '../types.js';
import { browseRunDir } from './browse.js';
import { executeRun, type RunOptions } from './run.js';

/**
 * Interactive wizard launched by bare `librarium` in a TTY: prompt for the
 * query, pick providers (group or specific), pick mode, confirm, then run
 * the exact same flow as `librarium run` with the live table.
 */

const TIER_ORDER: ProviderTier[] = [
  'deep-research',
  'ai-grounded',
  'raw-search',
];

/** Summarize a group's members by tier, e.g. "6 providers: 4 ai-grounded, 2 raw-search". */
function groupHint(ids: string[], tierById: Map<string, ProviderTier>): string {
  const counts = new Map<ProviderTier, number>();
  for (const id of ids) {
    const tier = tierById.get(id);
    if (!tier) continue;
    counts.set(tier, (counts.get(tier) ?? 0) + 1);
  }
  const breakdown = TIER_ORDER.filter((tier) => counts.has(tier))
    .map((tier) => `${counts.get(tier)} ${tier}`)
    .join(', ');
  return breakdown
    ? `${ids.length} providers: ${breakdown}`
    : `${ids.length} providers`;
}

function enabledProviderIds(config: Config): string[] {
  return Object.entries(config.providers)
    .filter(([, providerConfig]) => providerConfig.enabled)
    .map(([id]) => id);
}

export async function runWizard(): Promise<void> {
  const config = mergeConfigs(loadConfig(), loadProjectConfig(process.cwd()));
  const initResult = await initializeProviders({
    ...config,
    credentials: { env: process.env },
  });
  for (const warning of initResult.warnings) {
    console.error(`[librarium] warning: ${warning}`);
  }
  const tierById = new Map<string, ProviderTier>(
    getAllProviders().map((provider) => [provider.id, provider.tier]),
  );

  p.intro('librarium');

  const query = await p.text({
    message: 'What do you want to research?',
    placeholder: 'e.g. postgres pooling best practices',
    validate: (value) =>
      value && value.trim().length > 0 ? undefined : 'Enter a query',
  });
  if (p.isCancel(query)) return cancel();

  // Provider scope: enabled set, a group, or hand-picked providers.
  const enabled = enabledProviderIds(config);
  const scope = await p.select<string>({
    message: 'Which providers?',
    options: [
      {
        value: 'enabled',
        label: 'all enabled providers',
        hint: groupHint(enabled, tierById),
      },
      ...Object.entries(config.groups).map(([name, ids]) => ({
        value: `group:${name}`,
        label: `group: ${name}`,
        hint: groupHint(ids, tierById),
      })),
      { value: 'custom', label: 'pick specific providers' },
    ],
  });
  if (p.isCancel(scope)) return cancel();

  let providers: string[] | undefined;
  let group: string | undefined;
  if (scope === 'custom') {
    const picked = await p.multiselect<string>({
      message: 'Select providers (space to toggle, enter to confirm)',
      options: getAllProviders().map((provider) => ({
        value: provider.id,
        label: provider.id,
        hint: `${provider.tier}${config.providers[provider.id]?.enabled ? '' : ', not enabled in config'}`,
      })),
      required: true,
    });
    if (p.isCancel(picked)) return cancel();
    providers = picked;
  } else if (scope.startsWith('group:')) {
    group = scope.slice('group:'.length);
  }

  const mode = await p.select<'mixed' | 'sync' | 'async'>({
    message: 'Execution mode',
    initialValue: 'mixed',
    options: [
      {
        value: 'mixed',
        label: 'mixed',
        hint: 'deep research async, the rest sync (default)',
      },
      { value: 'sync', label: 'sync', hint: 'wait for every provider' },
      {
        value: 'async',
        label: 'async',
        hint: 'submit deep research and return',
      },
    ],
  });
  if (p.isCancel(mode)) return cancel();

  const refine = await p.confirm({
    message: 'Refine the query into tier-tuned variants first (one LLM call)?',
    initialValue: false,
  });
  if (p.isCancel(refine)) return cancel();

  const scopeLabel = group
    ? `group "${group}"`
    : providers
      ? `${providers.length} hand-picked providers`
      : 'all enabled providers';
  const confirmed = await p.confirm({
    message: `Fan out "${query.trim()}" to ${scopeLabel} in ${mode} mode?`,
  });
  if (p.isCancel(confirmed) || !confirmed) return cancel();

  p.outro('starting run');

  const options: RunOptions = { mode };
  if (providers) options.providers = providers;
  if (group) options.group = group;
  if (refine) options.refine = true;
  const outcome = await executeRun(query.trim(), options);

  if (
    outcome.outputDir &&
    outcome.exitCode !== 2 &&
    process.stdout.isTTY &&
    process.stdin.isTTY
  ) {
    const browse = await p.confirm({
      message: 'Browse these results now?',
      initialValue: false,
    });
    if (!p.isCancel(browse) && browse) {
      await browseRunDir(outcome.outputDir);
    }
  }
}

function cancel(): void {
  p.cancel('Cancelled.');
  process.exitCode = 130;
}
