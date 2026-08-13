import { loadCustomProviders } from '../node-entry.js';
import type { Provider, ProviderTier } from '../types.js';
import {
  getAllProviders,
  getExactProvider,
  getProvider,
  getProviderMeta,
  getProvidersByTier,
  initializeProviders as initializeBuiltinProviders,
  type ProviderInitConfig,
  type ProviderInitResult,
  registeredAdapterIds,
  registerProvider,
} from './index.js';

export {
  getAllProviders,
  getExactProvider,
  getProvider,
  getProviderMeta,
  getProvidersByTier,
  registeredAdapterIds,
  registerProvider,
};

export interface InitializeProvidersOptions {
  /**
   * Limit trusted custom-code loading to the exact adapters admitted for this
   * request, including its configured fallback reserve. Built-ins remain
   * available for legacy read compatibility.
   */
  customProviderIds?: Iterable<string>;
}

function expectedTier(
  resultKind:
    | 'search_results'
    | 'grounded_answer'
    | 'research_report'
    | 'model_answer'
    | 'surface_observation',
): ProviderTier {
  switch (resultKind) {
    case 'search_results':
      return 'raw-search';
    case 'grounded_answer':
    case 'surface_observation':
      return 'ai-grounded';
    case 'research_report':
      return 'deep-research';
    case 'model_answer':
      return 'llm';
  }
}

function assertCustomProviderDeclarationMatch(
  providers: readonly Provider[],
  customProviders: NonNullable<ProviderInitConfig['customProviders']>,
): void {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  for (const [adapterId, source] of Object.entries(customProviders)) {
    const declared = source.executionProfile;
    const loaded = byId.get(adapterId);
    if (!declared || !loaded) {
      throw new Error(
        `Admitted custom provider "${adapterId}" did not load its declared execution profile.`,
      );
    }
    if (loaded.execution !== declared.profile.invocation) {
      throw new Error(
        `Admitted custom provider "${adapterId}" returned an execution mode that does not match its declared execution profile.`,
      );
    }
    if (loaded.tier !== expectedTier(declared.profile.result_kind)) {
      throw new Error(
        `Admitted custom provider "${adapterId}" returned a tier that does not match its declared result kind.`,
      );
    }
    const declaredCredential = declared.credential?.envVar;
    if (
      declaredCredential === undefined
        ? loaded.requiresApiKey !== false
        : loaded.requiresApiKey !== true || loaded.envVar !== declaredCredential
    ) {
      throw new Error(
        `Admitted custom provider "${adapterId}" returned credential requirements that do not match its declared execution profile.`,
      );
    }

    // The v1 Provider descriptor exposes no canonical profile identity or
    // selected target. This Slice A bridge therefore cannot verify those
    // fields after import; Slice B must replace it with the v2 attempt bridge
    // before runtime target/provenance claims can be made.
  }
}

export async function initializeProviders(
  config: ProviderInitConfig = {},
  options: InitializeProvidersOptions = {},
): Promise<ProviderInitResult> {
  const builtinResult = await initializeBuiltinProviders(config);
  const configuredCustomProviders = config.customProviders ?? {};
  const permittedCustomProviderIds = options.customProviderIds
    ? new Set(options.customProviderIds)
    : undefined;
  const customProviders =
    permittedCustomProviderIds === undefined
      ? configuredCustomProviders
      : Object.fromEntries(
          Object.entries(configuredCustomProviders).filter(([id]) =>
            permittedCustomProviderIds.has(id),
          ),
        );

  if (Object.keys(customProviders).length === 0) {
    return builtinResult;
  }

  // Reuse the public trust-filtered loader, then keep the legacy global
  // registration step private to the CLI compatibility path.
  const customResult = await loadCustomProviders({
    customProviders,
    trustedProviderIds: (config.trustedProviderIds ?? []).filter(
      (id) => permittedCustomProviderIds?.has(id) ?? true,
    ),
    providers: config.providers ?? {},
  });
  if (permittedCustomProviderIds !== undefined) {
    assertCustomProviderDeclarationMatch(
      customResult.providers,
      customProviders,
    );
  }
  for (const provider of customResult.providers) registerProvider(provider);

  return {
    warnings: [...builtinResult.warnings, ...customResult.warnings],
    loadedCustomProviders: [
      ...builtinResult.loadedCustomProviders,
      ...customResult.loadedIds,
    ],
    skippedCustomProviders: [
      ...builtinResult.skippedCustomProviders,
      ...customResult.skippedIds,
    ],
  };
}
