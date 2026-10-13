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

/** Redact resolved credentials and narrowly named credential URL parameters. */
export function redactCredentialText(
  value: string,
  knownCredentials: readonly (string | undefined)[] = [],
): string {
  const forms = new Set<string>();
  const add = (credential: string) => {
    if (!credential) return;
    forms.add(credential);
    forms.add(
      encodeURIComponent(credential).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    );
    forms.add(new URLSearchParams({ key: credential }).toString().slice(4));
    forms.add(
      btoa(
        Array.from(new TextEncoder().encode(credential), (byte) =>
          String.fromCharCode(byte),
        ).join(''),
      ),
    );
  };
  for (const credential of knownCredentials) {
    if (!credential) continue;
    add(credential);
    try {
      const bytes = atob(credential);
      if (btoa(bytes) !== credential) continue;
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(bytes, (character) => character.charCodeAt(0)),
      );
      add(decoded);
      for (const component of decoded.split(':')) add(component);
    } catch {
      // Most API keys are not canonical Base64 credentials.
    }
  }
  let redacted = value;
  for (const form of [...forms].sort((a, b) => b.length - a.length))
    redacted = redacted.split(form).join('[REDACTED]');
  return redacted.replace(
    /([?&](?:api[_-]?key|key|access[_-]?token)=)[^&#\s"'\\]+/gi,
    '$1[REDACTED]',
  );
}

/** Reject credential-bearing evidence URLs, including nested encoded keys. */
export function safeEvidenceUrl(value: string): string | null {
  if (
    value !== value.trim() ||
    value.length > 8192 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127 || character === '\\';
    })
  )
    return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  )
    return null;
  const credentialKey = (key: string) => {
    const parts = key
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    return [...parts, parts.join('')].some((part) =>
      /^(?:key|sig|auth|authorization|authentication|session|sessionid|apikey|apiaccesskey|accesskeyid)$|(?:signature|credential|token|secret|password|passwd)$/.test(
        part,
      ),
    );
  };
  for (const [index, component] of [
    url.pathname,
    url.search,
    url.hash,
  ].entries()) {
    let decoded = component;
    try {
      for (let pass = 0; pass < 3; pass++) {
        const next = decodeURIComponent(decoded.replace(/\+/g, ' '));
        if (next === decoded) break;
        decoded = next;
      }
    } catch {
      return null;
    }
    if (/%[a-f0-9]{2}/i.test(decoded)) return null;
    for (const assignment of decoded.matchAll(/(?:^|[?&#;/=])([^?&#;/=]+)=/g))
      if (credentialKey(assignment[1])) return null;
    if (
      index > 0 &&
      decoded
        .split(/[?&#;]/)
        .some((part) => !part.includes('=') && credentialKey(part))
    )
      return null;
  }
  return value;
}
