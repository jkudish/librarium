import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initConfigToSave, planInitProviders } from '../src/commands/init.js';
import {
  type PreparedRunRequest,
  paidStageBudgetIssues,
  prepareRunRequest,
  RequestPreflightError,
} from '../src/commands/run-request.js';
import { DEFAULT_GROUPS } from '../src/constants.js';
import { CURATED_WORKFLOW_ROSTERS } from '../src/core/builtin-workflows.js';
import {
  authoredGlobalGroups,
  loadConfig,
  saveConfig,
} from '../src/core/config.js';
import type { PreparationDiagnostic } from '../src/core/research-request.js';

/**
 * End-to-end over real config files: `init` writes a config, the CLI request
 * path reads it back, and admission decides what `run`/`answer` may execute.
 * No provider is initialized and no network is touched.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function configPath(stored: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'librarium-4766-'));
  roots.push(root);
  const path = join(root, 'config.json');
  writeFileSync(
    path,
    `${JSON.stringify({
      version: 1,
      defaults: {
        outputDir: './agents/librarium',
        maxParallel: 6,
        timeout: 30,
        asyncTimeout: 1800,
        asyncPollInterval: 30,
        mode: 'sync',
        llmWebSearch: true,
      },
      providers: {},
      customProviders: {},
      trustedProviderIds: [],
      groups: {},
      ...stored,
    })}\n`,
  );
  return path;
}

function init(
  path: string,
  env: Record<string, string>,
  options: { auto?: boolean; enable?: string[] },
) {
  const existing = loadConfig(path);
  const plan = planInitProviders({
    providers: existing.providers,
    customProviderIds: Object.keys(existing.customProviders),
    env,
    auto: Boolean(options.auto),
    enable: options.enable ?? [],
  });
  expect(plan.unknown).toEqual([]);
  saveConfig(initConfigToSave(existing, plan), path);
  return plan;
}

function prepare(
  path: string,
  env: Record<string, string>,
  options: Parameters<typeof prepareRunRequest>[1],
  intent = { refinement: false, synthesis: false, verification: false },
): PreparedRunRequest {
  return prepareRunRequest('test query', options, intent, {
    loadGlobalConfig: () => loadConfig(path),
    loadProjectConfig: () => null,
    createCredentials: () => ({ env }),
  });
}

function rejection(run: () => unknown): RequestPreflightError {
  try {
    run();
  } catch (error) {
    if (error instanceof RequestPreflightError) return error;
    throw error;
  }
  throw new Error('expected a preflight rejection');
}

function plannedKeys(prepared: PreparedRunRequest): string[] {
  return prepared.preflight.prepared.request.slots.map(
    ({ primary }) =>
      `${primary.identity.provider_id}/${primary.identity.profile_id}`,
  );
}

const visibilityKeys = CURATED_WORKFLOW_ROSTERS.visibility.map(
  ({ provider_id, profile_id }) => `${provider_id}/${profile_id}`,
);

function omissionNotices(
  notices: readonly PreparationDiagnostic[],
): PreparationDiagnostic[] {
  return notices.filter(({ code }) => code === 'workflow_profile_unavailable');
}

const VISIBILITY_ENV = {
  SEARCHAPI_API_KEY: 'searchapi-test',
  PERPLEXITY_API_KEY: 'perplexity-test',
  GEMINI_API_KEY: 'gemini-test',
  XAI_API_KEY: 'xai-test',
};

describe('#4766 visibility after init --auto', () => {
  it('names every skipped member and how to enable it instead of silently shrinking', () => {
    // Simulate a config written by an earlier init, which persisted every
    // injected default roster.
    const path = configPath({ groups: DEFAULT_GROUPS });
    init(path, VISIBILITY_ENV, { auto: true });

    // init no longer writes built-in roster copies, and the stored copy no
    // longer shadows the built-in workflow as `custom:visibility`.
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.groups.visibility).toBeUndefined();
    expect(authoredGlobalGroups(loadConfig(path)).visibility).toBeUndefined();

    const prepared = prepare(path, VISIBILITY_ENV, { group: 'visibility' });
    expect(prepared.preflight.notices.map(({ code }) => code)).not.toContain(
      'configuration_group_alias_migrated',
    );
    const planned = plannedKeys(prepared);
    const skipped = visibilityKeys.filter((key) => !planned.includes(key));
    // SearchAPI surfaces remain opt-in at setup (a deliberate cost boundary).
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((key) => key.startsWith('searchapi-'))).toBe(true);

    const notices = omissionNotices(prepared.preflight.notices);
    for (const key of skipped) {
      const provider = key.split('/')[0];
      expect(notices).toContainEqual(
        expect.objectContaining({
          message: `Workflow "visibility" omitted unavailable profile "${key}" (profile_disabled). Enable it with \`librarium init --enable ${provider}\`.`,
        }),
      );
    }
  });

  it('runs every visibility member once the named providers are enabled', () => {
    const path = configPath();
    init(path, VISIBILITY_ENV, { auto: true });
    const before = prepare(path, VISIBILITY_ENV, { group: 'visibility' });
    const enable = omissionNotices(before.preflight.notices).map(
      ({ message }) => /`librarium init --enable (\S+)`/.exec(message)?.[1],
    );
    expect(enable.length).toBeGreaterThan(0);

    init(path, VISIBILITY_ENV, { enable: enable as string[] });
    const after = prepare(path, VISIBILITY_ENV, { group: 'visibility' });
    expect(plannedKeys(after)).toEqual(visibilityKeys);
    expect(omissionNotices(after.preflight.notices)).toEqual([]);
  });

  it('says how to enable an explicitly selected disabled profile', () => {
    const path = configPath();
    init(path, VISIBILITY_ENV, { auto: true });
    const error = rejection(() =>
      prepare(path, VISIBILITY_ENV, { providers: ['searchapi-chatgpt'] }),
    );
    expect(error.issues).toContainEqual(
      expect.objectContaining({
        code: 'profile_disabled',
        message: expect.stringContaining(
          '`librarium init --enable searchapi-chatgpt`',
        ),
      }),
    );
  });

  it('reports skipped members of a custom group too', () => {
    const path = configPath({
      groups: { 'custom:mine': ['searchapi-chatgpt/surface', 'exa/search'] },
    });
    const env = { SEARCHAPI_API_KEY: 'searchapi-test', EXA_API_KEY: 'exa' };
    init(path, env, { auto: true });
    const prepared = prepare(path, env, { group: 'custom:mine' });
    expect(plannedKeys(prepared)).toEqual(['exa/search']);
    expect(omissionNotices(prepared.preflight.notices)).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          'Group "custom:mine" omitted unavailable profile "searchapi-chatgpt/surface" (profile_disabled). Enable it with `librarium init --enable searchapi-chatgpt`.',
        ),
      }),
    );
  });
});

describe('#4766 --max-cost with the standard groups', () => {
  it('admits the answer defaults when every planned quick member is bounded', () => {
    // Exa Search and Kagi FastGPT have exact snapshot prices; the other quick
    // members are absent here and are reported, not silently dropped.
    const env = { EXA_API_KEY: 'exa-test', KAGI_API_KEY: 'kagi-test' };
    const path = configPath();
    init(path, env, { auto: true });
    const prepared = prepare(
      path,
      env,
      { maxCost: 1.5 },
      { refinement: false, synthesis: true, verification: false },
    );
    expect(plannedKeys(prepared)).toEqual([
      'exa/search',
      'kagi-fastgpt/grounded',
    ]);
    expect(prepared.preflight.prepared.policy.budgets).toEqual({
      max_actual_cost_microusd: '1500000',
    });
    expect(prepared.preflight.prepared.profile_plans_by_identity).toBeDefined();
    const skipped = new Set(
      omissionNotices(prepared.preflight.notices).map(
        ({ message }) => /profile "([^"]+)"/.exec(message)?.[1],
      ),
    );
    expect(skipped.size).toBe(CURATED_WORKFLOW_ROSTERS.quick.length - 2);
  });

  it('gates answer synthesis before any spend when its LLM has no bounded price', () => {
    const env = {
      EXA_API_KEY: 'exa-test',
      KAGI_API_KEY: 'kagi-test',
      OPENAI_API_KEY: 'openai-test',
    };
    const answer = { refinement: false, synthesis: true, verification: false };
    const path = configPath();
    init(path, env, { auto: true });
    const unpriced = prepare(path, env, { maxCost: 1.5 }, answer);
    const issues = paidStageBudgetIssues(unpriced.stages);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'paid_stage_budget_estimate_required',
      path: '/stages/synthesis',
    });
    expect(issues[0]?.message).toContain(
      'Set options.perRequestUsd for provider "openai-chat"',
    );
    // Without a budget, nothing is gated.
    expect(
      paidStageBudgetIssues(prepare(path, env, {}, answer).stages),
    ).toEqual([]);

    const priced = configPath({
      providers: { 'openai-chat': { options: { perRequestUsd: 0.05 } } },
    });
    init(priced, env, { auto: true });
    expect(
      paidStageBudgetIssues(
        prepare(priced, env, { maxCost: 1.5 }, answer).stages,
      ),
    ).toEqual([]);
  });

  it('still fails closed when the bounded plan exceeds the budget', () => {
    const env = { EXA_API_KEY: 'exa-test', KAGI_API_KEY: 'kagi-test' };
    const path = configPath();
    init(path, env, { auto: true });
    const error = rejection(() => prepare(path, env, { maxCost: 0.02 }));
    expect(error.issues.map(({ code }) => code)).toContain(
      'primary_plan_budget_exceeded',
    );
  });

  it('names every unbounded visibility member with a way to proceed', () => {
    const path = configPath();
    init(path, VISIBILITY_ENV, { auto: true });
    init(path, VISIBILITY_ENV, {
      enable: visibilityKeys
        .filter((key) => key.startsWith('searchapi-'))
        .map((key) => key.split('/')[0] as string),
    });
    const error = rejection(() =>
      prepare(path, VISIBILITY_ENV, { group: 'visibility', maxCost: 1.5 }),
    );
    const budgetIssues = error.issues.filter(
      ({ code }) => code === 'budget_estimate_required',
    );
    const named = budgetIssues.map(
      ({ message }) => /^Profile "([^"]+)"/.exec(message)?.[1],
    );
    // Nothing is dropped: every planned member is accounted for by name.
    expect(named.sort()).toEqual([...visibilityKeys].sort());
    for (const { message } of budgetIssues) {
      expect(message).toMatch(/drop the budget\.$/);
    }
  });

  it('admits SearchAPI surfaces under a hard budget with a configured account rate', () => {
    const surfaces = visibilityKeys.filter((key) =>
      key.startsWith('searchapi-'),
    );
    const ids = surfaces.map((key) => key.split('/')[0] as string);
    const path = configPath({
      providers: Object.fromEntries(
        ids.map((id) => [id, { options: { perRequestUsd: 0.004 } }]),
      ),
    });
    init(path, VISIBILITY_ENV, { enable: ids });
    // init kept the configured options while enabling the providers.
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.providers[ids[0] as string]).toEqual({
      options: { perRequestUsd: 0.004 },
      apiKey: '$SEARCHAPI_API_KEY',
      enabled: true,
    });

    const prepared = prepare(path, VISIBILITY_ENV, {
      providers: ids,
      maxCost: 1.5,
    });
    expect(plannedKeys(prepared)).toEqual(surfaces);
    const estimates = Object.values(
      prepared.preflight.prepared.profile_plans_by_identity,
    ).map((plan) => plan.estimate?.estimated_cost_microusd);
    expect(estimates.every((value) => value !== undefined)).toBe(true);

    // The configured rate is a bound, not a waiver: an undersized budget
    // still fails before any call.
    const error = rejection(() =>
      prepare(path, VISIBILITY_ENV, { providers: ids, maxCost: 0.004 }),
    );
    expect(error.issues.map(({ code }) => code)).toContain(
      'primary_plan_budget_exceeded',
    );
  });
});
