import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionProfile } from '../src/contracts/domain/index.js';
import {
  configInlineAttemptDeadlineAuthored,
  loadConfig,
  mergeConfigs,
} from '../src/core/config.js';
import { profileDefaultInlineAttemptDeadlineMs } from '../src/core/profile-deadlines.js';
import { preflightProductionRequest } from '../src/node-request-preflight.js';
import type { Config } from '../src/types.js';

const XAI_PROFILES = [
  'grok/web',
  'grok-x-only/x',
  'grok-combined/combined',
] as const;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'librarium-deadlines-'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function configFile(content: unknown): string {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(content));
  return path;
}

function v1(defaults: Record<string, unknown> = {}): Config {
  return loadConfig(
    configFile({
      version: 1,
      defaults: { outputDir: join(dir, 'runs'), ...defaults },
      providers: {
        grok: { enabled: true },
        'grok-x-only': { enabled: true },
        'grok-combined': { enabled: true },
        exa: { enabled: true },
      },
      groups: {},
    }),
  );
}

function prepare(config: Config, timeoutSeconds?: number) {
  return preflightProductionRequest(
    {
      config,
      transport: {
        kind: 'cli',
        input: {
          query: 'deadline policy',
          providers: [...XAI_PROFILES, 'exa/search'],
          fallback: false,
          ...(timeoutSeconds !== undefined && { timeoutSeconds }),
        },
      },
    },
    {
      createCredentials: () => ({
        env: { XAI_API_KEY: 'synthetic', EXA_API_KEY: 'synthetic' },
      }),
    },
  ).prepared;
}

function plannedDeadlines(prepared: ReturnType<typeof prepare>) {
  return Object.fromEntries(
    Object.values(prepared.profile_plans_by_identity).map((plan) => [
      `${plan.identity.provider_id}/${plan.identity.profile_id}`,
      plan.inline_attempt_deadline_ms,
    ]),
  );
}

describe('per-profile inline deadlines (#4769)', () => {
  it('declares a 120s default only for the inline xAI profiles', () => {
    const profile = (
      provider_id: string,
      profile_id: string,
      invocation: 'inline' | 'background' = 'inline',
    ) =>
      ({
        identity: { provider_id, profile_id },
        invocation,
      }) as ExecutionProfile;

    for (const key of XAI_PROFILES) {
      const [providerId, profileId] = key.split('/') as [string, string];
      expect(
        profileDefaultInlineAttemptDeadlineMs(profile(providerId, profileId)),
      ).toBe(120_000);
    }
    expect(
      profileDefaultInlineAttemptDeadlineMs(profile('exa', 'search')),
    ).toBeUndefined();
    expect(
      profileDefaultInlineAttemptDeadlineMs(
        profile('grok', 'web', 'background'),
      ),
    ).toBeUndefined();
  });

  it('plans 120s for xAI profiles without raising the global default', () => {
    const config = v1();
    expect(configInlineAttemptDeadlineAuthored(config)).toBe(false);

    const prepared = prepare(config);

    expect(prepared.policy.limits.inline_attempt_deadline_ms).toBe(30_000);
    expect(plannedDeadlines(prepared)).toEqual({
      'grok/web': 120_000,
      'grok-x-only/x': 120_000,
      'grok-combined/combined': 120_000,
      'exa/search': undefined,
    });
  });

  it('derives the request deadline from the per-profile inline allowance', () => {
    // One worker and a short background deadline make the inline allowances
    // the binding term: 3 x 120s (xAI) + 30s (exa).
    const prepared = prepare(v1({ maxParallel: 1, asyncTimeout: 60 }));
    expect(prepared.policy.limits.request_deadline_ms).toBe(390_000);
  });

  it('lets an explicit CLI --timeout win over every per-profile default', () => {
    const prepared = prepare(v1(), 45);
    expect(prepared.policy.limits.inline_attempt_deadline_ms).toBe(45_000);
    expect(Object.values(plannedDeadlines(prepared))).toEqual(
      Array(4).fill(undefined),
    );
  });

  it('lets an authored v1 timeout win, even when it equals the built-in default', () => {
    const config = v1({ timeout: 30 });
    expect(configInlineAttemptDeadlineAuthored(config)).toBe(true);
    expect(Object.values(plannedDeadlines(prepare(config)))).toEqual(
      Array(4).fill(undefined),
    );
  });

  it('treats project and CLI-flag timeouts as authored when merging', () => {
    const global = v1();
    expect(
      configInlineAttemptDeadlineAuthored(mergeConfigs(global, null)),
    ).toBe(false);
    expect(
      configInlineAttemptDeadlineAuthored(
        mergeConfigs(global, { defaults: { timeout: 50 } }),
      ),
    ).toBe(true);
    expect(
      configInlineAttemptDeadlineAuthored(
        mergeConfigs(global, null, { timeout: 50 }),
      ),
    ).toBe(true);
    expect(
      configInlineAttemptDeadlineAuthored(
        mergeConfigs(v1({ timeout: 50 }), null),
      ),
    ).toBe(true);
  });

  it('treats a native v2 file deadline as authored', () => {
    const native = loadConfig(
      configFile({
        version: 2,
        execution_defaults: {
          mode: 'sync',
          max_concurrency: 4,
          inline_attempt_deadline_ms: 30_000,
          background_attempt_deadline_ms: 1_800_000,
          poll_interval_ms: 10_000,
        },
        providers: {},
        custom_providers: {},
        trusted_provider_ids: [],
        groups: {},
        runtime: { output_dir: join(dir, 'runs'), llm_web_search: true },
      }),
    );
    expect(configInlineAttemptDeadlineAuthored(native)).toBe(true);
  });

  it('treats a missing config file as an unauthored built-in default', () => {
    expect(
      configInlineAttemptDeadlineAuthored(loadConfig(join(dir, 'absent.json'))),
    ).toBe(false);
  });

  it('keeps hand-built library configs on the deadline they pass', () => {
    const handBuilt: Config = { ...v1(), defaults: { ...v1().defaults } };
    expect(configInlineAttemptDeadlineAuthored(handBuilt)).toBe(true);
    expect(Object.values(plannedDeadlines(prepare(handBuilt)))).toEqual(
      Array(4).fill(undefined),
    );
  });
});
