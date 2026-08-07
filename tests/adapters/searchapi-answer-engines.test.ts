import { describe, expect, it } from 'vitest';
import { SearchApiBingCopilotProvider } from '../../src/adapters/searchapi-bing-copilot.js';
import { SearchApiGoogleAiModeProvider } from '../../src/adapters/searchapi-google-ai-mode.js';
import type { HttpClient, HttpResponse } from '../../src/core/http-client.js';
import {
  SEARCHAPI_ANSWER_ENGINES_SYNTHETIC_KEY,
  searchApiBingCopilotFixtures,
  searchApiGoogleAiModeFixtures,
} from '../fixtures/searchapi-answer-engines.js';

function response<T>(status: number, data: T): HttpResponse<T> {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {},
    data,
    durationMs: 1,
  };
}

type AnswerEngineFixture = {
  successful: { markdown: string; reference_links: readonly unknown[] };
  citationFree: { markdown: string; reference_links: readonly unknown[] };
  malformed: {
    markdown: string;
    text_blocks: readonly unknown[];
    reference_links: readonly unknown[];
  };
  providerError: { error: string };
  timeout: { message: string };
  zeroRetentionDenied: { error: string };
};

const engines = [
  {
    id: 'searchapi-google-ai-mode',
    engine: 'google_ai_mode',
    fixtures: searchApiGoogleAiModeFixtures,
    fallback:
      '## Google structured fallback\n\nThis came from Google AI Mode text blocks.\n\n- Recognized Google list item.\n\n```text\nGoogle fixture code block\n```',
    sourceCitation: 'https://google-ai-mode.example.test/source',
    validCitation: 'https://google-ai-mode.example.test/valid',
    create: (httpClient: HttpClient, zeroRetention = false) =>
      new SearchApiGoogleAiModeProvider({
        apiKey: SEARCHAPI_ANSWER_ENGINES_SYNTHETIC_KEY,
        httpClient,
        zeroRetention,
      }),
  },
  {
    id: 'searchapi-bing-copilot',
    engine: 'bing_copilot',
    fixtures: searchApiBingCopilotFixtures,
    fallback:
      '## Bing structured fallback\n\nThis came from Bing Copilot text blocks.\n\n1. Recognized Bing list item.\n\n```text\nBing fixture code block\n```',
    sourceCitation: 'https://bing-copilot.example.test/source',
    validCitation: 'https://bing-copilot.example.test/valid',
    create: (httpClient: HttpClient, zeroRetention = false) =>
      new SearchApiBingCopilotProvider({
        apiKey: SEARCHAPI_ANSWER_ENGINES_SYNTHETIC_KEY,
        httpClient,
        zeroRetention,
      }),
  },
] as const satisfies readonly {
  id: string;
  engine: string;
  fixtures: AnswerEngineFixture;
  fallback: string;
  sourceCitation: string;
  validCitation: string;
  create: (
    httpClient: HttpClient,
    zeroRetention?: boolean,
  ) => {
    execute: (
      query: string,
      options: { timeout: number; signal?: AbortSignal },
    ) => Promise<unknown>;
    test: () => Promise<{ ok: boolean; error?: string }>;
  };
}[];

