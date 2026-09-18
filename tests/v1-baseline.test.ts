import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRunManifest } from '../src/core/run-manifest.js';
import { ConfigSchema, ProjectConfigSchema } from '../src/types.js';

interface FixtureSource {
  classification: string;
  references: string[];
}

interface FixtureEntry {
  id: string;
  path: string;
  category: string;
  shape: string;
  providerIds: string[];
  source: FixtureSource;
  neededFor: string;
  normalization: string[];
}

interface MigrationExpectation {
  id: string;
  inputFixture: string;
  action: 'migrate' | 'reject';
  beforeNetwork: boolean;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  notice?: {
    required: boolean;
    kind?: string;
    mustIdentify?: string[];
  };
  error?: {
    mustIdentify: string[];
    mustSuggest: string[];
  };
  decision: string;
}

interface Inventory {
  corpusVersion: number;
  productLine: string;
  baselineCommit: string;
  purpose: string;
  sourceClassifications: Record<string, string>;
  fixtures: FixtureEntry[];
  requiredOutcomes: string[];
  migrationExpectations: MigrationExpectation[];
  compatibilityExclusions: Array<{ id: string; reason: string }>;
}

interface FixtureManifest {
  schemaVersion: number;
  revision: number;
  status: string;
  timestamp: number;
  completedAt?: number;
  slug: string;
  query: string;
  mode: string;
  outputDir: string;
  exitCode: number | null;
  error?: string;
  providers: Array<{
    id: string;
    tier: string;
    status: string;
    durationMs: number;
    wordCount: number;
    citationCount: number;
    outputFile: string;
    metaFile: string;
    error?: string;
    fallbackFor?: string;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
    task?: {
      taskId: string;
      submittedAt: number;
      status: string;
      lastPolledAt?: number;
      completedAt?: number;
      retrievedAt?: number;
      providerStatus: string;
    };
  }>;
  sources: {
    total: number;
    unique: number;
    file: string;
  };
}

const EXPECTED_BASELINE_COMMIT = '72c07dff44da209c41479b1a2e5525d09ba05940';
const EXPECTED_INVENTORY_SHA256 =
  'c411ccc2afb44560799550042d4846aa42b71f8ce33e61492bc833b2390931b8';

