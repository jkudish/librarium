import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  enrichRetrievedReports,
  escapeHtml,
  generateHtmlReport,
  renderMarkdown,
  writeHtmlReport,
} from '../src/commands/html-report.js';
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
    version: 1,
    timestamp: 1_781_136_000,
    slug: 'postgres-pooling',
    query: 'postgres pooling best practices',
    mode: 'mixed',
    outputDir: '/tmp/x',
    providers: [makeReport()],
    sources: { total: 25, unique: 20, file: 'sources.json' },
    asyncTasks: [],
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

describe('escapeHtml', () => {
  it('escapes all special characters', () => {
    expect(escapeHtml(`<script>alert("x&'y")</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&amp;&#39;y&quot;)&lt;/script&gt;',
    );
  });
});

describe('renderMarkdown', () => {
  it('renders markdown but escapes raw HTML tokens', () => {
    const html = renderMarkdown(
      '# Title\n\n<script>alert(1)</script>\n\nSome **bold** text <img src=x onerror=alert(1)>.',
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img');
  });

  it('adds rel=noopener to links', () => {
    const html = renderMarkdown('[docs](https://example.com)');
    expect(html).toContain('rel="noopener"');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('>docs</a>');
  });
});

describe('generateHtmlReport', () => {
  it('uses the query as the escaped page title and heading', () => {
    const html = generateHtmlReport({
      manifest: makeManifest({ query: 'a <b>"query"</b>' }),
      providerContents: {},
      sources: [],
    });
    expect(html).toContain(
      '<title>a &lt;b&gt;&quot;query&quot;&lt;/b&gt;</title>',
    );
    expect(html).not.toContain('<title>a <b>');
  });

  it('renders one details block per provider with the table summary', () => {
    const manifest = makeManifest({
      providers: [
        makeReport(),
        makeReport({
          id: 'brave-search',
          tier: 'raw-search',
          status: 'error',
          error: 'HTTP 401',
          outputFile: 'brave-search.md',
        }),
      ],
    });
    const html = generateHtmlReport({
      manifest,
      providerContents: { 'exa.md': '# Findings\n\ncontent here' },
      sources: SOURCES,
    });
    expect(html.match(/<details class="provider">/g)).toHaveLength(2);
    expect(html).toContain('<span class="pid">exa</span>');
    expect(html).toContain('<span class="tier">ai-grounded</span>');
    expect(html).toContain('25 sources');
    expect(html).toContain('20 results'.replace('20 results', 'error'));
    expect(html).toContain('HTTP 401');
    expect(html).toContain('content here');
  });

  it('shows a pending note for async-pending providers', () => {
    const html = generateHtmlReport({
      manifest: makeManifest({
        providers: [
          makeReport({
            id: 'openai-deep',
            tier: 'deep-research',
            status: 'async-pending',
            outputFile: '',
            metaFile: '',
          }),
        ],
      }),
      providerContents: {},
      sources: [],
    });
    expect(html).toContain('submitted');
    expect(html).toContain('status --wait');
    expect(html).toContain('Result not retrieved yet');
  });

  it('escapes provider markdown so it cannot inject script', () => {
    const html = generateHtmlReport({
      manifest: makeManifest(),
      providerContents: { 'exa.md': '<script>window.x=1</script>' },
      sources: [],
    });
    expect(html).not.toContain('<script>window.x=1</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('lists deduped sources with provider attribution and noopener links', () => {
    const html = generateHtmlReport({
      manifest: makeManifest(),
      providerContents: {},
      sources: SOURCES,
    });
    expect(html).toContain('PgBouncer docs');
    expect(html).toContain('exa, brave-search');
    expect(html).toContain(
      '<a href="https://example.com/pgbouncer" rel="noopener" target="_blank">',
    );
  });

  it('marks fallback providers in the summary row', () => {
    const html = generateHtmlReport({
      manifest: makeManifest({
        providers: [makeReport({ fallbackFor: 'openai-deep' })],
      }),
      providerContents: {},
      sources: [],
    });
    expect(html).toContain('fallback for openai-deep');
  });

  it('contains no em-dashes in chrome text', () => {
    const html = generateHtmlReport({
      manifest: makeManifest(),
      providerContents: {},
      sources: SOURCES,
    });
    expect(html).not.toContain('—');
  });
});

describe('writeHtmlReport', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `librarium-html-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null without a run manifest', () => {
    expect(writeHtmlReport(dir)).toBeNull();
  });

  it('writes report.html from run.json, provider files, and sources.json', () => {
    writeFileSync(join(dir, 'run.json'), JSON.stringify(makeManifest()));
    writeFileSync(join(dir, 'exa.md'), '# Exa findings\n\nhello');
    writeFileSync(join(dir, 'sources.json'), JSON.stringify(SOURCES));

    const reportPath = writeHtmlReport(dir);
    expect(reportPath).toBe(join(dir, 'report.html'));
    const html = readFileSync(reportPath as string, 'utf-8');
    expect(html).toContain('Exa findings');
    expect(html).toContain('PgBouncer docs');
  });

  it('fills in retrieved results for reports still marked async-pending', () => {
    const manifest = makeManifest({
      providers: [
        makeReport({
          id: 'openai-deep',
          tier: 'deep-research',
          status: 'async-pending',
          outputFile: '',
          metaFile: '',
          durationMs: 0,
          citationCount: 0,
        }),
      ],
    });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'openai-deep.md'), '# Deep findings\n\nretrieved');
    writeFileSync(
      join(dir, 'openai-deep.meta.json'),
      JSON.stringify({ durationMs: 95_000, citationCount: 14 }),
    );

    const reportPath = writeHtmlReport(dir) as string;
    const html = readFileSync(reportPath, 'utf-8');
    expect(html).toContain('Deep findings');
    expect(html).toContain('14 sources');
    expect(html).not.toContain('Result not retrieved yet');
  });
});

describe('enrichRetrievedReports', () => {
  it('leaves pending reports untouched when no file exists', () => {
    const reports = [
      makeReport({
        status: 'async-pending',
        id: 'openai-deep',
        outputFile: '',
      }),
    ];
    const enriched = enrichRetrievedReports('/nonexistent-dir', reports);
    expect(enriched[0]?.status).toBe('async-pending');
  });
});
