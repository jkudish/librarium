import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBrowseRunView } from '../src/commands/browse-data.js';
import type { ExecutionProfile } from '../src/contracts/domain/index.js';
import {
  advanceCoordination,
  cancelCoordination,
  createCoordinatorState,
} from '../src/core/coordinator.js';
import type { PreparedResearchExecution } from '../src/core/execution-plan.js';
import { profileIdentityKey } from '../src/core/execution-plan.js';
import { BUILTIN_PROFILE_BINDING_SPECS } from '../src/core/profile-bindings.js';
import { buildProviderCatalog } from '../src/core/profile-catalog.js';
import { BUILTIN_PROVIDER_CATALOG } from '../src/core/provider-profiles.js';
import { RunManifestError, readRunManifest } from '../src/core/run-manifest.js';
import { checkAsyncTasks } from '../src/mcp/async.js';
import { readRunResults, resolveRunDir } from '../src/mcp/shaping.js';
import { writeCanonicalPresentationArtifacts } from '../src/node-canonical-artifacts.js';
import { projectCanonicalRunPresentation } from '../src/node-canonical-presentation.js';
import {
  CanonicalRunManifestV3Schema,
  cancelCanonicalRun,
  createRegisteredProviderAttemptBridge,
  RunJsonCoordinationStateStore,
  readCanonicalRunManifest,
  resumeCanonicalPreparedExecution,
  runCanonicalPreparedExecution,
} from '../src/node-canonical-run.js';
import {
  fingerprint,
  type PaidStageDeclaration,
  RunPaidWallet,
} from '../src/run-paid-wallet.js';
import type { Provider, ProviderResult } from '../src/types.js';

const START = Date.parse('2026-08-11T12:00:00.000Z');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function directories() {
  const root = join(tmpdir(), `librarium-canonical-${crypto.randomUUID()}`);
  const runDirectory = join(root, 'request-1');
  mkdirSync(runDirectory, { recursive: true });
  roots.push(root);
  return { root, runDirectory };
}

function profile(
  providerId: string,
  invocation: 'inline' | 'background' = 'inline',
): ExecutionProfile {
  return {
    identity: {
      provider_id: providerId,
      profile_id: 'fixture',
      target: {
        primary: {
          model_selection: 'fixed',
          kind: 'model',
          target_id: `${providerId}-model`,
        },
      },
    },
    result_kind: 'grounded_answer',
    grounding_policy: 'required',
    observation_mode: 'api_output',
    corpora: ['web'],
    retrieval_method: 'model_search_tool',
    access_mode: 'direct',
    operator_id: providerId,
    invocation,
    resumability: invocation === 'inline' ? 'none' : 'durable',
  };
}

function surfaceProfiles(): readonly ExecutionProfile[] {
  const providerConfigs = Object.fromEntries(
    BUILTIN_PROFILE_BINDING_SPECS.map((spec) => [
      spec.adapter_id,
      { enabled: true },
    ]),
  );
  const env = Object.fromEntries(
    BUILTIN_PROVIDER_CATALOG.map((entry) => [
      entry.credential.env_var,
      'test-credential',
    ]),
  );
  const catalog = buildProviderCatalog({
    providerConfigs,
    credentials: { env },
  });
  return [
    'searchapi-chatgpt',
    'searchapi-gemini',
    'searchapi-perplexity',
    'searchapi-google-ai-mode',
    'searchapi-bing-copilot',
    'searchapi-google-ai-overview',
  ].map((providerId) => {
    const resolved = catalog.get(providerId, 'surface');
    if (!resolved) throw new Error(`missing surface ${providerId}`);
    return resolved.profile;
  });
}

function prepared(
  profiles: readonly ExecutionProfile[],
  mode: 'sync' | 'async' = 'sync',
): PreparedResearchExecution {
  return {
    request: {
      interchange_version: '1.0.0',
      message_type: 'request',
      request_id: 'request-1',
      requested_at: new Date(START).toISOString(),
      mode,
      query: 'canonical persistence',
      slots: profiles.map((item, position) => ({
        slot_id: `slot-${position}`,
        position,
        requirements: {
          result_kind: item.result_kind,
          grounding_policy: item.grounding_policy,
          corpora: [...item.corpora],
          retrieval_methods: [item.retrieval_method],
        },
        primary: item,
      })),
      fallback_reserve: [],
    },
    policy: {
      limits: {
        max_concurrency: profiles.length,
        request_deadline_ms: 60_000,
        inline_attempt_deadline_ms: 10_000,
        background_attempt_deadline_ms: 20_000,
        poll_interval_ms: 1_000,
      },
      fallback: { kind: 'disabled' },
      exclusions: [],
      refinement: { kind: 'disabled' },
    },
    profile_plans_by_identity: Object.fromEntries(
      profiles.map((item) => {
        const key = profileIdentityKey(item.identity);
        return [
          key,
          {
            profile_key: key,
            identity: item.identity,
            binding: {
              adapter_id: `adapter-${item.identity.provider_id}`,
              binding_id: `binding-${item.identity.provider_id}`,
            },
          },
        ];
      }),
    ),
    catalog: { revision: 'catalog-r1', digest: 'catalog-digest' },
    notices: [],
  };
}

function coordinator(prefix = '') {
  let next = 0;
  return {
    clock: { now: () => START },
    ids: {
      next: (scope: 'attempt' | 'event' | 'delivery_lease') =>
        `${prefix}${scope}-${++next}`,
    },
  };
}

function success(provider: string): ProviderResult {
  return {
    provider,
    tier: 'ai-grounded',
    content: '# Durable result',
    citations: [
      {
        provider,
        url: 'https://example.com/source',
        title: 'Source',
        snippet: 'Evidence',
      },
    ],
    durationMs: 5,
    model: 'observed-model',
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.125,
      raw: { authorization: 'Bearer secret' },
    },
    providerMeta: {
      'fixture:artifact': {
        kind: 'pdf',
        url: 'https://example.com/report.pdf?expires=soon',
      },
    },
  };
}

