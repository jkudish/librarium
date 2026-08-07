import { describe, expect, it } from 'vitest';
import { SearchApiGoogleAiOverviewProvider } from '../../src/adapters/searchapi-google-ai-overview.js';
import type { HttpClient } from '../../src/core/http-client.js';

describe('SearchAPI Google AI Overview in workerd', () => {
  it('runs the two-stage adapter with fetch-only Worker globals', async () => {
    const calls: string[] = [];
    const httpClient: HttpClient = async <T>(url) => {
      calls.push(url);
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        data: (calls.length === 1
          ? { ai_overview: { page_token: 'worker-synthetic-token' } }
          : {
              markdown: 'Worker-safe dedicated overview.',
              reference_links: [
                { link: 'https://worker.example.test/evidence' },
              ],
            }) as T,
        durationMs: 1,
      };
    };
    const provider = new SearchApiGoogleAiOverviewProvider({
      apiKey: 'worker-searchapi-google-ai-overview-synthetic-key',
      httpClient,
      zeroRetention: true,
    });

    await expect(
      provider.execute('worker overview', { timeout: 5 }),
    ).resolves.toMatchObject({
      provider: 'searchapi-google-ai-overview',
      content: 'Worker-safe dedicated overview.',
      citations: [
        {
          url: 'https://worker.example.test/evidence',
          provider: 'searchapi-google-ai-overview',
        },
      ],
    });
    expect(calls).toHaveLength(2);
    expect(
      calls.map((url) => new URL(url).searchParams.get('zero_retention')),
    ).toEqual(['true', 'true']);
  });
});
