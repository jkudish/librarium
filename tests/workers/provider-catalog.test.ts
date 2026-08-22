import { describe, expect, it } from 'vitest';
import {
  catalogFingerprint,
  isCatalogFingerprint,
} from '../../src/core/catalog-fingerprint.js';
import { mapConfiguration } from '../../src/core/configuration-mapping.js';
import { prepareResearchExecution } from '../../src/core/execution-plan.js';
import { BUILTIN_PROFILE_BINDING_SPECS } from '../../src/core/profile-bindings.js';
import { buildProviderCatalog } from '../../src/core/profile-catalog.js';
import { BUILTIN_PROVIDER_CATALOG } from '../../src/core/provider-profiles.js';
import { collectionProvenanceFor } from '../../src/core/result-provenance.js';
import type { Config } from '../../src/types.js';

function workerCatalog() {
  return buildProviderCatalog({
    providerConfigs: Object.fromEntries(
      BUILTIN_PROFILE_BINDING_SPECS.map((spec) => [
        spec.adapter_id,
        { enabled: true },
      ]),
    ),
    credentials: {
      env: Object.fromEntries(
        BUILTIN_PROVIDER_CATALOG.map((entry) => [
          entry.credential.env_var,
          'test-credential',
        ]),
      ),
    },
  });
}

describe('provider catalog in workerd', () => {
  it('builds the full catalog without Node APIs', () => {
    const catalog = workerCatalog();
    expect(catalog.entries).toHaveLength(33);
    expect(catalog.resolved).toHaveLength(41);
    expect(catalog.profiles).toHaveLength(41);
    expect(catalog.workflow('all').members).toHaveLength(41);
    expect(catalog.workflow('quick').members).toHaveLength(6);
    expect(catalog.workflow('visibility').members).toHaveLength(9);
    expect(catalog.workflow('deep').members).toHaveLength(9);
  });

  it('maps configuration without importing Node config loading', () => {
    const config: Config = {
      version: 1,
      defaults: {
        outputDir: './agents/librarium',
        maxParallel: 2,
        timeout: 30,
        asyncTimeout: 60,
        asyncPollInterval: 5,
        mode: 'sync',
        llmWebSearch: true,
      },
      providers: { exa: { enabled: true } },
      customProviders: {},
      trustedProviderIds: [],
      groups: { team: ['exa'] },
    };
    const mapped = mapConfiguration(config, {
      authoredGroups: { global: config.groups, project: {} },
      requestDeadlineMs: 60_000,
      credentials: {
        env: { EXA_API_KEY: 'worker-synthetic-credential' },
      },
    });
    expect(mapped.groups).toEqual({ team: ['exa/search'] });
    expect(mapped.catalog.resolveDefault()).toHaveLength(1);
  });

  it('fingerprints deterministically without crypto', () => {
    const first = workerCatalog();
    const second = workerCatalog();
    expect(isCatalogFingerprint(first.revision)).toBe(true);
    expect(isCatalogFingerprint(first.digest)).toBe(true);
    expect(first.revision).toBe(second.revision);
    expect(first.digest).toBe(second.digest);
    expect(catalogFingerprint({ b: 1, a: 2 })).toBe(
      catalogFingerprint({ a: 2, b: 1 }),
    );
  });

  it('plans a catalog-backed request end to end', () => {
    let counter = 0;
    const result = prepareResearchExecution(
      {
        query: 'worker catalog query',
        mode: 'sync',
        selector: {
          kind: 'targets',
          targets: [{ provider_id: 'brave-search', profile_id: 'search' }],
        },
        fallback: {
          kind: 'explicit',
          reserve: [{ provider_id: 'exa', profile_id: 'search' }],
        },
        limits: {
          max_concurrency: 2,
          request_deadline_ms: 120_000,
          inline_attempt_deadline_ms: 60_000,
          background_attempt_deadline_ms: 120_000,
          poll_interval_ms: 1_000,
        },
      },
      workerCatalog(),
      {
        clock: { now: () => Date.parse('2026-08-09T00:00:00Z') },
        ids: {
          next: (scope: 'request' | 'slot' | 'fallback_candidate') => {
            counter += 1;
            return `worker-${scope}-${counter}`;
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.request.slots[0]?.primary.identity).toMatchObject({
      provider_id: 'brave-search',
      profile_id: 'search',
    });
    expect(result.prepared.request.fallback_reserve).toHaveLength(1);
    expect(result.prepared.catalog.digest).toBe(workerCatalog().digest);
  });

  it('builds provenance from a resolved profile without Node APIs', () => {
    const profile = workerCatalog().get(
      'searchapi-chatgpt',
      'surface',
    )?.profile;
    if (!profile) throw new Error('missing surface profile');
    const provenance = collectionProvenanceFor({ profile });
    expect(provenance.collector_id).toBe('searchapi');
    expect(provenance.provider).toEqual(profile.identity);
  });
});
