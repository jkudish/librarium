import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ResearchResponseSchema,
  ResearchResultSchema,
  ResultProvenanceSchema,
  SourceSchema,
  UsageSchema,
} from '../src/contracts/interchange/index.js';

const root = join(process.cwd(), 'contracts', 'v1');
const read = <T>(path: string): T =>
  JSON.parse(readFileSync(join(root, path), 'utf8')) as T;

describe('terminal interchange schemas', () => {
  const index = read<{
    fixtures: Array<{ id: string; path: string; valid: boolean }>;
  }>('fixtures/index.json');

  it.each(index.fixtures.filter((fixture) => fixture.valid))(
    'accepts %s',
    ({ id, path }) => {
      expect(ResearchResponseSchema.safeParse(read(path)).success, id).toBe(
        true,
      );
    },
  );

  it.each(index.fixtures.filter((fixture) => !fixture.valid))(
    'rejects %s',
    ({ id, path }) => {
      expect(ResearchResponseSchema.safeParse(read(path)).success, id).toBe(
        false,
      );
    },
  );

  it('has exactly the three terminal status shapes', () => {
    const valid = (
      status: 'succeeded' | 'partial' | 'failed',
      results: unknown[],
      errors: unknown[],
    ) =>
      ResearchResponseSchema.safeParse({
        generator: 'jkudish/librarium',
        generator_version: '1.0.0',
        request_id: 'request-1',
        status,
        completed_at: '2026-08-09T12:00:02Z',
        results,
        errors,
      }).success;
    const error = { code: 'provider.failed', message: 'No result' };
    const result = read<Record<string, unknown>>(
      'fixtures/valid/markdown-success.json',
    ).results as unknown[];
    expect(valid('succeeded', result, [])).toBe(true);
    expect(valid('partial', result, [error])).toBe(true);
    expect(valid('failed', [], [error])).toBe(true);
    expect(valid('succeeded', [], [])).toBe(false);
    expect(valid('partial', result, [])).toBe(false);
    expect(valid('failed', result, [error])).toBe(false);
  });

  it('keeps embedded sources, provenance, usage, and metadata constrained to the terminal shape', () => {
    expect(
      SourceSchema.safeParse({ kind: 'web_page', url: 'https://example.com' })
        .success,
    ).toBe(true);
    expect(SourceSchema.safeParse({ kind: 'web_page' }).success).toBe(false);
    expect(
      ResultProvenanceSchema.safeParse({
        result_kind: 'model_answer',
        retrieval_methods: [],
        corpora: [],
        observed_at: '2026-08-09T12:00:00Z',
        surface: 'google',
      }).success,
    ).toBe(false);
    expect(UsageSchema.safeParse({ actual_cost: '0.1' }).success).toBe(false);
    expect(
      UsageSchema.safeParse({ actual_cost: '0.1', currency: 'USD' }).success,
    ).toBe(true);
    const providerMeta = read<Record<string, any>>(
      'fixtures/valid/provider-meta-namespaces.json',
    ).results[0].provider_meta;
    expect(
      ResearchResultSchema.safeParse({
        ...read<Record<string, any>>('fixtures/valid/markdown-success.json')
          .results[0],
        provider_meta: providerMeta,
      }).success,
    ).toBe(true);
    expect(providerMeta['com.example:public'].CamelCase).toBe('kept');
    expect(providerMeta['io.other:metrics'].large).toHaveLength(17_000);
    const baseResult = read<Record<string, any>>(
      'fixtures/valid/markdown-success.json',
    ).results[0];
    for (const providerMeta of [
      { 'com.example:public': { nested: { Authorization: 'Bearer x' } } },
      { 'com.example:public': { password: 'x' } },
      { 'com.example:public': { sessionToken: 'x' } },
      { 'com.example:public': { binary_payload: 'x' } },
      { 'com.example:public': { openaiapikey: 'x' } },
      { 'com.example:public': { githubaccesstoken: 'x' } },
      { 'com.example:public': { providerrawresponse: 'x' } },
      { 'com.example:public': { openaiApiKeyValue: 'x' } },
      { 'com.example:public': { credentialsBlob: 'x' } },
      { 'com.example:public': { providerRawResponseData: 'x' } },
      { 'com.example:public': { vendorSessionTokenValue: 'x' } },
      { 'com.example:public': { binaryPayloadData: 'x' } },
      { 'com.example:public': { openaiapikeyvalue: 'x' } },
      { 'com.example:public': { vendorsessiontokenvalue: 'x' } },
      { 'com.example:public': { prompttokenvalue: 'x' } },
      { 'com.example:public': { tokenResponseData: 'x' } },
      { 'com.example:public': { cookieJar: 'x' } },
      { 'com.example:openaiApiKeyValue': 'x' },
      {
        'com.example:public': {
          response: { headers: { 'x-request-id': '1' }, status: 200 },
        },
      },
    ]) {
      expect(
        ResearchResultSchema.safeParse({
          ...baseResult,
          provider_meta: providerMeta,
        }).success,
      ).toBe(false);
    }
    for (const key of [
      'prompt_tokens',
      'token_count',
      'binary_classifier',
      'session_tokens_count',
      'secret_count',
      'password_policy',
      'credentials_guide_url',
    ]) {
      expect(
        ResearchResultSchema.safeParse({
          ...baseResult,
          provider_meta: {
            'com.example:public': { [key]: 'public-metadata' },
          },
        }).success,
        key,
      ).toBe(true);
    }
    expect(
      index.fixtures
        .filter((fixture) =>
          fixture.id.startsWith('surface-context-authentication-'),
        )
        .map((fixture) =>
          fixture.id.replace('surface-context-authentication-', ''),
        )
        .sort(),
    ).toEqual(['anonymous', 'authenticated', 'managed', 'unknown']);
  });

  it('covers every closed terminal enum branch in one compact fixture', () => {
    const coverage = read<Record<string, any>>(
      'fixtures/valid/enum-branch-coverage.json',
    );
    const sources = coverage.results[0].citations.map(
      (citation: Record<string, any>) => citation.source,
    );
    const citations = coverage.results.flatMap(
      (result: Record<string, any>) => result.citations,
    );
    const provenance = coverage.results.map(
      (result: Record<string, any>) => result.provenance,
    );

    expect(
      sources.map((source: Record<string, any>) => source.kind).sort(),
    ).toEqual([
      'file',
      'forum_post',
      'news_article',
      'place',
      'unknown',
      'video',
      'web_page',
      'x_post',
    ]);
    expect(
      [
        ...new Set(
          citations.map((citation: Record<string, any>) => citation.derivation),
        ),
      ].sort(),
    ).toEqual([
      'collector_extracted',
      'librarium_inferred',
      'provider_reported',
    ]);
    expect(
      provenance.map((entry: Record<string, any>) => entry.result_kind).sort(),
    ).toEqual([
      'grounded_answer',
      'model_answer',
      'research_report',
      'search_results',
      'surface_observation',
    ]);
    expect(provenance[0].retrieval_methods).toEqual([
      'search_endpoint',
      'model_search_tool',
      'research_agent',
      'model_only',
    ]);
    expect(provenance[0].corpora).toEqual([
      'web',
      'news',
      'x',
      'files',
      'places',
    ]);
    expect(provenance[4]).toMatchObject({
      result_kind: 'surface_observation',
      retrieval_methods: ['surface_collector'],
      observation_mode: 'surface_snapshot',
      collector: 'searchapi',
      surface: 'chatgpt',
      context: {
        authentication: 'unknown',
        personalization: 'unknown',
      },
    });
  });
});
