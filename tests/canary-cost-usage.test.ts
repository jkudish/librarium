/**
 * Offline regressions for the 2026-10-11 live canary (#4866). Each provider
 * response reproduces the shape the canary observed; no request leaves the
 * process.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from '../src/adapters/claude.js';
import { GeminiGroundedProvider } from '../src/adapters/gemini-grounded.js';
import { GrokCombinedProvider } from '../src/adapters/grok.js';
import { ParallelResearchProvider } from '../src/adapters/parallel.js';
import { aggregateUsage } from '../src/commands/usage-data.js';
import type { ExecutionProfile } from '../src/contracts/domain/index.js';
import type { PreparedResearchExecution } from '../src/core/execution-plan.js';
import { profileIdentityKey } from '../src/core/execution-plan.js';
import { buildProviderCatalog } from '../src/core/profile-catalog.js';
import { runCanonicalPreparedExecution } from '../src/node-canonical-run.js';
import type { Provider } from '../src/types.js';

// After Gemini's 2027-01-01 price doubling, so the dated window matters.
const T0 = Date.parse('2027-02-01T00:00:00.000Z');
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function json(status: number, data: unknown): Response {
  return {
    status,
    statusText: 'OK',
    headers: new Headers({}),
    text: async () => JSON.stringify(data),
  } as Response;
}

const PARALLEL_SCHEMA = {
  type: 'object',
  properties: { providers: { type: 'array', items: { type: 'string' } } },
  required: ['providers'],
};

/** Provider responses in the shapes the canary recorded. */
function canaryFetch(): typeof fetch {
  let parallelPolls = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('generativelanguage.googleapis.com')) {
      return json(200, {
        candidates: [
          {
            content: { parts: [{ text: 'Gemini grounded answer.' }] },
            groundingMetadata: {
              // Gemini bills unique non-empty queries: three here.
              webSearchQueries: [
                'luxgive',
                'luxgive fees',
                'luxgive',
                ' ',
                'tether',
              ],
              groundingChunks: [
                { web: { uri: 'https://example.com/g', title: 'g' } },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 2677,
          candidatesTokenCount: 2461,
          totalTokenCount: 5138,
        },
      });
    }
    if (url.includes('api.anthropic.com')) {
      return json(200, {
        model: 'claude-sonnet-5-5',
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: 'Claude answer.',
            citations: [
              {
                type: 'web_search_result_location',
                url: 'https://example.com/c',
                title: 'c',
              },
            ],
          },
        ],
        usage: {
          input_tokens: 42848,
          output_tokens: 5061,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: { web_search_requests: 5 },
        },
      });
    }
    if (url.includes('api.x.ai')) {
      return json(200, {
        model: 'grok-4.7',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Grok answer.',
                annotations: [
                  { type: 'url_citation', url: 'https://x.com/i/status/1' },
                ],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 266866,
          output_tokens: 4554,
          input_tokens_details: { cached_tokens: 183424 },
          output_tokens_details: { reasoning_tokens: 1576 },
          cost_in_usd_ticks: 7_418_400_000,
          server_side_tool_usage_details: {
            web_search_calls: 6,
            x_search_calls: 3,
            x_posts_fetched: 9,
            x_users_fetched: 1,
            code_interpreter_calls: 0,
          },
        },
      });
    }
    if (url.endsWith('/v1/tasks/runs')) {
      return json(202, { run_id: 'trun_canary', status: 'queued' });
    }
    if (url.endsWith('/v1/tasks/runs/trun_canary')) {
      parallelPolls += 1;
      return json(200, {
        run_id: 'trun_canary',
        status: parallelPolls < 3 ? 'running' : 'completed',
      });
    }
    if (url.endsWith('/v1/tasks/runs/trun_canary/result')) {
      return json(200, {
        run: { run_id: 'trun_canary', status: 'completed', processor: 'core' },
        output: {
          type: 'json',
          content: { providers: ['a', 'b', 'c', 'd', 'e'] },
          basis: [],
        },
      });
    }
    throw new Error(`unexpected request ${url}`);
  }) as unknown as typeof fetch;
}

