import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPlanReceipt,
  executePlan,
  type PlanOptions,
} from '../src/commands/plan.js';
import { prepareRunRequest } from '../src/commands/run-request.js';
import { fingerprint, RunPaidWallet } from '../src/run-paid-wallet.js';
import type { Config } from '../src/types.js';

const roots: string[] = [];

function config(
  overrides: Partial<Config> & { defaults?: Partial<Config['defaults']> } = {},
): Config {
  const { defaults, ...rest } = overrides;
  return {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 3,
      timeout: 30,
      asyncTimeout: 300,
      asyncPollInterval: 5,
      mode: 'sync',
      llmWebSearch: true,
      ...defaults,
    },
    providers: { 'brave-search': { enabled: true } },
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
    ...rest,
  };
}

function customExecutionProfile() {
  return {
    identity: {
      provider_id: 'acme',
      profile_id: 'search',
      target: { primary: { model_selection: 'not_applicable' as const } },
    },
    result_kind: 'search_results' as const,
    observation_mode: 'api_output' as const,
    corpora: ['web' as const],
    retrieval_method: 'search_endpoint' as const,
    access_mode: 'direct' as const,
    operator_id: 'acme',
    invocation: 'inline' as const,
    resumability: 'none' as const,
  };
}

function deps(source: Config, env: Record<string, string> = {}) {
  return {
    loadGlobalConfig: () => source,
    loadProjectConfig: () => null,
    createCredentials: () => ({ env }),
    env,
  };
}

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    output: () => ({ stdout, stderr }),
  };
}

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('plan command', () => {
  it('renders a sanitized versioned research plan without network or artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'librarium-plan-'));
    roots.push(root);
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network must not be used'));
    const output = capture();

    const receipt = await executePlan(
      'secret research query',
      { providers: ['brave-search'], json: true },
      {
        ...deps(config(), { BRAVE_API_KEY: 'secret-brave-key' }),
        cwd: root,
        stdout: output.stdout,
        stderr: output.stderr,
      },
    );

    expect(receipt).toMatchObject({
      schema_version: 1,
      artifact: 'librarium.plan',
      status: 'ready',
      ready_means: 'preflight_ready_only',
      primary_profiles: [
        {
          provider_id: 'brave-search',
          profile_id: 'search',
          credential_availability: 'locally_resolved',
          estimate: { state: 'known', cost_microusd: '5000' },
        },
      ],
      guarantees: {
        provider_requests_made: false,
        provider_authentication_verified: false,
        custom_code_loaded: false,
        run_artifacts_created: false,
      },
    });
    expect(output.output().stderr).toBe('');
    expect(output.output().stdout).not.toContain('secret research query');
    expect(output.output().stdout).not.toContain('secret-brave-key');
    expect(JSON.parse(output.output().stdout)).toEqual(receipt);
    expect(network).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  });

  it('plans answer plus verification with all four stages and synthesis reserve', async () => {
    const source = config({
      providers: {
        'brave-search': { enabled: true },
        'openai-chat': {
          enabled: true,
          options: { perRequestUsd: 0.002 },
        },
      },
    });
    const output = capture();

    const receipt = await executePlan(
      'staged plan',
      {
        providers: ['brave-search'],
        answer: true,
        verify: true,
        maxEstimatedCost: 0.02,
      },
      {
        ...deps(source, {
          BRAVE_API_KEY: 'brave',
          OPENAI_API_KEY: 'openai',
        }),
        stdout: output.stdout,
        stderr: output.stderr,
      },
    );

    expect(receipt.status).toBe('ready');
    if (receipt.status !== 'ready') return;
    expect(receipt.paid_stages).toEqual([
      expect.objectContaining({ stage: 'refinement', status: 'not_requested' }),
      expect.objectContaining({ stage: 'research', status: 'requested' }),
      expect.objectContaining({
        stage: 'synthesis',
        status: 'requested',
        synthesis_reservation: expect.objectContaining({
          state: 'known',
          cost_microusd: '2000',
        }),
      }),
      expect.objectContaining({ stage: 'verification', status: 'requested' }),
    ]);
    expect(output.output().stdout).toContain('Plan ready — preflight only');
    expect(output.output().stdout).toContain('verification: requested');
    expect(output.output().stdout).toContain('reserved $0.002000');
  });

  it('warns prominently when a requested unknown-cost helper is skipped', async () => {
    const source = config({
      providers: {
        'brave-search': { enabled: true },
        'openai-chat': { enabled: true },
      },
    });
    const output = capture();
    const receipt = await executePlan(
      'unknown helper',
      {
        providers: ['brave-search'],
        answer: true,
        maxCost: 0.02,
      },
      {
        ...deps(source, {
          BRAVE_API_KEY: 'brave',
          OPENAI_API_KEY: 'openai',
        }),
        stdout: output.stdout,
        stderr: output.stderr,
      },
    );

    expect(receipt.status).toBe('ready');
    if (receipt.status !== 'ready') return;
    expect(receipt.paid_stages[2]).toMatchObject({
      stage: 'synthesis',
      status: 'skipped',
      reason_code: 'unknown_cost_under_hard_budget',
      providers: [{ estimate: { state: 'unknown' } }],
    });
    expect(receipt.warnings).toContainEqual(
      expect.objectContaining({
        code: 'paid_stage_skipped',
        stage: 'synthesis',
      }),
    );
    expect(output.output().stdout).toContain('WARNINGS:');
    expect(output.output().stdout).toContain(
      'Requested synthesis will be skipped',
    );
  });

  it('requires --answer for verification and emits a blocked JSON receipt', async () => {
    const output = capture();
    const receipt = await executePlan(
      'invalid combination',
      { verify: true, json: true },
      { stdout: output.stdout, stderr: output.stderr },
    );

    expect(receipt).toMatchObject({
      status: 'blocked',
      ready: false,
      issues: [{ code: 'verification_requires_answer', path: '/verify' }],
    });
    expect(process.exitCode).toBe(2);
    expect(output.output().stderr).toBe('');
    expect(JSON.parse(output.output().stdout)).toEqual(receipt);
  });

  it('preserves actionable missing-credential and budget admission failures', async () => {
    for (const testCase of [
      {
        options: { providers: ['brave-search'] } satisfies PlanOptions,
        env: {},
        code: 'profile_uncredentialed',
      },
      {
        options: {
          providers: ['brave-search'],
          maxEstimatedCost: 0.001,
        } satisfies PlanOptions,
        env: { BRAVE_API_KEY: 'brave' },
        code: 'primary_plan_budget_exceeded',
      },
    ]) {
      const output = capture();
      const receipt = await executePlan('blocked plan', testCase.options, {
        ...deps(config(), testCase.env),
        stdout: output.stdout,
        stderr: output.stderr,
      });
      expect(receipt.status).toBe('blocked');
      if (receipt.status !== 'blocked') continue;
      expect(receipt.ready).toBe(false);
      expect(receipt.issues).toContainEqual(
        expect.objectContaining({ code: testCase.code }),
      );
      expect(output.output().stderr).toContain(testCase.code);
      expect(process.exitCode).toBe(2);
    }
  });

  it('validates structure before credential lookup', async () => {
    const credentialLookup = vi.fn(() => ({ env: {} }));
    const output = capture();

    const receipt = await executePlan(
      'invalid group',
      { group: '__missing__' },
      {
        loadGlobalConfig: () => config(),
        loadProjectConfig: () => null,
        createCredentials: credentialLookup,
        stdout: output.stdout,
        stderr: output.stderr,
      },
    );

    expect(receipt.status).toBe('blocked');
    expect(credentialLookup).not.toHaveBeenCalled();
  });

  it('never loads trusted npm or script declarations while planning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'librarium-plan-custom-'));
    roots.push(root);
    const marker = join(root, 'executed');
    const modulePath = join(root, 'provider.mjs');
    const scriptPath = join(root, 'provider-script.mjs');
    writeFileSync(
      modulePath,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'npm imported'); export default {};`,
    );
    writeFileSync(
      scriptPath,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'script spawned');`,
    );
    for (const customProvider of [
      { type: 'npm' as const, module: modulePath },
      {
        type: 'script' as const,
        command: process.execPath,
        args: [scriptPath],
      },
    ]) {
      const output = capture();
      const source = config({
        providers: { 'acme-adapter': { enabled: true } },
        customProviders: {
          'acme-adapter': {
            ...customProvider,
            executionProfile: {
              bindingId: 'acme.search.v1',
              profile: customExecutionProfile(),
            },
          },
        },
        trustedProviderIds: ['acme-adapter'],
      });
      const receipt = await executePlan(
        'custom provider',
        { providers: ['acme-adapter'] },
        {
          ...deps(source),
          stdout: output.stdout,
          stderr: output.stderr,
        },
      );
      expect(receipt).toMatchObject({
        status: 'ready',
        primary_profiles: [
          {
            provider_id: 'acme',
            adapter_id: 'acme-adapter',
            estimate: { state: 'unknown' },
          },
        ],
        guarantees: { custom_code_loaded: false },
      });
      if (receipt.status === 'ready') {
        const admission = receipt.paid_stages.find(
          ({ stage }) => stage === 'research',
        )?.initial_attempt_admission;
        expect(admission).toMatchObject({ status: 'admitted' });
        expect(admission).not.toHaveProperty(
          'projected_estimated_cost_microusd',
        );
        expect(admission).not.toHaveProperty('projected_actual_cost_microusd');
      }
      expect(existsSync(marker)).toBe(false);
    }
  });

  it('explains untrusted custom declarations without loading them', async () => {
    const output = capture();
    const source = config({
      providers: { 'acme-adapter': { enabled: true } },
      customProviders: {
        'acme-adapter': {
          type: 'npm',
          module: 'must-not-import',
          executionProfile: {
            bindingId: 'acme.search.v1',
            profile: customExecutionProfile(),
          },
        },
      },
      trustedProviderIds: [],
    });

    const receipt = await executePlan(
      'untrusted provider',
      { providers: ['acme-adapter'], json: true },
      {
        ...deps(source),
        stdout: output.stdout,
        stderr: output.stderr,
      },
    );

    expect(receipt.status).toBe('blocked');
    if (receipt.status !== 'blocked') return;
    expect(receipt.issues).toContainEqual(
      expect.objectContaining({
        code: expect.stringMatching(/custom_provider|provider_token_unknown/),
      }),
    );
    expect(output.output().stdout).not.toContain('must-not-import');
  });

  it('keeps no-fallback and authored quick alias semantics canonical', async () => {
    const fallbackSource = config({
      providers: {
        'brave-search': { enabled: true, fallback: 'exa' },
        exa: { enabled: true },
      },
    });
    const withFallback = prepareRunRequest(
      'configured reserve',
      { providers: ['brave-search'] },
      { refinement: false, synthesis: false, verification: false },
      deps(fallbackSource, { BRAVE_API_KEY: 'brave', EXA_API_KEY: 'exa' }),
    );
    expect(
      withFallback.preflight.prepared.request.fallback_reserve.map(
        ({ profile }) => profile.identity.provider_id,
      ),
    ).toEqual(['exa']);

    const noFallback = prepareRunRequest(
      'exact matrix',
      {
        providers: ['brave-search'],
        fallback: false,
      },
      { refinement: false, synthesis: false, verification: false },
      deps(fallbackSource, { BRAVE_API_KEY: 'brave', EXA_API_KEY: 'exa' }),
    );
    expect(noFallback.preflight.prepared.request.fallback_reserve).toEqual([]);
    expect(noFallback.stages.every((stage) => !stage.fallback_authorized)).toBe(
      true,
    );

    const authored = prepareRunRequest(
      'authored alias',
      { group: 'quick' },
      { refinement: false, synthesis: false, verification: false },
      deps(
        config({
          groups: { quick: ['brave-search'] },
        }),
        { BRAVE_API_KEY: 'brave' },
      ),
    );
    const receipt = buildPlanReceipt(authored, { group: 'quick' });
    expect(receipt.selector).toMatchObject({
      requested: 'quick',
      effective: 'custom:quick',
    });
    expect(receipt.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'configuration_group_alias_migrated' }),
    );
  });

  it('reports builtin quick omissions without widening the workflow', async () => {
    const preparation = prepareRunRequest(
      'quick plan',
      {},
      { refinement: false, synthesis: false, verification: false },
      deps(
        config({
          providers: {
            exa: { enabled: true },
            'brave-answers': { enabled: true },
            tavily: { enabled: true },
          },
        }),
        { EXA_API_KEY: 'exa', TAVILY_API_KEY: 'tavily' },
      ),
    );
    const receipt = buildPlanReceipt(preparation, {});

    expect(receipt.selector).toMatchObject({
      source: 'builtin_default',
      effective: 'quick',
    });
    expect(
      receipt.primary_profiles.map(({ provider_id }) => provider_id),
    ).toEqual(['exa']);
    expect(
      receipt.primary_profiles.map(({ provider_id }) => provider_id),
    ).not.toContain('tavily');
    expect(receipt.workflow_omissions).toContainEqual(
      expect.objectContaining({ profile: 'brave-answers/grounded' }),
    );
  });

  it('previews the same stage admission and reserve used by the real wallet', () => {
    const preparation = prepareRunRequest(
      'wallet parity',
      {
        providers: ['brave-search'],
        maxCost: 0.02,
      },
      { refinement: false, synthesis: true, verification: true },
      deps(
        config({
          providers: {
            'brave-search': { enabled: true },
            'openai-chat': {
              enabled: true,
              options: { perRequestUsd: 0.002 },
            },
          },
        }),
        { BRAVE_API_KEY: 'brave', OPENAI_API_KEY: 'openai' },
      ),
    );
    const prepared = preparation.preflight.prepared;
    const wallet = new RunPaidWallet({
      request_id: prepared.request.request_id,
      request_fingerprint: fingerprint(prepared.request),
      config_fingerprint: fingerprint(preparation.config),
      created_at: prepared.request.requested_at,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      limits: prepared.policy.budgets,
      stages: preparation.stageDeclarations,
      now: () => Date.now(),
    });

    expect(wallet.snapshot().limits).toEqual(prepared.policy.budgets);
    expect(wallet.snapshot().stages).toEqual(preparation.stages);
  });

  it.each([
    ['maxEstimatedCost', 'estimated_budget_exhausted'],
    ['maxCost', 'actual_budget_exhausted'],
  ] as const)(
    'matches real first-attempt wallet rejection for %s',
    (limit, reasonCode) => {
      const source = config({
        providers: {
          'brave-search': { enabled: true },
          'openai-chat': {
            enabled: true,
            options: { perRequestUsd: 0.002 },
          },
        },
      });
      const options = {
        providers: ['brave-search'],
        answer: true,
        [limit]: 0.006,
      } satisfies PlanOptions;
      const preparation = prepareRunRequest(
        'wallet attempt parity',
        options,
        { refinement: false, synthesis: true, verification: false },
        deps(source, {
          BRAVE_API_KEY: 'brave',
          OPENAI_API_KEY: '[REDACTED:api-key]',
        }),
      );
      const receipt = buildPlanReceipt(preparation, options);
      const research = receipt.paid_stages.find(
        ({ stage }) => stage === 'research',
      );
      expect(research?.initial_attempt_admission).toMatchObject({
        status: 'blocked',
        reason_code: reasonCode,
        basis: 'empty_paid_attempt_ledger',
        conditional_on_prior_attempts: false,
        future_reserved_cost_microusd: '2000',
      });
      expect(receipt.warnings).toContainEqual(
        expect.objectContaining({
          code: 'paid_stage_initial_attempt_blocked',
          stage: 'research',
          reason: reasonCode,
        }),
      );

      const prepared = preparation.preflight.prepared;
      const wallet = new RunPaidWallet({
        request_id: prepared.request.request_id,
        request_fingerprint: fingerprint(prepared.request),
        config_fingerprint: fingerprint(preparation.config),
        created_at: prepared.request.requested_at,
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
        limits: prepared.policy.budgets,
        stages: preparation.stageDeclarations,
      });
      const provider = preparation.stages.find(
        ({ stage }) => stage === 'research',
      )?.providers[0];
      expect(provider).toBeDefined();
      expect(() =>
        wallet.begin({
          stage: 'research',
          provider: provider?.provider ?? '',
          profile: provider?.profile,
          model: provider?.model,
          estimated_cost_microusd: provider?.estimated_cost_microusd,
          estimate_source: provider?.estimate_source,
          input_fingerprint: fingerprint('research'),
        }),
      ).toThrowError(reasonCode);
      expect(wallet.snapshot().attempts[0]?.reason_code).toBe(reasonCode);
    },
  );

  it('accounts for synthesis reserve when previewing refinement admission', () => {
    const source = config({
      providers: {
        'brave-search': { enabled: true },
        'openai-chat': {
          enabled: true,
          options: { perRequestUsd: 0.005 },
        },
      },
    });
    const options = {
      providers: ['brave-search'],
      refine: true,
      answer: true,
      maxEstimatedCost: 0.006,
    } satisfies PlanOptions;
    const preparation = prepareRunRequest(
      'refinement reserve parity',
      options,
      { refinement: true, synthesis: true, verification: false },
      deps(source, {
        BRAVE_API_KEY: 'brave',
        OPENAI_API_KEY: '[REDACTED:api-key]',
      }),
    );
    const receipt = buildPlanReceipt(preparation, options);

    expect(receipt.paid_stages[0]?.initial_attempt_admission).toMatchObject({
      status: 'blocked',
      reason_code: 'estimated_budget_exhausted',
      conditional_on_prior_attempts: false,
      future_reserved_cost_microusd: '5000',
      projected_estimated_cost_microusd: '10000',
    });
    expect(receipt.paid_stages[1]?.initial_attempt_admission).toMatchObject({
      conditional_on_prior_attempts: true,
    });

    const prepared = preparation.preflight.prepared;
    const wallet = new RunPaidWallet({
      request_id: prepared.request.request_id,
      request_fingerprint: fingerprint(prepared.request),
      config_fingerprint: fingerprint(preparation.config),
      created_at: prepared.request.requested_at,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      limits: prepared.policy.budgets,
      stages: preparation.stageDeclarations,
    });
    const provider = preparation.stages[0]?.providers[0];
    expect(provider).toBeDefined();
    expect(() =>
      wallet.begin({
        stage: 'refinement',
        provider: provider?.provider ?? '',
        profile: provider?.profile,
        model: provider?.model,
        estimated_cost_microusd: provider?.estimated_cost_microusd,
        estimate_source: provider?.estimate_source,
        input_fingerprint: fingerprint('refinement'),
      }),
    ).toThrowError('estimated_budget_exhausted');
    expect(wallet.snapshot().attempts[0]?.reason_code).toBe(
      receipt.paid_stages[0]?.initial_attempt_admission.reason_code,
    );
  });

  it('reports the exact canonical configurable preset and underlying model', async () => {
    const target = {
      primary: {
        model_selection: 'configurable' as const,
        kind: 'preset' as const,
        target_id: 'pro',
      },
      underlying: {
        model_selection: 'configurable' as const,
        kind: 'model' as const,
        target_id: 'model-v2',
      },
    };
    const source = config({
      providers: { 'acme-adapter': { enabled: true } },
      customProviders: {
        'acme-adapter': {
          type: 'npm',
          module: 'not-loaded',
          executionProfile: {
            bindingId: 'acme.search.v1',
            profile: {
              ...customExecutionProfile(),
              identity: {
                provider_id: 'acme',
                profile_id: 'search',
                target,
              },
            },
          },
        },
      },
      trustedProviderIds: ['acme-adapter'],
    });
    const preparation = prepareRunRequest(
      'target agreement',
      { providers: ['acme-adapter'] },
      { refinement: false, synthesis: false, verification: false },
      deps(source),
    );
    const output = capture();
    const receipt = await executePlan(
      'target agreement',
      { providers: ['acme-adapter'] },
      { ...deps(source), stdout: output.stdout, stderr: output.stderr },
    );

    expect(receipt.status).toBe('ready');
    if (receipt.status !== 'ready') return;
    expect(receipt.primary_profiles[0]?.target).toEqual(
      preparation.preflight.prepared.request.slots[0]?.primary.identity.target,
    );
    expect(receipt.primary_profiles[0]?.target).toEqual(target);
    expect(output.output().stdout).toContain('preset pro (configurable)');
    expect(output.output().stdout).toContain(
      'underlying model model-v2 (configurable)',
    );
  });
});