function exactBindings(
  profiles: readonly ExecutionProfile[],
  providers: Readonly<Record<string, Provider>>,
) {
  return {
    resolveExactBinding(binding: { adapter_id: string; binding_id: string }) {
      const item = profiles.find(
        (candidate) =>
          `adapter-${candidate.identity.provider_id}` === binding.adapter_id,
      );
      const provider = providers[binding.adapter_id];
      return item && provider
        ? {
            binding,
            profile: item,
            catalog_digest: 'catalog-digest',
            provider,
          }
        : undefined;
    },
    now: () => START,
    wait: async () => {},
  };
}

describe('canonical v3 run.json', () => {
  it('serializes concurrent compare-and-swap updates with one monotonic winner', async () => {
    const { root, runDirectory } = directories();
    const plan = prepared([profile('primary')]);
    const state = createCoordinatorState(plan, coordinator());
    const store = new RunJsonCoordinationStateStore({
      runs_root: root,
      run_directory: runDirectory,
      request: plan.request,
    });
    const created = await store.create(state);
    const left = structuredClone(created.state);
    const right = structuredClone(created.state);
    left.poll_interval_ms = 2_000;
    right.poll_interval_ms = 3_000;

    const results = await Promise.all([
      store.compareAndSwap('request-1', created.version, left),
      store.compareAndSwap('request-1', created.version, right),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(store.readManifest().revision).toBe(2);
    expect(readdirSync(runDirectory).sort()).toEqual(['run.json']);
  });

  it('atomically stores a safe result and immutable terminal projection', async () => {
    const { root, runDirectory } = directories();
    const selected = profile('primary');
    const provider: Provider = {
      id: 'adapter-primary',
      displayName: 'Primary',
      tier: 'ai-grounded',
      envVar: '',
      execution: 'inline',
      execute: vi.fn(async () => success('adapter-primary')),
    };

    const result = await runCanonicalPreparedExecution(prepared([selected]), {
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator(),
      attempt_bridge: exactBindings([selected], {
        'adapter-primary': provider,
      }),
    });
    expect(result.response?.results[0]?.citations).toHaveLength(1);

    expect(result.response).toMatchObject({
      request_id: 'request-1',
      status: 'succeeded',
      results: [
        {
          requested_profile: 'fixture',
          provider: 'primary',
          profile: 'fixture',
          model: 'observed-model',
        },
      ],
      errors: [],
    });
    expect(Object.isFrozen(result.response)).toBe(true);
    expect(Object.isFrozen(result.response?.results[0])).toBe(true);
    const raw = readFileSync(join(runDirectory, 'run.json'), 'utf8');
    expect(raw).not.toContain('Bearer secret');
    expect(raw).not.toContain('authorization');
    expect(raw).not.toContain('durable_handle":');
    expect(JSON.parse(raw)).toMatchObject({
      schemaVersion: 3,
      artifact_name: 'run_manifest',
      artifact_version: '3.0.0',
      terminal_response: { status: 'succeeded' },
    });
    expect(() => readRunManifest(runDirectory)).toThrow(RunManifestError);
  });

  it('does not invoke the research adapter when the run-wide wallet preserves synthesis reserve', async () => {
    const { root, runDirectory } = directories();
    const selected = profile('budgeted');
    const plan = prepared([selected]);
    const profileKey = profileIdentityKey(selected.identity);
    const frozenPlan = plan.profile_plans_by_identity[profileKey];
    if (!frozenPlan) throw new Error('missing fixture plan');
    plan.profile_plans_by_identity[profileKey] = {
      ...frozenPlan,
      estimate: { estimated_cost_microusd: '100' },
    };
    plan.policy = {
      ...plan.policy,
      budgets: {
        max_estimated_cost_microusd: '100',
        max_actual_cost_microusd: '100',
      },
    };
    const execute = vi.fn(async () => success('adapter-budgeted'));
    const stages: PaidStageDeclaration[] = [
      {
        stage: 'refinement',
        requested: false,
        fallback_authorized: false,
        prompt_version: 'refine-v1',
        providers: [],
      },
      {
        stage: 'research',
        requested: true,
        fallback_authorized: false,
        prompt_version: 'research-v1',
        providers: [
          {
            provider: 'adapter-budgeted',
            profile: profileKey,
            estimated_cost_microusd: '100',
          },
        ],
      },
      {
        stage: 'synthesis',
        requested: true,
        fallback_authorized: false,
        prompt_version: 'synthesis-v1',
        providers: [
          {
            provider: 'openai',
            model: 'model-a',
            estimated_cost_microusd: '100',
          },
        ],
        reserve_first_attempt: true,
      },
      {
        stage: 'verification',
        requested: false,
        fallback_authorized: false,
        prompt_version: 'verification-v1',
        providers: [],
      },
    ];
    const wallet = new RunPaidWallet({
      request_id: 'request-1',
      request_fingerprint: fingerprint(plan.request),
      config_fingerprint: fingerprint('config'),
      created_at: new Date(START).toISOString(),
      deadline_at: new Date(START + 60_000).toISOString(),
      limits: plan.policy.budgets,
      stages,
      now: () => START,
    });

    const result = await runCanonicalPreparedExecution(plan, {
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator(),
      attempt_bridge: exactBindings([selected], {
        'adapter-budgeted': {
          id: 'adapter-budgeted',
          displayName: 'Budgeted',
          tier: 'ai-grounded',
          envVar: '',
          execution: 'inline',
          execute,
        },
      }),
      paid_wallet: wallet,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.response?.status).toBe('failed');
    expect(wallet.snapshot().attempts).toEqual([
      expect.objectContaining({
        stage: 'research',
        status: 'blocked',
        reason_code: 'estimated_budget_exhausted',
      }),
    ]);
  });

  it('writes derived artifacts without changing the v3 authority', async () => {
    const { root, runDirectory } = directories();
    const selected = profile('primary');
    const provider: Provider = {
      id: 'adapter-primary',
      displayName: 'Primary',
      tier: 'ai-grounded',
      envVar: '',
      execution: 'inline',
      execute: async () => success('adapter-primary'),
    };
    const result = await runCanonicalPreparedExecution(prepared([selected]), {
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator(),
      attempt_bridge: createRegisteredProviderAttemptBridge(
        prepared([selected]),
        () => provider,
        () => START,
      ),
    });
    expect(result.response?.status).toBe('succeeded');
    const before = readFileSync(join(runDirectory, 'run.json'), 'utf8');
    expect(
      result.manifest.terminal_response?.results[0]?.citations,
    ).toHaveLength(1);
    expect(result.manifest.coordination_state.slots[0]?.result_id).toBe(
      result.manifest.terminal_response?.results[0]?.id,
    );
    const presentation = writeCanonicalPresentationArtifacts(
      result.manifest,
      runDirectory,
      'fixture',
    );
    expect(presentation.sources).toMatchObject([
      { normalizedUrl: 'example.com/source', providers: ['adapter-primary'] },
    ]);
    expect(readFileSync(join(runDirectory, 'run.json'), 'utf8')).toBe(before);
    expect(readdirSync(runDirectory)).not.toContain('coordination.json');
    expect(
      readdirSync(runDirectory).filter((name) => name === 'run.json'),
    ).toHaveLength(1);
    expect(resolveRunDir(root)).toBe(realpathSync(runDirectory));
    expect(readRunResults(runDirectory)?.results[0]?.content).toContain(
      '# Durable result',
    );
    const outputFile = presentation.reports[0]?.outputFile;
    expect(outputFile).toBeDefined();
    const metaFile = presentation.reports[0]?.metaFile;
    expect(metaFile).toBeDefined();
    expect(
      JSON.parse(readFileSync(join(runDirectory, metaFile as string), 'utf8')),
    ).toMatchObject({
      providerMeta: {
        'fixture:artifact': {
          kind: 'pdf',
          url: 'https://example.com/report.pdf?expires=soon',
        },
      },
    });
    const outside = join(root, 'outside.md');
    writeFileSync(outside, 'must not leak');
    rmSync(join(runDirectory, outputFile as string));
    symlinkSync(outside, join(runDirectory, outputFile as string));
    const safe = readRunResults(runDirectory);
    expect(safe?.results[0]?.content).toContain('# Durable result');
    expect(safe?.results[0]?.content).not.toContain('must not leak');
  });

  it('keeps failed primary presentation when its fallback succeeds', async () => {
    const { root, runDirectory } = directories();
    const primary = profile('primary');
    const fallback = profile('fallback');
    const base = prepared([primary]);
    const fallbackKey = profileIdentityKey(fallback.identity);
    const plan: PreparedResearchExecution = {
      ...base,
      request: {
        ...base.request,
        fallback_reserve: [
          {
            candidate_id: 'candidate-1',
            position: 0,
            profile: fallback,
            eligible_slot_ids: ['slot-0'],
          },
        ],
      },
      policy: {
        ...base.policy,
        fallback: {
          kind: 'explicit',
          reserve: [{ provider_id: 'fallback', profile_id: 'fixture' }],
        },
      },
      profile_plans_by_identity: {
        ...base.profile_plans_by_identity,
        [fallbackKey]: {
          profile_key: fallbackKey,
          identity: fallback.identity,
          binding: {
            adapter_id: 'adapter-fallback',
            binding_id: 'binding-fallback',
          },
        },
      },
    };
    const primaryProvider: Provider = {
      id: 'adapter-primary',
      displayName: 'Primary',
      tier: 'ai-grounded',
      envVar: '',
      execution: 'inline',
      execute: async () => {
        return {
          ...success('adapter-primary'),
          error: 'primary failed',
          preventFallback: undefined,
        };
      },
    };
    const fallbackProvider: Provider = {
      id: 'adapter-fallback',
      displayName: 'Fallback',
      tier: 'ai-grounded',
      envVar: '',
      execution: 'inline',
      execute: async () => success('adapter-fallback'),
    };
    const result = await runCanonicalPreparedExecution(plan, {
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator(),
      attempt_bridge: createRegisteredProviderAttemptBridge(
        plan,
        (id) => (id === 'adapter-primary' ? primaryProvider : fallbackProvider),
        () => START,
      ),
    });
    expect(result.response?.status).toBe('succeeded');
    const presentation = projectCanonicalRunPresentation(
      result.manifest,
      runDirectory,
      'fixture',
    );
    expect(presentation.reports).toMatchObject([
      { id: 'adapter-primary', status: 'error' },
      {
        id: 'adapter-fallback',
        status: 'success',
        fallbackFor: 'adapter-primary',
      },
    ]);
    expect(presentation.sources[0]?.providers).toEqual(['adapter-fallback']);
  });

  it('derives partial and failed terminal shapes from exact slot outcomes', async () => {
    const partialDirs = directories();
    const first = profile('first');
    const second = profile('second');
    const good: Provider = {
      id: 'adapter-first',
      displayName: 'Good',
      tier: 'ai-grounded',
      envVar: '',
      execution: 'inline',
      execute: async () => success('adapter-first'),
    };
    const bad: Provider = {
      id: 'adapter-second',
      displayName: 'Bad',
      tier: 'ai-grounded',
      envVar: '',
      execution: 'inline',
      execute: async () => ({
        ...success('adapter-second'),
        error: 'provider failure containing a secret-token',
      }),
    };
    const partial = await runCanonicalPreparedExecution(
      prepared([first, second]),
      {
        runs_root: partialDirs.root,
        run_directory: partialDirs.runDirectory,
        coordinator: coordinator(),
        attempt_bridge: exactBindings([first, second], {
          'adapter-first': good,
          'adapter-second': bad,
        }),
      },
    );
    expect(partial.response?.status).toBe('partial');
    expect(partial.response?.results).toHaveLength(1);
    expect(partial.response?.errors).toHaveLength(1);

    const failedDirs = directories();
    const failed = await runCanonicalPreparedExecution(prepared([second]), {
      runs_root: failedDirs.root,
      run_directory: failedDirs.runDirectory,
      coordinator: coordinator('failed-'),
      attempt_bridge: exactBindings([second], { 'adapter-second': bad }),
    });
    expect(failed.response).toMatchObject({
      status: 'failed',
      results: [],
      errors: [{ code: 'librarium.provider_reported_error' }],
    });
    expect(
      readFileSync(join(failedDirs.runDirectory, 'run.json'), 'utf8'),
    ).not.toContain('secret-token');
  });

  it('resumes an accepted durable handle without re-admission or resubmission', async () => {
    const { root, runDirectory } = directories();
    const durableProfile = profile('durable', 'background');
    const submit = vi.fn(async () => ({
      provider: 'adapter-durable',
      taskId: 'public-task-id',
      query: 'canonical persistence',
      submittedAt: START,
      status: 'pending' as const,
    }));
    const poll = vi.fn(async () => ({ status: 'completed' as const }));
    const retrieve = vi.fn(async () => success('adapter-durable'));
    const provider: Provider = {
      id: 'adapter-durable',
      displayName: 'Durable',
      tier: 'deep-research',
      envVar: '',
      execution: 'background',
      execute: vi.fn(),
      submit,
      poll,
      retrieve,
    };

    const accepted = await runCanonicalPreparedExecution(
      prepared([durableProfile], 'async'),
      {
        runs_root: root,
        run_directory: runDirectory,
        coordinator: coordinator(),
        attempt_bridge: exactBindings([durableProfile], {
          'adapter-durable': provider,
        }),
      },
    );
    expect(accepted.response).toBeUndefined();
    expect(accepted.runtime.state.attempts[0]).toMatchObject({
      status: 'submitted',
      durable_handle: { provider_task_id: 'public-task-id' },
    });
    const pendingBrowse =
      readBrowseRunView(runDirectory)?.presentation.providers[0];
    expect(pendingBrowse?.report.status).toBe('async-pending');
    expect(Object.hasOwn(pendingBrowse ?? {}, 'content')).toBe(false);

    const resumed = await resumeCanonicalPreparedExecution({
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator('resume-'),
      attempt_bridge: exactBindings([durableProfile], {
        'adapter-durable': provider,
      }),
    });

    expect(submit).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalledOnce();
    expect(retrieve).toHaveBeenCalledOnce();
    expect(resumed.response?.status).toBe('succeeded');
    expect(readdirSync(runDirectory).sort()).toEqual(['run.json']);
  });

  it('routes v3 check_async through one idempotent canonical resume pass', async () => {
    const { root, runDirectory } = directories();
    const durableProfile = profile('durable', 'background');
    const submit = vi.fn(async () => ({
      provider: 'adapter-durable',
      taskId: 'private-task-id',
      query: 'canonical persistence',
      submittedAt: START,
      status: 'pending' as const,
    }));
    const poll = vi.fn(async () => ({ status: 'completed' as const }));
    const retrieve = vi.fn(async () => success('adapter-durable'));
    const provider: Provider = {
      id: 'adapter-durable',
      displayName: 'Durable',
      tier: 'deep-research',
      envVar: '',
      execution: 'background',
      execute: vi.fn(),
      submit,
      poll,
      retrieve,
    };
    const plan = prepared([durableProfile], 'async');
    await runCanonicalPreparedExecution(plan, {
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator(),
      attempt_bridge: exactBindings([durableProfile], {
        'adapter-durable': provider,
      }),
    });
    const config = {
      version: 1 as const,
      defaults: {
        outputDir: root,
        maxParallel: 1,
        timeout: 30,
        asyncTimeout: 60,
        asyncPollInterval: 1,
        mode: 'async' as const,
        llmWebSearch: true,
      },
      providers: {},
      customProviders: {},
      trustedProviderIds: [],
      groups: {},
    };
    const dependencies = {
      initialize: vi.fn(async () => ({
        warnings: [],
        loadedCustomProviders: [],
        skippedCustomProviders: [],
      })),
      resolveExactProvider: () => provider,
      resumeCanonical: (
        input: Parameters<typeof resumeCanonicalPreparedExecution>[0],
      ) =>
        resumeCanonicalPreparedExecution({
          ...input,
          attempt_bridge: { ...input.attempt_bridge, now: () => START },
        }),
      onError: (error: unknown) => {
        throw error;
      },
      coordinator: coordinator('check-'),
    };
    const first = await checkAsyncTasks(
      runDirectory,
      false,
      config,
      dependencies,
    );
    if (first.error) throw new Error(JSON.stringify(first));
    const revision = readCanonicalRunManifest(root, runDirectory).revision;
    const second = await checkAsyncTasks(
      runDirectory,
      true,
      config,
      dependencies,
    );
    expect(first).toMatchObject({
      state: 'terminal',
      retrieved: 1,
      tasks: [],
      response: { status: 'succeeded' },
    });
    expect(JSON.stringify(first)).not.toContain('private-task-id');
    expect(second).toMatchObject({
      state: 'terminal',
      retrieved: 0,
      tasks: [],
      response: { status: 'succeeded' },
    });
    expect(readCanonicalRunManifest(root, runDirectory).revision).toBe(
      revision,
    );
    expect(submit).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalledOnce();
    expect(retrieve).toHaveBeenCalledOnce();
  });

  it('attempts remote cancellation only for accepted pending/running work', async () => {
    const { root, runDirectory } = directories();
    const durableProfile = profile('durable', 'background');
    const cancel = vi.fn(async (handle) => ({
      status: 'cancelled' as const,
      rawStatus: `cancelled:${handle.taskId}`,
    }));
    const provider: Provider = {
      id: 'adapter-durable',
      displayName: 'Durable',
      tier: 'deep-research',
      envVar: '',
      execution: 'background',
      execute: vi.fn(),
      submit: async () => ({
        provider: 'adapter-durable',
        taskId: 'task-1',
        query: 'canonical persistence',
        submittedAt: START,
        status: 'pending',
      }),
      poll: vi.fn(),
      retrieve: vi.fn(),
      cancel,
    };
    await runCanonicalPreparedExecution(prepared([durableProfile], 'async'), {
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator(),
      attempt_bridge: exactBindings([durableProfile], {
        'adapter-durable': provider,
      }),
    });
    const cancelled = await cancelCanonicalRun({
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator('cancel-'),
      attempt_bridge: exactBindings([durableProfile], {
        'adapter-durable': provider,
      }),
    });
    expect(cancelled.coordination_state.status).toBe('cancelled');
    expect(cancelled.terminal_response?.status).toBe('failed');
    expect(cancelled.coordination_state.attempts).toHaveLength(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(
      cancelled.coordination_state.attempts[0]?.durable_handle,
    ).toMatchObject({ provider_task_id: 'task-1', status: 'cancelled' });
    const repeated = await cancelCanonicalRun({
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator('repeat-'),
      attempt_bridge: exactBindings([durableProfile], {
        'adapter-durable': provider,
      }),
    });
    expect(repeated.coordination_state.status).toBe('cancelled');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['no-hook', undefined],
    [
      'cancel-error',
      vi.fn(async () => {
        throw new Error('Authorization: Bearer cancel-secret');
      }),
    ],
  ])(
    'commits local cancellation for %s providers',
    async (_case, cancelHook) => {
      const { root, runDirectory } = directories();
      const durableProfile = profile('durable', 'background');
      const provider: Provider = {
        id: 'adapter-durable',
        displayName: 'Durable',
        tier: 'deep-research',
        envVar: '',
        execution: 'background',
        execute: vi.fn(),
        submit: async () => ({
          provider: 'adapter-durable',
          taskId: 'task-unchanged',
          query: 'canonical persistence',
          submittedAt: START,
          status: 'running',
        }),
        poll: vi.fn(),
        retrieve: vi.fn(),
        ...(cancelHook && { cancel: cancelHook }),
      };
      const bindings = exactBindings([durableProfile], {
        'adapter-durable': provider,
      });
      await runCanonicalPreparedExecution(prepared([durableProfile], 'async'), {
        runs_root: root,
        run_directory: runDirectory,
        coordinator: coordinator(),
        attempt_bridge: bindings,
      });
      const before = readCanonicalRunManifest(root, runDirectory)
        .coordination_state.attempts[0]?.durable_handle;
      const cancelled = await cancelCanonicalRun({
        runs_root: root,
        run_directory: runDirectory,
        coordinator: coordinator('cancel-'),
        attempt_bridge: bindings,
      });
      expect(cancelled.coordination_state.status).toBe('cancelled');
      expect(cancelled.coordination_state.attempts[0]?.durable_handle).toEqual(
        before,
      );
      expect(JSON.stringify(cancelled)).not.toContain('cancel-secret');
    },
  );

  it('does not let late cancellation overwrite a terminal success', async () => {
    const { root, runDirectory } = directories();
    const selected = profile('primary');
    const provider: Provider = {
      id: 'adapter-primary',
      displayName: 'Primary',
      tier: 'ai-grounded',
      envVar: '',
      execution: 'inline',
      execute: async () => success('adapter-primary'),
    };
    const completed = await runCanonicalPreparedExecution(
      prepared([selected]),
      {
        runs_root: root,
        run_directory: runDirectory,
        coordinator: coordinator(),
        attempt_bridge: exactBindings([selected], {
          'adapter-primary': provider,
        }),
      },
    );
    expect(completed.response?.status).toBe('succeeded');
    const before = readFileSync(join(runDirectory, 'run.json'), 'utf8');
    const cancelled = await cancelCanonicalRun({
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator('late-cancel-'),
    });
    expect(cancelled.coordination_state.status).toBe('succeeded');
    expect(cancelled.terminal_response?.status).toBe('succeeded');
    expect(readFileSync(join(runDirectory, 'run.json'), 'utf8')).toBe(before);
  });

  it('preserves terminal success when completion wins a cancellation race', async () => {
    const { root, runDirectory } = directories();
    const durableProfile = profile('durable', 'background');
    let releaseCancel: (() => void) | undefined;
    const cancelStarted = Promise.withResolvers<void>();
    const cancel = vi.fn(
      () =>
        new Promise<{ status: 'cancelled' }>((resolve) => {
          cancelStarted.resolve();
          releaseCancel = () => resolve({ status: 'cancelled' });
        }),
    );
    const provider: Provider = {
      id: 'adapter-durable',
      displayName: 'Durable',
      tier: 'deep-research',
      envVar: '',
      execution: 'background',
      execute: vi.fn(),
      submit: async () => ({
        provider: 'adapter-durable',
        taskId: 'task-race',
        query: 'canonical persistence',
        submittedAt: START,
        status: 'running',
      }),
      poll: vi.fn(async () => ({ status: 'completed' as const })),
      retrieve: vi.fn(async () => success('adapter-durable')),
      cancel,
    };
    const bindings = exactBindings([durableProfile], {
      'adapter-durable': provider,
    });
    await runCanonicalPreparedExecution(prepared([durableProfile], 'async'), {
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator(),
      attempt_bridge: bindings,
    });
    const cancellation = cancelCanonicalRun({
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator('cancel-'),
      attempt_bridge: bindings,
    });
    await cancelStarted.promise;
    const completed = await resumeCanonicalPreparedExecution({
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator('resume-'),
      attempt_bridge: bindings,
    });
    expect(completed.response?.status).toBe('succeeded');
    releaseCancel?.();
    const raced = await cancellation;
    expect(raced.coordination_state.status).toBe('succeeded');
    expect(raced.coordination_state.attempts[0]).toMatchObject({
      status: 'succeeded',
      durable_handle: { status: 'succeeded', provider_task_id: 'task-race' },
    });
    expect(raced.terminal_response?.status).toBe('succeeded');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('projects specialized Valyu provenance without widening public corpora', async () => {
    const { root, runDirectory } = directories();
    const selected: ExecutionProfile = {
      ...profile('valyu'),
      corpora: ['specialized'],
    };
    const provider: Provider = {
      id: 'adapter-valyu',
      displayName: 'Valyu',
      tier: 'raw-search',
      envVar: '',
      execution: 'inline',
      execute: async () => ({
        provider: 'adapter-valyu',
        tier: 'raw-search',
        content: '# Specialized result',
        durationMs: 7,
        usage: { costUsd: 0.004 },
        citations: [
          {
            provider: 'adapter-valyu',
            url: 'https://example.com/study',
            title: 'Study',
            providerReference: 'valyu/medical/study-1',
            sourceKind: 'web_page',
            publisher: 'valyu/medical',
          },
        ],
        providerMeta: {
          'valyu:transaction_id': 'tx-specialized',
          'valyu:dataset': 'valyu/medical',
        },
      }),
    };
    const result = await runCanonicalPreparedExecution(prepared([selected]), {
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator(),
      attempt_bridge: exactBindings([selected], { 'adapter-valyu': provider }),
    });
    expect(result.response?.results[0]).toMatchObject({
      provenance: { corpora: [] },
      usage: { actual_cost: '0.004', currency: 'USD' },
      citations: [
        {
          source: {
            provider_reference: 'valyu/medical/study-1',
            publisher: 'valyu/medical',
          },
        },
      ],
      provider_meta: {
        'valyu:transaction_id': 'tx-specialized',
        'valyu:dataset': 'valyu/medical',
      },
    });
    expect(result.response?.results[0]?.provenance.corpora).toEqual([]);
  });

  it('truthfully projects every SearchAPI surface profile to terminal provenance', async () => {
    const { root, runDirectory } = directories();
    const selected = surfaceProfiles();
    const providers = Object.fromEntries(
      selected.map((item) => {
        const id = `adapter-${item.identity.provider_id}`;
        return [
          id,
          {
            id,
            displayName: item.identity.provider_id,
            tier: 'ai-grounded' as const,
            envVar: '',
            execution: 'inline' as const,
            execute: async () => success(id),
          },
        ];
      }),
    );

    const result = await runCanonicalPreparedExecution(prepared(selected), {
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator(),
      attempt_bridge: exactBindings(selected, providers),
    });

    expect(result.response?.status).toBe('succeeded');
    expect(result.response?.results).toHaveLength(6);
    for (const profile of selected) {
      const projected = result.response?.results.find(
        (item) => item.provider === profile.identity.provider_id,
      );
      expect(projected?.provenance).toEqual({
        result_kind: 'surface_observation',
        retrieval_methods: ['surface_collector'],
        corpora: [...profile.corpora],
        observation_mode: 'surface_snapshot',
        observed_at: new Date(START).toISOString(),
        collector: profile.collector_id,
        surface: profile.surface_id,
        context: {
          authentication: profile.surface_context?.account_context,
          personalization: profile.surface_context?.personalization,
        },
      });
    }
  });

  it('projects specialized-only Valyu research without widening public corpora', async () => {
    const { root, runDirectory } = directories();
    const selected: ExecutionProfile = {
      ...profile('valyu', 'background'),
      result_kind: 'research_report',
      corpora: ['specialized'],
      retrieval_method: 'research_agent',
    };
    const provider: Provider = {
      id: 'adapter-valyu',
      displayName: 'Valyu',
      tier: 'deep-research',
      envVar: '',
      execution: 'background',
      execute: vi.fn(),
      submit: async () => ({
        provider: 'adapter-valyu',
        taskId: 'dr-specialized',
        query: 'canonical persistence',
        submittedAt: START,
        status: 'completed',
      }),
      poll: vi.fn(),
      retrieve: async () => ({
        provider: 'adapter-valyu',
        tier: 'deep-research',
        content: '# Specialized research',
        durationMs: 9,
        citations: [
          {
            provider: 'adapter-valyu',
            url: 'https://example.com/dataset-record',
            providerReference: 'valyu/medical/record-1',
          },
        ],
        providerMeta: { 'valyu:mode': 'heavy' },
      }),
    };
    const result = await runCanonicalPreparedExecution(
      prepared([selected], 'async'),
      {
        runs_root: root,
        run_directory: runDirectory,
        coordinator: coordinator(),
        attempt_bridge: exactBindings([selected], {
          'adapter-valyu': provider,
        }),
      },
    );
    expect(result.response?.results[0]).toMatchObject({
      provenance: { result_kind: 'research_report', corpora: [] },
      provider_meta: { 'valyu:mode': 'heavy' },
    });
  });

  it('keeps acceptance-unknown state inert across restart', async () => {
    const { root, runDirectory } = directories();
    const durableProfile = profile('unknown', 'background');
    const submit = vi.fn(async () => {
      throw new Error('lost response');
    });
    const provider: Provider = {
      id: 'adapter-unknown',
      displayName: 'Unknown',
      tier: 'deep-research',
      envVar: '',
      execution: 'background',
      execute: vi.fn(),
      submit,
      poll: vi.fn(),
      retrieve: vi.fn(),
    };
    await runCanonicalPreparedExecution(prepared([durableProfile], 'async'), {
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator(),
      attempt_bridge: exactBindings([durableProfile], {
        'adapter-unknown': provider,
      }),
    });
    const resumed = await resumeCanonicalPreparedExecution({
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator('resume-'),
      attempt_bridge: exactBindings([durableProfile], {
        'adapter-unknown': provider,
      }),
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(provider.poll).not.toHaveBeenCalled();
    expect(resumed.runtime.state.attempts[0]?.status).toBe(
      'acceptance_unknown',
    );
  });

  it('rejects path escape and process-local profiles before creating run.json', async () => {
    const first = directories();
    const outside = directories();
    expect(
      () =>
        new RunJsonCoordinationStateStore({
          runs_root: first.root,
          run_directory: outside.runDirectory,
        }),
    ).toThrow('not contained');

    const local = {
      ...profile('local', 'background'),
      resumability: 'process_local' as const,
    };
    await expect(
      runCanonicalPreparedExecution(prepared([local]), {
        runs_root: first.root,
        run_directory: first.runDirectory,
        coordinator: coordinator(),
        attempt_bridge: exactBindings([local], {}),
      }),
    ).rejects.toThrow('process_local');
    expect(readdirSync(first.runDirectory)).toEqual([]);
  });

  it('resumes a sync durable task through polling and retrieval', async () => {
    const { root, runDirectory } = directories();
    const durableProfile = profile('sync-durable', 'background');
    let pollCount = 0;
    const provider: Provider = {
      id: 'adapter-sync-durable',
      displayName: 'Sync durable',
      tier: 'deep-research',
      envVar: '',
      execution: 'background',
      execute: vi.fn(),
      submit: vi.fn(async () => ({
        provider: 'adapter-sync-durable',
        taskId: 'sync-task',
        query: 'canonical persistence',
        submittedAt: START,
        status: 'pending' as const,
      })),
      poll: vi.fn(async () => ({
        status:
          ++pollCount === 1 ? ('running' as const) : ('completed' as const),
      })),
      retrieve: vi.fn(async () => success('adapter-sync-durable')),
    };
    const initial = await runCanonicalPreparedExecution(
      prepared([durableProfile], 'async'),
      {
        runs_root: root,
        run_directory: runDirectory,
        coordinator: coordinator(),
        attempt_bridge: exactBindings([durableProfile], {
          'adapter-sync-durable': provider,
        }),
      },
    );
    const manifest = structuredClone(initial.manifest);
    manifest.request.mode = 'sync';
    manifest.coordination_state.mode = 'sync';
    if (
      manifest.coordination_state.lifecycle[0]?.event_kind === 'request_started'
    ) {
      manifest.coordination_state.lifecycle[0].data.mode = 'sync';
    }
    writeFileSync(
      join(runDirectory, 'run.json'),
      JSON.stringify(manifest, null, 2),
    );

    const resumed = await resumeCanonicalPreparedExecution({
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator('sync-resume-'),
      attempt_bridge: exactBindings([durableProfile], {
        'adapter-sync-durable': provider,
      }),
    });
    expect(provider.submit).toHaveBeenCalledOnce();
    expect(provider.poll).toHaveBeenCalledTimes(2);
    expect(provider.retrieve).toHaveBeenCalledOnce();
    expect(resumed.response?.status).toBe('succeeded');
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'persists immediate terminal submit state for %s without polling',
    async (status) => {
      const { root, runDirectory } = directories();
      const durableProfile = profile(`terminal-${status}`, 'background');
      const adapterId = `adapter-terminal-${status}`;
      const provider: Provider = {
        id: adapterId,
        displayName: 'Terminal submit',
        tier: 'deep-research',
        envVar: '',
        execution: 'background',
        execute: vi.fn(),
        submit: vi.fn(async () => ({
          provider: adapterId,
          taskId: `${status}-task`,
          query: 'canonical persistence',
          submittedAt: START,
          status,
        })),
        poll: vi.fn(),
        retrieve: vi.fn(async () => success(adapterId)),
      };
      const result = await runCanonicalPreparedExecution(
        prepared([durableProfile], 'async'),
        {
          runs_root: root,
          run_directory: runDirectory,
          coordinator: coordinator(status),
          attempt_bridge: exactBindings([durableProfile], {
            [adapterId]: provider,
          }),
        },
      );
      expect(provider.poll).not.toHaveBeenCalled();
      expect(result.runtime.state.attempts[0]?.status).toBe(
        status === 'completed' ? 'succeeded' : status,
      );
    },
  );

  it('rejects representative tampering before resume effects', async () => {
    const { root, runDirectory } = directories();
    const selected = profile('tamper');
    const provider: Provider = {
      id: 'adapter-tamper',
      displayName: 'Tamper',
      tier: 'ai-grounded',
      envVar: '',
      execution: 'inline',
      execute: vi.fn(async () => success('adapter-tamper')),
    };
    const valid = await runCanonicalPreparedExecution(prepared([selected]), {
      runs_root: root,
      run_directory: runDirectory,
      coordinator: coordinator(),
      attempt_bridge: exactBindings([selected], { 'adapter-tamper': provider }),
    });
    const mutations: Array<(value: Record<string, any>) => void> = [
      (value) => {
        value.unknown_field = true;
      },
      (value) => {
        value.coordination_state.request_id = 'wrong-request';
      },
      (value) => {
        value.coordination_state.lifecycle[0].sequence = 2;
      },
      (value) => {
        value.coordination_state.attempts[0].durable_handle = {
          handle_id: 'forged',
          provider_task_id: 'forged-task',
          provider: selected.identity,
          submitted_at: new Date(START).toISOString(),
          status: 'pending',
        };
      },
      (value) => {
        value.terminal_response.status = 'failed';
      },
      (value) => {
        value.request.slots[0].primary.result_kind = 'surface_observation';
      },
      (value) => {
        value.request.extensions = {
          'com.example:path': '/opt/librarium/run.json',
        };
      },
      (value) => {
        value.request.extensions = {
          'com.example:note': 'Bearer secret-value',
        };
      },
      (value) => {
        value.coordination_state.request_deadline_at = new Date(
          START - 1,
        ).toISOString();
      },
      (value) => {
        value.coordination_state.attempts[0].finished_at = new Date(
          START - 1,
        ).toISOString();
      },
      (value) => {
        value.coordination_state.attempts[0].finished_at = new Date(
          START + 1,
        ).toISOString();
      },
      (value) => {
        value.provider_outputs_by_attempt.unknown_attempt = structuredClone(
          Object.values(value.provider_outputs_by_attempt)[0],
        );
      },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(valid.manifest) as unknown as Record<
        string,
        any
      >;
      mutate(candidate);
      expect(CanonicalRunManifestV3Schema.safeParse(candidate).success).toBe(
        false,
      );
    }
  });

  it('binds an unstarted timeout finish to the terminal request observation', async () => {
    const { root, runDirectory } = directories();
    const plan = prepared([profile('unstarted-timeout')]);
    const pending = advanceCoordination(
      createCoordinatorState(plan, coordinator('initial-')),
      coordinator('launch-'),
    ).state;
    expect(pending.attempts[0]?.status).toBe('dispatch_pending');
    expect(pending.attempts[0]).not.toHaveProperty('started_at');
    const expired = advanceCoordination(pending, {
      ...coordinator('expired-'),
      clock: { now: () => START + 60_001 },
    }).state;
    const attempt = expired.attempts[0];
    const terminal = expired.lifecycle.at(-1);
    expect(attempt).toMatchObject({
      status: 'timed_out',
      finished_at: terminal?.occurred_at,
    });
    expect(attempt).not.toHaveProperty('started_at');
    expect(
      expired.lifecycle.some(
        (event) =>
          event.event_kind === 'attempt_finished' &&
          event.attempt_id === attempt?.attempt_id,
      ),
    ).toBe(false);

    const store = new RunJsonCoordinationStateStore({
      runs_root: root,
      run_directory: runDirectory,
      request: plan.request,
    });
    await store.create(expired);
    const manifest = store.readManifest();
    expect(CanonicalRunManifestV3Schema.safeParse(manifest).success).toBe(true);

    const impossible = structuredClone(manifest);
    impossible.coordination_state.attempts[0]!.finished_at = new Date(
      Date.parse(terminal?.occurred_at ?? '') + 1,
    ).toISOString();
    expect(CanonicalRunManifestV3Schema.safeParse(impossible).success).toBe(
      false,
    );
  });

  it('rejects symlinked roots, run directories, and run.json files', async () => {
    const real = directories();
    const links = directories();
    const rootLink = join(links.root, 'root-link');
    symlinkSync(real.root, rootLink);
    expect(
      () =>
        new RunJsonCoordinationStateStore({
          runs_root: rootLink,
          run_directory: join(rootLink, 'request-1'),
        }),
    ).toThrow();

    const runLink = join(links.root, 'run-link');
    symlinkSync(real.runDirectory, runLink);
    expect(
      () =>
        new RunJsonCoordinationStateStore({
          runs_root: links.root,
          run_directory: runLink,
        }),
    ).toThrow();

    const plan = prepared([profile('symlink-file')]);
    const store = new RunJsonCoordinationStateStore({
      runs_root: real.root,
      run_directory: real.runDirectory,
      request: plan.request,
    });
    writeFileSync(join(real.root, 'outside.json'), '{}');
    symlinkSync(
      join(real.root, 'outside.json'),
      join(real.runDirectory, 'run.json'),
    );
    await expect(
      store.create(createCoordinatorState(plan, coordinator())),
    ).rejects.toThrow();
  });

  it.each([true, false])(
    'reconciles terminal remote custody without changing the public receipt (receipt persisted: %s)',
    async (persistReceipt) => {
      const { root, runDirectory } = directories();
      const durableProfile = profile('custody', 'background');
      const provider: Provider = {
        id: 'adapter-custody',
        displayName: 'Custody',
        tier: 'deep-research',
        envVar: '',
        execution: 'background',
        execute: vi.fn(),
        submit: vi.fn(async () => ({
          provider: 'adapter-custody',
          taskId: 'remote-custody-task',
          query: 'canonical persistence',
          submittedAt: START,
          status: 'pending' as const,
        })),
        poll: vi.fn(async () => ({ status: 'running' as const })),
        retrieve: vi.fn(),
      };
      const initial = await runCanonicalPreparedExecution(
        prepared([durableProfile], 'async'),
        {
          runs_root: root,
          run_directory: runDirectory,
          coordinator: coordinator(),
          attempt_bridge: exactBindings([durableProfile], {
            'adapter-custody': provider,
          }),
        },
      );
      const store = new RunJsonCoordinationStateStore({
        runs_root: root,
        run_directory: runDirectory,
      });
      const current = await store.load('request-1');
      expect(current).toBeDefined();
      const cancelled = cancelCoordination(
        current?.state as NonNullable<typeof current>['state'],
        coordinator('cancel-'),
      );
      const swapped = await store.compareAndSwap(
        'request-1',
        current?.version as number,
        cancelled,
      );
      expect(swapped.ok).toBe(true);
      const receipt = persistReceipt
        ? store.persistTerminalResponse({
            generator: initial.manifest.producer.id,
            generator_version: initial.manifest.producer.version,
          })
        : undefined;
      const before = store.readManifest();
      const beforeOutputs = JSON.stringify(before.provider_outputs_by_attempt);

      const resumed = await resumeCanonicalPreparedExecution({
        runs_root: root,
        run_directory: runDirectory,
        coordinator: coordinator('custody-resume-'),
        attempt_bridge: exactBindings([durableProfile], {
          'adapter-custody': provider,
        }),
      });

      expect(provider.submit).toHaveBeenCalledOnce();
      expect(provider.poll).toHaveBeenCalledOnce();
      expect(provider.retrieve).not.toHaveBeenCalled();
      expect(resumed.response).toEqual(
        receipt ?? expect.objectContaining({ status: 'failed' }),
      );
      expect(JSON.stringify(resumed.manifest.provider_outputs_by_attempt)).toBe(
        beforeOutputs,
      );
      expect(resumed.manifest.coordination_state.attempts[0]).toMatchObject({
        status: 'cancelled',
        durable_handle: {
          status: 'running',
          last_observed_at: new Date(START).toISOString(),
        },
      });
      if (receipt) expect(resumed.response).toEqual(receipt);
    },
  );
});
