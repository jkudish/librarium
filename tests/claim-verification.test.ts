import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProvider } from '../src/adapters/index.js';
import {
  MAX_VERIFICATION_ATTEMPTS,
  MAX_VERIFICATION_CLAIMS,
  MAX_VERIFICATION_QUERIES,
  normalizeAssessment,
  selectMaterialClaims,
  verifyAnswer,
} from '../src/commands/claim-verification.js';
import type {
  Config,
  Provider,
  ProviderDispatchResult,
  ProviderResult,
} from '../src/types.js';

function config(
  providers: Config['providers'],
  overrides: Partial<Config['defaults']> = {},
): Config {
  return {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 6,
      timeout: 17,
      asyncTimeout: 1800,
      asyncPollInterval: 10,
      mode: 'mixed',
      llmWebSearch: true,
      ...overrides,
    },
    providers,
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
  };
}

function initialResult(provider = 'primary'): ProviderDispatchResult {
  return {
    provider,
    tier: 'ai-grounded',
    status: 'success',
    text: 'The release was published on 2025-01-01.',
    sourceUrls: ['https://initial.example/release'],
    citations: [
      {
        provider,
        url: 'https://initial.example/release',
        title: 'Release notes',
      },
    ],
    durationMs: 12,
  };
}

function provider(
  id: string,
  execute: Provider['execute'],
  tier: Provider['tier'] = 'ai-grounded',
): Provider {
  return {
    id,
    displayName: id,
    tier,
    execution: 'inline',
    envVar: `VERIFY_${id.toUpperCase()}_KEY`,
    execute,
  };
}

function successResult(id: string): ProviderResult {
  return {
    provider: id,
    tier: 'ai-grounded',
    content: 'Official evidence confirms the release date.',
    citations: [
      {
        provider: id,
        url: `https://${id}.example/evidence`,
        title: 'Official evidence',
      },
    ],
    durationMs: 9,
    usage: { costUsd: 0.004 },
  };
}

function llmResponses(...bodies: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const body = bodies.shift();
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(body) } }],
        }),
        { status: 200 },
      );
    }),
  );
}

const CLAIM = {
  id: 'claim-1',
  claim: 'The release was published on 2025-01-01.',
  category: 'date',
  material: true,
  externallyCheckable: true,
  explicitUncertainty: false,
};

