import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod/v4';
import {
  CitationSchema,
  ResearchErrorSchema,
  ResearchResponseSchema,
  ResearchResultSchema,
  ResultProvenanceSchema,
  SourceSchema,
  UsageSchema,
} from '../src/contracts/interchange/index.js';
import { resolveSnapshotWritePath } from './contract-snapshot-path.js';

const root =
  process.env.LIBRARIUM_CONTRACTS_OUTPUT ??
  join(process.cwd(), 'contracts', 'v1');
const TYPESCRIPT_FIXTURE_GENERATOR_VERSION = '1.4.1';

function isRecognizedSnapshotManifest(path: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      unknown
    >;
    return (
      (manifest.snapshot_version === 1 &&
        manifest.title === 'Librarium terminal interchange snapshot') ||
      (manifest.snapshot_format_version === '1.0.0' &&
        manifest.contract_set === 'librarium_contracts' &&
        manifest.owner === 'typescript_librarium' &&
        manifest.ownership_policy === 'canonical_upstream')
    );
  } catch {
    return false;
  }
}

function assertSnapshotRootCanBeRegenerated(): void {
  resolveSnapshotWritePath(root, 'manifest.json');
  if (!existsSync(root) || readdirSync(root).length === 0) return;
  const manifestPath = resolveSnapshotWritePath(root, 'manifest.json');
  if (!isRecognizedSnapshotManifest(manifestPath)) {
    throw new Error(
      `Refusing to prune unrecognized nonempty contract snapshot root: ${root}`,
    );
  }
}

assertSnapshotRootCanBeRegenerated();

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function write(path: string, value: unknown): string {
  const target = resolveSnapshotWritePath(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    typeof value === 'string' ? value : canonicalJson(value),
  );
  return path;
}
function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Refusing symlink snapshot entry: ${path}`);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}
function pruneRetiredFiles(expectedPaths: readonly string[]): void {
  const expected = new Set(expectedPaths);
  for (const file of listFiles(root)) {
    const path = relative(root, file).replaceAll('\\', '/');
    if (!expected.has(path)) rmSync(file);
  }
  const pruneEmpty = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pruneEmpty(path);
    }
    if (directory !== root && readdirSync(directory).length === 0)
      rmSync(directory, { recursive: true });
  };
  pruneEmpty(root);
}
function assertExactSnapshotInventory(expectedPaths: readonly string[]): void {
  const actual = listFiles(root)
    .map((path) => relative(root, path).replaceAll('\\', '/'))
    .sort();
  const expected = [...expectedPaths].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Contract snapshot inventory mismatch');
}
function areaSchema(
  definitions: Record<string, z.ZodType>,
): Record<string, unknown> {
  const rewriteLocalRefs = (
    value: unknown,
    definitionName: string,
  ): unknown => {
    if (Array.isArray(value))
      return value.map((child) => rewriteLocalRefs(child, definitionName));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (
          key === '$ref' &&
          typeof child === 'string' &&
          child.startsWith('#')
        ) {
          return [key, `#/$defs/${definitionName}${child.slice(1)}`];
        }
        return [key, rewriteLocalRefs(child, definitionName)];
      }),
    );
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://librarium.dev/contracts/v1/interchange',
    title: 'Librarium terminal interchange',
    $defs: Object.fromEntries(
      Object.entries(definitions).map(([name, schema]) => {
        const jsonSchema = z.toJSONSchema(schema, { target: 'draft-2020-12' });
        delete jsonSchema.$schema;
        return [name, rewriteLocalRefs(jsonSchema, name)];
      }),
    ),
  };
}

