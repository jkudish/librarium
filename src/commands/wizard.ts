import * as p from '@clack/prompts';
import { loadConfig, loadProjectConfig, mergeConfigs } from '../core/config.js';
import type { CredentialContext } from '../core/credentials.js';
import { BUILTIN_PROVIDER_DEFINITIONS } from '../core/provider-descriptor.js';
import {
  preflightProductionRequest,
  preflightProductionRequestStructure,
  RequestPreflightError,
} from '../node-request-preflight.js';
import type { Config, ProviderTier } from '../types.js';
import { synthesizeAnswer } from './answer.js';
import { browseRunDir } from './browse.js';
import { runOnboardingWizard } from './onboarding.js';
import { resolveRefineClient } from './refine.js';
import { type ExecuteRunHooks, executeRun, type RunOptions } from './run.js';

/**
 * Interactive wizard launched by bare `librarium` in a TTY: prompt for the
 * query, pick providers (group or specific), pick mode, confirm, then run
 * the exact same flow as `librarium run` with the live table.
 */

const TIER_ORDER: ProviderTier[] = [
  'deep-research',
  'ai-grounded',
  'raw-search',
  'llm',
];

interface WizardProvider {
  readonly id: string;
  readonly displayName: string;
  readonly tier: ProviderTier;
}

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

function customProviderTier(
  source: Config['customProviders'][string],
): ProviderTier {
  switch (source.executionProfile?.profile.result_kind) {
    case 'research_report':
      return 'deep-research';
    case 'grounded_answer':
    case 'surface_observation':
      return 'ai-grounded';
    case 'model_answer':
      return 'llm';
    case 'search_results':
      return 'raw-search';
    default:
      return 'raw-search';
  }
}

/**
 * Build a display-only provider list from configuration declarations. Bare
 * `librarium` must not initialize providers, load custom modules, spawn custom
 * scripts, or construct a keychain-aware credential context before executeRun
 * performs its two-phase admission gate.
 */
function wizardProviders(config: Config): readonly WizardProvider[] {
  const builtins = BUILTIN_PROVIDER_DEFINITIONS.map((definition) => ({
    id: definition.id,
    displayName: definition.display.name,
    tier: definition.tier,
  }));
  const builtinIds = new Set(builtins.map(({ id }) => id));
  const custom = Object.entries(config.customProviders)
    .filter(([id]) => !builtinIds.has(id))
    .map(([id, source]) => ({
      id,
      displayName: id,
      tier: customProviderTier(source),
    }));
  return [...builtins, ...custom];
}

/** Safe to call only after structural request admission has completed. */
export function hasWizardSynthesisClient(
  config: Config,
  credentials: CredentialContext,
): boolean {
  return resolveRefineClient(config, process.env, credentials) !== null;
}

export async function runWizard(): Promise<void> {
  const config = mergeConfigs(loadConfig(), loadProjectConfig(process.cwd()));
  const displayProviders = wizardProviders(config);
  const tierById = new Map<string, ProviderTier>(
    displayProviders.map((provider) => [provider.id, provider.tier]),
  );
  const enabled = enabledProviderIds(config);

  if (enabled.length === 0) {
    await runOnboardingWizard();
    return;
  }

  p.intro('librarium');

  const query = await p.text({
    message: 'What do you want to research?',
    placeholder: 'e.g. postgres pooling best practices',
    validate: (value) =>
      value && value.trim().length > 0 ? undefined : 'Enter a query',
  });
  if (p.isCancel(query)) return cancel();

  // Provider scope: enabled set, a group, or hand-picked providers.
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
      {
        value: 'custom',
        label: 'pick specific providers',
        hint: 'choose exactly which providers run',
      },
    ],
  });
  if (p.isCancel(scope)) return cancel();

  let providers: string[] | undefined;
  let group: string | undefined;
  if (scope === 'custom') {
    const picked = await p.multiselect<string>({
      message: 'Select providers (space to toggle, enter to confirm)',
      options: displayProviders.map((provider) => ({
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
        hint: 'fast providers answer now, deep research runs in the background (recommended)',
      },
      {
        value: 'sync',
        label: 'sync',
        hint: 'wait for everything to finish, deep research can take several minutes',
      },
      {
        value: 'async',
        label: 'async',
        hint: 'submit everything and return immediately, collect later with librarium status',
      },
    ],
  });
  if (p.isCancel(mode)) return cancel();

  // Validate the request shape before consent without reading environment or
  // keychain credentials and without importing provider implementations.
  const preflightInput: RunOptions = { mode, skipPreflightConfirm: true };
  if (providers) preflightInput.providers = providers;
  else if (scope === 'enabled') preflightInput.providers = enabled;
  if (group) preflightInput.group = group;
  try {
    preflightProductionRequestStructure({
      config,
      transport: {
        kind: 'cli',
        input: {
          query: query.trim(),
          providers: preflightInput.providers,
          group: preflightInput.group,
          mode: preflightInput.mode,
        },
      },
    });
  } catch (error) {
    if (error instanceof RequestPreflightError) {
      p.log.error(error.message);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  const scopeLabel = group
    ? `group "${group}"`
    : providers
      ? `${providers.length} hand-picked providers`
      : 'all enabled providers';
  const confirmed = await p.confirm({
    message: `Fan out "${query.trim()}" to ${scopeLabel} in ${mode} mode?`,
  });
  if (p.isCancel(confirmed) || !confirmed) return cancel();

  // Consent is explicit. Credential resolution is allowed now, but provider
  // initialization remains inside executeRun after credential-aware preflight.
  let refine: boolean | symbol = false;
  let synthesize: boolean | symbol = false;
  let wizardCredentials: CredentialContext;
  try {
    wizardCredentials = preflightProductionRequest({
      config,
      transport: {
        kind: 'cli',
        input: {
          query: query.trim(),
          providers: preflightInput.providers,
          group: preflightInput.group,
          mode: preflightInput.mode,
        },
      },
    }).credentials;
  } catch (error) {
    if (
      error instanceof RequestPreflightError &&
      error.issues.some((issue) => issue.code === 'profile_uncredentialed')
    ) {
      p.log.warn('A selected provider needs credentials. Opening onboarding.');
      await runOnboardingWizard();
      return;
    }
    if (error instanceof RequestPreflightError) {
      p.log.error(error.message);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  if (hasWizardSynthesisClient(config, wizardCredentials)) {
    p.log.message(
      'Refine rewrites your query three ways with one quick LLM call: a research brief for deep research, a focused question for AI answers, keywords for raw search.',
    );
    refine = await p.confirm({
      message: 'Refine the query for each tier first?',
      initialValue: false,
    });
    if (p.isCancel(refine)) return cancel();

    synthesize = await p.confirm({
      message: 'Synthesize a grounded answer afterwards?',
      initialValue: false,
    });
    if (p.isCancel(synthesize)) return cancel();
  }

  p.outro('starting run');

  // The wizard's own confirm above already counts as consent, so suppress the
  // deep-research pre-flight confirm in executeRun to avoid double-prompting.
  const options: RunOptions = { mode, skipPreflightConfirm: true };
  if (providers) options.providers = providers;
  if (group) options.group = group;
  if (refine) options.refine = true;

  // Reuse the exact postDispatch synthesis hook the answer command uses, so the
  // wizard path produces the same answer.md, run.json metadata, and output.
  const hooks: ExecuteRunHooks | undefined = synthesize
    ? { postDispatch: (context) => synthesizeAnswer(context) }
    : undefined;
  const outcome = await executeRun(query.trim(), options, hooks);

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
