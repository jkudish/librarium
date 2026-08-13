import { resolveProviderId } from '../constants.js';
import {
  type CredentialContext,
  describeCredentialReference,
} from '../core/credentials.js';
import type { HttpClient, HttpStreamClient } from '../core/http-client.js';
import { getMeteringKind } from '../core/metering.js';
import {
  buildProfileBindings,
  executionAdapterProfileBindings,
  TargetSelectionError,
} from '../core/profile-bindings.js';
import { BUILTIN_PROVIDER_CATALOG } from '../core/provider-profiles.js';
import {
  providerCredentialRef,
  providerHasCredential,
} from '../core/provider-selection.js';
import {
  INTERNAL_ADAPTER_ID_SET,
  INTERNAL_ADAPTER_IDS,
  INTERNAL_ADAPTER_PUBLIC_PROVIDER_IDS,
} from '../internal-adapter-ids.js';
import type {
  Config,
  Provider,
  ProviderConfig,
  ProviderMeta,
  ProviderTier,
} from '../types.js';
import { ProviderBase } from './base.js';
import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  type BuiltInProviderDescriptor,
  getInternalBuiltInProviderDescriptor,
} from './provider-descriptors.js';

const builtinDeclarations = new Map(
  BUILTIN_PROVIDER_CATALOG.flatMap((entry) =>
    entry.profiles.map(
      (profile) =>
        [`${entry.provider_id}/${profile.profile_id}`, profile] as const,
    ),
  ),
);
const builtinProfileBindings = buildProfileBindings(builtinDeclarations);
const builtinAdapterBindings = executionAdapterProfileBindings();

const providers = new Map<string, Provider>();

export type ProviderInitConfig = Partial<
  Pick<
    Config,
    'defaults' | 'providers' | 'customProviders' | 'trustedProviderIds'
  >
> & {
  credentials?: CredentialContext;
  httpClient?: HttpClient;
  httpStreamClient?: HttpStreamClient;
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
  return Array.from(providers.values()).filter(
    (provider) => !INTERNAL_ADAPTER_ID_SET.has(provider.id),
  );
}

/** Internal research adapters remain resolvable by exact frozen binding only. */
export function registeredAdapterIds(): string[] {
  return Array.from(providers.keys());
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
  config: Record<
    string,
    Pick<ProviderConfig, 'apiKey' | 'enabled' | 'model' | 'options'>
  >,
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
    const identity = builtinAdapterBindings.get(p.id);
    const binding = identity
      ? builtinProfileBindings.get(
          `${identity.provider_id}/${identity.profile_id}`,
        )
      : undefined;
    let target;
    try {
      target = binding?.resolve({
        model: providerConfig?.model,
        options: providerConfig?.options ?? {},
      }).profile.identity.target;
    } catch {
      // Invalid configuration is reported by preflight. Display the declared
      // target rather than inventing a configured or provider-reported value.
      target = identity
        ? builtinDeclarations.get(
            `${identity.provider_id}/${identity.profile_id}`,
          )?.target
        : undefined;
    }
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
      ...(target !== undefined && { target }),
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
  const httpStreamClient = config.httpStreamClient;
  const warnings: string[] = [];

  const descriptors = [
    ...BUILTIN_PROVIDER_DESCRIPTORS,
    ...INTERNAL_ADAPTER_IDS.flatMap((id) => {
      const descriptor = getInternalBuiltInProviderDescriptor(id);
      return descriptor ? [descriptor] : [];
    }),
  ];
  for (const descriptor of descriptors) {
    // Research profiles share the established public provider configuration,
    // while their background adapters retain distinct internal ids.
    const configured =
      providerConfig[
        INTERNAL_ADAPTER_PUBLIC_PROVIDER_IDS[
          descriptor.id as keyof typeof INTERNAL_ADAPTER_PUBLIC_PROVIDER_IDS
        ] ?? descriptor.id
      ];
    const identity = builtinAdapterBindings.get(descriptor.id);
    const binding = identity
      ? builtinProfileBindings.get(
          `${identity.provider_id}/${identity.profile_id}`,
        )
      : undefined;
    try {
      binding?.validateModel(configured?.model);
    } catch (error) {
      const detail =
        error instanceof TargetSelectionError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      warnings.push(`Skipping ${descriptor.id}: ${detail}`);
      continue;
    }
    const options = descriptor.optionsSchema.safeParse(
      configured?.options ?? {},
    );
    if (!options.success) {
      const detail = options.error.issues
        .map(
          (issue) => `${issue.path.join('.') || 'options'}: ${issue.message}`,
        )
        .join('; ');
      warnings.push(`Invalid options for ${descriptor.id} (${detail})`);
    }
    const normalizedConfig = configured
      ? {
          ...configured,
          // Invalid raw options have already been rejected by the descriptor
          // schema. Do not pass them to a factory where a coercion could turn
          // a fail-closed configuration error into a live request.
          options: options.success
            ? (options.data as Record<string, unknown>)
            : {},
        }
      : undefined;
    let provider: Provider;
    try {
      provider = descriptor.factory({
        providerConfig: normalizedConfig,
        // Descriptor validation is the only configuration boundary. Factories
        // receive its parsed value, never the raw option record.
        options: options.success ? options.data : {},
        defaults: config.defaults,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`Skipping ${descriptor.id}: ${detail}`);
      continue;
    }
    if (!options.success) {
      applyConfigurationError(provider, `Invalid options for ${descriptor.id}`);
    }
    assertBuiltInDescriptorMatch(descriptor, provider);
    if (provider instanceof ProviderBase) {
      provider.configure({
        apiKey: normalizedConfig?.apiKey,
        credentials,
        httpClient,
        httpStreamClient,
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

function applyConfigurationError(provider: Provider, message: string): void {
  provider.configurationError = message;
  provider.execute = async () => ({
    provider: provider.id,
    tier: provider.tier,
    content: '',
    citations: [],
    durationMs: 0,
    preventFallback: true,
    error: message,
  });
  provider.test = async () => ({ ok: false, error: message });

  if (provider.execution === 'background') {
    provider.submit = async () => {
      throw new Error(message);
    };
  }
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
