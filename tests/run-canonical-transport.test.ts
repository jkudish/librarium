import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeRun } from '../src/commands/run.js';
import type { PreparedResearchExecution } from '../src/core/execution-plan.js';
import type { Config, Provider } from '../src/types.js';

const state = vi.hoisted(() => ({
  stdout: '' as string,
  runCanonical: vi.fn(),
  cancelCanonical: vi.fn(),
  spinner: {
    isSpinning: false,
    start: vi.fn(),
    stop: vi.fn(),
    fail: vi.fn(),
  },
}));

const profile = {
  identity: {
    provider_id: 'provider',
    profile_id: 'profile',
    target: { primary: { model_selection: 'not_applicable' as const } },
  },
  result_kind: 'search_results' as const,
  grounding_policy: 'required' as const,
  observation_mode: 'api_output' as const,
  corpora: ['web' as const],
  retrieval_method: 'search_endpoint' as const,
  access_mode: 'direct' as const,
  operator_id: 'provider',
  invocation: 'inline' as const,
  resumability: 'none' as const,
};

const config: Config = {
  version: 1,
  defaults: {
    outputDir: '/tmp/canonical-transport',
    maxParallel: 1,
    timeout: 30,
    asyncTimeout: 60,
    asyncPollInterval: 1,
    mode: 'sync',
    llmWebSearch: true,
  },
  providers: { adapter: { enabled: true } },
  customProviders: {},
  trustedProviderIds: [],
  groups: {},
};

const prepared = {
  request: {
    interchange_version: '1.0.0',
    message_type: 'request',
    request_id: 'request-1',
    requested_at: '2026-08-11T12:00:00.000Z',
    mode: 'sync',
    query: 'query',
    slots: [
      {
        slot_id: 'slot-1',
        position: 0,
        requirements: {
          result_kind: 'search_results',
          grounding_policy: 'required',
          corpora: ['web'],
          retrieval_methods: ['search_endpoint'],
        },
        primary: profile,
      },
    ],
    fallback_reserve: [],
  },
  policy: {
    limits: {
      max_concurrency: 1,
      request_deadline_ms: 60_000,
      inline_attempt_deadline_ms: 30_000,
      background_attempt_deadline_ms: 30_000,
      poll_interval_ms: 1_000,
    },
    fallback: { kind: 'disabled' },
    exclusions: [],
    refinement: { kind: 'disabled' },
  },
  profile_plans_by_identity: {
    '["provider","profile","not_applicable",null,null,null,null,null]': {
      profile_key:
        '["provider","profile","not_applicable",null,null,null,null,null]',
      identity: profile.identity,
      binding: { adapter_id: 'adapter', binding_id: 'binding' },
    },
  },
  catalog: { revision: 'r1', digest: 'digest' },
  notices: [],
} satisfies PreparedResearchExecution;

vi.mock('ora', () => ({
  default: () => {
    state.spinner.start.mockImplementation(() => {
      state.spinner.isSpinning = true;
      return state.spinner;
    });
    state.spinner.stop.mockImplementation(() => {
      state.spinner.isSpinning = false;
      return state.spinner;
    });
    state.spinner.fail.mockImplementation(() => {
      state.spinner.isSpinning = false;
      return state.spinner;
    });
    return state.spinner;
  },
}));

vi.mock('../src/core/config.js', () => ({
  loadConfig: () => config,
  loadProjectConfig: () => null,
  mergeConfigs: () => config,
}));

vi.mock('../src/node-request-preflight.js', () => ({
  preflightProductionRequest: () => ({
    prepared,
    credentials: { env: {} },
    notices: [],
    admittedAdapterIds: ['adapter'],
  }),
  emitRequestPreflightNotices: () => {},
  assertAdmittedAdaptersRegistered: () => {},
}));

vi.mock('../src/adapters/node-registry.js', () => ({
  getAllProviders: () => [{ id: 'adapter', tier: 'raw-search' }],
  getExactProvider: () =>
    ({
      id: 'adapter',
      displayName: 'Adapter',
      tier: 'raw-search',
      envVar: '',
      execution: 'inline',
      execute: vi.fn(),
    }) satisfies Provider,
  initializeProviders: async () => ({
    warnings: [],
    loadedCustomProviders: [],
    skippedCustomProviders: [],
  }),
}));

vi.mock('../src/core/provider-selection.js', () => ({
  retiredProviderSelectionIssues: () => [],
}));

vi.mock('../src/node-run-directory.js', () => ({
  createRunDir: () => '/tmp/canonical-transport/run-1',
}));

vi.mock('../src/node-canonical-artifacts.js', () => ({
  writeCanonicalPresentationArtifacts: () => ({
    reports: [],
    results: [],
    sources: [],
    providerContents: {},
    totalCitations: 0,
    totalDurationMs: 0,
    generatorManifest: {
      schemaVersion: 2,
      revision: 1,
      status: 'completed',
      timestamp: 0,
      slug: 'query',
      query: 'query',
      mode: 'sync',
      outputDir: '/tmp/canonical-transport/run-1',
      providers: [],
      sources: { total: 0, unique: 0, file: 'sources.json' },
      exitCode: 0,
    },
  }),
}));

