import type { Config } from '../types.js';
import { loadCustomProviders } from './custom.js';
import {
  getAllProviders,
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
  getProvider,
  getProviderMeta,
  getProvidersByTier,
  registerProvider,
};

export async function initializeProviders(
  config: ProviderInitConfig = {},
): Promise<ProviderInitResult> {
  const builtinResult = await initializeBuiltinProviders(config);
  const providerConfig = config.providers ?? {};
  const customProviders = config.customProviders ?? {};

  if (Object.keys(customProviders).length === 0) {
    return builtinResult;
  }

  const reservedProviderIds = new Set(getAllProviders().map((p) => p.id));
  const customResult = await loadCustomProviders({
    customProviders,
    trustedProviderIds: config.trustedProviderIds ?? [],
    providerConfigs: providerConfig as Config['providers'],
    reservedProviderIds,
  });

  for (const provider of customResult.providers) {
    registerProvider(provider);
  }

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
