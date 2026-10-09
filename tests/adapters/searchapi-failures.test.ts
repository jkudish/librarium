import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchApiProvider } from '../../src/adapters/searchapi.js';
import { SearchApiBingCopilotProvider } from '../../src/adapters/searchapi-bing-copilot.js';
import { SearchApiChatGptProvider } from '../../src/adapters/searchapi-chatgpt.js';
import { SearchApiGeminiProvider } from '../../src/adapters/searchapi-gemini.js';
import { createSearchApiRequest } from '../../src/core/searchapi.js';
import { searchApiHttpFailureDiagnostic } from '../../src/core/searchapi-diagnostics.js';

const SYNTHETIC_KEY = 'searchapi-synthetic-test-key';
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const adapters = [
  ['searchapi', () => new SearchApiProvider({ apiKey: SYNTHETIC_KEY })],
  [
    'searchapi-chatgpt',
    () => new SearchApiChatGptProvider({ apiKey: SYNTHETIC_KEY }),
  ],
  [
    'searchapi-gemini',
    () => new SearchApiGeminiProvider({ apiKey: SYNTHETIC_KEY }),
  ],
  [
    'searchapi-bing-copilot',
    () => new SearchApiBingCopilotProvider({ apiKey: SYNTHETIC_KEY }),
  ],
] as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SearchAPI failure handling (#4769)', () => {
  it('builds requests that never retry unless a caller opts in', () => {
    const base = { apiKey: SYNTHETIC_KEY, engine: 'google', timeout: 1_000 };
    expect(createSearchApiRequest(base).options.retry).toEqual({
      mode: 'never',
    });
    const optIn = { mode: 'safe', maxAttempts: 2 } as const;
    expect(
      createSearchApiRequest({ ...base, retry: optIn }).options.retry,
    ).toBe(optIn);
  });

  it.each(adapters)(
    '%s sends one request for a deterministic 503 and keeps its cause',
    async (_id, create) => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(503, { error: 'This API has been deprecated.' }),
      );
      globalThis.fetch = fetchMock as typeof fetch;

      const result = await create().execute('deprecated engine', {
        timeout: 5,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.error).toContain('API returned 503');
      expect(result.error).toContain('This API has been deprecated.');
      expect(result.error).not.toContain(SYNTHETIC_KEY);
      expect(result.failureDiagnostic).toEqual({
        kind: 'provider',
        httpStatus: 503,
      });
    },
  );

  it.each(adapters)(
    '%s classifies an authentication rejection with its status',
    async (_id, create) => {
      globalThis.fetch = vi.fn(async () =>
        jsonResponse(401, { error: 'Invalid API key.' }),
      ) as typeof fetch;

      const result = await create().execute('bad key', { timeout: 5 });

      expect(result.failureDiagnostic).toEqual({
        kind: 'authentication',
        httpStatus: 401,
      });
    },
  );

  it.each(adapters)(
    '%s classifies a transport failure without retrying or keeping its message',
    async (_id, create) => {
      const fetchMock = vi.fn(async () => {
        throw new TypeError('fetch failed');
      });
      globalThis.fetch = fetchMock as typeof fetch;

      const result = await create().execute('offline', { timeout: 5 });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.failureDiagnostic).toEqual({ kind: 'network' });
    },
  );

  it.each([
    [400, 'invalid_request'],
    [402, 'billing'],
    [404, 'invalid_request'],
    [418, 'provider'],
    [429, 'rate_limit'],
    [500, 'provider'],
    [504, 'timeout'],
  ] as const)(
    'keeps HTTP %i as a %s diagnostic with its status',
    (status, kind) => {
      expect(searchApiHttpFailureDiagnostic(status)).toEqual({
        kind,
        httpStatus: status,
      });
    },
  );
});