const source = {
  kind: 'web_page',
  url: 'https://example.com/research',
  title: 'Research',
};
const provenance = {
  result_kind: 'grounded_answer',
  retrieval_methods: ['research_agent'],
  corpora: ['web'],
  observed_at: '2026-08-09T12:00:00Z',
};
const result = {
  id: 'result-1',
  content_format: 'markdown',
  content: '# Result',
  requested_profile: 'deep-research',
  provider: 'example-provider',
  profile: 'deep-research-v2',
  provenance,
  citations: [{ id: 'citation-1', derivation: 'provider_reported', source }],
  completed_at: '2026-08-09T12:00:01Z',
};
const success = {
  generator: 'jkudish/librarium',
  generator_version: TYPESCRIPT_FIXTURE_GENERATOR_VERSION,
  request_id: 'request-terminal-1',
  status: 'succeeded',
  completed_at: '2026-08-09T12:00:02Z',
  results: [result],
  errors: [],
};
const phpSuccess = {
  ...success,
  generator: 'jkudish/laravel-ai-librarium',
  generator_version: '1.0.0-rc.1+build.7',
  results: [{ ...result, content_format: 'text', content: 'PHP receipt' }],
};
const fullUsage = {
  prompt_tokens: 10,
  completion_tokens: 20,
  cache_write_input_tokens: 3,
  cache_read_input_tokens: 4,
  reasoning_tokens: 5,
  actual_cost: '0.125',
  estimated_cost: '0.250',
  currency: 'USD',
};
const valid = {
  'markdown-success': success,
  'php-text-success': phpSuccess,
  'json-object-success': {
    ...success,
    results: [
      {
        ...result,
        id: 'result-json-object',
        content_format: 'json',
        content: { answer: 'yes' },
      },
    ],
  },
  'json-array-success': {
    ...success,
    results: [
      {
        ...result,
        id: 'result-json-array',
        content_format: 'json',
        content: [{ answer: 'yes' }],
      },
    ],
  },
  'partial-top-level-usage': {
    ...success,
    status: 'partial',
    errors: [
      {
        code: 'provider.timeout',
        message: 'The provider timed out',
        profile: 'fallback',
      },
    ],
    usage: fullUsage,
  },
  failed: {
    ...success,
    status: 'failed',
    results: [],
    errors: [{ code: 'provider.unavailable', message: 'Unavailable' }],
  },
  'provider-reference-source': {
    ...success,
    results: [
      {
        ...result,
        citations: [
          {
            id: 'citation-reference',
            derivation: 'collector_extracted',
            source: { kind: 'file', provider_reference: 'provider-file-1' },
          },
        ],
      },
    ],
  },
  'untrusted-url-identifier': {
    ...success,
    results: [
      {
        ...result,
        citations: [
          {
            id: 'citation-native-url',
            derivation: 'provider_reported',
            source: {
              kind: 'unknown',
              url: 'provider-native:source/123',
            },
          },
        ],
      },
    ],
  },
  'enum-branch-coverage': {
    ...success,
    results: [
      {
        ...result,
        id: 'result-search-results',
        provenance: {
          ...provenance,
          result_kind: 'search_results',
          retrieval_methods: [
            'search_endpoint',
            'model_search_tool',
            'research_agent',
            'model_only',
          ],
          corpora: ['web', 'news', 'x', 'files', 'places'],
        },
        citations: [
          {
            id: 'citation-web-page',
            derivation: 'provider_reported',
            source: { kind: 'web_page', url: 'source:web-page' },
          },
          {
            id: 'citation-news-article',
            derivation: 'collector_extracted',
            source: { kind: 'news_article', url: 'source:news-article' },
          },
          {
            id: 'citation-x-post',
            derivation: 'librarium_inferred',
            source: { kind: 'x_post', url: 'source:x-post' },
          },
          {
            id: 'citation-file',
            derivation: 'provider_reported',
            source: { kind: 'file', provider_reference: 'file-1' },
          },
          {
            id: 'citation-place',
            derivation: 'collector_extracted',
            source: { kind: 'place', url: 'source:place' },
          },
          {
            id: 'citation-video',
            derivation: 'librarium_inferred',
            source: { kind: 'video', url: 'source:video' },
          },
          {
            id: 'citation-forum-post',
            derivation: 'provider_reported',
            source: { kind: 'forum_post', url: 'source:forum-post' },
          },
          {
            id: 'citation-unknown',
            derivation: 'collector_extracted',
            source: { kind: 'unknown', url: 'source:unknown' },
          },
        ],
      },
      {
        ...result,
        id: 'result-grounded-answer',
        provenance: { ...provenance, result_kind: 'grounded_answer' },
      },
      {
        ...result,
        id: 'result-research-report',
        provenance: { ...provenance, result_kind: 'research_report' },
      },
      {
        ...result,
        id: 'result-model-answer',
        provenance: { ...provenance, result_kind: 'model_answer' },
      },
      {
        ...result,
        id: 'result-surface-observation',
        provenance: {
          ...provenance,
          result_kind: 'surface_observation',
          retrieval_methods: ['surface_collector'],
          observation_mode: 'surface_snapshot',
          collector: 'searchapi',
          surface: 'chatgpt',
          context: {
            authentication: 'unknown',
            personalization: 'unknown',
          },
        },
      },
    ],
  },
  'empty-retrieval-and-corpora': {
    ...success,
    results: [
      {
        ...result,
        provenance: { ...provenance, retrieval_methods: [], corpora: [] },
      },
    ],
  },
  ...Object.fromEntries(
    ['anonymous', 'authenticated', 'managed', 'unknown'].map(
      (authentication) => [
        `surface-context-authentication-${authentication}`,
        {
          ...success,
          results: [
            {
              ...result,
              provenance: {
                ...provenance,
                result_kind: 'surface_observation',
                retrieval_methods: ['surface_collector'],
                observation_mode: 'surface_snapshot',
                collector: 'searchapi',
                surface: 'google_ai_mode',
                context: {
                  locale: 'en-CA',
                  country: 'CA',
                  device: 'desktop',
                  authentication,
                  personalization: 'unknown',
                },
              },
            },
          ],
        },
      ],
    ),
  ),
  'optional-result-fields': {
    ...success,
    results: [
      {
        ...result,
        model: 'model-v2',
        fallback_reason: 'primary_unavailable',
        usage: fullUsage,
      },
    ],
  },
  'provider-meta-namespaces': {
    ...success,
    results: [
      {
        ...result,
        provider_meta: {
          'com.example:public': { CamelCase: 'kept', nested: { value: true } },
          'io.other:metrics': { requestId: 'abc', large: 'x'.repeat(17_000) },
        },
      },
    ],
  },
  'provider-meta-benign-keys': {
    ...success,
    results: [
      {
        ...result,
        provider_meta: {
          'com.example:usage': {
            prompt_tokens: 10,
            token_count: 20,
            binary_classifier: 'safe',
          },
        },
      },
    ],
  },
};
const invalid = {
  'terminal-version': { ...success, version: '1' },
  'terminal-source-registry': { ...success, source_registry: [] },
  'terminal-extensions': { ...success, extensions: {} },
  'terminal-execution-field': { ...success, attempts: [] },
  'result-legacy-fields': {
    ...success,
    results: [{ ...result, result_id: 'old' }],
  },
  'result-plain-text-format': {
    ...success,
    results: [{ ...result, content_format: 'plain_text' }],
  },
  'result-semantic-facts': {
    ...success,
    results: [{ ...result, semantic_facts: {} }],
  },
  'result-profile-graph': {
    ...success,
    results: [{ ...result, profile: { identity: 'old' } }],
  },
  'result-target-graph': { ...success, results: [{ ...result, target: {} }] },
  'result-collection-graph': {
    ...success,
    results: [{ ...result, collection: {} }],
  },
  'result-wrong-content': {
    ...success,
    results: [{ ...result, content_format: 'json', content: 'wrong' }],
  },
  'citation-no-source': {
    ...success,
    results: [
      {
        ...result,
        citations: [{ id: 'citation-1', derivation: 'provider_reported' }],
      },
    ],
  },
  'source-no-locator': {
    ...success,
    results: [
      {
        ...result,
        citations: [
          {
            id: 'citation-1',
            derivation: 'provider_reported',
            source: { kind: 'web_page' },
          },
        ],
      },
    ],
  },
  'provider-meta-top-level': { ...success, provider_meta: {} },
  'provider-meta-non-object': {
    ...success,
    results: [{ ...result, provider_meta: [] }],
  },
  'provider-meta-secret': {
    ...success,
    results: [
      {
        ...result,
        provider_meta: { 'com.example:public': { APIKey: 'do-not-share' } },
      },
    ],
  },
  'provider-meta-raw': {
    ...success,
    results: [
      {
        ...result,
        provider_meta: {
          'com.example:public': { rawResponse: { status: 200 } },
        },
      },
    ],
  },
  'provider-meta-fused-api-key': {
    ...success,
    results: [
      {
        ...result,
        provider_meta: { 'com.example:public': { openaiapikey: 'secret' } },
      },
    ],
  },
  'provider-meta-fused-access-token': {
    ...success,
    results: [
      {
        ...result,
        provider_meta: {
          'com.example:public': { githubaccesstoken: 'secret' },
        },
      },
    ],
  },
  'provider-meta-fused-raw-response': {
    ...success,
    results: [
      {
        ...result,
        provider_meta: {
          'com.example:public': { providerrawresponse: { status: 200 } },
        },
      },
    ],
  },
  'provider-meta-wrapped-api-key': {
    ...success,
    results: [
      {
        ...result,
        provider_meta: {
          'com.example:public': { openaiApiKeyValue: 'secret' },
        },
      },
    ],
  },
  'provider-meta-wrapped-credentials': {
    ...success,
    results: [
      {
        ...result,
        provider_meta: {
          'com.example:public': { credentialsBlob: 'secret' },
        },
      },
    ],
  },
  'provider-meta-wrapped-raw-response': {
    ...success,
    results: [
      {
        ...result,
        provider_meta: {
          'com.example:public': { providerRawResponseData: { status: 200 } },
        },
      },
    ],
  },
  'provider-meta-wrapped-session-token': {
    ...success,
    results: [
      {
        ...result,
        provider_meta: {
          'com.example:public': { vendorSessionTokenValue: 'secret' },
        },
      },
    ],
  },
  'provider-meta-wrapped-binary-payload': {
    ...success,
    results: [
      {
        ...result,
        provider_meta: {
          'com.example:public': { binaryPayloadData: 'secret' },
        },
      },
    ],
  },
  'error-rich': {
    ...success,
    status: 'failed',
    results: [],
    errors: [{ code: 'x.y', message: 'No', retryable: true }],
  },
  'error-not-namespaced': {
    ...success,
    status: 'failed',
    results: [],
    errors: [{ code: 'failed', message: 'No' }],
  },
  'usage-rich': { ...success, usage: { ...fullUsage, total_tokens: 30 } },
  'usage-negative': { ...success, usage: { prompt_tokens: -1 } },
  'usage-malformed-decimal': {
    ...success,
    usage: { actual_cost: '1.2.3', currency: 'USD' },
  },
  'usage-cost-no-currency': { ...success, usage: { actual_cost: '1.2' } },
  'provenance-context-unknown': {
    ...success,
    results: [
      {
        ...result,
        provenance: { ...provenance, context: { timezone: 'UTC' } },
      },
    ],
  },
  'provenance-surface-no-collector': {
    ...success,
    results: [{ ...result, provenance: { ...provenance, surface: 'google' } }],
  },
  'provenance-surface-snapshot-wrong-result': {
    ...success,
    results: [
      {
        ...result,
        provenance: {
          ...provenance,
          result_kind: 'grounded_answer',
          retrieval_methods: ['surface_collector'],
          observation_mode: 'surface_snapshot',
          collector: 'searchapi',
          surface: 'chatgpt',
        },
      },
    ],
  },
  'invalid-enum': {
    ...success,
    results: [
      {
        ...result,
        citations: [
          {
            id: 'citation-1',
            derivation: 'provider_reported',
            source: { kind: 'database' as any, url: 'https://example.com' },
          },
        ],
      },
    ],
  },
  'invalid-timestamp': {
    ...success,
    completed_at: '2026-08-09T12:00:02+00:00',
  },
  'invalid-id': { ...success, request_id: ' request ' },
  'succeeded-shape': { ...success, results: [], errors: [] },
  'partial-shape': { ...success, status: 'partial', errors: [] },
  'failed-shape': { ...success, status: 'failed', results: [result] },
};