function catalogProfiles(): Record<string, ExecutionProfile> {
  const catalog = buildProviderCatalog({
    providerConfigs: {
      'gemini-grounded': { enabled: true },
      claude: { enabled: true },
      'grok-combined': { enabled: true },
      'parallel-research': {
        enabled: true,
        model: 'core',
        options: { outputSchema: PARALLEL_SCHEMA },
      },
    },
    assumeCredentialAvailability: true,
  });
  const get = (provider: string, profile: string) => {
    const resolved = catalog.get(provider, profile);
    if (!resolved) throw new Error(`missing ${provider}/${profile}`);
    return resolved.profile;
  };
  return {
    'gemini-grounded': get('gemini-grounded', 'grounded'),
    claude: get('claude', 'chat'),
    'grok-combined': get('grok-combined', 'combined'),
    'parallel-research': get('parallel', 'research'),
  };
}

function prepared(
  profiles: Record<string, ExecutionProfile>,
): PreparedResearchExecution {
  const entries = Object.entries(profiles);
  return {
    request: {
      interchange_version: '1.0.0',
      message_type: 'request',
      request_id: 'canary-request',
      requested_at: new Date(T0).toISOString(),
      mode: 'sync',
      query: 'canary query',
      slots: entries.map(([, profile], position) => ({
        slot_id: `slot-${position}`,
        position,
        requirements: {
          result_kind: profile.result_kind,
          grounding_policy: profile.grounding_policy,
          corpora: [...profile.corpora],
          retrieval_methods: [profile.retrieval_method],
        },
        primary: profile,
      })),
      fallback_reserve: [],
    },
    policy: {
      limits: {
        max_concurrency: entries.length,
        request_deadline_ms: 900_000,
        inline_attempt_deadline_ms: 60_000,
        background_attempt_deadline_ms: 600_000,
        poll_interval_ms: 60_000,
      },
      fallback: { kind: 'disabled' },
      exclusions: [],
      refinement: { kind: 'disabled' },
    },
    profile_plans_by_identity: Object.fromEntries(
      entries.map(([adapterId, profile]) => {
        const key = profileIdentityKey(profile.identity);
        return [
          key,
          {
            profile_key: key,
            identity: profile.identity,
            binding: { adapter_id: adapterId, binding_id: `${adapterId}-b` },
          },
        ];
      }),
    ),
    catalog: { revision: 'canary-r1', digest: 'canary-digest' },
    notices: [],
  };
}

