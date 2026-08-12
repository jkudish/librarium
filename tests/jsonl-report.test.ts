import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateJsonlReport } from '../src/commands/jsonl-report.js';
import {
  writeJsonlReport,
  writeJsonlReportFromSnapshot,
} from '../src/commands/jsonl-report-v2.js';
import { RunArtifactRepository } from '../src/node-run-artifacts.js';
import type {
  DeduplicatedSource,
  ProviderReport,
  RunManifest,
} from '../src/types.js';

function makeReport(overrides: Partial<ProviderReport> = {}): ProviderReport {
  return {
    id: 'exa',
    tier: 'ai-grounded',
    status: 'success',
    durationMs: 1800,
    wordCount: 100,
    citationCount: 25,
    outputFile: 'exa.md',
    metaFile: 'exa.meta.json',
    ...overrides,
  };
}

function makeManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: 2,
    revision: 0,
    status: 'completed',
    timestamp: 1_781_136_000,
    slug: 'postgres-pooling',
    query: 'postgres pooling best practices',
    mode: 'mixed',
    outputDir: '/tmp/x',
    providers: [makeReport()],
    sources: { total: 25, unique: 20, file: 'sources.json' },
    exitCode: 0,
    ...overrides,
  };
}

const SOURCES: DeduplicatedSource[] = [
  {
    url: 'https://example.com/pgbouncer',
    normalizedUrl: 'example.com/pgbouncer',
    title: 'PgBouncer docs',
    providers: ['exa', 'brave-search'],
    citationCount: 3,
  },
];

