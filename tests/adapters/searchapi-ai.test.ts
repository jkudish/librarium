import { describe, expect, it } from 'vitest';
import { SearchApiChatGptProvider } from '../../src/adapters/searchapi-chatgpt.js';
import { SearchApiGeminiProvider } from '../../src/adapters/searchapi-gemini.js';
import { SearchApiPerplexityProvider } from '../../src/adapters/searchapi-perplexity.js';
import type { HttpClient, HttpResponse } from '../../src/core/http-client.js';
import { normalizeSearchApiAiAnswer } from '../../src/core/searchapi-ai.js';
import {
  SEARCHAPI_AI_SYNTHETIC_KEY,
  searchApiAiFixtures,
} from '../fixtures/searchapi-ai.js';

const engines = [
  {
    id: 'searchapi-chatgpt',
    engine: 'chatgpt',
    create: (httpClient: HttpClient, zeroRetention = false) =>
      new SearchApiChatGptProvider({
        apiKey: SEARCHAPI_AI_SYNTHETIC_KEY,
        httpClient,
        zeroRetention,
      }),
  },
  {
    id: 'searchapi-gemini',
    engine: 'gemini',
    create: (httpClient: HttpClient, zeroRetention = false) =>
      new SearchApiGeminiProvider({
        apiKey: SEARCHAPI_AI_SYNTHETIC_KEY,
        httpClient,
        zeroRetention,
      }),
  },
  {
    id: 'searchapi-perplexity',
    engine: 'perplexity',
    create: (httpClient: HttpClient, zeroRetention = false) =>
      new SearchApiPerplexityProvider({
        apiKey: SEARCHAPI_AI_SYNTHETIC_KEY,
        httpClient,
        zeroRetention,
      }),
  },
] as const;

function response<T>(status: number, data: T): HttpResponse<T> {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {},
    data,
    durationMs: 1,
  };
}

function fixtureClient(data: unknown): HttpClient {
  return async <T>() => response(200, data as T);
}

describe('SearchAPI AI answer normalizer', () => {
  it('renders only known typed blocks recursively when Markdown is unusable', () => {
    const normalized = normalizeSearchApiAiAnswer(
      searchApiAiFixtures.malformed,
      'searchapi-gemini',
    );

    expect(normalized.content).toBe(
      '## Structured fallback\n\nThis came from typed text blocks.\n\n- Recognized item\n\nNested evidence.',
    );
    expect(normalized.content).not.toContain('Must not be rendered');
    expect(normalized.citations).toEqual([
      {
        url: 'https://example.test/valid',
        title: 'Valid reference',
        provider: 'searchapi-gemini',
      },
    ]);
  });
});