vi.mock('../src/node-canonical-run.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/node-canonical-run.js')>();
  return {
    ...actual,
    cancelCanonicalRun: (...args: unknown[]) => state.cancelCanonical(...args),
    runCanonicalPreparedExecution: (...args: unknown[]) =>
      state.runCanonical(...args),
  };
});

describe('canonical CLI transport', () => {
  const cancelledManifest = {
    coordination_state: { status: 'cancelled' },
    terminal_response: {
      generator: 'jkudish/librarium',
      generator_version: '1.4.1',
      request_id: 'request-1',
      status: 'failed',
      completed_at: '2026-08-11T12:00:01.000Z',
      results: [],
      errors: [{ code: 'librarium.request.cancelled', message: 'Cancelled.' }],
    },
  };

  beforeEach(() => {
    state.stdout = '';
    state.runCanonical.mockReset();
    state.cancelCanonical.mockReset();
    state.spinner.start.mockClear();
    state.spinner.stop.mockClear();
    state.spinner.fail.mockClear();
    process.exitCode = undefined;
  });

  it('prints one public terminal envelope without private coordinator facts', async () => {
    const response = {
      generator: 'jkudish/librarium',
      generator_version: '1.4.1',
      request_id: 'request-1',
      status: 'failed' as const,
      completed_at: '2026-08-11T12:00:01.000Z',
      results: [],
      errors: [
        { code: 'librarium.provider.failed', message: 'Provider failed.' },
      ],
    };
    state.runCanonical.mockResolvedValue({
      runtime: { state: { status: 'failed' }, outputs_by_attempt: {} },
      manifest: { coordination_state: { status: 'failed' } },
      response,
    });
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        state.stdout += String(chunk);
        return true;
      });
    const log = vi.spyOn(console, 'log').mockImplementation((value) => {
      state.stdout += `${String(value)}\n`;
    });
    const outcome = await executeRun('query', { json: true, open: true });
    write.mockRestore();
    log.mockRestore();
    expect(outcome.exitCode).toBe(2);
    const payload = JSON.parse(state.stdout);
    expect(payload).toEqual({
      outputDir: '/tmp/canonical-transport/run-1',
      state: 'terminal',
      response,
    });
    expect(state.stdout).not.toMatch(
      /coordination_state|durable_handle|attempts|delivery_lease|provider_task_id/,
    );
  });

  it('returns exit 0 with a compact public envelope for async pending work', async () => {
    state.runCanonical.mockResolvedValue({
      runtime: { state: { status: 'running' }, outputs_by_attempt: {} },
      manifest: { coordination_state: { status: 'running' } },
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      state.stdout += String(chunk);
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation((value) => {
      state.stdout += `${String(value)}\n`;
    });

    const outcome = await executeRun('query', { json: true });

    expect(outcome.exitCode).toBe(0);
    expect(JSON.parse(state.stdout)).toEqual({
      outputDir: '/tmp/canonical-transport/run-1',
      state: 'pending',
    });
    expect(state.stdout).not.toMatch(
      /coordination_state|durable_handle|attempts|provider_task_id/,
    );
  });

  it('returns exit 1 for a partial canonical terminal response', async () => {
    const response = {
      generator: 'jkudish/librarium',
      generator_version: '1.4.1',
      request_id: 'request-1',
      status: 'partial' as const,
      completed_at: '2026-08-11T12:00:01.000Z',
      results: [],
      errors: [
        { code: 'librarium.provider.failed', message: 'One provider failed.' },
      ],
    };
    state.runCanonical.mockResolvedValue({
      runtime: { state: { status: 'partial' }, outputs_by_attempt: {} },
      manifest: { coordination_state: { status: 'partial' } },
      response,
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      state.stdout += String(chunk);
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation((value) => {
      state.stdout += `${String(value)}\n`;
    });

    const outcome = await executeRun('query', { json: true });

    expect(outcome.exitCode).toBe(1);
    expect(JSON.parse(state.stdout)).toMatchObject({
      state: 'terminal',
      response: { status: 'partial' },
    });
  });

  it('stops cleanly when interrupted before canonical state creation', async () => {
    state.cancelCanonical.mockClear();
    state.runCanonical.mockImplementation(
      async (
        _plan: unknown,
        dependencies: {
          is_cancelled?: () => boolean;
        },
      ) => {
        process.emit('SIGINT');
        expect(dependencies.is_cancelled?.()).toBe(true);
        throw new Error('cancelled before persistence');
      },
    );
    const outcome = await executeRun('query', { json: true });
    expect(outcome).toEqual({ exitCode: 130 });
    expect(state.cancelCanonical).not.toHaveBeenCalled();
    expect(state.spinner.stop).toHaveBeenCalled();
  });

  it('persists cancellation after state creation and ignores in-flight failure', async () => {
    state.cancelCanonical.mockReset();
    state.cancelCanonical.mockResolvedValue(cancelledManifest);
    state.runCanonical.mockImplementation(
      async (
        _plan: unknown,
        dependencies: {
          on_state_created?: () => void;
        },
      ) => {
        dependencies.on_state_created?.();
        process.emit('SIGINT');
        throw new Error('in-flight completion lost its CAS');
      },
    );
    const outcome = await executeRun('query', { json: true });
    expect(outcome).toMatchObject({ exitCode: 130 });
    expect(state.cancelCanonical).toHaveBeenCalled();
  });
});
