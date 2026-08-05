import { resolveProviderId } from '../constants.js';
import {
  type CredentialContext,
  describeCredentialReference,
} from '../core/credentials.js';
import type { HttpClient } from '../core/http-client.js';
import { getMeteringKind } from '../core/metering.js';
import {
  providerCredentialRef,
  providerHasCredential,
} from '../core/provider-selection.js';
import type { Config, Provider, ProviderMeta, ProviderTier } from '../types.js';
import { ProviderBase } from './base.js';
import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  type BuiltInProviderDescriptor,
} from './provider-descriptors.js';

const providers = new Map<string, Provider>();

export type ProviderInitConfig = Partial<
  Pick<
    Config,
    'defaults' | 'providers' | 'customProviders' | 'trustedProviderIds'
  >
> & {
  credentials?: CredentialContext;
  httpClient?: HttpClient;
};

export interface ProviderInitResult {
  warnings: string[];
  loadedCustomProviders: string[];
  skippedCustomProviders: string[];
}

/**
 * Register a provider in the registry
 */
export function registerProvider(provider: Provider): void {
  assertProviderExecutionContract(provider);
  provider.source ??= 'builtin';
  provider.requiresApiKey ??= true;
  providers.set(provider.id, provider);
}

function assertProviderExecutionContract(provider: Provider): void {
  const candidate = provider as Provider & {
    execution?: unknown;
    execute?: unknown;
    submit?: unknown;
    poll?: unknown;
    retrieve?: unknown;
  };
  if (
    candidate.execution !== 'inline' &&
    candidate.execution !== 'background'
  ) {
    throw new TypeError(
      `Provider "${provider.id}" must declare execution as "inline" or "background"`,
    );
  }
  if (typeof candidate.execute !== 'function') {
    throw new TypeError(`Provider "${provider.id}" must define execute`);
  }
  const lifecycle = [candidate.submit, candidate.poll, candidate.retrieve];
  if (
    candidate.execution === 'background' &&
    lifecycle.some((method) => typeof method !== 'function')
  ) {
    throw new TypeError(
      `Background provider "${provider.id}" must define submit, poll, and retrieve`,
    );
  }
  if (
    candidate.execution === 'inline' &&
    lifecycle.some((method) => method !== undefined)
  ) {
    throw new TypeError(
      `Inline provider "${provider.id}" cannot define submit, poll, or retrieve`,
    );
  }
}

/**
 * Get a provider by ID
 */
export function getProvider(id: string): Provider | undefined {
  return providers.get(resolveProviderId(id));
}

/**
 * Look up only a canonical registered id. Async task files use this stricter
 * path so retired provider handles are never reinterpreted as a new provider's
 * remote task identifier after an upgrade.
 */
export function getExactProvider(id: string): Provider | undefined {
  return providers.get(id);
}

/**
 * Get all registered providers
 */
export function getAllProviders(): Provider[] {
  return Array.from(providers.values());
}

/**
 * Get providers by tier
 */
export function getProvidersByTier(tier: ProviderTier): Provider[] {
  return getAllProviders().filter((p) => p.tier === tier);
}

/**
 * Get provider metadata for display (ls command)
 */
export function getProviderMeta(
  config: Record<string, { apiKey?: string; enabled?: boolean }>,
  credentials: CredentialContext = {},
): ProviderMeta[] {
  return getAllProviders().map((p) => {
    const providerConfig = config[p.id];
    const requiresApiKey = p.requiresApiKey ?? true;
    const credentialRef = providerCredentialRef(p, providerConfig);
    const credentialInfo = describeCredentialReference(
      requiresApiKey ? credentialRef : undefined,
    );
    const hasApiKey = requiresApiKey
      ? providerHasCredential(p, providerConfig, credentials)
      : true;
    return {
      id: p.id,
      displayName: p.displayName,
      tier: p.tier,
      envVar: p.envVar,
      source: p.source ?? 'builtin',
      enabled: providerConfig?.enabled ?? false,
      configured: providerConfig !== undefined,
      meteringKind: getMeteringKind(p.id),
      hasApiKey,
      credentialSource: requiresApiKey
        ? hasApiKey
          ? credentialInfo.source
          : 'missing'
        : 'literal',
    };
  });
}

/**
 * Initialize all providers — called at startup.
 * Instantiates and registers all built-in provider adapters.
 */
export async function initializeProviders(
  config: ProviderInitConfig = {},
): Promise<ProviderInitResult> {
  providers.clear();
  const providerConfig = config.providers ?? {};
  const credentials = config.credentials ?? {};
  const httpClient = config.httpClient;
  const warnings: string[] = [];

  for (const descriptor of BUILTIN_PROVIDER_DESCRIPTORS) {
    const configured = providerConfig[descriptor.id];
    const options = descriptor.optionsSchema.safeParse(
      configured?.options ?? {},
    );
    if (!options.success) {
      const detail = options.error.issues
        .map(
          (issue) => `${issue.path.join('.') || 'options'}: ${issue.message}`,
        )
        .join('; ');
      warnings.push(`Skipping ${descriptor.id}: invalid options (${detail})`);
      continue;
    }
    const normalizedConfig = configured
      ? { ...configured, options: options.data }
      : undefined;
    const provider = descriptor.factory({
      providerConfig: normalizedConfig,
      defaults: config.defaults,
    });
    assertBuiltInDescriptorMatch(descriptor, provider);
    if (provider instanceof ProviderBase) {
      provider.configure({
        apiKey: normalizedConfig?.apiKey,
        credentials,
        httpClient,
      });
    }
    provider.source = 'builtin';
    provider.requiresApiKey = descriptor.credential.required;
    registerProvider(provider);
  }

  return {
    warnings,
    loadedCustomProviders: [],
    skippedCustomProviders: [],
  };
}

function assertBuiltInDescriptorMatch(
  descriptor: BuiltInProviderDescriptor,
  provider: Provider,
): void {
  const mismatches = [
    provider.id === descriptor.id ? undefined : `id=${provider.id}`,
    provider.tier === descriptor.tier ? undefined : `tier=${provider.tier}`,
    provider.execution === descriptor.capabilities.execution
      ? undefined
      : `execution=${provider.execution}`,
    provider.displayName === descriptor.display.name
      ? undefined
      : `displayName=${provider.displayName}`,
    provider.envVar === descriptor.credential.envVar
      ? undefined
      : `envVar=${provider.envVar}`,
  ].filter((value): value is string => value !== undefined);

  if (mismatches.length > 0) {
    throw new TypeError(
      `Built-in provider descriptor mismatch for ${descriptor.id}: ${mismatches.join(', ')}`,
    );
  }
}