describe('SearchAPI consumer AI adapters', () => {
  it.each(engines)(
    '$id sends its fixed engine and preserves answer provenance',
    async ({ id, engine, create }) => {
      const calls: Array<{ url: string; options: Record<string, unknown> }> =
        [];
      const provider = create(async <T>(url, options = {}) => {
        calls.push({ url, options });
        return response(200, searchApiAiFixtures.successful as T);
      });

      const result = await provider.execute('fixture query', { timeout: 7 });

      expect(result).toMatchObject({
        provider: id,
        tier: 'ai-grounded',
        content: searchApiAiFixtures.successful.markdown,
        citations: [
          {
            url: 'https://example.test/source',
            title: 'Fixture source',
            provider: id,
          },
        ],
      });
      expect(calls).toHaveLength(1);
      const request = calls[0];
      if (!request) throw new Error('Expected one synthetic request');
      const url = new URL(request.url);
      expect(url.searchParams.get('engine')).toBe(engine);
      expect(url.searchParams.get('q')).toBe('fixture query');
      expect(url.searchParams.has('api_key')).toBe(false);
      expect(request.options.headers).toEqual({
        Authorization: `Bearer ${SEARCHAPI_AI_SYNTHETIC_KEY}`,
      });
      expect(url.searchParams.get('web_search')).toBe(
        id === 'searchapi-chatgpt' ? 'true' : null,
      );
    },
  );

  it.each(engines)(
    '$id accepts a legitimate citation-free success',
    async ({ create }) => {
      const result = await create(
        fixtureClient(searchApiAiFixtures.citationFree),
      ).execute('no citation', { timeout: 7 });
      expect(result).toMatchObject({
        content: searchApiAiFixtures.citationFree.markdown,
        citations: [],
      });
      expect(result.error).toBeUndefined();
    },
  );

  it.each(engines)(
    '$id falls back from malformed Markdown without losing valid references',
    async ({ id, create }) => {
      const result = await create(
        fixtureClient(searchApiAiFixtures.malformed),
      ).execute('malformed fixture', { timeout: 7 });

      expect(result).toMatchObject({
        provider: id,
        content:
          '## Structured fallback\n\nThis came from typed text blocks.\n\n- Recognized item\n\nNested evidence.',
        citations: [
          {
            url: 'https://example.test/valid',
            provider: id,
          },
        ],
      });
    },
  );

  it.each(engines)(
    '$id keeps malformed upstream errors local to its fixed engine',
    async ({ id, engine, create }) => {
      const calls: string[] = [];
      const result = await create(async <_T>(url) => {
        calls.push(url);
        return response(200, searchApiAiFixtures.providerError as _T);
      }).execute('error fixture', { timeout: 7 });

      expect(result).toMatchObject({
        provider: id,
        content: '',
        citations: [],
      });
      expect(result.error).toContain('engine is unavailable');
      expect(calls).toHaveLength(1);
      expect(new URL(calls[0] as string).searchParams.get('engine')).toBe(
        engine,
      );
    },
  );

  it.each(engines)(
    '$id reports a timeout without a cross-engine retry',
    async ({ id, engine, create }) => {
      const calls: string[] = [];
      const result = await create(async (url) => {
        calls.push(url);
        throw new Error(searchApiAiFixtures.timeout.message);
      }).execute('timeout fixture', { timeout: 7 });

      expect(result).toMatchObject({
        provider: id,
        content: '',
        citations: [],
      });
      expect(result.error).toContain('synthetic timeout');
      expect(calls).toHaveLength(1);
      expect(new URL(calls[0] as string).searchParams.get('engine')).toBe(
        engine,
      );
    },
  );

  it.each(engines)(
    '$id keeps zero retention on its request and fails closed',
    async ({ engine, create }) => {
      const calls: Array<{ url: string; options: Record<string, unknown> }> =
        [];
      const provider = create(async <T>(url, options = {}) => {
        calls.push({ url, options });
        return response(403, searchApiAiFixtures.zeroRetentionDenied as T);
      }, true);
      const result = await provider.execute('privacy fixture', { timeout: 7 });

      expect(result.preventFallback).toBe(true);
      expect(result.error).toContain('zero-retention capability unavailable');
      expect(calls).toHaveLength(1);
      const request = calls[0];
      if (!request) throw new Error('Expected one synthetic request');
      const url = new URL(request.url);
      expect(url.searchParams.get('engine')).toBe(engine);
      expect(url.searchParams.get('zero_retention')).toBe('true');
      expect(request.options.headers).toEqual({
        Authorization: `Bearer ${SEARCHAPI_AI_SYNTHETIC_KEY}`,
      });
    },
  );

  it('rejects ChatGPT queries longer than 4000 characters before HTTP', async () => {
    let requested = false;
    const provider = new SearchApiChatGptProvider({
      apiKey: SEARCHAPI_AI_SYNTHETIC_KEY,
      httpClient: async () => {
        requested = true;
        return response(200, {});
      },
    });

    const result = await provider.execute('x'.repeat(4001), { timeout: 7 });

    expect(requested).toBe(false);
    expect(result.error).toContain('maximum of 4000 characters');
  });

  it('keeps only ChatGPT response_metadata.model and drops stateful IDs', async () => {
    const provider = new SearchApiChatGptProvider({
      apiKey: SEARCHAPI_AI_SYNTHETIC_KEY,
      httpClient: fixtureClient({
        ...searchApiAiFixtures.successful,
        response_metadata: {
          model: 'chatgpt-synthetic-model',
          conversation_id: 'never-persist',
          message_id: 'never-persist',
        },
        conversation_id: 'never-persist',
        message_id: 'never-persist',
        state: { token: 'never-persist' },
      }),
    });

    const result = await provider.execute('metadata fixture', { timeout: 7 });

    expect(result).toMatchObject({ model: 'chatgpt-synthetic-model' });
    expect(JSON.stringify(result)).not.toContain('never-persist');
    expect('conversation_id' in result).toBe(false);
  });
});