describe('SearchAPI Google AI Mode and Bing Copilot adapters', () => {
  it.each(engines)(
    '$id uses its fixed documented engine and bearer-only request',
    async ({ id, engine, fixtures, sourceCitation, create }) => {
      const calls: Array<{ url: string; options: Record<string, unknown> }> =
        [];
      const result = await create(async <T>(url, options = {}) => {
        calls.push({ url, options });
        return response(200, fixtures.successful as T);
      }).execute('fixture query', { timeout: 7 });

      expect(result).toMatchObject({
        provider: id,
        tier: 'ai-grounded',
        content: fixtures.successful.markdown,
        citations: [
          {
            url: sourceCitation,
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
        Authorization: `Bearer ${SEARCHAPI_ANSWER_ENGINES_SYNTHETIC_KEY}`,
      });
      expect(request.options.timeout).toBe(7000);
      expect(JSON.stringify(result)).not.toContain('organic.example.test');
    },
  );

  it.each(engines)(
    '$id accepts a legitimate citation-free success',
    async ({ fixtures, create }) => {
      const result = await create(async <T>() =>
        response(200, fixtures.citationFree as T),
      ).execute('citation-free fixture', { timeout: 7 });

      expect(result).toMatchObject({
        content: fixtures.citationFree.markdown,
        citations: [],
      });
      expect(result).not.toHaveProperty('error');
    },
  );

  it.each(engines)(
    '$id falls back to its documented text blocks and drops malformed references',
    async ({ id, fixtures, fallback, validCitation, create }) => {
      const result = await create(async <T>() =>
        response(200, fixtures.malformed as T),
      ).execute('malformed fixture', { timeout: 7 });

      expect(result).toMatchObject({
        provider: id,
        content: fallback,
        citations: [{ url: validCitation, provider: id }],
      });
      expect(JSON.stringify(result)).not.toContain('Must not be rendered');
      expect(JSON.stringify(result)).not.toContain('Unsafe reference');
    },
  );

  it.each(engines)(
    '$id keeps unavailable-engine payloads local to that engine',
    async ({ id, engine, fixtures, create }) => {
      const calls: string[] = [];
      const result = await create(async <T>(url) => {
        calls.push(url);
        return response(200, fixtures.providerError as T);
      }).execute('error fixture', { timeout: 7 });

      expect(result).toMatchObject({
        provider: id,
        content: '',
        citations: [],
      });
      expect(result).toHaveProperty(
        'error',
        expect.stringContaining('unavailable'),
      );
      expect(calls).toHaveLength(1);
      expect(new URL(calls[0] as string).searchParams.get('engine')).toBe(
        engine,
      );
    },
  );

  it.each(engines)(
    '$id reports a timeout without semantic substitution',
    async ({ id, engine, fixtures, create }) => {
      const calls: string[] = [];
      const result = await create(async (url) => {
        calls.push(url);
        throw new Error(fixtures.timeout.message);
      }).execute('timeout fixture', { timeout: 7 });

      expect(result).toMatchObject({
        provider: id,
        content: '',
        citations: [],
      });
      expect(result).toHaveProperty(
        'error',
        expect.stringContaining(fixtures.timeout.message),
      );
      expect(calls).toHaveLength(1);
      expect(new URL(calls[0] as string).searchParams.get('engine')).toBe(
        engine,
      );
    },
  );

  it.each(engines)(
    '$id fails closed when zero retention is rejected',
    async ({ engine, fixtures, create }) => {
      const calls: Array<{ url: string; options: Record<string, unknown> }> =
        [];
      const result = await create(async <T>(url, options = {}) => {
        calls.push({ url, options });
        return response(403, fixtures.zeroRetentionDenied as T);
      }, true).execute('privacy fixture', { timeout: 7 });

      expect(result).toMatchObject({
        content: '',
        citations: [],
        preventFallback: true,
        error: expect.stringContaining('zero-retention capability unavailable'),
      });
      expect(calls).toHaveLength(1);
      const request = calls[0];
      if (!request) throw new Error('Expected one synthetic request');
      const url = new URL(request.url);
      expect(url.searchParams.get('engine')).toBe(engine);
      expect(url.searchParams.get('zero_retention')).toBe('true');
      expect(url.searchParams.has('api_key')).toBe(false);
    },
  );

  it.each(engines)(
    '$id preserves caller abort signals without another engine request',
    async ({ id, engine, create }) => {
      const controller = new AbortController();
      const calls: Array<{ url: string; signal: AbortSignal | undefined }> = [];
      const result = await create(async (url, options = {}) => {
        calls.push({ url, signal: options.signal });
        controller.abort();
        throw new Error('Request aborted');
      }).execute('abort fixture', { timeout: 7, signal: controller.signal });

      expect(result).toMatchObject({
        provider: id,
        content: '',
        citations: [],
      });
      expect(result).toHaveProperty(
        'error',
        expect.stringContaining('aborted'),
      );
      expect(calls).toEqual([
        expect.objectContaining({ signal: controller.signal }),
      ]);
      expect(new URL(calls[0]?.url ?? '').searchParams.get('engine')).toBe(
        engine,
      );
    },
  );

  it.each(engines)(
    '$id health checks exercise configured zero retention',
    async ({ engine, create }) => {
      const calls: string[] = [];
      const result = await create(async <T>(url) => {
        calls.push(url);
        return response(200, { markdown: 'health check' } as T);
      }, true).test();

      expect(result).toEqual({ ok: true });
      expect(calls).toHaveLength(1);
      const url = new URL(calls[0] as string);
      expect(url.searchParams.get('engine')).toBe(engine);
      expect(url.searchParams.get('zero_retention')).toBe('true');
    },
  );
});