/** Parse all lines of a JSONL string, asserting each parses independently. */
function parseLines(jsonl: string): unknown[] {
  return jsonl.split('\n').map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Line ${i} failed JSON.parse: ${line}`);
    }
  });
}

describe('generateJsonlReport -- each line parses independently', () => {
  it('produces one run line + N result lines + M source lines', () => {
    const manifest = makeManifest({
      providers: [
        makeReport(),
        makeReport({ id: 'brave-search', tier: 'raw-search' }),
      ],
    });
    const jsonl = generateJsonlReport({
      manifest,
      providerContents: {},
      sources: SOURCES,
    });
    const lines = parseLines(jsonl);
    // 1 run + 2 result + 1 source
    expect(lines).toHaveLength(4);
    expect((lines[0] as { type: string }).type).toBe('run');
    expect((lines[1] as { type: string }).type).toBe('result');
    expect((lines[2] as { type: string }).type).toBe('result');
    expect((lines[3] as { type: string }).type).toBe('source');
  });

  it('run header has correct version and counts', () => {
    const manifest = makeManifest({
      providers: [
        makeReport({ status: 'success' }),
        makeReport({ id: 'b', status: 'error', error: 'oops' }),
        makeReport({
          id: 'c',
          tier: 'deep-research',
          status: 'async-pending',
          outputFile: '',
          metaFile: '',
        }),
      ],
    });
    const jsonl = generateJsonlReport({
      manifest,
      providerContents: {},
      sources: [],
    });
    const [run] = parseLines(jsonl) as [
      { version: number; succeeded: number; failed: number; pending: number },
    ];
    expect(run.version).toBe(1);
    expect(run.succeeded).toBe(1);
    expect(run.failed).toBe(1);
    expect(run.pending).toBe(1);
  });

  it('run header includes uniqueSources and totalCitations from manifest', () => {
    const jsonl = generateJsonlReport({
      manifest: makeManifest(),
      providerContents: {},
      sources: [],
    });
    const [run] = parseLines(jsonl) as [
      { uniqueSources: number; totalCitations: number },
    ];
    expect(run.uniqueSources).toBe(20);
    expect(run.totalCitations).toBe(25);
  });

  it('includes refinedQueries when present', () => {
    const manifest = makeManifest({
      refinedQueries: {
        'deep-research': 'deep variant',
        'raw-search': 'keyword variant',
      },
    });
    const jsonl = generateJsonlReport({
      manifest,
      providerContents: {},
      sources: [],
    });
    const [run] = parseLines(jsonl) as [{ refinedQueries?: unknown }];
    expect(run.refinedQueries).toEqual({
      'deep-research': 'deep variant',
      'raw-search': 'keyword variant',
    });
  });

  it('omits refinedQueries key entirely when not in manifest', () => {
    const manifest = makeManifest();
    delete manifest.refinedQueries;
    const jsonl = generateJsonlReport({
      manifest,
      providerContents: {},
      sources: [],
    });
    const [run] = parseLines(jsonl) as [Record<string, unknown>];
    expect('refinedQueries' in run).toBe(false);
  });

  it('embeds full content string including newlines and quotes', () => {
    const content = 'line one\nline "two"\nline three';
    const jsonl = generateJsonlReport({
      manifest: makeManifest(),
      providerContents: { 'exa.md': content },
      sources: [],
    });
    const lines = parseLines(jsonl) as Array<{
      type: string;
      content?: string | null;
    }>;
    const resultLine = lines.find((l) => l.type === 'result');
    expect(resultLine?.content).toBe(content);
  });

  it('emits the full claim verification matrix as a separate structured line', () => {
    const manifest = makeManifest({
      verification: {
        status: 'partial',
        matrixFile: 'verification.json',
        matrix: [
          {
            id: 'claim-1',
            claim: 'The release was published in 2025.',
            category: 'date',
            status: 'supported',
            sourceUrls: ['https://example.com/release'],
          },
        ],
        followUps: [
          {
            claimId: 'claim-1',
            query: 'release primary source evidence',
            sourceUrls: ['https://example.com/release'],
            attempts: [
              {
                provider: 'exa',
                tier: 'ai-grounded',
                status: 'success',
                durationMs: 12,
                sourceUrls: ['https://example.com/release'],
                usage: { costUsd: 0.004, totalTokens: 10 },
                metering: { kind: 'native_cost' },
              },
            ],
          },
        ],
        reasons: ['insufficient independent evidence for one or more claims'],
        usage: {
          providerAttempts: 1,
          successfulProviderAttempts: 1,
          reportedCostUsd: 0.006,
          reportedCostIsLowerBound: false,
          estimatedCostUsd: 0.01,
          estimatedCostIsLowerBound: true,
          llmCalls: 1,
          successfulLlmCalls: 1,
          provider: {
            totalTokens: 10,
            tokenCountsAreLowerBound: true,
            reportedCostUsd: 0.004,
            reportedCostIsLowerBound: false,
            estimatedCostUsd: 0.01,
            estimatedCostIsLowerBound: false,
          },
          llm: {
            inputTokens: 20,
            outputTokens: 5,
            totalTokens: 25,
            tokenCountsAreLowerBound: false,
            reportedCostUsd: 0.002,
            reportedCostIsLowerBound: false,
            estimatedCostUsd: 0,
            estimatedCostIsLowerBound: true,
          },
        },
        llm: [
          {
            stage: 'claims',
            provider: 'openai',
            model: 'gpt-5-mini',
            status: 'success',
            durationMs: 20,
            usage: {
              inputTokens: 20,
              outputTokens: 5,
              totalTokens: 25,
              costUsd: 0.002,
            },
            metering: { kind: 'native_cost' },
          },
        ],
        revised: false,
      },
    });
    const lines = parseLines(
      generateJsonlReport({ manifest, providerContents: {}, sources: [] }),
    ) as Array<{
      type: string;
      verification?: {
        matrix?: unknown[];
        followUps?: unknown[];
        llm?: unknown[];
        usage?: Record<string, unknown>;
      };
    }>;
    const verification = lines.find((line) => line.type === 'verification');
    expect(verification?.verification?.matrix).toHaveLength(1);
    expect(verification?.verification?.followUps).toHaveLength(1);
    expect(verification?.verification?.llm).toHaveLength(1);
    expect(verification?.verification?.usage).toMatchObject({
      reportedCostUsd: 0.006,
      llmCalls: 1,
      successfulLlmCalls: 1,
      llm: { totalTokens: 25, reportedCostUsd: 0.002 },
    });
  });

  it('sets content to null for pending providers', () => {
    const manifest = makeManifest({
      providers: [
        makeReport({
          id: 'openai-deep',
          tier: 'deep-research',
          status: 'async-pending',
          outputFile: '',
          metaFile: '',
        }),
      ],
    });
    const jsonl = generateJsonlReport({
      manifest,
      providerContents: {},
      sources: [],
    });
    const lines = parseLines(jsonl) as Array<{
      type: string;
      content?: string | null;
    }>;
    const resultLine = lines.find((l) => l.type === 'result');
    expect(resultLine?.content).toBeNull();
  });

  it('sets content to null when outputFile present but content not in providerContents', () => {
    const jsonl = generateJsonlReport({
      manifest: makeManifest(),
      providerContents: {},
      sources: [],
    });
    const lines = parseLines(jsonl) as Array<{
      type: string;
      content?: string | null;
    }>;
    const resultLine = lines.find((l) => l.type === 'result');
    expect(resultLine?.content).toBeNull();
  });

  it('omits undefined keys from result lines (error, fallbackFor, usage)', () => {
    const jsonl = generateJsonlReport({
      manifest: makeManifest({ providers: [makeReport()] }),
      providerContents: {},
      sources: [],
    });
    const lines = parseLines(jsonl) as Array<Record<string, unknown>>;
    const resultLine = lines.find((l) => l.type === 'result') as Record<
      string,
      unknown
    >;
    expect('error' in resultLine).toBe(false);
    expect('fallbackFor' in resultLine).toBe(false);
    expect('usage' in resultLine).toBe(false);
  });

  it('includes error when present on result line', () => {
    const manifest = makeManifest({
      providers: [makeReport({ status: 'error', error: 'HTTP 429' })],
    });
    const jsonl = generateJsonlReport({
      manifest,
      providerContents: {},
      sources: [],
    });
    const lines = parseLines(jsonl) as Array<{ type: string; error?: string }>;
    const resultLine = lines.find((l) => l.type === 'result');
    expect(resultLine?.error).toBe('HTTP 429');
  });

  it('includes fallbackFor when present on result line', () => {
    const manifest = makeManifest({
      providers: [makeReport({ fallbackFor: 'openai-deep' })],
    });
    const jsonl = generateJsonlReport({
      manifest,
      providerContents: {},
      sources: [],
    });
    const lines = parseLines(jsonl) as Array<{
      type: string;
      fallbackFor?: string;
    }>;
    const resultLine = lines.find((l) => l.type === 'result');
    expect(resultLine?.fallbackFor).toBe('openai-deep');
  });

  it('includes usage when present on result line', () => {
    const manifest = makeManifest({
      providers: [makeReport({ usage: { costUsd: 0.012, inputTokens: 500 } })],
    });
    const jsonl = generateJsonlReport({
      manifest,
      providerContents: {},
      sources: [],
    });
    const lines = parseLines(jsonl) as Array<{ type: string; usage?: unknown }>;
    const resultLine = lines.find((l) => l.type === 'result');
    expect(resultLine?.usage).toEqual({ costUsd: 0.012, inputTokens: 500 });
  });

  it('includes metering when present on result line', () => {
    const manifest = makeManifest({
      providers: [
        makeReport({
          metering: {
            kind: 'request_priced',
            pricingVersion: '2026-06',
            estimate: {
              estimatedCostUsd: 0.015,
              billableUnits: 1,
              unit: 'request',
              costConfidence: 'estimated',
            },
          },
        }),
      ],
    });
    const jsonl = generateJsonlReport({
      manifest,
      providerContents: {},
      sources: [],
    });
    const lines = parseLines(jsonl) as Array<{
      type: string;
      metering?: { kind?: string; estimate?: { estimatedCostUsd?: number } };
    }>;
    const resultLine = lines.find((l) => l.type === 'result');
    expect(resultLine?.metering?.kind).toBe('request_priced');
    expect(resultLine?.metering?.estimate?.estimatedCostUsd).toBe(0.015);
  });

  it('emits source lines with correct fields', () => {
    const jsonl = generateJsonlReport({
      manifest: makeManifest(),
      providerContents: {},
      sources: SOURCES,
    });
    const lines = parseLines(jsonl) as Array<{
      type: string;
      url?: string;
      title?: string;
      providers?: string[];
      citationCount?: number;
    }>;
    const sourceLine = lines.find((l) => l.type === 'source');
    expect(sourceLine?.url).toBe('https://example.com/pgbouncer');
    expect(sourceLine?.title).toBe('PgBouncer docs');
    expect(sourceLine?.providers).toEqual(['exa', 'brave-search']);
    expect(sourceLine?.citationCount).toBe(3);
  });

  it('omits title key from source line when title is undefined', () => {
    const sources: DeduplicatedSource[] = [
      {
        url: 'https://example.com',
        normalizedUrl: 'example.com',
        providers: ['exa'],
        citationCount: 1,
      },
    ];
    const jsonl = generateJsonlReport({
      manifest: makeManifest(),
      providerContents: {},
      sources,
    });
    const lines = parseLines(jsonl) as Array<Record<string, unknown>>;
    const sourceLine = lines.find((l) => l.type === 'source');
    expect(sourceLine).toBeDefined();
    expect('title' in (sourceLine as Record<string, unknown>)).toBe(false);
  });

  it('produces no trailing blank line (no empty last line)', () => {
    const jsonl = generateJsonlReport({
      manifest: makeManifest(),
      providerContents: {},
      sources: SOURCES,
    });
    expect(jsonl.endsWith('\n')).toBe(false);
    const lines = jsonl.split('\n');
    expect(lines.at(-1)).not.toBe('');
  });

  it('contains no em-dashes in output', () => {
    const jsonl = generateJsonlReport({
      manifest: makeManifest(),
      providerContents: { 'exa.md': 'some content' },
      sources: SOURCES,
    });
    expect(jsonl).not.toContain('—');
  });

  it('emits an answer line right after the run header when answer present', () => {
    const jsonl = generateJsonlReport({
      manifest: makeManifest(),
      providerContents: {},
      sources: SOURCES,
      answer: {
        content: '# q\n\nThe answer is 42 [1].',
        provider: 'openai',
        model: 'gpt-5-mini',
      },
    });
    const lines = parseLines(jsonl) as Array<{
      type: string;
      provider?: string;
      model?: string;
      content?: string;
    }>;
    expect(lines[0]?.type).toBe('run');
    expect(lines[1]?.type).toBe('answer');
    expect(lines[1]?.provider).toBe('openai');
    expect(lines[1]?.model).toBe('gpt-5-mini');
    expect(lines[1]?.content).toContain('The answer is 42');
    // result/source lines still follow the answer line.
    expect(lines[2]?.type).toBe('result');
  });

  it('omits the answer line when no answer is provided', () => {
    const jsonl = generateJsonlReport({
      manifest: makeManifest(),
      providerContents: {},
      sources: SOURCES,
    });
    const lines = parseLines(jsonl) as Array<{ type: string }>;
    expect(lines.some((l) => l.type === 'answer')).toBe(false);
  });

  it('omits the answer line when answer content is blank', () => {
    const jsonl = generateJsonlReport({
      manifest: makeManifest(),
      providerContents: {},
      sources: SOURCES,
      answer: { content: '   \n  ', provider: 'openai', model: 'gpt-5-mini' },
    });
    const lines = parseLines(jsonl) as Array<{ type: string }>;
    expect(lines.some((l) => l.type === 'answer')).toBe(false);
  });

  it('omits provider/model keys from the answer line when not recorded', () => {
    const jsonl = generateJsonlReport({
      manifest: makeManifest(),
      providerContents: {},
      sources: [],
      answer: { content: 'grounded answer' },
    });
    const lines = parseLines(jsonl) as Array<Record<string, unknown>>;
    const answerLine = lines.find((l) => l.type === 'answer') as Record<
      string,
      unknown
    >;
    expect(answerLine).toBeDefined();
    expect('provider' in answerLine).toBe(false);
    expect('model' in answerLine).toBe(false);
    expect(answerLine.content).toBe('grounded answer');
  });
});

describe('writeJsonlReport', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `librarium-jsonl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null without a run manifest', () => {
    expect(writeJsonlReport(dir)).toBeNull();
  });

  it('writes results.jsonl from run.json, provider files, and sources.json', () => {
    writeFileSync(join(dir, 'run.json'), JSON.stringify(makeManifest()));
    writeFileSync(join(dir, 'exa.md'), '# Exa findings\n\nhello world');
    writeFileSync(join(dir, 'sources.json'), JSON.stringify(SOURCES));

    const reportPath = writeJsonlReport(dir);
    expect(reportPath).toBe(join(realpathSync(dir), 'results.jsonl'));

    const text = readFileSync(reportPath as string, 'utf-8');
    const lines = parseLines(text) as Array<Record<string, unknown>>;

    const runLine = lines.find((l) => l.type === 'run');
    const resultLine = lines.find((l) => l.type === 'result');
    const sourceLine = lines.find((l) => l.type === 'source');

    expect(runLine?.query).toBe('postgres pooling best practices');
    expect(resultLine?.content).toContain('Exa findings');
    expect(sourceLine?.url).toBe('https://example.com/pgbouncer');
  });

  it('picks up answer.md and run.json answer metadata automatically', () => {
    const manifest = makeManifest({
      answer: { provider: 'gemini', model: 'gemini-2.5-flash' },
    });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'exa.md'), '# Exa findings\n\nhello');
    writeFileSync(join(dir, 'sources.json'), JSON.stringify(SOURCES));
    writeFileSync(
      join(dir, 'answer.md'),
      '# postgres pooling best practices\n\nUse PgBouncer [1].\n',
    );

    const reportPath = writeJsonlReport(dir) as string;
    const lines = parseLines(readFileSync(reportPath, 'utf-8')) as Array<{
      type: string;
      provider?: string;
      model?: string;
      content?: string;
    }>;
    const answerLine = lines.find((l) => l.type === 'answer');
    expect(answerLine?.provider).toBe('gemini');
    expect(answerLine?.model).toBe('gemini-2.5-flash');
    expect(answerLine?.content).toContain('Use PgBouncer');
  });

  it('writes a recovery snapshot without changing durable pending state', () => {
    const providerId = 'constructor';
    const manifest = makeManifest({
      providers: [
        makeReport({
          id: providerId,
          tier: 'deep-research',
          status: 'async-pending',
          outputFile: '',
          metaFile: '',
          durationMs: 0,
          citationCount: 0,
          task: { taskId: 'opaque-task', submittedAt: 1, status: 'completed' },
        }),
      ],
    });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest));
    writeFileSync(
      join(dir, 'constructor.md'),
      '# Deep findings\n\nretrieved content',
    );
    writeFileSync(
      join(dir, 'constructor.meta.json'),
      JSON.stringify({
        provider: providerId,
        durationMs: 95_000,
        citationCount: 14,
        citations: Array.from({ length: 14 }, (_, index) => ({
          provider: providerId,
          url: `https://example.test/jsonl-${index}`,
        })),
      }),
    );

    const before = readFileSync(join(dir, 'run.json'), 'utf-8');
    const repository = new RunArtifactRepository();
    const snapshot = repository.readSnapshot(dir, { view: 'recovery' });
    expect(snapshot.manifest.providers[0]?.status).toBe('async-pending');
    expect(snapshot.reports[0]?.status).toBe('success');
    expect(Object.hasOwn(snapshot.providerArtifacts, providerId)).toBe(true);

    const reportPath = writeJsonlReportFromSnapshot(snapshot, repository);
    const text = readFileSync(reportPath, 'utf-8');
    const lines = parseLines(text) as Array<Record<string, unknown>>;
    const resultLine = lines.find((l) => l.type === 'result') as Record<
      string,
      unknown
    >;

    expect(resultLine?.status).toBe('success');
    expect(resultLine?.id).toBe(providerId);
    expect(resultLine?.content).toContain('Deep findings');
    expect(readFileSync(join(dir, 'run.json'), 'utf-8')).toBe(before);
  });
});
