export type EnvRecord = Record<string, string | undefined>;

export type CredentialResolver = (value: string) => string | undefined;

export interface CredentialContext {
  env?: EnvRecord;
  resolveCredential?: CredentialResolver;
}

/**
 * Resolve literal API keys and $ENV_VAR references from injected credentials.
 */
export function resolveCredential(
  value: string,
  context: CredentialContext = {},
): string | undefined {
  if (context.resolveCredential) {
    return context.resolveCredential(value);
  }

  if (value.startsWith('$')) {
    return context.env?.[value.slice(1)];
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
