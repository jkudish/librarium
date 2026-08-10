export type EnvRecord = Record<string, string | undefined>;

export type CredentialResolver = (value: string) => string | undefined;

export const KEYCHAIN_CREDENTIAL_PREFIX = 'keychain:';

export interface CredentialContext {
  env?: EnvRecord;
  resolveCredential?: CredentialResolver;
}

export type CredentialSource = 'env' | 'keychain' | 'literal' | 'missing';

export interface CredentialReferenceInfo {
  source: CredentialSource;
  name?: string;
}

export function keychainCredentialRef(name: string): string {
  return `${KEYCHAIN_CREDENTIAL_PREFIX}${name}`;
}

export function isKeychainCredentialRef(value: string): boolean {
  return value.startsWith(KEYCHAIN_CREDENTIAL_PREFIX);
}

export function keychainCredentialName(value: string): string | undefined {
  if (!isKeychainCredentialRef(value)) return undefined;
  const name = value.slice(KEYCHAIN_CREDENTIAL_PREFIX.length).trim();
  return name.length > 0 ? name : undefined;
}

export function describeCredentialReference(
  value: string | undefined,
): CredentialReferenceInfo {
  if (!value) return { source: 'missing' };
  if (value.startsWith('$')) {
    const name = value.slice(1).trim();
    return name ? { source: 'env', name } : { source: 'missing' };
  }
  const keychainName = keychainCredentialName(value);
  if (keychainName) return { source: 'keychain', name: keychainName };
  return { source: 'literal' };
}

/**
 * Resolve literal API keys and $ENV_VAR references from injected credentials.
 */
export function resolveCredential(
  value: string,
  context: CredentialContext = {},
): string | undefined {
  if (context.resolveCredential) {
    const resolved = context.resolveCredential(value);
    if (resolved !== undefined) return resolved;
  }

  if (value.startsWith('$')) {
    const name = value.slice(1);
    if (!context.env || !Object.hasOwn(context.env, name)) return undefined;
    const resolved = context.env[name];
    return typeof resolved === 'string' ? resolved : undefined;
  }

  if (isKeychainCredentialRef(value)) {
    return undefined;
  }

  return value;
}

export function hasCredential(
  value: string | undefined,
  context: CredentialContext = {},
): boolean {
  if (!value) return false;
  const resolved = resolveCredential(value, context);
  return resolved !== undefined && resolved.length > 0;
}
