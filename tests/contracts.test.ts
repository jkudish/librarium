import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { z } from 'zod/v4';
import { resolveSnapshotWritePath } from '../scripts/contract-snapshot-path.js';
import {
  ArtifactSchema,
  ContractFixtureIndexSchema,
  ContractSnapshotManifestSchema,
  HistoricalArtifactReaderSchema,
  JsonlArtifactRecordSchema,
  ProviderMetadataArtifactSchema,
  RunManifestArtifactSchema,
  SourcesArtifactSchema,
} from '../src/contracts/artifacts/index.js';
import {
  CONTRACT_LIMITS,
  ExtensionsSchema,
  Rfc3339UtcSchema,
} from '../src/contracts/common.js';
import { CustomProviderExchangeSchema } from '../src/contracts/custom-provider/index.js';
import {
  ErrorCategorySchema,
  ExecutionProfileSchema,
  NormalizedSourceSchema,
  SemanticFactsSchema,
  StructuredErrorSchema,
  UsageSchema,
} from '../src/contracts/domain/index.js';
import {
  EvidenceRequirementsSchema,
  InterchangeRequestSchema,
  InterchangeResponseSchema,
  LifecycleTraceSchema,
} from '../src/contracts/interchange/index.js';

const snapshotRoot = join(process.cwd(), 'contracts', 'v1');

const fixtureSchemas = {
  'schema/artifacts.schema.json#/$defs/historical_reader':
    HistoricalArtifactReaderSchema,
  'schema/artifacts.schema.json#/$defs/run_manifest': RunManifestArtifactSchema,
  'schema/custom-provider.schema.json#/$defs/exchange':
    CustomProviderExchangeSchema,
  'schema/interchange.schema.json#/$defs/request': InterchangeRequestSchema,
  'schema/interchange.schema.json#/$defs/response': InterchangeResponseSchema,
  'schema/interchange.schema.json#/$defs/lifecycle_trace': LifecycleTraceSchema,
} satisfies Record<string, z.ZodType>;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function issuePointer(path: PropertyKey[]): string {
  if (path.length === 0) return '';
  return `/${path
    .map((segment) =>
      String(segment).replaceAll('~', '~0').replaceAll('/', '~1'),
    )
    .join('/')}`;
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function collectSemanticKeys(
  value: unknown,
  keys = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => {
      collectSemanticKeys(item, keys);
    });
    return keys;
  }
  if (!value || typeof value !== 'object') return keys;

  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    if (key !== 'extensions' && key !== 'correlation_keys') {
      collectSemanticKeys(child, keys);
    }
  }
  return keys;
}

const SENSITIVE_EXTENSION_KEY_NAMES = [
  'api_key',
  'access_token',
  'auth_token',
  'client_secret',
  'client_token',
  'refresh_token',
  'resume_token',
  'session_token',
  'task_secret',
  'task_token',
  'id_token',
  'private_key',
  'encryption_key',
  'signing_key',
  'presigned_url',
  'pre_signed_url',
  'signed_url',
  'signed_polling_url',
  'connection_string',
  'database_url',
  'dsn',
  'authorization',
  'auth',
  'bearer',
  'cookie',
  'credentials',
  'password',
  'passwd',
  'secret',
  'token',
  'request_headers',
  'response_headers',
  'raw_body',
  'raw_provider',
  'raw_response',
  'binary',
  'binary_data',
  'binary_material',
  'binary_payload',
  'stack',
  'stack_trace',
  'api_keys',
  'access_tokens',
  'client_secrets',
  'private_keys',
  'presigned_urls',
  'signed_urls',
  'connection_strings',
  'database_urls',
  'dsns',
  'cookies',
  'passwords',
  'raw_bodies',
  'raw_responses',
  'binary_materials',
  'binary_payloads',
  'stack_traces',
] as const;

const ACRONYM_WORDS = new Map([
  ['api', 'API'],
  ['dsn', 'DSN'],
  ['id', 'ID'],
  ['url', 'URL'],
]);

