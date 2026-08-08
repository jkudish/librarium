import { z } from 'zod/v4';

export const CONTRACT_LIMITS = {
  extensionBytes: 16_384,
  extensionDepth: 6,
  extensionKeys: 32,
  extensionArrayItems: 100,
  extensionStringLength: 8_192,
  decimalStringLength: 128,
  identifierLength: 255,
  safeMessageLength: 2_048,
} as const;

const normalizeExtensionKey = (key: string): string =>
  key
    .replace(/URLs/g, '_urls')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z\d]+/g, '_')
    .replace(/^_+|_+$/g, '');

const FORBIDDEN_EXTENSION_KEY_NAMES = new Set([
  'api_key',
  'api_keys',
  'access_token',
  'access_tokens',
  'auth_token',
  'auth_tokens',
  'client_token',
  'client_tokens',
  'client_secret',
  'client_secrets',
  'refresh_token',
  'refresh_tokens',
  'resume_token',
  'resume_tokens',
  'resume_secret',
  'resume_secrets',
  'session_token',
  'session_tokens',
  'session_secret',
  'session_secrets',
  'task_token',
  'task_tokens',
  'task_secret',
  'task_secrets',
  'id_token',
  'id_tokens',
  'private_key',
  'private_keys',
  'encryption_key',
  'encryption_keys',
  'signing_key',
  'signing_keys',
  'presigned_url',
  'presigned_urls',
  'signed_url',
  'signed_urls',
  'signed_polling_url',
  'signed_polling_urls',
  'connection_string',
  'connection_strings',
  'database_url',
  'database_urls',
  'dsn',
  'dsns',
  'authorization',
  'auth',
  'bearer',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'password',
  'passwords',
  'passwd',
  'passwds',
  'secret',
  'secrets',
  'token',
  'tokens',
  'request_header',
  'request_headers',
  'response_header',
  'response_headers',
  'raw_body',
  'raw_bodies',
  'raw_provider',
  'raw_providers',
  'raw_response',
  'raw_responses',
  'binary',
  'binary_data',
  'binary_material',
  'binary_materials',
  'binary_payload',
  'binary_payloads',
  'stack',
  'stacks',
  'stack_trace',
  'stack_traces',
]);

const FORBIDDEN_FUSED_EXTENSION_KEY_NAMES = new Set(
  [...FORBIDDEN_EXTENSION_KEY_NAMES].map((key) => key.replaceAll('_', '')),
);

const isForbiddenNormalizedExtensionKey = (key: string): boolean =>
  FORBIDDEN_EXTENSION_KEY_NAMES.has(key) ||
  FORBIDDEN_FUSED_EXTENSION_KEY_NAMES.has(key.replaceAll('_', ''));

const isForbiddenExtensionKey = (key: string): boolean => {
  const candidates = [normalizeExtensionKey(key)];
  const namespaceSeparator = key.lastIndexOf(':');
  if (namespaceSeparator >= 0) {
    candidates.push(normalizeExtensionKey(key.slice(namespaceSeparator + 1)));
  }
  return candidates.some(isForbiddenNormalizedExtensionKey);
};

export const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(CONTRACT_LIMITS.identifierLength)
  .refine(
    (value) =>
      value.trim() === value &&
      Array.from(value).every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 31 && codePoint !== 127;
      }),
    {
      message:
        'Opaque identifiers must not have surrounding whitespace or control characters',
    },
  );

export const Rfc3339UtcSchema = z.iso
  .datetime({ offset: false })
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
    'Timestamp must include seconds and use the RFC3339 UTC Z form',
  );

const HTTP_HOST_LABEL_PATTERN = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const HTTP_PORT_PATTERN = String.raw`(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])`;
const HTTP_SUFFIX_PATTERN = String.raw`(?:[/?#][\u0021-\u005B\u005D-\u007E]*)?`;

