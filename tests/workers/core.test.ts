import {
  BUILTIN_PROVIDER_CATALOG,
  type ResearchRequest,
  ResearchRequestSchema,
  VERSION,
} from 'librarium';
import {
  buildPrompt,
  buildProviderCatalog,
  createProviderAttemptBridge,
  type HttpClient,
  httpStreamRequest,
  InMemoryCoordinationStateStore,
  prepareResearchExecution,
} from 'librarium/core';
import { describe, expect, it } from 'vitest';

function request(): ResearchRequest {
  return ResearchRequestSchema.parse({
    query: 'Worker-safe package boundary',
    mode: 'sync',
    selector: {
      kind: 'targets',
      targets: [{ provider_id: 'brave-search', profile_id: 'search' }],
    },
    fallback: { kind: 'disabled' },
    limits: {
      max_concurrency: 1,
      request_deadline_ms: 30_000,
      inline_attempt_deadline_ms: 30_000,
      background_attempt_deadline_ms: 30_000,
      poll_interval_ms: 1_000,
    },
  });
}

describe('public Librarium entries in workerd', () => {
  it('validates, plans, and exposes only Worker-safe root/core primitives', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(BUILTIN_PROVIDER_CATALOG.length).toBeGreaterThan(20);
    expect(request().query).toBe('Worker-safe package boundary');

    const catalog = buildProviderCatalog({
      providerConfigs: { 'brave-search': { enabled: true } },
      credentials: { env: { BRAVE_API_KEY: 'worker-synthetic-key' } },
    });
    const prepared = prepareResearchExecution(request(), catalog, {
      clock: { now: () => Date.parse('2026-08-10T00:00:00.000Z') },
      ids: {
        next: (scope) => `${scope}-worker`,
      },
    });

    expect(catalog.get('brave-search', 'search')?.availability.selectable).toBe(
      true,
    );
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.prepared.request.slots).toHaveLength(1);
      expect(
        prepared.prepared.request.slots[0]?.primary.identity,
      ).toMatchObject({
        provider_id: 'brave-search',
        profile_id: 'search',
      });
    }
    const client: HttpClient = async <T>() => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {} as T,
      durationMs: 1,
    });

    expect(typeof client).toBe('function');
    expect(typeof httpStreamRequest).toBe('function');
    expect(typeof createProviderAttemptBridge).toBe('function');
    expect(new InMemoryCoordinationStateStore()).toBeDefined();
    expect(buildPrompt('worker')).toContain('# Research Query');
  });
});