const APPROVED_FIXTURES = [
  {
    id: 'artifact.background-pending',
    path: 'artifacts/background-pending-run.json',
    category: 'run_artifact',
    shape: 'background_pending',
    providerIds: ['perplexity-sonar-deep'],
    classification: 'repository_behavior_scenario',
  },
  {
    id: 'artifact.background-retrieved',
    path: 'artifacts/background-retrieved-run.json',
    category: 'run_artifact',
    shape: 'background_retrieved',
    providerIds: ['perplexity-sonar-deep'],
    classification: 'repository_behavior_scenario',
  },
  {
    id: 'artifact.completed',
    path: 'artifacts/completed-run.json',
    category: 'run_artifact',
    shape: 'completed',
    providerIds: ['perplexity-search'],
    classification: 'repository_behavior_scenario',
  },
  {
    id: 'artifact.failed',
    path: 'artifacts/failed-run.json',
    category: 'run_artifact',
    shape: 'failed',
    providerIds: ['perplexity-sonar-pro', 'brave-answers'],
    classification: 'repository_behavior_scenario',
  },
  {
    id: 'artifact.recovered-partial',
    path: 'artifacts/recovered-partial-run.json',
    category: 'run_artifact',
    shape: 'recovered_partial',
    providerIds: ['perplexity-sonar-pro', 'brave-answers', 'perplexity-search'],
    classification: 'repository_behavior_scenario',
  },
  {
    id: 'boundary.public-surfaces',
    path: 'public-boundaries.json',
    category: 'public_boundary',
    shape: 'semantic_public_boundaries',
    providerIds: [],
    classification: 'repository_behavior_scenario',
  },
  {
    id: 'config.async-inline-rejection',
    path: 'configs/async-inline-rejection.json',
    category: 'config',
    shape: 'project_config',
    providerIds: ['openai-research', 'perplexity-search'],
    classification: 'repository_behavior_scenario',
  },
  {
    id: 'config.global-mixed',
    path: 'configs/global-mixed.json',
    category: 'config',
    shape: 'global_config',
    providerIds: ['perplexity-sonar-deep', 'perplexity-search'],
    classification: 'repository_behavior_scenario',
  },
  {
    id: 'config.project-reserved-group',
    path: 'configs/project-reserved-group.json',
    category: 'config',
    shape: 'project_config',
    providerIds: ['perplexity-search', 'brave-search'],
    classification: 'repository_behavior_scenario',
  },
  {
    id: 'config.trusted-custom-provider',
    path: 'configs/trusted-custom-provider.json',
    category: 'config',
    shape: 'custom_provider_config',
    providerIds: ['acme-research'],
    classification: 'repository_behavior_scenario',
  },
  {
    id: 'provider.cited-streamed-answer.brave-answers',
    path: 'providers/brave-answers-stream.json',
    category: 'provider_response',
    shape: 'cited_streamed_answer',
    providerIds: ['brave-answers'],
    classification: 'repository_behavior_scenario',
  },
  {
    id: 'provider.consumer-surface.searchapi-google-ai-mode',
    path: 'providers/searchapi-google-ai-mode-observation.json',
    category: 'provider_response',
    shape: 'consumer_surface_observation',
    providerIds: ['searchapi-google-ai-mode'],
    classification: 'repository_contract_fixture',
  },
  {
    id: 'provider.durable-background.perplexity-sonar-deep',
    path: 'providers/perplexity-sonar-deep-lifecycle.json',
    category: 'provider_lifecycle',
    shape: 'durable_background_submit_poll_retrieve',
    providerIds: ['perplexity-sonar-deep'],
    classification: 'repository_behavior_scenario',
  },
  {
    id: 'provider.raw-search.perplexity-search',
    path: 'providers/perplexity-search-response.json',
    category: 'provider_response',
    shape: 'raw_search',
    providerIds: ['perplexity-search'],
    classification: 'repository_behavior_scenario',
  },
  {
    id: 'provider.safe-error.brave-answers',
    path: 'providers/brave-answers-error.json',
    category: 'provider_error',
    shape: 'safe_provider_error',
    providerIds: ['brave-answers'],
    classification: 'sanitized_live_shape',
  },
] as const;

const APPROVED_FIXTURE_HASHES: Record<string, string> = {
  'artifacts/background-pending-run.json':
    '33f49471c8172921bfbf8329562c2c9317a630c60e2c98c8d272e92359e9a2d0',
  'artifacts/background-retrieved-run.json':
    'a5b51fa9b869293bc4fde346c24216554c6e13908bef1a1a9501ef3ec0910767',
  'artifacts/completed-run.json':
    '7044039a8fb86e2177b54f0b153f48bfb764d3fd1df4878380641b26129f6ac4',
  'artifacts/failed-run.json':
    'bf7894080f97c800ea75b922d030bf2ac6415ccedfdc8e8ba18c3e4968c51f31',
  'artifacts/recovered-partial-run.json':
    '92438a59fe556809df340d961625e50fe61c491db7d0b5cbc52433c54603ec14',
  'configs/async-inline-rejection.json':
    '6d4968dd65980090fdefe623c20076ed714ca57b131e2cb0b916a0e7e8bd4677',
  'configs/global-mixed.json':
    '7b83aeb3e4fd0f6e6c797f1fb10bf35f5d0619bf3647e43b82ad65d70da5d493',
  'configs/project-reserved-group.json':
    '9b8f91aee9cd14b6e504e7a9f6bc235688548ad7f1d6ca9417a4bb50fabd6b04',
  'configs/trusted-custom-provider.json':
    'fbb997624d61f6da76b6518bc2cf499aaffb59d8125ec47d5d390229f9c69ac9',
  'providers/brave-answers-error.json':
    '5e681bb5cf8bb24515698a3b6c279da10fdecf9a2d792aa9e63ae6224db62d3f',
  'providers/brave-answers-stream.json':
    '2209003e6681bed3986b972f38445d4d07d8de2fb0ce3685d4f0f28e1c791112',
  'providers/perplexity-search-response.json':
    'caef6e6bb808d99ddd3f8a068af099677f377b68160ee72883e553995baebda3',
  'providers/perplexity-sonar-deep-lifecycle.json':
    'f83fa31d38c3bab98b8ad964e7c550bd9b0a20908acf2a64fca767bd1ffe2289',
  'providers/searchapi-google-ai-mode-observation.json':
    '00844d3ff77d75e12ac974559d4cfcfbcbfcdba2ab14a8f3238bc7371789e3d2',
  'public-boundaries.json':
    '357c0c138e0cb8d7f691f974af5ae9a155221944f6b4a3461d214f11593bba79',
};