describe('claim verification boundaries', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    delete process.env.GEMINI_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    process.env.VERIFY_PRIMARY_KEY = 'primary-key';
    process.env.VERIFY_FALLBACK_KEY = 'fallback-key';
    process.env.VERIFY_ALTERNATE_KEY = 'alternate-key';
    process.env.VERIFY_DEEP_KEY = 'deep-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.VERIFY_PRIMARY_KEY;
    delete process.env.VERIFY_FALLBACK_KEY;
    delete process.env.VERIFY_ALTERNATE_KEY;
    delete process.env.VERIFY_DEEP_KEY;
  });

  it('caps material claims at eight and excludes advice, framing, and explicit uncertainty', () => {
    const raw = [
      { ...CLAIM, claim: 'You should upgrade now.', category: 'comparison' },
      { ...CLAIM, claim: 'The release may be delayed.', category: 'date' },
      ...Array.from({ length: 10 }, (_, index) => ({
        ...CLAIM,
        id: `claim-${index}`,
        claim: `The release date was 2025-01-${String(index + 1).padStart(2, '0')}.`,
      })),
      { ...CLAIM, claim: 'This is a helpful overview.', category: 'advice' },
    ];
    const selected = selectMaterialClaims(raw);
    expect(selected).toHaveLength(MAX_VERIFICATION_CLAIMS);
    expect(selected.map((claim) => claim.claim)).not.toContain(
      'You should upgrade now.',
    );
    expect(selected.map((claim) => claim.claim)).not.toContain(
      'The release may be delayed.',
    );
  });

  it('keeps modal claims with active verbs checkable while excluding hedges', () => {
    const selected = selectMaterialClaims([
      {
        ...CLAIM,
        claim: 'TLS 1.3 servers may require SNI.',
        category: 'compatibility',
      },
      {
        ...CLAIM,
        claim: 'Clients could negotiate the extension since v2.',
        category: 'compatibility',
      },
      {
        ...CLAIM,
        claim: 'The maintainers might have merged the fix already.',
        category: 'date',
      },
      {
        ...CLAIM,
        claim: 'The date is reportedly 2025-03-01.',
        category: 'date',
      },
      {
        ...CLAIM,
        claim: 'The rollout may be postponed.',
        category: 'date',
      },
      {
        ...CLAIM,
        claim: 'The launch might well be delayed again.',
        category: 'date',
      },
      {
        ...CLAIM,
        claim: 'The cutoff is apparently 2025-06-01.',
        category: 'date',
      },
    ]);
    expect(selected.map((claim) => claim.claim)).toEqual([
      'TLS 1.3 servers may require SNI.',
      'Clients could negotiate the extension since v2.',
    ]);
  });

  it('assigns deterministic unique ids regardless of duplicate or adversarial model ids', () => {
    const selected = selectMaterialClaims([
      { ...CLAIM, id: 'claim-2' },
      {
        ...CLAIM,
        id: 'claim-1',
        claim: 'The API supports two regions.',
        category: 'number',
      },
      {
        ...CLAIM,
        id: 'claim-1',
        claim: 'The API is compatible with v2.',
        category: 'compatibility',
      },
    ]);

    expect(selected.map((claim) => claim.id)).toEqual([
      'claim-1',
      'claim-2',
      'claim-3',
    ]);
    const matrix = normalizeAssessment(
      selected,
      {
        assessments: [
          {
            id: 'claim-2',
            status: 'supported',
            sourceUrls: ['https://two.example'],
          },
        ],
      },
      new Set(['https://two.example']),
    );
    expect(matrix.map((claim) => claim.status)).toEqual([
      'insufficient',
      'supported',
      'insufficient',
    ]);
  });

  it('never upgrades provider agreement without an independent source URL', () => {
    const claims = selectMaterialClaims([CLAIM]);
    expect(
      normalizeAssessment(
        claims,
        {
          assessments: [{ id: 'claim-1', status: 'supported', sourceUrls: [] }],
        },
        new Set(['https://initial.example/release']),
      )[0]?.status,
    ).toBe('insufficient');
  });

  it('normalizes supported, conflicting, and insufficient outcomes only', () => {
    const claims = selectMaterialClaims([
      CLAIM,
      {
        ...CLAIM,
        id: 'claim-2',
        claim: 'The API is compatible with v2.',
        category: 'compatibility',
      },
      {
        ...CLAIM,
        id: 'claim-3',
        claim: 'The change caused latency.',
        category: 'causal',
      },
    ]);
    const matrix = normalizeAssessment(
      claims,
      {
        assessments: [
          {
            id: 'claim-1',
            status: 'supported',
            sourceUrls: ['https://a.example'],
          },
          {
            id: 'claim-2',
            status: 'conflicting',
            sourceUrls: ['https://b.example'],
          },
          {
            id: 'claim-3',
            status: 'not-a-status',
            sourceUrls: ['https://c.example'],
          },
        ],
      },
      new Set(['https://a.example', 'https://b.example', 'https://c.example']),
    );
    expect(matrix.map((claim) => claim.status)).toEqual([
      'supported',
      'conflicting',
      'insufficient',
    ]);
  });

  it('assesses initial evidence before launching any follow-up and records actual LLM provider/model', async () => {
    const order: string[] = [];
    registerProvider(
      provider('primary', async (_query, options) => {
        order.push(`provider:${options.timeout}`);
        return successResult('primary');
      }),
    );
    llmResponses(
      { claims: [CLAIM] },
      {
        assessments: [
          { id: 'claim-1', status: 'insufficient', sourceUrls: [] },
        ],
      },
      {
        assessments: [
          {
            id: 'claim-1',
            status: 'supported',
            sourceUrls: ['https://primary.example/evidence'],
          },
        ],
      },
      'Revised answer [1].',
    );
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async () => {
      order.push('llm');
      const body = (
        fetchMock.mock.calls.length === 1
          ? { claims: [CLAIM] }
          : fetchMock.mock.calls.length === 2
            ? {
                assessments: [
                  { id: 'claim-1', status: 'insufficient', sourceUrls: [] },
                ],
              }
            : fetchMock.mock.calls.length === 3
              ? {
                  assessments: [
                    {
                      id: 'claim-1',
                      status: 'supported',
                      sourceUrls: ['https://primary.example/evidence'],
                    },
                  ],
                }
              : 'Revised answer [1].'
      ) as unknown;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: typeof body === 'string' ? body : JSON.stringify(body),
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const result = await verifyAnswer({
      query: 'release date',
      answer: 'The release was published on 2025-01-01 [1].',
      config: config({
        primary: { apiKey: '$VERIFY_PRIMARY_KEY', enabled: true },
      }),
      results: [initialResult()],
      reports: [],
      sources: [
        {
          url: 'https://initial.example/release',
          normalizedUrl: 'initial.example/release',
          providers: ['primary'],
          citationCount: 1,
        },
      ],
    });
    expect(order.indexOf('provider:17')).toBeGreaterThan(
      order.lastIndexOf('llm', 1),
    );
    expect(result.metadata.llm[0]).toMatchObject({
      stage: 'claims',
      provider: 'openai',
      model: 'gpt-5-mini',
      status: 'success',
    });
    expect(result.metadata.status).toBe('complete');
    expect(result.revisedAnswer).toBe('Revised answer [1].');
    expect(result.revision).toEqual({
      provider: 'openai',
      model: 'gpt-5-mini',
    });
  });

  it('uses fast fallback then alternates, excludes deep research, and caps attempts', async () => {
    const calls: string[] = [];
    registerProvider(
      provider('primary', async () => {
        calls.push('primary');
        throw new Error('transport down');
      }),
    );
    registerProvider(
      provider('fallback', async () => {
        calls.push('fallback');
        throw new Error('fallback down');
      }),
    );
    registerProvider(
      provider('alternate', async () => {
        calls.push('alternate');
        return successResult('alternate');
      }),
    );
    registerProvider(
      provider(
        'deep',
        async () => {
          calls.push('deep');
          return successResult('deep');
        },
        'deep-research',
      ),
    );
    llmResponses(
      { claims: [CLAIM] },
      {
        assessments: [
          { id: 'claim-1', status: 'insufficient', sourceUrls: [] },
        ],
      },
      {
        assessments: [
          {
            id: 'claim-1',
            status: 'supported',
            sourceUrls: ['https://alternate.example/evidence'],
          },
        ],
      },
      'Revised answer.',
    );
    const result = await verifyAnswer({
      query: 'release date',
      answer: 'The release was published on 2025-01-01.',
      config: config({
        primary: {
          apiKey: '$VERIFY_PRIMARY_KEY',
          enabled: true,
          fallback: 'fallback',
        },
        fallback: { apiKey: '$VERIFY_FALLBACK_KEY', enabled: false },
        alternate: { apiKey: '$VERIFY_ALTERNATE_KEY', enabled: true },
        deep: { apiKey: '$VERIFY_DEEP_KEY', enabled: true },
      }),
      results: [
        initialResult('primary'),
        initialResult('alternate'),
        { ...initialResult('deep'), tier: 'deep-research' },
      ],
      reports: [],
      sources: [],
    });
    expect(calls).toEqual(['primary', 'fallback', 'alternate']);
    expect(calls).not.toContain('deep');
    expect(result.metadata.followUps[0]?.attempts).toHaveLength(
      MAX_VERIFICATION_ATTEMPTS,
    );
    expect(result.metadata.followUps[0]?.attempts[2]?.sourceUrls).toEqual([
      'https://alternate.example/evidence',
    ]);
  });

  it('does not spend the evidence-query budget on transport failures', async () => {
    const calls: string[] = [];
    registerProvider(
      provider('primary', async (query) => {
        calls.push(query);
        if (!query.includes('4 regions')) throw new Error('network down');
        return successResult('primary');
      }),
    );
    const claims = Array.from({ length: 4 }, (_, index) => ({
      ...CLAIM,
      id: `claim-${index + 1}`,
      claim: `The API supports ${index + 1} regions.`,
      category: 'number',
    }));
    llmResponses(
      { claims },
      {
        assessments: claims.map((claim) => ({
          id: claim.id,
          status: 'insufficient',
          sourceUrls: [],
        })),
      },
      {
        assessments: claims.map((claim) => ({
          id: claim.id,
          status: claim.id === 'claim-4' ? 'supported' : 'insufficient',
          sourceUrls:
            claim.id === 'claim-4' ? ['https://primary.example/evidence'] : [],
        })),
      },
    );
    const result = await verifyAnswer({
      query: 'regions',
      answer: claims.map((claim) => claim.claim).join(' '),
      config: config({
        primary: { apiKey: '$VERIFY_PRIMARY_KEY', enabled: true },
      }),
      results: [initialResult()],
      reports: [],
      sources: [],
    });
    expect(calls).toHaveLength(4);
    expect(result.metadata.followUps).toHaveLength(4);
    expect(result.metadata.usage.successfulProviderAttempts).toBe(1);
  });

  it('caps successful evidence queries at three', async () => {
    const execute = vi.fn(async () => successResult('primary'));
    registerProvider(provider('primary', execute));
    const claims = Array.from({ length: 5 }, (_, index) => ({
      ...CLAIM,
      id: `claim-${index + 1}`,
      claim: `The API supports ${index + 1} regions.`,
      category: 'number',
    }));
    llmResponses(
      { claims },
      {
        assessments: claims.map((claim) => ({
          id: claim.id,
          status: 'insufficient',
          sourceUrls: [],
        })),
      },
      {
        assessments: claims.map((claim, index) => ({
          id: claim.id,
          status:
            index < MAX_VERIFICATION_QUERIES ? 'supported' : 'insufficient',
          sourceUrls:
            index < MAX_VERIFICATION_QUERIES
              ? ['https://primary.example/evidence']
              : [],
        })),
      },
    );
    const result = await verifyAnswer({
      query: 'regions',
      answer: claims.map((claim) => claim.claim).join(' '),
      config: config({
        primary: { apiKey: '$VERIFY_PRIMARY_KEY', enabled: true },
      }),
      results: [initialResult()],
      reports: [],
      sources: [],
    });
    expect(execute).toHaveBeenCalledTimes(MAX_VERIFICATION_QUERIES);
    expect(result.metadata.followUps).toHaveLength(MAX_VERIFICATION_QUERIES);
    expect(result.metadata.usage.successfulProviderAttempts).toBe(
      MAX_VERIFICATION_QUERIES,
    );
  });

  it('honors inherited reported and estimated cost ceilings and fails open', async () => {
    const execute = vi.fn(async () => successResult('primary'));
    registerProvider(provider('primary', execute));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await verifyAnswer({
      query: 'release',
      answer: 'The release was published on 2025-01-01.',
      config: config(
        { primary: { apiKey: '$VERIFY_PRIMARY_KEY', enabled: true } },
        { maxCostUsd: 0.01, maxEstimatedCostUsd: 0.01 },
      ),
      results: [initialResult()],
      reports: [
        {
          id: 'primary',
          tier: 'ai-grounded',
          status: 'success',
          durationMs: 1,
          wordCount: 1,
          citationCount: 1,
          outputFile: 'primary.md',
          metaFile: 'primary.meta.json',
          usage: { costUsd: 0.01 },
          metering: {
            kind: 'request_priced',
            estimate: { estimatedCostUsd: 0.01, costConfidence: 'estimated' },
          },
        },
      ],
      sources: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.metadata.status).toBe('incomplete');
    expect(result.revisedAnswer).toBeUndefined();
    expect(result.metadata.reasons).toContain(
      'verification budget exhausted before verification started',
    );
    expect(result.metadata.usage.llmCalls).toBe(0);
    expect(result.metadata.usage.providerAttempts).toBe(0);
  });

  it('makes no verification call when the inherited estimated ceiling alone is exhausted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyAnswer({
      query: 'release',
      answer: 'The release was published on 2025-01-01.',
      config: config({}, { maxEstimatedCostUsd: 0.02 }),
      results: [initialResult()],
      reports: [
        {
          id: 'primary',
          tier: 'ai-grounded',
          status: 'success',
          durationMs: 1,
          wordCount: 1,
          citationCount: 1,
          outputFile: 'primary.md',
          metaFile: 'primary.meta.json',
          metering: {
            kind: 'request_priced',
            estimate: {
              estimatedCostUsd: 0.02,
              costConfidence: 'estimated',
            },
          },
        },
      ],
      sources: [],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.metadata.status).toBe('incomplete');
    expect(result.metadata.usage).toMatchObject({
      providerAttempts: 0,
      llmCalls: 0,
      reportedCostUsd: 0,
      estimatedCostUsd: 0,
    });
  });

  it('checks the reported budget before every LLM cascade attempt', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'not-json' } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
              cost: 0.005,
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyAnswer({
      query: 'release',
      answer: 'The release was published on 2025-01-01.',
      config: config({}, { maxCostUsd: 0.01 }),
      results: [initialResult()],
      reports: [
        {
          id: 'primary',
          tier: 'ai-grounded',
          status: 'success',
          durationMs: 1,
          wordCount: 1,
          citationCount: 1,
          outputFile: 'primary.md',
          metaFile: 'primary.meta.json',
          usage: { costUsd: 0.005 },
        },
      ],
      sources: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.metadata.status).toBe('incomplete');
    expect(result.metadata.usage.llmCalls).toBe(1);
    expect(result.metadata.usage.llm?.reportedCostUsd).toBe(0.005);
    expect(result.metadata.llm[0]).toMatchObject({
      provider: 'openai',
      status: 'error',
      usage: { costUsd: 0.005, totalTokens: 12 },
    });
  });

  it('propagates the inherited seconds timeout to every LLM cascade attempt and stage', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    const execute = vi.fn(async () => successResult('primary'));
    registerProvider(provider('primary', execute));
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    let geminiCall = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('openai.com')) {
          return new Response(
            JSON.stringify({ error: { message: 'cascade' } }),
            { status: 500 },
          );
        }
        geminiCall++;
        const value =
          geminiCall === 1
            ? { claims: [CLAIM] }
            : geminiCall === 2
              ? {
                  assessments: [
                    { id: 'claim-1', status: 'insufficient', sourceUrls: [] },
                  ],
                }
              : geminiCall === 3
                ? {
                    assessments: [
                      {
                        id: 'claim-1',
                        status: 'supported',
                        sourceUrls: ['https://primary.example/evidence'],
                      },
                    ],
                  }
                : 'Revised answer.';
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text:
                        typeof value === 'string'
                          ? value
                          : JSON.stringify(value),
                    },
                  ],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 2,
              candidatesTokenCount: 1,
              totalTokenCount: 3,
            },
          }),
          { status: 200 },
        );
      }),
    );

    const result = await verifyAnswer({
      query: 'release',
      answer: 'The release was published on 2025-01-01.',
      config: config({
        primary: { apiKey: '$VERIFY_PRIMARY_KEY', enabled: true },
      }),
      results: [initialResult()],
      reports: [],
      sources: [],
    });

    expect(result.metadata.status).toBe('complete');
    expect(timeoutSpy).toHaveBeenCalledTimes(8);
    expect(timeoutSpy.mock.calls.every(([timeout]) => timeout === 17_000)).toBe(
      true,
    );
    expect(result.metadata.usage.llm).toMatchObject({
      inputTokens: 8,
      outputTokens: 4,
      totalTokens: 12,
    });
    expect(result.metadata.llm.map((call) => call.stage)).toEqual([
      'claims',
      'claims',
      'initial-assessment',
      'initial-assessment',
      'follow-up-assessment',
      'follow-up-assessment',
      'revision',
      'revision',
    ]);
  });

  it('persists normalized verification LLM usage and provider-reported cost separately', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.PERPLEXITY_API_KEY = 'perplexity-key';
    const responses = [
      {
        content: JSON.stringify({ claims: [CLAIM] }),
        input: 10,
        output: 5,
        cost: 0.001,
      },
      {
        content: JSON.stringify({
          assessments: [
            {
              id: 'claim-1',
              status: 'supported',
              sourceUrls: ['https://initial.example/release'],
            },
          ],
        }),
        input: 20,
        output: 10,
        cost: 0.002,
      },
      { content: 'Revised answer.', input: 30, output: 15, cost: 0.003 },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const next = responses.shift();
        if (!next) throw new Error('unexpected LLM call');
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: next.content } }],
            usage: {
              prompt_tokens: next.input,
              completion_tokens: next.output,
              total_tokens: next.input + next.output,
              cost: { total_cost: next.cost },
            },
          }),
          { status: 200 },
        );
      }),
    );
    const runConfig = config({});
    runConfig.answer = { provider: 'perplexity' };

    const result = await verifyAnswer({
      query: 'release',
      answer: 'The release was published on 2025-01-01.',
      config: runConfig,
      results: [initialResult()],
      reports: [],
      sources: [
        {
          url: 'https://initial.example/release',
          normalizedUrl: 'initial.example/release',
          providers: ['primary'],
          citationCount: 1,
        },
      ],
    });

    expect(result.metadata.usage).toMatchObject({
      providerAttempts: 0,
      successfulProviderAttempts: 0,
      llmCalls: 3,
      successfulLlmCalls: 3,
      reportedCostUsd: 0.006,
      reportedCostIsLowerBound: false,
      estimatedCostUsd: 0,
      estimatedCostIsLowerBound: true,
      llm: {
        inputTokens: 60,
        outputTokens: 30,
        totalTokens: 90,
        tokenCountsAreLowerBound: false,
        reportedCostUsd: 0.006,
        reportedCostIsLowerBound: false,
        estimatedCostUsd: 0,
        estimatedCostIsLowerBound: true,
      },
    });
    expect(result.metadata.llm.map((call) => call.usage?.costUsd)).toEqual([
      0.001, 0.002, 0.003,
    ]);
  });

  it('skips a follow-up before dispatch when its estimate would cross the budget', async () => {
    const execute = vi.fn(async () => successResult('serpapi'));
    registerProvider(provider('serpapi', execute, 'raw-search'));
    llmResponses(
      { claims: [CLAIM] },
      {
        assessments: [
          { id: 'claim-1', status: 'insufficient', sourceUrls: [] },
        ],
      },
    );
    const result = await verifyAnswer({
      query: 'release',
      answer: 'The release was published on 2025-01-01.',
      config: config(
        {
          serpapi: {
            apiKey: 'test-key',
            enabled: true,
            options: { perRequestUsd: 0.015 },
          },
        },
        { maxEstimatedCostUsd: 0.02 },
      ),
      results: [initialResult('serpapi')],
      reports: [
        {
          id: 'serpapi',
          tier: 'raw-search',
          status: 'success',
          durationMs: 1,
          wordCount: 1,
          citationCount: 1,
          outputFile: 'serpapi.md',
          metaFile: 'serpapi.meta.json',
          metering: {
            kind: 'request_priced',
            estimate: { estimatedCostUsd: 0.01, costConfidence: 'estimated' },
          },
        },
      ],
      sources: [],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.metadata.followUps[0]?.attempts[0]).toMatchObject({
      provider: 'serpapi',
      status: 'skipped',
      error: 'skipped: estimated cost budget reached',
    });
    expect(result.metadata.usage.estimatedCostUsd).toBe(0);
  });
});
