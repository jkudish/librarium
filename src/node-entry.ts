/**
 * librarium/node -- the Node-only bridge for the library.
 *
 * `librarium/core` is edge-safe (no Node APIs) and exposes the built-in
 * provider adapters plus `registerProvider()` for hand-written providers.
 * Custom providers configured as npm modules or external scripts, however,
 * require Node (module resolution + child processes). This entry point is the
 * single, documented place those are loaded from -- it shares the exact
 * loading/trust logic the CLI uses (one implementation, two callers).
 *
 * Edge/Workers users should keep importing from `librarium/core`.
 */

import {
  type CustomProviderLoadResult,
  loadCustomProviders as loadCustomProvidersInternal,
} from './adapters/custom.js';
import { getAllProviders, registerProvider } from './adapters/index.js';
import type { Config } from './types.js';

export type { CustomProviderLoadResult } from './adapters/custom.js';
export * from './node-credentials.js';

export interface LoadCustomProvidersOptions {
  /**
   * Provider IDs that may not be claimed by a custom provider. Defaults to the
   * IDs of every provider currently registered in the core registry (i.e. the
   * built-ins after `initializeProviders()`), matching CLI behavior.
   */
  reservedProviderIds?: Iterable<string>;
}

/**
 * Load custom providers (npm modules + scripts) declared in a librarium
 * `Config`, applying the same trust gating (`trustedProviderIds`) and
 * reserved-ID protection the CLI uses. Returns the loaded providers plus
 * diagnostics; it does NOT register them. Use `registerCustomProviders` for
 * the load-and-register convenience.
 */
export async function loadCustomProviders(
  config: Pick<Config, 'customProviders' | 'trustedProviderIds' | 'providers'>,
  options: LoadCustomProvidersOptions = {},
): Promise<CustomProviderLoadResult> {
  const reservedProviderIds = new Set(
    options.reservedProviderIds ?? getAllProviders().map((p) => p.id),
  );

  return loadCustomProvidersInternal({
    customProviders: config.customProviders ?? {},
    trustedProviderIds: config.trustedProviderIds ?? [],
    providerConfigs: config.providers ?? {},
    reservedProviderIds,
  });
}

/**
 * Load custom providers from a `Config` and register the successfully loaded
 * ones into the core registry (so `getProvider`/`dispatch` see them). Returns
 * the same diagnostics as `loadCustomProviders`. Call after
 * `initializeProviders()` so reserved-ID detection sees the built-ins.
 */
export async function registerCustomProviders(
  config: Pick<Config, 'customProviders' | 'trustedProviderIds' | 'providers'>,
  options: LoadCustomProvidersOptions = {},
): Promise<CustomProviderLoadResult> {
  const result = await loadCustomProviders(config, options);
  for (const provider of result.providers) {
    registerProvider(provider);
  }
  return result;
}
