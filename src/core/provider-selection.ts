import {
  type ProviderNameEntry,
  resolveProviderIds,
  resolveProviderTokens,
} from '../constants.js';
import type { Config, Provider } from '../types.js';
import type { CredentialContext } from './credentials.js';
import { hasCredential } from './credentials.js';

export class ProviderSelectionError extends Error {}

export interface ProviderSelectionArgs {
  providers?: string[];
  group?: string;
}

export interface ProviderSelectionOptions {
  includeConfiguredOnly?: boolean;
  requireUsable?: boolean;
  strictExplicitCredentials?: boolean;
  allowDisabledWithCredentials?: boolean;
  credentials?: CredentialContext;
  onWarn?: (message: string) => void;
}

export interface ProviderAvailabilityResult {
  providerIds: string[];
  unavailable: string[];
  disabled: string[];
  missingCredentials: string[];
}

function providerMap(providers: Provider[]): Map<string, Provider> {
  return new Map(providers.map((provider) => [provider.id, provider]));
}

export function providerCredentialRef(
  provider: Pick<Provider, 'envVar'>,
  config: { apiKey?: string } | undefined,
): string | undefined {
  return (
    config?.apiKey ?? (provider.envVar ? `$${provider.envVar}` : undefined)
  );
}

export function providerHasCredential(
  provider: Pick<Provider, 'envVar' | 'requiresApiKey'>,
  config: { apiKey?: string } | undefined,
  credentials: CredentialContext = {},
): boolean {
  if ((provider.requiresApiKey ?? true) === false) return true;
  return hasCredential(providerCredentialRef(provider, config), credentials);
}

export function buildProviderNameIndex(
  providers: Provider[],
  config: Config,
  includeConfiguredOnly = false,
): ProviderNameEntry[] {
  const nameIndex = providers.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
  }));
  if (!includeConfiguredOnly) return nameIndex;

  const registeredIds = new Set(nameIndex.map((entry) => entry.id));
  for (const configuredId of Object.keys(config.providers)) {
    if (!registeredIds.has(configuredId)) {
      nameIndex.push({ id: configuredId, displayName: configuredId });
    }
  }
  return nameIndex;
}

export function resolveProviderSelection(
  config: Config,
  args: ProviderSelectionArgs,
  providers: Provider[],
  options: ProviderSelectionOptions = {},
): string[] {
  const onWarn = options.onWarn ?? (() => {});
  let providerIds: string[];

  if (args.providers !== undefined) {
    const tokens = args.providers
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    if (tokens.length === 0) {
      throw new ProviderSelectionError(
        'The `providers` array was provided but contains no usable provider ids. Omit `providers` to use the default enabled set, or pass at least one provider id.',
      );
    }

    const resolution = resolveProviderTokens(
      tokens,
      buildProviderNameIndex(
        providers,
        config,
        options.includeConfiguredOnly ?? false,
      ),
    );
    for (const warning of resolution.warnings) {
      onWarn(`[librarium] warning: ${warning}`);
    }
    if (resolution.errors.length > 0) {
      throw new ProviderSelectionError(resolution.errors.join(' '));
    }
    providerIds = resolution.ids;
  } else if (args.group !== undefined) {
    const groupName = args.group.trim();
    if (groupName.length === 0) {
      throw new ProviderSelectionError(
        'The `group` was provided but is empty. Omit `group` to use the default enabled set, or pass a configured group name.',
      );
    }
    const group = config.groups[groupName];
    if (!group) {
      throw new ProviderSelectionError(`Unknown group: ${groupName}`);
    }
    providerIds = resolveProviderIds(group);
  } else {
    providerIds = resolveProviderIds(
      Object.entries(config.providers)
        .filter(([, providerConfig]) => providerConfig.enabled)
        .map(([id]) => id),
    );
  }

  if (providerIds.length === 0) {
    throw new ProviderSelectionError(
      'No providers selected. Run `librarium init` or bare `librarium` to configure providers.',
    );
  }

  if (!options.requireUsable) {
    const registered = new Set(providers.map((provider) => provider.id));
    const filtered = providerIds.filter((id) => registered.has(id));
    if (filtered.length === 0) {
      throw new ProviderSelectionError(
        'No valid providers selected after validation. Check provider availability in config.',
      );
    }
    return filtered;
  }

  const availability = filterProviderAvailability(
    config,
    providerIds,
    providers,
    options.credentials,
    {
      allowDisabledWithCredentials:
        options.allowDisabledWithCredentials ??
        (args.providers !== undefined || args.group !== undefined),
    },
  );

  if (
    options.strictExplicitCredentials &&
    args.providers !== undefined &&
    (availability.disabled.length > 0 ||
      availability.missingCredentials.length > 0)
  ) {
    const problems = [
      ...availability.disabled.map((id) => `${id} is not enabled`),
      ...availability.missingCredentials.map(
        (id) => `${id} is missing an API key`,
      ),
    ];
    throw new ProviderSelectionError(problems.join('; '));
  }

  for (const id of availability.unavailable) {
    onWarn(`[librarium] warning: ${id} is not registered and will be skipped`);
  }
  for (const id of availability.disabled) {
    onWarn(`[librarium] warning: ${id} is not enabled and will be skipped`);
  }
  for (const id of availability.missingCredentials) {
    onWarn(
      `[librarium] warning: ${id} is missing an API key and will be skipped`,
    );
  }

  if (availability.providerIds.length === 0) {
    throw new ProviderSelectionError(
      'No usable providers selected. Run bare `librarium` to configure at least one API key.',
    );
  }

  return availability.providerIds;
}

export function filterProviderAvailability(
  config: Config,
  providerIds: string[],
  providers: Provider[],
  credentials: CredentialContext = {},
  options: Pick<ProviderSelectionOptions, 'allowDisabledWithCredentials'> = {},
): ProviderAvailabilityResult {
  const byId = providerMap(providers);
  const available: string[] = [];
  const unavailable: string[] = [];
  const disabled: string[] = [];
  const missingCredentials: string[] = [];

  for (const id of providerIds) {
    const provider = byId.get(id);
    if (!provider) {
      unavailable.push(id);
      continue;
    }

    const providerConfig = config.providers[id];
    const hasAvailableCredential = providerHasCredential(
      provider,
      providerConfig,
      credentials,
    );
    if (!providerConfig?.enabled) {
      if (options.allowDisabledWithCredentials && hasAvailableCredential) {
        available.push(id);
        continue;
      }
      disabled.push(id);
      continue;
    }

    if (!hasAvailableCredential) {
      missingCredentials.push(id);
      continue;
    }

    available.push(id);
  }

  return {
    providerIds: available,
    unavailable,
    disabled,
    missingCredentials,
  };
}

export function usableProviderIds(
  config: Config,
  providers: Provider[],
  credentials: CredentialContext = {},
): string[] {
  return filterProviderAvailability(
    config,
    resolveProviderIds(
      Object.entries(config.providers)
        .filter(([, providerConfig]) => providerConfig.enabled)
        .map(([id]) => id),
    ),
    providers,
    credentials,
  ).providerIds;
}
