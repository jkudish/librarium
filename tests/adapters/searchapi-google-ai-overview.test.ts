import { describe, expect, it } from 'vitest';
import {
  SEARCHAPI_GOOGLE_AI_OVERVIEW_MAX_LOGICAL_OPERATIONS,
  SearchApiGoogleAiOverviewProvider,
} from '../../src/adapters/searchapi-google-ai-overview.js';
import type {
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
} from '../../src/core/http-client.js';
import {
  SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
  SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_TOKEN,
  searchApiGoogleAiOverviewFixtures,
} from '../fixtures/searchapi-google-ai-overview.js';

interface RecordedRequest {
  url: string;
  options: HttpRequestOptions;
}

function response<T>(status: number, data: T): HttpResponse<T> {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {},
    data,
    durationMs: 1,
  };
}

describe('SearchAPI Google AI Overview adapter', () => {
  it('performs the exact private two-stage sequence and normalizes only stage two', async () => {
    const calls: RecordedRequest[] = [];
    const controller = new AbortController();
    const retry = { mode: 'safe', maxAttempts: 2 } as const;
    const provider = new SearchApiGoogleAiOverviewProvider({
      apiKey: SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
      zeroRetention: true,
      retry,
      httpClient: async <T>(url, options = {}) => {
        calls.push({ url, options });
        return response(
          200,
          (calls.length === 1
            ? searchApiGoogleAiOverviewFixtures.stageOneWithToken
            : searchApiGoogleAiOverviewFixtures.successfulOverview) as T,
        );
      },
    });

    const result = await provider.execute('synthetic query', {
      timeout: 7,
      signal: controller.signal,
    });

    expect(provider.maxLogicalOperations).toBe(
      SEARCHAPI_GOOGLE_AI_OVERVIEW_MAX_LOGICAL_OPERATIONS,
    );
    expect(SEARCHAPI_GOOGLE_AI_OVERVIEW_MAX_LOGICAL_OPERATIONS).toBe(2);
    expect(calls).toHaveLength(2);

    const first = calls[0];
    const second = calls[1];
    if (!first || !second) throw new Error('Expected both synthetic stages');
    const firstUrl = new URL(first.url);
    const secondUrl = new URL(second.url);

    expect(firstUrl.searchParams.get('engine')).toBe('google');
    expect(firstUrl.searchParams.get('q')).toBe('synthetic query');
    expect(firstUrl.searchParams.has('page_token')).toBe(false);
    expect(secondUrl.searchParams.get('engine')).toBe('google_ai_overview');
    expect(secondUrl.searchParams.get('page_token')).toBe(
      SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_TOKEN,
    );
    expect(secondUrl.searchParams.has('q')).toBe(false);

    for (const request of calls) {
      const url = new URL(request.url);
      expect(url.searchParams.has('api_key')).toBe(false);
      expect(url.searchParams.get('zero_retention')).toBe('true');
      expect(request.options).toMatchObject({
        headers: {
          Authorization: `Bearer ${SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY}`,
        },
        timeout: 7000,
        signal: controller.signal,
        retry,
      });
    }
    expect(result).toMatchObject({
      provider: 'searchapi-google-ai-overview',
      tier: 'ai-grounded',
      content: searchApiGoogleAiOverviewFixtures.successfulOverview.markdown,
      citations: [
        {
          url: 'https://evidence.example.test/overview',
          title: 'Synthetic overview evidence',
          provider: 'searchapi-google-ai-overview',
        },
      ],
    });
    expect(result.content).not.toContain('Organic content must not render');
    expect(result.citations).not.toContainEqual(
      expect.objectContaining({ url: expect.stringContaining('organic') }),
    );
  });

  it.each([
    ['missing', searchApiGoogleAiOverviewFixtures.missingToken],
    ['invalid', searchApiGoogleAiOverviewFixtures.invalidToken],
  ])('stops after stage one for a %s token', async (_label, firstStage) => {
    const calls: string[] = [];
    const provider = new SearchApiGoogleAiOverviewProvider({
      apiKey: SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
      httpClient: async <T>(url) => {
        calls.push(url);
        return response(200, firstStage as T);
      },
    });

    const result = await provider.execute('missing token', { timeout: 7 });

    expect(calls).toHaveLength(1);
    expect(new URL(calls[0] as string).searchParams.get('engine')).toBe(
      'google',
    );
    expect(result).toMatchObject({
      content: '',
      citations: [],
      preventFallback: true,
    });
    expect(result.error).toContain('unverified');
    expect(result.error).toContain('no valid ai_overview.page_token');
    expect(result.content).not.toContain('No organic fallback');
  });

  it('reports an expired token after exactly two logical operations and redacts errors', async () => {
    const calls: string[] = [];
    const provider = new SearchApiGoogleAiOverviewProvider({
      apiKey: SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
      httpClient: async <T>(url) => {
        calls.push(url);
        return calls.length === 1
          ? response(
              200,
              searchApiGoogleAiOverviewFixtures.stageOneWithToken as T,
            )
          : response(400, searchApiGoogleAiOverviewFixtures.expiredToken as T);
      },
    });

    const result = await provider.execute('expired token', { timeout: 7 });

    expect(calls).toHaveLength(2);
    expect(result.preventFallback).toBe(true);
    expect(result.error).toContain('page_token expired');
    expect(result.error).toContain('[REDACTED]');
    expect(result.error).not.toContain(
      SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
    );
  });

  it('contains a second-stage failure without a third operation or fallback', async () => {
    const calls: string[] = [];
    const provider = new SearchApiGoogleAiOverviewProvider({
      apiKey: SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
      zeroRetention: true,
      httpClient: async <T>(url) => {
        calls.push(url);
        return calls.length === 1
          ? response(
              200,
              searchApiGoogleAiOverviewFixtures.stageOneWithToken as T,
            )
          : response(
              503,
              searchApiGoogleAiOverviewFixtures.secondStageFailure as T,
            );
      },
    });

    const result = await provider.execute('stage two failure', { timeout: 7 });

    expect(calls).toHaveLength(2);
    expect(calls.map((url) => new URL(url).searchParams.get('engine'))).toEqual(
      ['google', 'google_ai_overview'],
    );
    expect(result).toMatchObject({
      content: '',
      citations: [],
      preventFallback: true,
    });
    expect(result.error).toContain('503');
  });

  it('honors an abort between stages without starting stage two', async () => {
    const controller = new AbortController();
    const calls: RecordedRequest[] = [];
    const provider = new SearchApiGoogleAiOverviewProvider({
      apiKey: SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
      zeroRetention: true,
      httpClient: async <T>(url, options = {}) => {
        calls.push({ url, options });
        controller.abort();
        return response(
          200,
          searchApiGoogleAiOverviewFixtures.stageOneWithToken as T,
        );
      },
    });

    const result = await provider.execute('abort between stages', {
      timeout: 7,
      signal: controller.signal,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.signal).toBe(controller.signal);
    expect(result).toMatchObject({
      content: '',
      citations: [],
      preventFallback: true,
      error: 'Request aborted',
    });
  });

  it('treats a valid empty overview as unverified no-result capability evidence', async () => {
    const calls: string[] = [];
    const provider = new SearchApiGoogleAiOverviewProvider({
      apiKey: SEARCHAPI_GOOGLE_AI_OVERVIEW_SYNTHETIC_KEY,
      httpClient: (async <T>(url) => {
        calls.push(url);
        return response(
          200,
          (calls.length === 1
            ? searchApiGoogleAiOverviewFixtures.stageOneWithToken
            : searchApiGoogleAiOverviewFixtures.noResult) as T,
        );
      }) as HttpClient,
    });

    const result = await provider.execute('no result', { timeout: 7 });
    expect(result).toMatchObject({ content: '', citations: [] });
    expect(result.error).toBeUndefined();
    expect(calls).toHaveLength(2);

    calls.length = 0;
    await expect(provider.test()).resolves.toEqual({
      ok: false,
      error: 'SearchAPI Google AI Overview capability unverified: no result',
    });
    expect(calls).toHaveLength(2);
  });
});
