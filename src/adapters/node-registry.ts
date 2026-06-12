import { registerCustomProviders } from '../node-entry.js';
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
  const customProviders = config.customProviders ?? {};

  if (Object.keys(customProviders).length === 0) {
    return builtinResult;
  }

  // Reuse the same load-and-register path the library `librarium/node` entry
  // exposes -- one implementation, two callers. Reserved IDs default to the
  // built-ins just registered above.
  const customResult = await registerCustomProviders({
    customProviders,
    trustedProviderIds: config.trustedProviderIds ?? [],
    providers: config.providers ?? {},
  });

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