const schemaPath = write(
  'schema/interchange.schema.json',
  areaSchema({
    research_response: ResearchResponseSchema,
    research_result: ResearchResultSchema,
    citation: CitationSchema,
    source: SourceSchema,
    result_provenance: ResultProvenanceSchema,
    usage: UsageSchema,
    research_error: ResearchErrorSchema,
  }),
);
const fixtureEntries = [
  ...Object.entries(valid).map(([id, payload]) => ({
    id,
    valid: true,
    payload,
  })),
  ...Object.entries(invalid).map(([id, payload]) => ({
    id,
    valid: false,
    payload,
  })),
];
const fixtureFiles = fixtureEntries.map((entry) =>
  write(
    `fixtures/${entry.valid ? 'valid' : 'invalid'}/${entry.id}.json`,
    entry.payload,
  ),
);
const semanticRuleForFixture: Record<string, string> = {
  'succeeded-shape': 'research_response.terminal_shape',
  'partial-shape': 'research_response.terminal_shape',
  'failed-shape': 'research_response.terminal_shape',
  'source-no-locator': 'source.locator_required',
  'usage-cost-no-currency': 'usage.cost_requires_currency',
  'provenance-surface-no-collector':
    'result_provenance.surface_requires_collector',
  'provenance-surface-snapshot-wrong-result':
    'result_provenance.surface_snapshot_boundary',
  'provider-meta-secret': 'provider_meta.safe_metadata',
  'provider-meta-raw': 'provider_meta.safe_metadata',
  'provider-meta-fused-api-key': 'provider_meta.safe_metadata',
  'provider-meta-fused-access-token': 'provider_meta.safe_metadata',
  'provider-meta-fused-raw-response': 'provider_meta.safe_metadata',
  'provider-meta-wrapped-api-key': 'provider_meta.safe_metadata',
  'provider-meta-wrapped-credentials': 'provider_meta.safe_metadata',
  'provider-meta-wrapped-raw-response': 'provider_meta.safe_metadata',
  'provider-meta-wrapped-session-token': 'provider_meta.safe_metadata',
  'provider-meta-wrapped-binary-payload': 'provider_meta.safe_metadata',
};
const fixtureIndexPath = write('fixtures/index.json', {
  fixtures: fixtureEntries.map((entry) => ({
    id: entry.id,
    path: `fixtures/${entry.valid ? 'valid' : 'invalid'}/${entry.id}.json`,
    valid: entry.valid,
    area: 'interchange',
    schema_path: schemaPath,
    schema_ref: '#/$defs/research_response',
    enforcement: entry.valid
      ? 'structural'
      : semanticRuleForFixture[entry.id]
        ? 'semantic_rule'
        : 'structural',
    ...(semanticRuleForFixture[entry.id]
      ? { semantic_rule_id: semanticRuleForFixture[entry.id] }
      : {}),
  })),
});
const manifest = {
  snapshot_version: 1,
  title: 'Librarium terminal interchange snapshot',
  areas: ['interchange'],
  semantic_rules: [
    {
      rule_id: 'research_response.terminal_shape',
      description: 'Status exactly matches terminal result and error shape.',
    },
    {
      rule_id: 'source.locator_required',
      description: 'An embedded source has a URL or provider reference.',
    },
    {
      rule_id: 'usage.cost_requires_currency',
      description: 'Costs require currency.',
    },
    {
      rule_id: 'result_provenance.surface_requires_collector',
      description: 'A surface requires a collector.',
    },
    {
      rule_id: 'result_provenance.surface_snapshot_boundary',
      description:
        'A surface snapshot requires a surface observation, collector retrieval, and collector identity.',
    },
    {
      rule_id: 'provider_meta.safe_metadata',
      description:
        'Provider metadata excludes obvious credentials and raw responses.',
    },
  ],
  files: [],
};
const manifestPath = 'manifest.json';
const preChecksum = [
  schemaPath,
  fixtureIndexPath,
  ...fixtureFiles,
  manifestPath,
];
manifest.files = preChecksum.map((path) => ({
  path,
  role:
    path === manifestPath
      ? 'manifest'
      : path === fixtureIndexPath
        ? 'fixture_index'
        : path.startsWith('schema/')
          ? 'schema'
          : 'fixture',
  areas: ['interchange'],
}));
write(manifestPath, manifest);
const checksums = preChecksum
  .sort()
  .map(
    (path) =>
      `${createHash('sha256')
        .update(readFileSync(resolveSnapshotWritePath(root, path)))
        .digest('hex')}  ${path}`,
  )
  .join('\n');
const checksumPath = write('checksums.sha256', `${checksums}\n`);
pruneRetiredFiles([...preChecksum, checksumPath]);
assertExactSnapshotInventory([...preChecksum, checksumPath]);
