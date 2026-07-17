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
    process.env.VERIFY_PRIMARY_KEY = 'primary-key';
    process.env.VERIFY_FALLBACK_KEY = 'fallback-key';
    process.env.VERIFY_ALTERNATE_KEY = 'alternate-key';
    process.env.VERIFY_DEEP_KEY = 'deep-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.OPENAI_API_KEY;
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
    expect(result.metadata.llm[0]).toEqual({
      stage: 'claims',
      provider: 'openai',
      model: 'gpt-5-mini',
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
  });

  it('does not spend the evidence-query budget on transport failures', async () => {
    const calls: string[] = [];
    registerProvider(
      provider('primary', async (query) => {
        calls.push(query);
        if (query.includes('2025-01-01')) throw new Error('network down');
        return successResult('primary');
      }),
    );
    const secondClaim = {
      ...CLAIM,
      id: 'claim-2',
      claim: 'The API supports 12 regions.',
      category: 'number',
    };
    llmResponses(
      { claims: [CLAIM, secondClaim] },
      {
        assessments: [
          { id: 'claim-1', status: 'insufficient', sourceUrls: [] },
          { id: 'claim-2', status: 'insufficient', sourceUrls: [] },
        ],
      },
      {
        assessments: [
          { id: 'claim-1', status: 'insufficient', sourceUrls: [] },
          {
            id: 'claim-2',
            status: 'supported',
            sourceUrls: ['https://primary.example/evidence'],
          },
        ],
      },
    );
    const result = await verifyAnswer({
      query: 'release',
      answer:
        'The release was published on 2025-01-01. The API supports 12 regions.',
      config: config({
        primary: { apiKey: '$VERIFY_PRIMARY_KEY', enabled: true },
      }),
      results: [initialResult()],
      reports: [],
      sources: [],
    });
    expect(calls).toHaveLength(2);
    expect(result.metadata.followUps).toHaveLength(2);
    expect(result.metadata.usage.successfulProviderAttempts).toBe(1);
    expect(MAX_VERIFICATION_QUERIES).toBe(3);
  });

  it('caps distinct targeted follow-up queries at three', async () => {
    registerProvider(
      provider('primary', async () => {
        throw new Error('transport down');
      }),
    );
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
    expect(result.metadata.followUps).toHaveLength(MAX_VERIFICATION_QUERIES);
  });

  it('honors inherited reported and estimated cost ceilings and fails open', async () => {
    const execute = vi.fn(async () => successResult('primary'));
    registerProvider(provider('primary', execute));
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
    expect(execute).not.toHaveBeenCalled();
    expect(result.metadata.status).toBe('partial');
    expect(result.revisedAnswer).toBeUndefined();
    expect(result.metadata.reasons).toContain('verification budget exhausted');
  });
});