const titleCase = (word: string): string =>
  `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;

const FORBIDDEN_EXTENSION_KEY_CASES = SENSITIVE_EXTENSION_KEY_NAMES.flatMap(
  (canonical) => {
    const words = canonical.split('_');
    const variants = [
      ['exact', canonical],
      ['fused', words.join('')],
      ['camel', `${words[0]}${words.slice(1).map(titleCase).join('')}`],
      [
        'acronym',
        words
          .map((word) => ACRONYM_WORDS.get(word) ?? titleCase(word))
          .join(''),
      ],
      ['case', canonical.toUpperCase()],
      ['separator', words.join('.-')],
      ['adversarial', `__${words.join('__..--::')}__`],
    ] as const;

    return [
      ...new Map(variants.map(([style, key]) => [key, style])).entries(),
    ].map(([key, style]) => ({ canonical, key, style }));
  },
);

const BENIGN_EXTENSION_KEY_CASES = [
  'token_count',
  'tokenCount',
  'token_usage',
  'max_tokens',
  'totalTokens',
  'input_tokens',
  'auth_method',
  'authentication_method',
  'authorizationStatus',
  'cookie_policy',
  'passwordPolicy',
  'stack_depth',
  'binary_classifier',
  'header_text',
  'response_header_text',
  'api_version',
  'connection_pool_size',
  'database_engine',
  'encryption_algorithm',
  'key_signature',
  'monkey',
  'presign_enabled',
  'signing_algorithm',
] as const;

describe('canonical v2 contracts', () => {
  const fixtureIndex = ContractFixtureIndexSchema.parse(
    readJson(join(snapshotRoot, 'fixtures', 'index.json')),
  );

  it.each(fixtureIndex.fixtures.filter((fixture) => fixture.valid))(
    'round-trips $id without semantic loss',
    (fixture) => {
      const schema =
        fixtureSchemas[
          `${fixture.schema_path}${fixture.schema_ref}` as keyof typeof fixtureSchemas
        ];
      expect(schema).toBeDefined();
      const input = readJson<unknown>(join(snapshotRoot, fixture.path));
      const parsed = schema.parse(input);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(input);
    },
  );

  it.each(fixtureIndex.fixtures.filter((fixture) => !fixture.valid))(
    'rejects $id at its stable path',
    (fixture) => {
      const schema =
        fixtureSchemas[
          `${fixture.schema_path}${fixture.schema_ref}` as keyof typeof fixtureSchemas
        ];
      expect(schema).toBeDefined();
      const input = readJson<unknown>(join(snapshotRoot, fixture.path));
      const result = schema.safeParse(input);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(
        result.error.issues.map((issue) => issuePointer(issue.path)),
      ).toContain(fixture.expected_issue_path);
    },
  );

  it('locks the structured error vocabulary and required fallback policy', () => {
    expect(ErrorCategorySchema.options).toEqual([
      'validation',
      'authentication',
      'authorization',
      'rate_limit',
      'timeout',
      'network',
      'provider',
      'budget',
      'cancelled',
      'unsupported',
      'internal',
    ]);

    expect(
      StructuredErrorSchema.safeParse({
        code: 'provider_error',
        message: 'Safe message',
        category: 'provider',
        retryable: true,
      }).success,
    ).toBe(false);
  });

  it('bounds namespaced extensions and rejects secret-bearing keys at any depth', () => {
    expect(CONTRACT_LIMITS).toMatchObject({
      extensionBytes: 16_384,
      extensionDepth: 6,
      extensionKeys: 32,
      extensionArrayItems: 100,
      extensionStringLength: 8_192,
    });
    expect(
      ExtensionsSchema.safeParse({ 'com.example:traceId': 'public-id' })
        .success,
    ).toBe(true);
    expect(ExtensionsSchema.safeParse({ traceId: 'public-id' }).success).toBe(
      false,
    );
    expect(
      ExtensionsSchema.safeParse({
        'com.example:metadata': { nested: { authorization: 'forbidden' } },
      }).success,
    ).toBe(false);
    expect(
      ExtensionsSchema.safeParse({
        'com.example:metadata': {
          signed_polling_url: 'https://provider.example/status?signed=value',
        },
      }).success,
    ).toBe(false);

    for (const key of [
      'credential',
      'task_secret',
      'raw_response',
      'request_headers',
      'stack_trace',
      'binary',
    ]) {
      expect(
        ExtensionsSchema.safeParse({
          'com.example:metadata': { [key]: 'forbidden' },
        }).success,
        key,
      ).toBe(false);
    }

    for (const key of [
      'accessToken',
      'client-token',
      'id.token',
      'refresh_token',
      'resumeToken',
      'session:token',
      'auth',
      'cookies',
      'passwd',
      'privateKeys',
      'signedURLs',
      'responseHeaders',
      'rawBodies',
      'rawResponses',
      'binaryMaterials',
      'stackTraces',
    ]) {
      const secretValue = `must-not-leak-${key}`;
      const result = ExtensionsSchema.safeParse({
        'com.example:metadata': { public: { [key]: secretValue } },
      });
      expect(result.success, key).toBe(false);
      if (!result.success) {
        expect(JSON.stringify(result.error.issues)).not.toContain(secretValue);
      }
    }

    expect(
      ExtensionsSchema.safeParse({
        'com.example:text': 'x'.repeat(8_192),
      }).success,
    ).toBe(true);
    expect(
      ExtensionsSchema.safeParse({
        'com.example:text': 'x'.repeat(8_193),
      }).success,
    ).toBe(false);
    expect(
      ExtensionsSchema.safeParse({
        'com.example:items': Array.from({ length: 100 }, (_, index) => index),
      }).success,
    ).toBe(true);
    expect(
      ExtensionsSchema.safeParse({
        'com.example:items': Array.from({ length: 101 }, (_, index) => index),
      }).success,
    ).toBe(false);
    expect(
      ExtensionsSchema.safeParse({
        'com.example:object': Object.fromEntries(
          Array.from({ length: 32 }, (_, index) => [`key_${index}`, index]),
        ),
      }).success,
    ).toBe(true);
    expect(
      ExtensionsSchema.safeParse({
        'com.example:object': Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`key_${index}`, index]),
        ),
      }).success,
    ).toBe(false);

    const nested = (levels: number): unknown => {
      let value: unknown = 'leaf';
      for (let level = 0; level < levels; level += 1) {
        value = { [`level_${level}`]: value };
      }
      return value;
    };
    expect(
      ExtensionsSchema.safeParse({ 'com.example:nested': nested(5) }).success,
    ).toBe(true);
    expect(
      ExtensionsSchema.safeParse({ 'com.example:nested': nested(6) }).success,
    ).toBe(false);
    expect(
      ExtensionsSchema.safeParse({
        'com.example:partOne': 'x'.repeat(6_000),
        'com.example:partTwo': 'x'.repeat(6_000),
        'com.example:partThree': 'x'.repeat(6_000),
      }).success,
    ).toBe(false);
    expect(
      ExtensionsSchema.safeParse({
        'com.example:large': 'x'.repeat(20_000),
      }).success,
    ).toBe(false);
  });

  it.each(FORBIDDEN_EXTENSION_KEY_CASES)(
    'rejects $canonical $style variant $key without leaking its value',
    ({ canonical, key, style }) => {
      const secretValue = `must-not-leak:${canonical}:${style}`;
      const result = ExtensionsSchema.safeParse({
        'com.example:metadata': { public: { [key]: secretValue } },
      });
      expect(result.success, key).toBe(false);
      if (!result.success) {
        expect(JSON.stringify(result.error.issues), key).not.toContain(
          secretValue,
        );
      }
    },
  );

  it('rejects normalized secret names in top-level namespaced keys without leaking values', () => {
    const secretValue = 'must-not-leak-top-level-api-key';
    const result = ExtensionsSchema.safeParse({
      'com.example:API..Key': secretValue,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).not.toContain(secretValue);
    }
  });

  it.each(BENIGN_EXTENSION_KEY_CASES)(
    'allows benign extension metadata key %s',
    (key) => {
      expect(
        ExtensionsSchema.safeParse({
          'com.example:metadata': { [key]: 'public-metadata' },
        }).success,
      ).toBe(true);
    },
  );

  it('bounds exact decimals and requires lexical RFC3339 UTC timestamps with seconds', () => {
    const usage = (amount: string) => ({
      actual_cost: {
        amount: { amount_decimal: amount, currency: 'USD' },
        source: 'provider_reported',
      },
      completeness: 'complete',
    });

    expect(CONTRACT_LIMITS.decimalStringLength).toBe(128);
    expect(UsageSchema.safeParse(usage('1'.repeat(128))).success).toBe(true);
    expect(UsageSchema.safeParse(usage('1'.repeat(129))).success).toBe(false);
    expect(Rfc3339UtcSchema.safeParse('2026-08-08T00:00:00Z').success).toBe(
      true,
    );
    expect(Rfc3339UtcSchema.safeParse('2026-08-08T00:00:00.123Z').success).toBe(
      true,
    );
    expect(Rfc3339UtcSchema.safeParse('2026-08-08T00:00Z').success).toBe(false);
    expect(
      Rfc3339UtcSchema.safeParse('2026-08-08T00:00:00+00:00').success,
    ).toBe(false);
  });

  it('keeps web locators HTTP(S) and represents specialized data records without paths', () => {
    const specialized = InterchangeResponseSchema.parse(
      readJson(
        join(
          snapshotRoot,
          'fixtures',
          'valid',
          'specialized-data-record-response.json',
        ),
      ),
    );
    expect(specialized.results[0]!.semantic_facts.corpora).toContain(
      'specialized',
    );
    expect(specialized.results[0]!.citations[0]).toMatchObject({
      source_kind: 'data_record',
      source_category: 'patent_record',
      dataset_id: 'dataset-public-001',
      provider_reference: 'record-public-001',
    });
    expect(specialized.results[0]!.citations[0]).not.toHaveProperty('url');

    expect(
      NormalizedSourceSchema.safeParse({
        source_id: 'source-data-001',
        provider_reference: 'record-public-001',
        source_kind: 'data_record',
        source_category: 'financial_filing',
        dataset_id: 'dataset-public-001',
        citation_ids: ['citation-001'],
      }).success,
    ).toBe(true);
    expect(
      NormalizedSourceSchema.safeParse({
        source_id: 'source-file-001',
        canonical_url: 'file:///tmp/source.json',
        source_kind: 'data_record',
        citation_ids: ['citation-001'],
      }).success,
    ).toBe(false);
    expect(
      NormalizedSourceSchema.safeParse({
        source_id: 'source-missing-001',
        source_kind: 'data_record',
        citation_ids: ['citation-001'],
      }).success,
    ).toBe(false);
  });

  it('keeps interchange semantic keys snake_case and excludes forbidden architecture fields', () => {
    const keys = new Set<string>();
    for (const fixture of fixtureIndex.fixtures.filter(
      (entry) => entry.valid && entry.area === 'interchange',
    )) {
      collectSemanticKeys(readJson(join(snapshotRoot, fixture.path)), keys);
    }

    for (const key of keys) {
      expect(key).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
    }
    expect([...keys]).not.toEqual(
      expect.arrayContaining([
        'verified',
        'truth_threshold',
        'minimum_independent_sources',
        'output_dir',
        'run_directory',
        'queue',
        'persistence',
        'facade',
        'provider_native_payload',
        'raw_response',
      ]),
    );
  });

  it('keeps the contract runtime graph Node-free', () => {
    const sourceFiles = listFiles(
      join(process.cwd(), 'src', 'contracts'),
    ).filter((path) => path.endsWith('.ts'));
    for (const path of sourceFiles) {
      expect(
        readFileSync(path, 'utf8'),
        relative(process.cwd(), path),
      ).not.toMatch(/from ['"]node:/);
      expect(readFileSync(path, 'utf8')).not.toMatch(/export\s+interface\b/);
      expect(readFileSync(path, 'utf8')).not.toContain('ProviderTier');
    }
  });

  it('makes grounding semantics inapplicable to search results and required elsewhere', () => {
    const searchRequest = InterchangeRequestSchema.parse(
      readJson(
        join(snapshotRoot, 'fixtures', 'valid', 'search-results-request.json'),
      ),
    );
    const searchSlot = searchRequest.slots[0]!;
    expect(searchSlot.requirements).not.toHaveProperty('grounding_policy');
    expect(searchSlot.primary).not.toHaveProperty('grounding_policy');

    expect(
      ExecutionProfileSchema.safeParse({
        ...searchSlot.primary,
        grounding_policy: 'none',
      }).success,
    ).toBe(false);
    expect(
      EvidenceRequirementsSchema.safeParse({
        ...searchSlot.requirements,
        grounding_policy: 'none',
      }).success,
    ).toBe(false);
    expect(
      SemanticFactsSchema.safeParse({
        result_kinds: ['search_results'],
        observation_mode: 'api_output',
        corpora: ['web'],
        retrieval_methods: ['search_endpoint'],
        observed_at: '2026-08-08T00:00:05Z',
      }).success,
    ).toBe(true);
    expect(
      SemanticFactsSchema.safeParse({
        result_kinds: ['search_results'],
        grounding_outcome: 'unknown',
        observation_mode: 'api_output',
        corpora: ['web'],
        retrieval_methods: ['search_endpoint'],
        observed_at: '2026-08-08T00:00:05Z',
      }).success,
    ).toBe(false);
  });

  it('matches only explicitly constrained surface fields for primaries and fallbacks', () => {
    const localeOnly = InterchangeRequestSchema.parse(
      readJson(
        join(
          snapshotRoot,
          'fixtures',
          'valid',
          'locale-only-surface-context.json',
        ),
      ),
    );
    expect(localeOnly.slots[0]!.primary.surface_context).toMatchObject({
      account_context: 'unknown',
      locale: 'en-CA',
      personalization: 'unknown',
    });
    expect(
      localeOnly.fallback_reserve[0]!.profile.surface_context,
    ).toMatchObject({
      account_context: 'unknown',
      locale: 'en-CA',
      personalization: 'unknown',
    });

    const anonymousButUnknownPersonalization = structuredClone(localeOnly);
    anonymousButUnknownPersonalization.slots[0]!.primary.surface_context = {
      ...anonymousButUnknownPersonalization.slots[0]!.primary.surface_context!,
      account_context: 'anonymous',
      personalization: 'unknown',
    };
    expect(
      InterchangeRequestSchema.safeParse(anonymousButUnknownPersonalization)
        .success,
    ).toBe(true);
    expect(
      ExecutionProfileSchema.safeParse({
        ...anonymousButUnknownPersonalization.slots[0]!.primary,
        surface_context: { account_context: 'anonymous' },
      }).success,
    ).toBe(false);

    const ordinaryRequest = InterchangeRequestSchema.parse(
      readJson(
        join(snapshotRoot, 'fixtures', 'valid', 'interchange-request.json'),
      ),
    );
    expect(
      ordinaryRequest.slots.every(
        (slot) => slot.primary.surface_context === undefined,
      ),
    ).toBe(true);

    for (const file of [
      'missing-surface-context.json',
      'unknown-constrained-account-context.json',
      'unknown-constrained-personalization.json',
      'fallback-surface-context.json',
    ]) {
      expect(
        InterchangeRequestSchema.safeParse(
          readJson(join(snapshotRoot, 'fixtures', 'invalid', file)),
        ).success,
        file,
      ).toBe(false);
    }
  });

  it('keeps lifecycle separate from responses and valid as JSONL', () => {
    const response = InterchangeResponseSchema.parse(
      readJson(
        join(snapshotRoot, 'fixtures', 'valid', 'partial-response.json'),
      ),
    );
    const lifecycle = LifecycleTraceSchema.parse(
      readJson(join(snapshotRoot, 'fixtures', 'valid', 'lifecycle-trace.json')),
    );

    expect(response).not.toHaveProperty('lifecycle');
    expect(new Set(lifecycle.map((event) => event.request_id))).toEqual(
      new Set([response.request_id]),
    );

    const jsonlRecord = {
      artifact_name: 'jsonl_record',
      artifact_version: '1.0.0',
      generated_at: lifecycle[0]!.occurred_at,
      request_id: response.request_id,
      record_type: 'lifecycle_event',
      payload: lifecycle[0],
    } as const;
    expect(JsonlArtifactRecordSchema.parse(jsonlRecord)).toEqual(jsonlRecord);
    expect(
      JsonlArtifactRecordSchema.safeParse({
        ...jsonlRecord,
        request_id: 'req-does-not-match',
      }).success,
    ).toBe(false);
  });

  it('retains exact attempt usage for paid work without a result', () => {
    const response = InterchangeResponseSchema.parse(
      readJson(
        join(snapshotRoot, 'fixtures', 'valid', 'partial-response.json'),
      ),
    );
    const timedOutAttempt = response.attempts.find(
      (attempt) => attempt.attempt_status === 'timed_out',
    );

    expect(timedOutAttempt?.usage?.actual_cost).toEqual({
      amount: { amount_decimal: '0.250000', currency: 'USD' },
      source: 'provider_reported',
    });
    expect(
      UsageSchema.safeParse({
        actual_cost: {
          amount: { amount_decimal: '0.125', currency: 'USD' },
          source: 'computed_from_tokens',
        },
        completeness: 'partial',
      }).success,
    ).toBe(true);
    expect(
      UsageSchema.safeParse({
        actual_cost: {
          amount: { amount_decimal: '0.125', currency: 'USD' },
          source: 'pricing_snapshot',
          pricing_version: '2026.8.0',
        },
        completeness: 'partial',
      }).success,
    ).toBe(false);
    expect(
      response.results.some(
        (result) => result.attempt_id === timedOutAttempt?.attempt_id,
      ),
    ).toBe(false);
  });

  it('binds slot selections, results, profiles, providers, and replacement provenance', () => {
    const response = readJson<Record<string, any>>(
      join(snapshotRoot, 'fixtures', 'valid', 'partial-response.json'),
    );
    const mutations: Array<[string, (value: Record<string, any>) => void]> = [
      [
        'selected attempt status',
        (value) => {
          value.slots[0].selected_attempt_id = 'attempt-grounded-primary';
        },
      ],
      [
        'effective profile',
        (value) => {
          value.results[0].provenance.effective_profile = structuredClone(
            value.results[0].provenance.effective_profile,
          );
          value.results[0].provenance.effective_profile.identity.profile_id =
            'mismatch';
        },
      ],
      [
        'collection provider',
        (value) => {
          value.results[0].provenance.collection.provider = structuredClone(
            value.results[0].provenance.collection.provider,
          );
          value.results[0].provenance.collection.provider.profile_id =
            'mismatch';
        },
      ],
      [
        'replacement provenance',
        (value) => {
          delete value.results[0].provenance.replaced_attempt_id;
        },
      ],
      [
        'requested profile chain',
        (value) => {
          value.results[0].provenance.requested_profile =
            value.results[0].provenance.effective_profile;
        },
      ],
      [
        'result id',
        (value) => {
          value.slots[0].result_id = 'result-does-not-match';
        },
      ],
    ];

    for (const [name, mutate] of mutations) {
      const invalid = structuredClone(response);
      mutate(invalid);
      expect(InterchangeResponseSchema.safeParse(invalid).success, name).toBe(
        false,
      );
    }
  });

  it('represents a terminal failed-and-cancelled response without misreporting', () => {
    const response = readJson<Record<string, any>>(
      join(snapshotRoot, 'fixtures', 'valid', 'unsuccessful-response.json'),
    );
    expect(InterchangeResponseSchema.safeParse(response).success).toBe(true);
    expect(response.response_status).toBe('unsuccessful');

    for (const status of ['failed', 'cancelled', 'partial', 'succeeded']) {
      expect(
        InterchangeResponseSchema.safeParse({
          ...response,
          response_status: status,
        }).success,
        status,
      ).toBe(false);
    }
  });

  it('discriminates attempt-finished lifecycle errors by outcome', () => {
    const lifecycle = readJson<Record<string, any>[]>(
      join(snapshotRoot, 'fixtures', 'valid', 'lifecycle-trace.json'),
    );

    const failedWithoutError = structuredClone(lifecycle);
    delete failedWithoutError[2]!.data.error;
    expect(LifecycleTraceSchema.safeParse(failedWithoutError).success).toBe(
      false,
    );

    const succeededWithError = structuredClone(lifecycle);
    succeededWithError[5]!.data.error = lifecycle[2]!.data.error;
    expect(LifecycleTraceSchema.safeParse(succeededWithError).success).toBe(
      false,
    );

    const cancelled = structuredClone(lifecycle);
    cancelled[5]!.data = { outcome: 'cancelled' };
    expect(LifecycleTraceSchema.safeParse(cancelled).success).toBe(true);
  });

  it('allows request-completed lifecycle events to report unsuccessful outcomes', () => {
    const lifecycle = readJson<Record<string, any>[]>(
      join(snapshotRoot, 'fixtures', 'valid', 'lifecycle-trace.json'),
    );

    for (const outcome of ['succeeded', 'partial', 'unsuccessful']) {
      const candidate = structuredClone(lifecycle);
      candidate.at(-1)!.data = { outcome };
      expect(LifecycleTraceSchema.safeParse(candidate).success, outcome).toBe(
        true,
      );
    }

    for (const outcome of ['failed', 'cancelled']) {
      const candidate = structuredClone(lifecycle);
      candidate.at(-1)!.data = { outcome };
      expect(LifecycleTraceSchema.safeParse(candidate).success, outcome).toBe(
        false,
      );
    }
  });

  it('binds run-manifest response execution to the requested primary and fallback plan', () => {
    const manifest = readJson<Record<string, any>>(
      join(snapshotRoot, 'fixtures', 'valid', 'run-manifest.json'),
    );
    const mutations: Array<[string, (value: Record<string, any>) => void]> = [
      ['slot order', (value) => value.response.slots.reverse()],
      [
        'primary profile',
        (value) => {
          value.response.attempts[0].profile =
            value.request.fallback_reserve[0].profile;
        },
      ],
      [
        'candidate id',
        (value) => {
          value.response.attempts[1].candidate_id = 'unknown-candidate';
        },
      ],
      [
        'replacement order',
        (value) => {
          value.response.attempts[1].replaces_attempt_id =
            'attempt-research-primary';
        },
      ],
      [
        'attempt number',
        (value) => {
          value.response.attempts[1].attempt_number = 3;
        },
      ],
      [
        'missing slot',
        (value) => {
          value.response.slots.pop();
        },
      ],
    ];

    for (const [name, mutate] of mutations) {
      const invalid = structuredClone(manifest);
      mutate(invalid);
      expect(RunManifestArtifactSchema.safeParse(invalid).success, name).toBe(
        false,
      );
    }
  });

  it('validates every independently versioned artifact family', () => {
    const request = readJson<Record<string, any>>(
      join(snapshotRoot, 'fixtures', 'valid', 'interchange-request.json'),
    );
    const response = readJson<Record<string, any>>(
      join(snapshotRoot, 'fixtures', 'valid', 'partial-response.json'),
    );
    const profile = request.slots[0].primary;
    const citation = response.results[0].citations[0];

    const artifacts = [
      RunManifestArtifactSchema.parse({
        artifact_name: 'run_manifest',
        artifact_version: '1.0.0',
        generated_at: '2026-08-08T00:00:11Z',
        producer: { id: 'librarium', version: '1.4.1' },
        request,
        response,
      }),
      ProviderMetadataArtifactSchema.parse({
        artifact_name: 'provider_metadata',
        artifact_version: '1.0.0',
        generated_at: '2026-08-08T00:00:00Z',
        providers: [
          {
            provider: profile.identity,
            display_name: 'Perplexity Sonar Pro',
            profiles: [profile],
            availability: 'available',
          },
        ],
      }),
      SourcesArtifactSchema.parse({
        artifact_name: 'sources',
        artifact_version: '1.0.0',
        generated_at: '2026-08-08T00:00:11Z',
        request_id: request.request_id,
        sources: [
          {
            source_id: 'source-001',
            canonical_url: citation.url,
            source_kind: citation.source_kind,
            citation_ids: [citation.citation_id],
          },
        ],
        citations: [citation],
      }),
      JsonlArtifactRecordSchema.parse({
        artifact_name: 'jsonl_record',
        artifact_version: '1.0.0',
        generated_at: '2026-08-08T00:00:00Z',
        request_id: request.request_id,
        record_type: 'request',
        payload: request,
      }),
    ];

    for (const artifact of artifacts) {
      expect(ArtifactSchema.parse(artifact)).toEqual(artifact);
    }
  });

  it('locks the run manifest to the approved thin envelope', () => {
    const manifest = readJson<Record<string, unknown>>(
      join(snapshotRoot, 'fixtures', 'valid', 'run-manifest.json'),
    );
    expect(Object.keys(manifest).sort()).toEqual([
      'artifact_name',
      'artifact_version',
      'generated_at',
      'producer',
      'request',
      'response',
    ]);
    expect(Object.keys(manifest.producer as object).sort()).toEqual([
      'id',
      'version',
    ]);
    expect(manifest.response).not.toHaveProperty('lifecycle');

    for (const field of [
      'run_id',
      'paths',
      'files',
      'media_type',
      'checksum',
      'storage_locator',
      'related_artifacts',
      'lifecycle',
    ]) {
      expect(
        RunManifestArtifactSchema.safeParse({
          ...manifest,
          [field]: 'forbidden',
        }).success,
        field,
      ).toBe(false);
    }

    const withoutProducer = structuredClone(manifest);
    delete withoutProducer.producer;
    expect(RunManifestArtifactSchema.safeParse(withoutProducer).success).toBe(
      false,
    );

    const mismatchedRequest = structuredClone(manifest) as Record<string, any>;
    mismatchedRequest.response.request_id = 'req-does-not-match';
    expect(RunManifestArtifactSchema.safeParse(mismatchedRequest).success).toBe(
      false,
    );
  });

  it('validates complete inline and durable custom-provider exchanges', () => {
    const request = readJson<Record<string, any>>(
      join(snapshotRoot, 'fixtures', 'valid', 'interchange-request.json'),
    );
    const response = readJson<Record<string, any>>(
      join(snapshotRoot, 'fixtures', 'valid', 'partial-response.json'),
    );
    const profile = request.slots[1].primary;
    const handle = structuredClone(response.attempts[2].durable_handle);

    const submitHandle = { ...handle, status: 'pending' };
    delete submitHandle.last_observed_at;
    const submitExchange = {
      request: {
        protocol_version: '1.0.0',
        message_type: 'submit',
        request_id: request.request_id,
        attempt_id: 'attempt-research-primary',
        sent_at: '2026-08-08T00:00:06Z',
        query: request.query,
        profile,
      },
      response: {
        protocol_version: '1.0.0',
        message_type: 'submitted',
        request_id: request.request_id,
        attempt_id: 'attempt-research-primary',
        emitted_at: '2026-08-08T00:00:06Z',
        durable_handle: submitHandle,
      },
    };
    expect(CustomProviderExchangeSchema.parse(submitExchange)).toEqual(
      submitExchange,
    );
    expect(
      CustomProviderExchangeSchema.safeParse({
        ...submitExchange,
        response: {
          ...submitExchange.response,
          durable_handle: {
            ...submitExchange.response.durable_handle,
            status: 'succeeded',
          },
        },
      }).success,
    ).toBe(false);

    const runningHandle = {
      ...handle,
      status: 'running',
      last_observed_at: '2026-08-08T00:00:07Z',
    };
    const pollExchange = {
      request: {
        protocol_version: '1.0.0',
        message_type: 'poll',
        request_id: request.request_id,
        attempt_id: 'attempt-research-primary',
        sent_at: '2026-08-08T00:00:07Z',
        durable_handle: submitHandle,
      },
      response: {
        protocol_version: '1.0.0',
        message_type: 'progress',
        request_id: request.request_id,
        attempt_id: 'attempt-research-primary',
        emitted_at: '2026-08-08T00:00:07Z',
        durable_handle: runningHandle,
        progress_percent: 40,
      },
    };
    expect(CustomProviderExchangeSchema.parse(pollExchange)).toEqual(
      pollExchange,
    );

    const result = structuredClone(response.results[0]);
    result.result_id = 'result-research-primary';
    result.slot_id = 'slot-research';
    result.attempt_id = 'attempt-research-primary';
    result.semantic_facts.result_kinds = ['research_report'];
    result.semantic_facts.corpora = ['web', 'news'];
    result.semantic_facts.retrieval_methods = ['research_agent'];
    result.provenance.slot_id = 'slot-research';
    result.provenance.attempt_id = 'attempt-research-primary';
    result.provenance.requested_profile = profile;
    result.provenance.effective_profile = profile;
    result.provenance.collection.provider = profile.identity;
    result.provenance.collection.operator_id = profile.operator_id;
    delete result.provenance.replaced_attempt_id;
    result.citations[0].provenance.provider = profile.identity;
    result.citations[0].provenance.operator_id = profile.operator_id;

    const succeededHandle = {
      ...handle,
      status: 'succeeded',
      last_observed_at: '2026-08-08T00:00:10Z',
    };
    const retrieveExchange = {
      request: {
        protocol_version: '1.0.0',
        message_type: 'retrieve',
        request_id: request.request_id,
        attempt_id: 'attempt-research-primary',
        sent_at: '2026-08-08T00:00:10Z',
        durable_handle: succeededHandle,
      },
      response: {
        protocol_version: '1.0.0',
        message_type: 'result',
        request_id: request.request_id,
        attempt_id: 'attempt-research-primary',
        emitted_at: '2026-08-08T00:00:10Z',
        result,
      },
    };
    expect(CustomProviderExchangeSchema.parse(retrieveExchange)).toEqual(
      retrieveExchange,
    );

    const mismatchedResult = structuredClone(retrieveExchange);
    mismatchedResult.response.result.provenance.slot_id = 'slot-mismatch';
    expect(
      CustomProviderExchangeSchema.safeParse(mismatchedResult).success,
    ).toBe(false);
  });

  it('reports terminal durable poll state separately and binds task identity', () => {
    const exchange = readJson<Record<string, any>>(
      join(
        snapshotRoot,
        'fixtures',
        'valid',
        'custom-provider-terminal-poll-exchange.json',
      ),
    );
    expect(CustomProviderExchangeSchema.safeParse(exchange).success).toBe(true);
    expect(exchange.response).toMatchObject({
      message_type: 'status',
      durable_handle: { status: 'failed' },
    });

    const mutations: Array<[string, (value: Record<string, any>) => void]> = [
      [
        'request id',
        (value) => {
          value.response.request_id = 'request-does-not-match';
        },
      ],
      [
        'attempt id',
        (value) => {
          value.response.attempt_id = 'attempt-does-not-match';
        },
      ],
      [
        'handle id',
        (value) => {
          value.response.durable_handle.handle_id = 'handle-does-not-match';
        },
      ],
      [
        'provider task id',
        (value) => {
          value.response.durable_handle.provider_task_id =
            'provider-task-does-not-match';
        },
      ],
      [
        'provider identity',
        (value) => {
          value.response.durable_handle.provider.profile_id =
            'profile-does-not-match';
        },
      ],
    ];
    for (const [name, mutate] of mutations) {
      const invalid = structuredClone(exchange);
      mutate(invalid);
      expect(
        CustomProviderExchangeSchema.safeParse(invalid).success,
        name,
      ).toBe(false);
    }

    const terminalProgress = structuredClone(exchange);
    terminalProgress.response.message_type = 'progress';
    expect(
      CustomProviderExchangeSchema.safeParse(terminalProgress).success,
    ).toBe(false);

    const nonterminalStatus = structuredClone(exchange);
    nonterminalStatus.response.durable_handle.status = 'running';
    expect(
      CustomProviderExchangeSchema.safeParse(nonterminalStatus).success,
    ).toBe(false);

    const retrieveStatus = structuredClone(exchange);
    retrieveStatus.request.message_type = 'retrieve';
    expect(CustomProviderExchangeSchema.safeParse(retrieveStatus).success).toBe(
      false,
    );
  });
});

describe('offline contract snapshot', () => {
  it('guards generator writes against traversal and absolute targets', () => {
    const root = join('/tmp', 'librarium-contracts');
    expect(resolveSnapshotWritePath(root, 'schema/domain.schema.json')).toBe(
      join(root, 'schema', 'domain.schema.json'),
    );

    for (const path of [
      '',
      '.',
      '../outside.json',
      'schema/../../outside.json',
      '/tmp/outside.json',
      String.raw`..\outside.json`,
      String.raw`C:\outside.json`,
    ]) {
      expect(() => resolveSnapshotWritePath(root, path), path).toThrow(
        /Refusing/,
      );
    }
  });

  it('rejects existing symlink roots, ancestors, and targets', () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), 'librarium-snapshot-path-'),
    );

    try {
      const root = join(temporaryRoot, 'snapshot');
      const outside = join(temporaryRoot, 'outside');
      mkdirSync(root);
      mkdirSync(outside);

      const symlinkRoot = join(temporaryRoot, 'snapshot-link');
      symlinkSync(root, symlinkRoot, 'dir');
      expect(() =>
        resolveSnapshotWritePath(symlinkRoot, 'schema/domain.schema.json'),
      ).toThrow(/symlink snapshot root/);

      const schemaDirectory = join(root, 'schema');
      symlinkSync(outside, schemaDirectory, 'dir');
      expect(() =>
        resolveSnapshotWritePath(root, 'schema/domain.schema.json'),
      ).toThrow(/symlink snapshot ancestor/);
      rmSync(schemaDirectory);

      mkdirSync(schemaDirectory);
      const outsideFile = join(outside, 'domain.schema.json');
      writeFileSync(outsideFile, '{}');
      symlinkSync(outsideFile, join(schemaDirectory, 'domain.schema.json'));
      expect(() =>
        resolveSnapshotWritePath(root, 'schema/domain.schema.json'),
      ).toThrow(/symlink snapshot target/);
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('validates its manifest and exact file inventory', () => {
    const manifest = ContractSnapshotManifestSchema.parse(
      readJson(join(snapshotRoot, 'manifest.json')),
    );
    const actualFiles = listFiles(snapshotRoot)
      .map((path) => relative(snapshotRoot, path))
      .sort();
    const expectedFiles = [
      ...manifest.files.map((file) => file.path),
      'checksums.sha256',
      'manifest.json',
    ].sort();

    expect(actualFiles).toEqual(expectedFiles);
    expect(manifest.owner).toBe('typescript_librarium');
    expect(manifest.versions).toEqual({
      domain: '1.0.0',
      artifacts: '1.0.0',
      custom_provider: '1.0.0',
      interchange: '1.0.0',
    });
  });

  it('verifies every checksum entirely offline', () => {
    const manifest = ContractSnapshotManifestSchema.parse(
      readJson(join(snapshotRoot, 'manifest.json')),
    );
    const lines = readFileSync(join(snapshotRoot, 'checksums.sha256'), 'utf8')
      .trim()
      .split('\n');

    const checksumPaths = lines.map((line) => {
      const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
      expect(match).not.toBeNull();
      return match?.[2] ?? '';
    });
    const expectedChecksumPaths = [
      ...manifest.files.map((file) => file.path),
      'manifest.json',
    ].sort();
    expect([...checksumPaths].sort()).toEqual(expectedChecksumPaths);
    expect(new Set(checksumPaths).size).toBe(checksumPaths.length);

    for (const line of lines) {
      const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
      expect(match).not.toBeNull();
      if (!match) continue;
      const [, expected, path] = match;
      expect(path).toMatch(
        /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/,
      );
      expect(relative(snapshotRoot, join(snapshotRoot, path))).not.toMatch(
        /^\.\./,
      );
      const actual = createHash('sha256')
        .update(readFileSync(join(snapshotRoot, path)))
        .digest('hex');
      expect(actual, path).toBe(expected);
    }
  });

  it('resolves every fixture schema target and semantic-rule link', () => {
    const manifest = ContractSnapshotManifestSchema.parse(
      readJson(join(snapshotRoot, 'manifest.json')),
    );
    const fixtureIndex = ContractFixtureIndexSchema.parse(
      readJson(join(snapshotRoot, 'fixtures', 'index.json')),
    );
    const manifestSchemaPaths = new Set(
      manifest.files
        .filter((file) => file.role === 'schema')
        .map((file) => file.path),
    );
    const semanticRuleIds = new Set(
      manifest.semantic_rules.map((rule) => rule.rule_id),
    );

    for (const fixture of fixtureIndex.fixtures) {
      expect(manifestSchemaPaths.has(fixture.schema_path), fixture.id).toBe(
        true,
      );
      const schema = readJson<Record<string, any>>(
        join(snapshotRoot, fixture.schema_path),
      );
      const definitionName = fixture.schema_ref.replace('#/$defs/', '');
      expect(schema.$defs?.[definitionName], fixture.id).toBeDefined();
      if (!fixture.valid && fixture.enforcement === 'semantic_rule') {
        expect(semanticRuleIds.has(fixture.semantic_rule_id), fixture.id).toBe(
          true,
        );
      }
    }
  });

  it('publishes four composable schema bundles instead of one monolith', () => {
    const schemaFiles = listFiles(join(snapshotRoot, 'schema'));
    expect(
      schemaFiles.map((path) => relative(snapshotRoot, path)).sort(),
    ).toEqual([
      'schema/artifacts.schema.json',
      'schema/custom-provider.schema.json',
      'schema/domain.schema.json',
      'schema/interchange.schema.json',
    ]);

    for (const path of schemaFiles) {
      const schema = readJson<Record<string, unknown>>(path);
      expect(schema.$schema).toBe(
        'https://json-schema.org/draft/2020-12/schema',
      );
      expect(schema.$defs).toBeTypeOf('object');
    }
  });
});
