import { loadCustomProviders } from '../node-entry.js';
import {
  getAllProviders,
  getExactProvider,
  getProvider,
  getProviderMeta,
  getProvidersByTier,
  initializeProviders as initializeBuiltinProviders,
  type ProviderInitConfig,
  type ProviderInitResult,
  registerProvider,
} from './index.js';

export {
  getAllProviders,
  getExactProvider,
  getProvider,
  getProviderMeta,
  getProvidersByTier,
  registerProvider,
};

export async function initializeProviders(
  config: ProviderInitConfig = {},
): Promise<ProviderInitResult> {
  const builtinResult = await initializeBuiltinProviders(config);
  const customProviders = config.customProviders ?? {};

  if (Object.keys(customProviders).length === 0) {
    return builtinResult;
  }

  // Reuse the public trust-filtered loader, then keep the legacy global
  // registration step private to the CLI compatibility path.
  const customResult = await loadCustomProviders({
    customProviders,
    trustedProviderIds: config.trustedProviderIds ?? [],
    providers: config.providers ?? {},
  });
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