export const HTTP_URL_PATTERN = String.raw`^https?:\/\/(?:${HTTP_HOST_LABEL_PATTERN})(?:\.(?:${HTTP_HOST_LABEL_PATTERN}))*(?::${HTTP_PORT_PATTERN})?${HTTP_SUFFIX_PATTERN}(?![\s\S])`;

export const HttpUrlSchema = z
  .string()
  .max(4_096)
  .regex(
    new RegExp(HTTP_URL_PATTERN),
    'URL must use the strict HTTP(S) wire format',
  );

export const SemverSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, {
    message: 'Expected an independent major.minor.patch contract version',
  });

export const SnakeCaseNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, {
    message: 'Expected a snake_case name',
  });

export const NamespacedKeySchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+:[A-Za-z0-9][A-Za-z0-9._-]*$/, {
    message:
      'Expected a namespaced key such as com.example:fieldName; casing after the colon is preserved',
  });

export const JsonPointerSchema = z
  .string()
  .max(512)
  .regex(/^(?:\/(?:[^~/]|~0|~1)*)*$/, {
    message: 'Expected an RFC 6901 JSON Pointer',
  });

export const JsonSafeValueSchema = z.json();

function checkJsonBounds(
  value: z.infer<typeof JsonSafeValueSchema>,
  ctx: z.RefinementCtx,
  path: PropertyKey[],
  depth: number,
): void {
  if (depth > CONTRACT_LIMITS.extensionDepth) {
    ctx.addIssue({
      code: 'custom',
      message: `Extension nesting exceeds ${CONTRACT_LIMITS.extensionDepth} levels`,
      path,
    });
    return;
  }

  if (typeof value === 'string') {
    if (value.length > CONTRACT_LIMITS.extensionStringLength) {
      ctx.addIssue({
        code: 'custom',
        message: `Extension strings must be at most ${CONTRACT_LIMITS.extensionStringLength} characters`,
        path,
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    if (value.length > CONTRACT_LIMITS.extensionArrayItems) {
      ctx.addIssue({
        code: 'custom',
        message: `Extension arrays must contain at most ${CONTRACT_LIMITS.extensionArrayItems} items`,
        path,
      });
    }
    value.forEach((item, index) => {
      checkJsonBounds(item, ctx, [...path, index], depth + 1);
    });
    return;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > CONTRACT_LIMITS.extensionKeys) {
      ctx.addIssue({
        code: 'custom',
        message: `Extension objects must contain at most ${CONTRACT_LIMITS.extensionKeys} keys`,
        path,
      });
    }
    for (const [key, child] of entries) {
      if (isForbiddenExtensionKey(key)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Extension data must not contain secrets, raw responses, headers, stacks, or binary payloads',
          path: [...path, key],
        });
      }
      checkJsonBounds(child, ctx, [...path, key], depth + 1);
    }
  }
}

export const ExtensionsSchema = z
  .record(NamespacedKeySchema, JsonSafeValueSchema)
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > CONTRACT_LIMITS.extensionKeys) {
      ctx.addIssue({
        code: 'custom',
        message: `Extensions must contain at most ${CONTRACT_LIMITS.extensionKeys} namespaced keys`,
      });
    }

    const encoded = new TextEncoder().encode(JSON.stringify(value));
    if (encoded.byteLength > CONTRACT_LIMITS.extensionBytes) {
      ctx.addIssue({
        code: 'custom',
        message: `Extensions must serialize to at most ${CONTRACT_LIMITS.extensionBytes} UTF-8 bytes`,
      });
    }

    for (const [key, child] of Object.entries(value)) {
      if (isForbiddenExtensionKey(key)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Extension keys must not describe secrets, raw responses, headers, stacks, or binary payloads',
          path: [key],
        });
      }
      checkJsonBounds(child, ctx, [key], 1);
    }
  });

export type Extensions = z.infer<typeof ExtensionsSchema>;
export type JsonSafeValue = z.infer<typeof JsonSafeValueSchema>;

export const jsonValuesEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }

  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        jsonValuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
};