describe('live canary cost, usage, and metadata regressions (#4866)', () => {
  it('persists unknown cost, snapshot estimates, X usage, JSON output, task duration, and stop_reason', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    globalThis.fetch = canaryFetch();
    const credentials = {
      env: {
        GEMINI_API_KEY: 'k',
        ANTHROPIC_API_KEY: 'k',
        XAI_API_KEY: 'k',
        PARALLEL_API_KEY: 'k',
      },
    };
    const providers: Record<string, Provider> = {
      'gemini-grounded': new GeminiGroundedProvider({ credentials }),
      claude: new ClaudeProvider({ credentials }),
      'grok-combined': new GrokCombinedProvider({ credentials }),
      'parallel-research': new ParallelResearchProvider({
        credentials,
        model: 'core',
        configuredOptions: { outputSchema: PARALLEL_SCHEMA },
      }) as unknown as Provider,
    };
    const profiles = catalogProfiles();
    const root = join(tmpdir(), `librarium-canary-${crypto.randomUUID()}`);
    const runDirectory = join(root, 'canary-run');
    mkdirSync(runDirectory, { recursive: true });
    roots.push(root);

    let ids = 0;
    const result = await runCanonicalPreparedExecution(prepared(profiles), {
      runs_root: root,
      run_directory: runDirectory,
      coordinator: {
        clock: { now: () => Date.now() },
        ids: { next: (scope) => `${scope}-${++ids}` },
      },
      attempt_bridge: {
        resolveExactBinding(binding) {
          const profile = profiles[binding.adapter_id];
          const provider = providers[binding.adapter_id];
          return profile && provider
            ? { binding, profile, catalog_digest: 'canary-digest', provider }
            : undefined;
        },
        now: () => Date.now(),
        // Each poll interval passes on the fake clock.
        wait: async (ms: number) => {
          vi.setSystemTime(Date.now() + ms);
        },
      },
    });
    expect(result.response?.errors ?? []).toEqual([]);
    expect(result.response?.status).toBe('succeeded');

    const manifest = JSON.parse(
      readFileSync(join(runDirectory, 'run.json'), 'utf8'),
    );
    const results = Object.fromEntries(
      result.response!.results.map((entry) => [entry.provider, entry]),
    );

    // 1. Token-priced runs never persist a zero cost. Only Grok reported one.
    const costByProvider = Object.fromEntries(
      manifest.coordination_state.attempts.map(
        (attempt: {
          profile: ExecutionProfile;
          actual_cost_microusd?: string;
        }) => [
          attempt.profile.identity.provider_id,
          attempt.actual_cost_microusd,
        ],
      ),
    );
    expect(costByProvider).toEqual({
      'gemini-grounded': undefined,
      claude: undefined,
      'grok-combined': '741840',
      parallel: undefined,
    });
    expect(manifest.coordination_state.budget.actual_cost_microusd).toBe(
      '741840',
    );
    expect(results.claude?.usage).not.toHaveProperty('actual_cost');
    expect(results['gemini-grounded']?.usage).not.toHaveProperty('actual_cost');
    // Persisted from xAI's integer ticks, not a float expansion.
    expect(results['grok-combined']?.usage?.actual_cost).toBe('0.74184');

    // 7. Gemini is priced from the dated snapshot at the 2027 rates:
    // 2677 x $1.50/M + 2461 x $7.50/M + 3 searches x $14/1k.
    expect(results['gemini-grounded']?.usage).toMatchObject({
      prompt_tokens: 2677,
      completion_tokens: 2461,
      server_tool_search_requests: 3,
      estimated_cost: '0.064473',
      currency: 'USD',
    });
    // Claude's snapshot has no search rate, so the cost stays unknown; only
    // the token minimum is recorded, labeled partial.
    expect(results.claude?.usage).not.toHaveProperty('estimated_cost');
    expect(results.claude?.usage?.server_tool_search_requests).toBe(5);
    expect(results.claude?.provider_meta?.['librarium:cost_estimate']).toEqual(
      expect.objectContaining({
        source: 'pricing_snapshot',
        status: 'partial',
        known_minimum_usd: '0.136306',
        missing_units: ['searches'],
      }),
    );

    // 6. Claude's stop_reason survives a successful result.
    expect(results.claude?.provider_meta?.['anthropic:stop_reason']).toBe(
      'end_turn',
    );

    // 2. Grok's X Search and web tool counts are normalized and persisted.
    expect(results['grok-combined']?.usage?.server_tool_search_requests).toBe(
      9,
    );
    expect(
      results['grok-combined']?.provider_meta?.['librarium:server_tool_usage'],
    ).toEqual({
      web_search_calls: 6,
      x_search_calls: 3,
      x_posts_fetched: 9,
      x_users_fetched: 1,
      code_interpreter_calls: 0,
    });

    // 5. A JSON outputSchema result is JSON, not Markdown.
    expect(results.parallel).toMatchObject({
      content_format: 'json',
      content: { providers: ['a', 'b', 'c', 'd', 'e'] },
    });
    // The fixed processor price is a labeled estimate: core is $25/1k runs.
    expect(results.parallel?.usage).toEqual({
      estimated_cost: '0.025',
      currency: 'USD',
    });

    // 4. Background duration spans submission to observed completion
    // (two 60 s poll intervals), with the retrieval time kept apart.
    expect(results.parallel?.provider_meta?.['librarium:duration_ms']).toBe(
      120_000,
    );
    expect(
      results.parallel?.provider_meta?.['librarium:retrieval_duration_ms'],
    ).toBeTypeOf('number');

    // 1 and 3. `librarium usage` lists every result, keeps reported cost,
    // estimates, and unknown cost apart, and shows X usage.
    const usage = aggregateUsage(root);
    const rows = Object.fromEntries(
      usage.providers.map((row) => [row.provider, row]),
    );
    expect(rows.claude).toMatchObject({
      costUsd: null,
      reportedCost: false,
      estimatedCostUsd: null,
      hasEstimate: false,
      unknownCostRuns: 1,
      searchRequests: 5,
    });
    expect(rows['gemini-grounded']).toMatchObject({
      costUsd: null,
      hasEstimate: true,
      unknownCostRuns: 0,
    });
    expect(rows['gemini-grounded']?.estimatedCostUsd).toBeCloseTo(0.064473);
    expect(rows['parallel-research']).toMatchObject({
      costUsd: null,
      hasEstimate: true,
      runCount: 1,
    });
    expect(rows['grok-combined']).toMatchObject({
      reportedCost: true,
      serverToolUsage: expect.objectContaining({ x_posts_fetched: 9 }),
    });
    expect(rows['grok-combined']?.costUsd).toBeCloseTo(0.74184);
    expect(usage.unknownCostResults).toBe(1);
  });
});