const APPROVED_EXCLUSIONS = [
  'exact_cli_prose',
  'current_rosters',
  'internal_classes',
  'generated_bundles',
  'accidental_async_mixed_equivalence',
  'benchmark_and_eval_corpora',
  'new_v2_provider_history',
  'volatile_values',
  'fallback_algorithm',
];

const SECRET_PATTERNS = [
  /\b(?:sk|pplx|xai|fc)-[A-Za-z0-9_-]{8,}\b/,
  /\bAIza[A-Za-z0-9_-]{20,}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /Bearer\s+[A-Za-z0-9._-]{8,}/i,
  /[?&](?:api_key|access_token|token)=[^&\s"]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

const CREDENTIAL_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'bearer',
  'clientsecret',
  'cookie',
  'credential',
  'credentials',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'subscriptiontoken',
  'token',
]);
const CREDENTIAL_KEY_SUFFIXES = [
  'accesstoken',
  'apikey',
  'clientsecret',
  'privatekey',
  'refreshtoken',
  'subscriptiontoken',
];

const repositoryRoot = realpathSync(
  fileURLToPath(new URL('../', import.meta.url)),
);
const fixtureRoot = realpathSync(
  fileURLToPath(new URL('./fixtures/v1/', import.meta.url)),
);

function assertContainedPath(root: string, candidate: string): void {
  const relativePath = relative(root, candidate);
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Path escapes expected root: ${candidate}`);
  }
}

function resolveFixturePath(fixturePath: string): string {
  if (isAbsolute(fixturePath)) {
    throw new Error(`Fixture path must be relative: ${fixturePath}`);
  }
  const candidate = resolve(fixtureRoot, fixturePath);
  assertContainedPath(fixtureRoot, candidate);
  const realCandidate = realpathSync(candidate);
  assertContainedPath(fixtureRoot, realCandidate);
  return realCandidate;
}

function resolveRepositoryReference(reference: string): string {
  if (isAbsolute(reference)) {
    throw new Error(`Source reference must be relative: ${reference}`);
  }
  const candidate = resolve(repositoryRoot, reference);
  assertContainedPath(repositoryRoot, candidate);
  if (!existsSync(candidate)) {
    throw new Error(`Source reference does not exist: ${reference}`);
  }
  const realCandidate = realpathSync(candidate);
  assertContainedPath(repositoryRoot, realCandidate);
  return realCandidate;
}

function readJson<T = unknown>(fixturePath: string): T {
  return JSON.parse(readFileSync(resolveFixturePath(fixturePath), 'utf8')) as T;
}

function listCorpusFiles(directory = fixtureRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) return listCorpusFiles(absolute);
    if (!entry.isFile() && !entry.isSymbolicLink()) return [];
    return [relative(fixtureRoot, absolute).split(sep).join('/')];
  });
}

function hashCanonicalJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function migration(id: string): MigrationExpectation {
  const found = inventory.migrationExpectations.find(
    (expectation) => expectation.id === id,
  );
  if (!found) throw new Error(`Missing migration expectation: ${id}`);
  return found;
}

function artifact(shape: string): FixtureManifest {
  const entry = inventory.fixtures.find(
    (fixture) => fixture.category === 'run_artifact' && fixture.shape === shape,
  );
  if (!entry) throw new Error(`Missing run artifact shape: ${shape}`);
  return readJson<FixtureManifest>(entry.path);
}

function assertNoEmbeddedCredentials(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoEmbeddedCredentials(item, `${path}[${index}]`);
    });
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (
      CREDENTIAL_KEYS.has(normalizedKey) ||
      CREDENTIAL_KEY_SUFFIXES.some((suffix) => normalizedKey.endsWith(suffix))
    ) {
      expect(child, childPath).toBeTypeOf('string');
      expect(String(child), childPath).toMatch(/^\$[A-Z][A-Z0-9_]+$/);
    }
    assertNoEmbeddedCredentials(child, childPath);
  }
}

function assertNoKnownSecretPatterns(value: unknown, path: string): void {
  const serialized = JSON.stringify(value);
  for (const pattern of SECRET_PATTERNS) {
    expect(serialized, `${path}: ${pattern}`).not.toMatch(pattern);
  }
}

const inventory = readJson<Inventory>('inventory.json');

describe('v1 migration and provider-fixture baseline', () => {
  it('locks the exact approved inventory, metadata, and fixture contents', () => {
    const approvedPaths = APPROVED_FIXTURES.map(({ path }) => path).sort();
    const onDisk = listCorpusFiles()
      .filter((path) => path !== 'inventory.json')
      .sort();
    const actualProjection = inventory.fixtures
      .map((fixture) => ({
        id: fixture.id,
        path: fixture.path,
        category: fixture.category,
        shape: fixture.shape,
        providerIds: fixture.providerIds,
        classification: fixture.source.classification,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));

    expect(inventory.corpusVersion).toBe(1);
    expect(inventory.productLine).toBe('librarium-v1');
    expect(inventory.baselineCommit).toBe(EXPECTED_BASELINE_COMMIT);
    expect(hashCanonicalJson(inventory)).toBe(EXPECTED_INVENTORY_SHA256);
    expect(actualProjection).toEqual(
      [...APPROVED_FIXTURES].sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
    );
    expect(onDisk).toEqual(approvedPaths);
    expect(Object.keys(APPROVED_FIXTURE_HASHES).sort()).toEqual(approvedPaths);

    for (const fixturePath of approvedPaths) {
      expect(hashCanonicalJson(readJson(fixturePath)), fixturePath).toBe(
        APPROVED_FIXTURE_HASHES[fixturePath],
      );
    }
  });

  it('records repository-contained provenance, rationale, and normalization for every fixture', () => {
    expect(inventory.sourceClassifications).toEqual({
      repository_contract_fixture:
        'A checked-in v1 adapter or transport fixture that already defined a provider-facing response boundary.',
      repository_behavior_scenario:
        'A compact JSON rendering of behavior covered by an existing v1 test or implementation path.',
      sanitized_live_shape:
        'A bounded, credential-free rendering of a provider shape recorded by a v1 test as live-observed, with volatile values replaced.',
    });

    for (const fixture of inventory.fixtures) {
      expect(fixture.source.references.length, fixture.id).toBeGreaterThan(0);
      for (const reference of fixture.source.references) {
        expect(
          () => resolveRepositoryReference(reference),
          fixture.id,
        ).not.toThrow();
        expect(reference, fixture.id).not.toMatch(
          /^(?:benchmark|benchmarks|evaluation|eval)\//,
        );
      }
      expect(fixture.neededFor.length, fixture.id).toBeGreaterThan(80);
      expect(fixture.normalization.length, fixture.id).toBeGreaterThan(0);
      expect(fixture.path, fixture.id).not.toContain('benchmark/fixtures/v1');
    }
  });

  it('rejects fixture traversal, absolute paths, symlink escapes, and embedded credentials', () => {
    expect(() => readJson('../../../package.json')).toThrow(
      /escapes expected root/,
    );
    expect(() => readJson(resolve(repositoryRoot, 'package.json'))).toThrow(
      /must be relative/,
    );
    expect(() =>
      assertContainedPath(fixtureRoot, resolve(repositoryRoot, 'package.json')),
    ).toThrow(/escapes expected root/);

    for (const fixturePath of listCorpusFiles()) {
      const parsed = readJson(fixturePath);
      expect(
        JSON.parse(JSON.stringify(parsed)),
        `${fixturePath} JSON round-trip`,
      ).toEqual(parsed);
      assertNoEmbeddedCredentials(parsed, fixturePath);
      assertNoKnownSecretPatterns(parsed, fixturePath);
    }

    for (const unsafe of [
      { token: `ghp_${'a'.repeat(36)}` },
      { clientSecret: 'literal-client-secret' },
      { private_key: 'literal-private-key' },
      { env: { ACME_API_KEY: 'literal-provider-key' } },
    ]) {
      expect(() => assertNoEmbeddedCredentials(unsafe)).toThrow();
    }
    expect(() =>
      assertNoKnownSecretPatterns(
        { value: `AKIA${'A'.repeat(16)}` },
        'known-prefix regression',
      ),
    ).toThrow();
  });

  it('preserves the five materially distinct v1 provider and lifecycle shapes', () => {
    const rawSearch = readJson<{
      provider: string;
      transport: string;
      response: {
        id: string;
        results: Array<{ url: string; title: string; snippet: string }>;
      };
    }>('providers/perplexity-search-response.json');
    expect(rawSearch).toMatchObject({
      provider: 'perplexity-search',
      transport: 'json',
      response: { id: 'search-normalized-1' },
    });
    expect(rawSearch.response.results).toEqual([
      {
        url: 'https://docs.example.test/pooling',
        title: 'Connection pooling guide',
        snippet: 'A bounded source snippet describing connection pooling.',
      },
      {
        url: 'https://research.example.test/pooling',
        title: 'Pooling behavior study',
        snippet: 'A second ordered result with independent source metadata.',
      },
    ]);

    const streamed = readJson<{
      provider: string;
      transport: string;
      events: Array<{ data: unknown }>;
    }>('providers/brave-answers-stream.json');
    expect(streamed.provider).toBe('brave-answers');
    expect(streamed.transport).toBe('sse');
    expect(streamed.events).toHaveLength(4);
    expect(JSON.stringify(streamed.events[0])).toContain(
      'https://evidence.example.test/source',
    );
    expect(JSON.stringify(streamed.events[0])).toContain('Source title');
    expect(JSON.stringify(streamed.events[1])).toContain(
      'X-Request-Total-Cost',
    );
    expect(streamed.events[2]).toMatchObject({
      data: {
        choices: [{ finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      },
    });
    expect(streamed.events[3]).toEqual({ data: '[DONE]' });

    const durable = readJson<{
      provider: string;
      submit: { id: string; status: string; response: null };
      poll: Array<{ id: string; status: string }>;
      retrieve: {
        id: string;
        status: string;
        response: {
          choices: Array<{ message: { role: string; content: string } }>;
          citations: string[];
          search_results: Array<{ url: string; title: string }>;
          usage: {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
            cost: { total_cost: number };
          };
        };
      };
    }>('providers/perplexity-sonar-deep-lifecycle.json');
    expect(durable.provider).toBe('perplexity-sonar-deep');
    expect(durable.submit).toEqual({
      id: 'task-normalized-1',
      model: 'sonar-deep-research',
      created_at: 1700000000,
      status: 'CREATED',
      response: null,
    });
    expect(durable.poll.map(({ status }) => status)).toEqual([
      'IN_PROGRESS',
      'COMPLETED',
    ]);
    expect(durable.retrieve).toMatchObject({
      id: 'task-normalized-1',
      status: 'COMPLETED',
      response: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Deep findings from the normalized fixture.',
            },
          },
        ],
        citations: ['https://evidence.example.test/a'],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 200,
          total_tokens: 300,
          cost: { total_cost: 0.01 },
        },
      },
    });
    expect(
      durable.retrieve.response.search_results.map(({ url }) => url),
    ).toEqual([
      'https://evidence.example.test/a',
      'https://evidence.example.test/b',
    ]);

    expect(
      readJson('providers/searchapi-google-ai-mode-observation.json'),
    ).toEqual({
      provider: 'searchapi-google-ai-mode',
      request: {
        engine: 'google_ai_mode',
        query: 'normalized surface query',
      },
      response: {
        markdown:
          '## AI Mode answer\n\nA bounded consumer-surface observation.',
        reference_links: [
          {
            link: 'https://surface.example.test/source',
            title: 'Observed source',
            snippet: 'Evidence extracted from the measured surface.',
          },
        ],
      },
    });

    expect(readJson('providers/brave-answers-error.json')).toEqual({
      provider: 'brave-answers',
      httpStatus: 400,
      response: {
        type: 'ErrorResponse',
        error: {
          id: 'provider-error-normalized-1',
          status: 400,
          detail: 'The requested option is not subscribed in the current plan.',
          meta: { component: 'authentication' },
          code: 'OPTION_NOT_IN_PLAN',
        },
        time: 1700000000,
      },
    });
  });

  it('ties each realistic config to its migrate-or-reject expectation', () => {
    const globalMixed = readJson<{
      defaults: { mode: string };
      providers: Record<string, unknown>;
      groups: Record<string, string[]>;
    }>('configs/global-mixed.json');
    const reservedGroup = readJson<{
      defaults: { mode: string };
      groups: Record<string, string[]>;
    }>('configs/project-reserved-group.json');
    const trustedCustom = readJson<{
      providers: Record<string, { options: Record<string, string> }>;
      customProviders: Record<
        string,
        {
          type: string;
          command: string;
          args: string[];
          options: Record<string, string>;
        }
      >;
      trustedProviderIds: string[];
      groups: Record<string, string[]>;
    }>('configs/trusted-custom-provider.json');
    const asyncInline = readJson<{
      defaults: { mode: string };
      providers: Record<string, unknown>;
      groups: Record<string, string[]>;
    }>('configs/async-inline-rejection.json');

    expect(() => ConfigSchema.parse(globalMixed)).not.toThrow();
    expect(() => ConfigSchema.parse(trustedCustom)).not.toThrow();
    expect(() => ProjectConfigSchema.parse(reservedGroup)).not.toThrow();
    expect(() => ProjectConfigSchema.parse(asyncInline)).not.toThrow();

    expect(globalMixed.defaults.mode).toBe('mixed');
    expect(Object.keys(globalMixed.providers)).toEqual([
      'perplexity-sonar-deep',
      'perplexity-search',
    ]);
    expect(globalMixed.groups['research-team']).toEqual([
      'perplexity-sonar-deep',
      'perplexity-search',
    ]);
    expect(migration('global-mixed-to-async')).toMatchObject({
      inputFixture: 'configs/global-mixed.json',
      action: 'migrate',
      beforeNetwork: true,
      input: { mode: globalMixed.defaults.mode },
      output: { mode: 'async' },
      notice: {
        required: true,
        kind: 'deprecation',
        mustIdentify: ['mixed', 'async'],
      },
      decision: 'D-CF-001',
    });

    expect(reservedGroup.defaults.mode).toBe('sync');
    expect(reservedGroup.groups.quick).toEqual([
      'perplexity-search',
      'brave-search',
    ]);
    expect(migration('reserved-group-collision')).toMatchObject({
      inputFixture: 'configs/project-reserved-group.json',
      action: 'migrate',
      beforeNetwork: true,
      input: { group: 'quick' },
      output: { group: 'custom:quick' },
      notice: {
        required: true,
        kind: 'namespace_migration',
        mustIdentify: ['quick', 'custom:quick'],
      },
      decision: 'D-CF-003',
    });

    expect(trustedCustom.trustedProviderIds).toEqual(['acme-research']);
    expect(trustedCustom.providers['acme-research']?.options).toEqual({
      region: 'ca',
    });
    expect(trustedCustom.customProviders['acme-research']).toEqual({
      type: 'script',
      command: 'node',
      args: ['./providers/acme-research.mjs'],
      options: { tag: 'internal-research' },
    });
    expect(trustedCustom.groups.internal).toEqual(['acme-research']);
    expect(migration('trusted-custom-provider-preserved')).toMatchObject({
      inputFixture: 'configs/trusted-custom-provider.json',
      action: 'migrate',
      beforeNetwork: true,
      output: {
        provider: 'acme-research',
        trustRequired: true,
        sourceType: trustedCustom.customProviders['acme-research']?.type,
      },
      notice: { required: false },
    });

    expect(asyncInline.defaults.mode).toBe('async');
    expect(Object.keys(asyncInline.providers)).toEqual([
      'openai-research',
      'perplexity-search',
    ]);
    expect(asyncInline.groups['durable-plus-inline']).toEqual([
      'openai-research',
      'perplexity-search',
    ]);
    expect(migration('async-inline-rejected')).toMatchObject({
      inputFixture: 'configs/async-inline-rejection.json',
      action: 'reject',
      beforeNetwork: true,
      input: {
        mode: asyncInline.defaults.mode,
        selection: 'durable-plus-inline',
      },
      error: {
        mustIdentify: ['perplexity-search'],
        mustSuggest: ['sync', 'exclude the incompatible provider'],
      },
      decision: 'D-CF-002',
    });

    expect(
      inventory.migrationExpectations
        .map(({ inputFixture }) => inputFixture)
        .sort(),
    ).toEqual(
      inventory.fixtures
        .filter(({ category }) => category === 'config')
        .map(({ path }) => path)
        .sort(),
    );
  });

  it('preserves exact normalized completed, partial, failed, pending, and retrieved artifact semantics', () => {
    for (const outcome of inventory.requiredOutcomes) {
      const manifest = artifact(outcome);
      expect(isRunManifest(manifest), outcome).toBe(true);
      expect(manifest.outputDir, outcome).toMatch(/^\/normalized\//);
      expect(manifest.timestamp, outcome).toBe(1700000000);
      expect(
        manifest.providers.every(({ durationMs }) => durationMs === 0),
        outcome,
      ).toBe(true);
    }

    expect(inventory.requiredOutcomes).toEqual([
      'completed',
      'recovered_partial',
      'failed',
      'background_pending',
      'background_retrieved',
    ]);

    expect(artifact('completed')).toMatchObject({
      schemaVersion: 2,
      revision: 1,
      status: 'completed',
      completedAt: 1700000001000,
      mode: 'sync',
      providers: [
        {
          id: 'perplexity-search',
          tier: 'raw-search',
          status: 'success',
          wordCount: 24,
          citationCount: 2,
          outputFile: 'perplexity-search.md',
          metaFile: 'perplexity-search.meta.json',
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        },
      ],
      sources: { total: 2, unique: 2, file: 'sources.json' },
      exitCode: 0,
    });

    expect(artifact('recovered_partial')).toMatchObject({
      revision: 3,
      status: 'partial',
      mode: 'sync',
      providers: [
        { id: 'perplexity-sonar-pro', status: 'error' },
        {
          id: 'brave-answers',
          status: 'success',
          fallbackFor: 'perplexity-sonar-pro',
          wordCount: 18,
          citationCount: 1,
          outputFile: 'brave-answers.md',
          metaFile: 'brave-answers.meta.json',
        },
        { id: 'perplexity-search', status: 'error' },
      ],
      sources: { total: 1, unique: 1, file: 'sources.json' },
      exitCode: 1,
    });

    expect(artifact('failed')).toMatchObject({
      revision: 2,
      status: 'failed',
      providers: [
        { id: 'perplexity-sonar-pro', status: 'error' },
        {
          id: 'brave-answers',
          status: 'error',
          fallbackFor: 'perplexity-sonar-pro',
        },
      ],
      sources: { total: 0, unique: 0, file: 'sources.json' },
      exitCode: 2,
      error: 'No provider completed successfully',
    });

    expect(artifact('background_pending')).toMatchObject({
      revision: 1,
      status: 'awaiting_async',
      mode: 'async',
      providers: [
        {
          id: 'perplexity-sonar-deep',
          status: 'async-pending',
          wordCount: 0,
          citationCount: 0,
          outputFile: '',
          metaFile: '',
          task: {
            taskId: 'task-normalized-1',
            submittedAt: 1700000000000,
            status: 'pending',
            providerStatus: 'CREATED',
          },
        },
      ],
      sources: { total: 0, unique: 0, file: 'sources.json' },
      exitCode: null,
    });

    expect(artifact('background_retrieved')).toMatchObject({
      revision: 4,
      status: 'completed',
      completedAt: 1700000003000,
      mode: 'async',
      providers: [
        {
          id: 'perplexity-sonar-deep',
          status: 'success',
          wordCount: 42,
          citationCount: 2,
          outputFile: 'perplexity-sonar-deep.md',
          metaFile: 'perplexity-sonar-deep.meta.json',
          task: {
            taskId: 'task-normalized-1',
            submittedAt: 1700000000000,
            status: 'completed',
            lastPolledAt: 1700000001000,
            completedAt: 1700000002000,
            retrievedAt: 1700000003000,
            providerStatus: 'COMPLETED',
          },
        },
      ],
      sources: { total: 2, unique: 2, file: 'sources.json' },
      exitCode: 0,
    });
  });

  it('locks public-boundary semantics and every explicit exclusion', () => {
    const boundaries = readJson<{
      exportSpecifiers: Array<{ specifier: string; retainedSemantic: string }>;
      cli: {
        jsonSemantics: string[];
        exitCodes: Record<string, number>;
        pendingManifestExitCode: null;
      };
      library: { resultSemantics: string[] };
      mcp: { resultSemantics: string[]; providerContent: string };
      customProviderProtocol: {
        protocolVersion: number;
        trustedProviderIdsRequired: boolean;
        operations: string[];
        requestEnvelope: string[];
        responseEnvelopes: Array<Record<string, unknown>>;
        backgroundRequires: string[];
        inlineForbids: string[];
      };
    }>('public-boundaries.json');

    expect(boundaries.exportSpecifiers).toHaveLength(3);
    expect(
      boundaries.exportSpecifiers.map(({ specifier }) => specifier),
    ).toEqual(['librarium', 'librarium/core', 'librarium/node']);
    expect(
      boundaries.exportSpecifiers.every(
        ({ retainedSemantic }) => retainedSemantic.length > 80,
      ),
    ).toBe(true);
    expect(boundaries.cli.jsonSemantics).toEqual([
      'Machine-readable commands emit parseable JSON rather than presentation text.',
      'run --json writes one manifest document to stdout and routes diagnostics to stderr.',
    ]);
    expect(boundaries.cli.exitCodes).toEqual({
      completed: 0,
      partial: 1,
      failed: 2,
      cancelled: 130,
    });
    expect(boundaries.cli.pendingManifestExitCode).toBeNull();
    expect(boundaries.library.resultSemantics).toEqual([
      'provider identity and semantic outcome',
      'answer or result text',
      'citations and source URLs',
      'duration and provider-reported usage when available',
      'fallback replacement relationship',
      'durable pending handle when work is not terminal',
    ]);
    expect(boundaries.mcp.resultSemantics).toEqual([
      'query and execution mode',
      'provider outcome tallies',
      'bounded provider summaries',
      'bounded deduplicated sources',
      'pending durable task identifiers',
      'safe tool errors',
    ]);
    expect(boundaries.mcp.providerContent).toMatch(/untrusted evidence/i);
    expect(boundaries.customProviderProtocol).toEqual({
      protocolVersion: 1,
      trustedProviderIdsRequired: true,
      operations: ['describe', 'execute', 'submit', 'poll', 'retrieve', 'test'],
      requestEnvelope: [
        'protocolVersion',
        'operation',
        'providerId',
        'query',
        'handle',
        'options',
        'providerConfig',
        'sourceOptions',
      ],
      responseEnvelopes: [
        { ok: true, data: '<operation payload>' },
        { ok: false, error: '<safe message>' },
      ],
      backgroundRequires: ['submit', 'poll', 'retrieve'],
      inlineForbids: ['submit', 'poll', 'retrieve'],
    });

    expect(inventory.compatibilityExclusions.map(({ id }) => id)).toEqual(
      APPROVED_EXCLUSIONS,
    );
    expect(
      inventory.compatibilityExclusions.every(
        ({ reason }) => reason.length > 60,
      ),
    ).toBe(true);
    expect(
      inventory.compatibilityExclusions.find(
        ({ id }) => id === 'new_v2_provider_history',
      )?.reason,
    ).toContain('grok-x-only');
    expect(
      inventory.compatibilityExclusions.find(
        ({ id }) => id === 'new_v2_provider_history',
      )?.reason,
    ).toContain('grok-combined');
  });
});
