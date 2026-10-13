import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionProfile } from '../src/contracts/domain/index.js';
import {
  configBackgroundAttemptDeadlineAuthored,
  configInlineAttemptDeadlineAuthored,
  configToPersist,
  loadConfig,
  mergeConfigs,
  saveConfig,
} from '../src/core/config.js';
import { migrateConfig } from '../src/core/config-v2.js';
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

  it('lets an authored v1 timeout win over every per-profile default', () => {
    const config = v1({ timeout: 45 });
    expect(configInlineAttemptDeadlineAuthored(config)).toBe(true);
    expect(Object.values(plannedDeadlines(prepare(config)))).toEqual(
      Array(4).fill(undefined),
    );
  });

  // #4769 counted any configured timeout as authored, including 30. Earlier
  // `init` runs and v1-to-v2 migrations wrote the shipped defaults (timeout 30,
  // asyncTimeout 1800) into config files without the user choosing them, which
  // switched every per-profile default off. A configured value equal to the
  // shipped default is therefore unauthored (#4856); any other value wins.
  it('treats a configured timeout equal to the shipped 30s default as unauthored', () => {
    const config = v1({ timeout: 30, asyncTimeout: 1800 });
    expect(configInlineAttemptDeadlineAuthored(config)).toBe(false);
    expect(configBackgroundAttemptDeadlineAuthored(config)).toBe(false);
    expect(plannedDeadlines(prepare(config))).toEqual({
      'grok/web': 120_000,
      'grok-x-only/x': 120_000,
      'grok-combined/combined': 120_000,
      'exa/search': undefined,
    });
  });

  it('gives grok 120s in a migrated v1 config that carries timeout 30', () => {
    const migrated = migrateConfig({
      global: {
        version: 1,
        defaults: {
          outputDir: join(dir, 'runs'),
          timeout: 30,
          asyncTimeout: 1800,
        },
        providers: {
          grok: { enabled: true },
          'grok-x-only': { enabled: true },
          'grok-combined': { enabled: true },
          exa: { enabled: true },
        },
        groups: {},
      },
    });
    if (!migrated.ok) throw new Error(JSON.stringify(migrated.issues));
    expect(migrated.config.execution_defaults).toMatchObject({
      inline_attempt_deadline_ms: 30_000,
      background_attempt_deadline_ms: 1_800_000,
    });
    const config = loadConfig(configFile(migrated.config));
    expect(configInlineAttemptDeadlineAuthored(config)).toBe(false);
    expect(plannedDeadlines(prepare(config))['grok/web']).toBe(120_000);
  });

  it('keeps an explicit CLI --timeout 30 authored', () => {
    expect(
      configInlineAttemptDeadlineAuthored(
        mergeConfigs(v1(), null, { timeout: 30 }),
      ),
    ).toBe(true);
    expect(Object.values(plannedDeadlines(prepare(v1(), 30)))).toEqual(
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
          inline_attempt_deadline_ms: 45_000,
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

describe('per-target background deadlines (#4856)', () => {
  const MINUTE = 60_000;

  function research(
    options: { processor?: string; model?: string; mode?: string },
    defaults: Record<string, unknown> = {},
  ): Config {
    return loadConfig(
      configFile({
        version: 1,
        defaults: { outputDir: join(dir, 'runs'), ...defaults },
        providers: {
          'parallel-research': {
            enabled: true,
            ...(options.model && { model: options.model }),
            ...(options.processor && {
              options: { processor: options.processor },
            }),
          },
          'valyu-research': {
            enabled: true,
            ...(options.mode && { options: { mode: options.mode } }),
          },
        },
        groups: {},
      }),
    );
  }

  function prepareResearch(config: Config) {
    return preflightProductionRequest(
      {
        config,
        transport: {
          kind: 'cli',
          input: {
            query: 'deadline policy',
            providers: ['parallel/research', 'valyu/research'],
            fallback: false,
          },
        },
      },
      {
        createCredentials: () => ({
          env: { PARALLEL_API_KEY: 'parallel', VALYU_API_KEY: 'valyu' },
        }),
      },
    ).prepared;
  }

  function plans(prepared: ReturnType<typeof prepareResearch>) {
    return Object.fromEntries(
      Object.values(prepared.profile_plans_by_identity).map((plan) => [
        `${plan.identity.provider_id}/${plan.identity.profile_id}/${plan.identity.target.primary.target_id}`,
        {
          deadline: plan.background_attempt_deadline_ms,
          cost: plan.estimate?.estimated_cost_microusd,
        },
      ]),
    );
  }

  it('keeps pro and standard on the global 30-minute default', () => {
    const prepared = prepareResearch(research({}));
    expect(prepared.policy.limits.background_attempt_deadline_ms).toBe(
      30 * MINUTE,
    );
    expect(plans(prepared)).toEqual({
      'parallel/research/pro': { deadline: undefined, cost: '100000' },
      'valyu/research/standard': { deadline: 30 * MINUTE, cost: '500000' },
    });
  });

  it.each([
    [{ processor: 'ultra8x', mode: 'max' }, 'ultra8x', 180, 'max', 180],
    [{ model: 'ultra2x', mode: 'heavy' }, 'ultra2x', 75, 'heavy', 120],
    [{ processor: 'ultra4x', mode: 'fast' }, 'ultra4x', 135, 'fast', 10],
    [{ processor: 'ultra' }, 'ultra', 45, 'standard', 30],
  ])(
    'plans the documented runtime for %o',
    (options, processor, parallelMinutes, mode, valyuMinutes) => {
      const prepared = prepareResearch(research(options));
      const planned = plans(prepared);
      expect(planned[`parallel/research/${processor}`]?.deadline).toBe(
        parallelMinutes * MINUTE,
      );
      expect(planned[`valyu/research/${mode}`]?.deadline).toBe(
        valyuMinutes * MINUTE,
      );
      // The derived request deadline covers the longest attempt.
      expect(prepared.policy.limits.request_deadline_ms).toBeGreaterThanOrEqual(
        Math.max(parallelMinutes, valyuMinutes) * MINUTE,
      );
    },
  );

  it.each(['core', 'core2x', 'lite', 'base'])(
    'keeps the global default for the short %s processor',
    (processor) => {
      expect(
        plans(prepareResearch(research({ processor })))[
          `parallel/research/${processor}`
        ]?.deadline,
      ).toBeUndefined();
    },
  );

  it('lets an authored asyncTimeout win over every per-target default', () => {
    const config = research(
      { processor: 'ultra8x', mode: 'max' },
      { asyncTimeout: 2400 },
    );
    expect(configBackgroundAttemptDeadlineAuthored(config)).toBe(true);
    // The inline timeout is independent: it stays unauthored.
    expect(configInlineAttemptDeadlineAuthored(config)).toBe(false);
    const prepared = prepareResearch(config);
    expect(
      Object.values(plans(prepared)).map(({ deadline }) => deadline),
    ).toEqual([undefined, undefined]);
    expect(prepared.policy.limits.background_attempt_deadline_ms).toBe(
      40 * MINUTE,
    );
  });

  it('treats a configured asyncTimeout equal to the shipped 1800s default as unauthored', () => {
    const config = research({ mode: 'max' }, { asyncTimeout: 1800 });
    expect(configBackgroundAttemptDeadlineAuthored(config)).toBe(false);
    expect(plans(prepareResearch(config))['valyu/research/max']?.deadline).toBe(
      180 * MINUTE,
    );
  });

  it('treats project and v2 background deadlines as authored', () => {
    const global = research({});
    expect(configBackgroundAttemptDeadlineAuthored(global)).toBe(false);
    expect(
      configBackgroundAttemptDeadlineAuthored(
        mergeConfigs(global, { defaults: { asyncTimeout: 600 } }),
      ),
    ).toBe(true);
    expect(
      configBackgroundAttemptDeadlineAuthored(
        mergeConfigs(global, { defaults: { timeout: 60 } }),
      ),
    ).toBe(false);
    const native = loadConfig(
      configFile({
        version: 2,
        execution_defaults: {
          mode: 'sync',
          max_concurrency: 4,
          inline_attempt_deadline_ms: 30_000,
          background_attempt_deadline_ms: 2_400_000,
          poll_interval_ms: 10_000,
        },
        providers: {},
        custom_providers: {},
        trusted_provider_ids: [],
        groups: {},
        runtime: { output_dir: join(dir, 'runs'), llm_web_search: true },
      }),
    );
    expect(configBackgroundAttemptDeadlineAuthored(native)).toBe(true);
    // The v2 inline deadline equals the shipped 30s default: unauthored.
    expect(configInlineAttemptDeadlineAuthored(native)).toBe(false);
  });
});

describe('research tier defaults (#4856)', () => {
  it.each(['deep', 'all'])(
    'plans Parallel pro and Valyu standard, never max, for --group %s',
    (group) => {
      const config = loadConfig(
        configFile({
          version: 1,
          defaults: { outputDir: join(dir, 'runs') },
          providers: {
            'parallel-research': { enabled: true },
            'valyu-research': { enabled: true },
          },
          groups: {},
        }),
      );
      const prepared = preflightProductionRequest(
        {
          config,
          transport: {
            kind: 'cli',
            input: { query: 'defaults', group, fallback: false },
          },
        },
        {
          createCredentials: () => ({
            env: { PARALLEL_API_KEY: 'parallel', VALYU_API_KEY: 'valyu' },
          }),
        },
      ).prepared;
      const targets = Object.fromEntries(
        Object.values(prepared.profile_plans_by_identity)
          .filter(({ identity }) =>
            ['parallel', 'valyu'].includes(identity.provider_id),
          )
          .map(({ identity }) => [
            `${identity.provider_id}/${identity.profile_id}`,
            identity.target.primary.target_id,
          ]),
      );
      expect(targets).toEqual({
        'parallel/research': 'pro',
        'valyu/research': 'standard',
      });
    },
  );
});

describe('config writers keep built-in deadlines unauthored (#4856)', () => {
  function initAuto(path: string, env: Record<string, string>) {
    const existing = loadConfig(path);
    existing.providers['parallel-research'] = {
      enabled: true,
      apiKey: env.PARALLEL_API_KEY,
    };
    existing.providers['valyu-research'] = {
      enabled: true,
      apiKey: env.VALYU_API_KEY,
    };
    saveConfig(configToPersist(existing, existing), path);
    return JSON.parse(readFileSync(path, 'utf8')) as {
      defaults: Record<string, unknown>;
    };
  }

  const env = { PARALLEL_API_KEY: 'parallel', VALYU_API_KEY: 'valyu' };

  it('does not persist default deadlines, so per-profile defaults still apply', () => {
    const path = join(dir, 'init-config.json');
    const saved = initAuto(path, env);
    expect(saved.defaults).not.toHaveProperty('timeout');
    expect(saved.defaults).not.toHaveProperty('asyncTimeout');
    expect(saved.defaults).toHaveProperty('maxParallel');

    const config = loadConfig(path);
    expect(configInlineAttemptDeadlineAuthored(config)).toBe(false);
    expect(configBackgroundAttemptDeadlineAuthored(config)).toBe(false);
    config.providers['valyu-research'] = {
      ...config.providers['valyu-research'],
      options: { mode: 'max' },
    };
    const prepared = preflightProductionRequest(
      {
        config,
        transport: {
          kind: 'cli',
          input: { query: 'q', providers: ['valyu/research'], fallback: false },
        },
      },
      { createCredentials: () => ({ env }) },
    ).prepared;
    expect(
      Object.values(prepared.profile_plans_by_identity)[0]
        ?.background_attempt_deadline_ms,
    ).toBe(180 * 60_000);
  });

  it('keeps deadlines a user wrote', () => {
    const path = configFile({
      version: 1,
      defaults: {
        outputDir: join(dir, 'runs'),
        timeout: 45,
        asyncTimeout: 2400,
      },
      providers: {},
      groups: {},
    });
    const saved = initAuto(path, env);
    expect(saved.defaults).toMatchObject({ timeout: 45, asyncTimeout: 2400 });
  });

  it('drops the shipped defaults an earlier init wrote', () => {
    const path = configFile({
      version: 1,
      defaults: {
        outputDir: join(dir, 'runs'),
        timeout: 30,
        asyncTimeout: 1800,
      },
      providers: {},
      groups: {},
    });
    const saved = initAuto(path, env);
    expect(saved.defaults).not.toHaveProperty('timeout');
    expect(saved.defaults).not.toHaveProperty('asyncTimeout');
  });
});
