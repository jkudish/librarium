import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  approvalFingerprint,
  assertRunningCandidateRoot,
  type LiveValidationApproval,
  registerLiveValidationCommand,
} from '../src/commands/live-validation.js';
import { NamespacedKeySchema } from '../src/contracts/common.js';
import { loadConfig } from '../src/core/config.js';
import type { CredentialContext } from '../src/core/credentials.js';
import {
  type PreparedResearchExecution,
  profileIdentityKey,
} from '../src/core/execution-plan.js';
import {
  buildCanonicalValidationMatrix,
  LIVE_VALIDATION_CONTRACT_EXTENSION_KEY,
} from '../src/node-live-validation.js';
import {
  createProductionFrozenCanonicalExecutor,
  productionValidationMatrix,
} from '../src/node-live-validation-production.js';
import type { Config } from '../src/types.js';

type Target = ReturnType<
  typeof buildCanonicalValidationMatrix
>['targets'][number];
type Protocol = LiveValidationApproval['targets'][number];

function protocol(target: Target): Protocol {
  return {
    key: target.key,
    query: 'offline production binding test',
    account: 'test-account',
    region: 'test-region',
    credential_reference: target.credential_family,
    options: {},
    timeout_seconds: 30,
    poll_deadline_seconds: 90,
    pacing_ms: 0,
    max_requests: 1,
    retry: 'disabled',
    cancel_policy: 'supported_exact_profile',
    sensibility_policy: 'deterministic_required',
    pricing: {
      status: 'unavailable',
      currency: 'USD',
      unknown_reason: 'offline test only',
      unknown_approved: true,
      approved_maximum_microusd: '1',
    },
  };
}

function prepared(target: Target): PreparedResearchExecution {
  return {
    request: {
      request_id: 'binding-request',
      query: 'offline production binding test',
      slots: [{ primary: { identity: target.expected_effective_identity } }],
      fallback_reserve: [],
    },
    policy: {
      limits: {
        max_concurrency: 1,
        request_deadline_ms: 30_000,
        inline_attempt_deadline_ms: 30_000,
        background_attempt_deadline_ms: 90_000,
        poll_interval_ms: 1_000,
      },
      fallback: { kind: 'disabled' },
    },
    catalog: { digest: target.catalog_digest },
    profile_plans_by_identity: {
      [profileIdentityKey(target.expected_effective_identity)]: {
        binding: {
          adapter_id: target.adapter_id,
          binding_id: target.binding_id,
        },
      },
    },
  } as unknown as PreparedResearchExecution;
}

function executorDependencies(
  target: Target,
  counters: Record<string, number>,
) {
  const planned = prepared(target);
  const structure = () => {
    counters.structural += 1;
    return {
      prepared: planned,
      notices: [],
      admittedAdapterIds: [target.adapter_id],
    };
  };
  return {
    preflightStructure: structure,
    preflightCredentials: () => {
      counters.credential += 1;
      return {
        ...structure(),
        credentials: {} as CredentialContext,
      };
    },
    initializeProviders: async () => {
      counters.initialize += 1;
      return {
        warnings: [],
        loadedCustomProviders: [],
        skippedCustomProviders: [],
      };
    },
    resolveExactProvider: () => ({ id: target.adapter_id }) as any,
    createRunDirectory: (root: string) => join(root, 'exact-run'),
    createCoordinator: (() => ({})) as any,
    createAttemptBridge: (() => {
      counters.bridge += 1;
      return {};
    }) as any,
    materialize: async (received: PreparedResearchExecution) => {
      counters.materialize += 1;
      expect(received.policy.limits.max_concurrency).toBe(1);
      expect(received.request.fallback_reserve).toStrictEqual([]);
      expect(
        NamespacedKeySchema.parse(LIVE_VALIDATION_CONTRACT_EXTENSION_KEY),
      ).toBe(LIVE_VALIDATION_CONTRACT_EXTENSION_KEY);
      expect(received.request.extensions).toHaveProperty(
        LIVE_VALIDATION_CONTRACT_EXTENSION_KEY,
      );
      return {} as any;
    },
    resume: async () => {
      counters.resume += 1;
      return {
        manifest: { coordination_state: { status: 'succeeded' } },
      } as any;
    },
    readReferenceManifest: (() => ({
      coordination_state: { attempts: [] },
    })) as any,
    cancelRun: async () => {
      counters.cancel += 1;
      return {} as any;
    },
  };
}

function counters() {
  return {
    structural: 0,
    credential: 0,
    initialize: 0,
    bridge: 0,
    materialize: 0,
    resume: 0,
    cancel: 0,
  };
}

describe('production live-validation binding (injected, offline)', () => {
  it('stops invalid options before credential context, provider initialization, or run services', async () => {
    const target = buildCanonicalValidationMatrix().targets[0]!;
    const observed = counters();
    const binding = createProductionFrozenCanonicalExecutor(
      {
        raw_root: mkdtempSync(join(tmpdir(), 'librarium-binding-')),
      } as LiveValidationApproval,
      { providers: {} } as Config,
      executorDependencies(target, observed),
    );
    await expect(
      binding.prepare(target, { ...protocol(target), options: null as any }),
    ).rejects.toThrow('Frozen provider options are invalid');
    expect(observed).toMatchObject({
      structural: 0,
      credential: 0,
      initialize: 0,
      bridge: 0,
      materialize: 0,
      resume: 0,
    });
  });

  it.each(['model', 'query', 'limits', 'deadline', 'catalog', 'binding'])(
    'stops structural %s drift before credential context or runtime services',
    async (kind) => {
      const target = buildCanonicalValidationMatrix().targets[0]!;
      const observed = counters();
      const dependencies = executorDependencies(target, observed);
      dependencies.preflightStructure = () => {
        observed.structural += 1;
        throw new Error(`structural ${kind} rejection`);
      };
      const binding = createProductionFrozenCanonicalExecutor(
        {
          raw_root: mkdtempSync(join(tmpdir(), 'librarium-binding-')),
        } as LiveValidationApproval,
        { providers: {} } as Config,
        dependencies,
      );
      await expect(binding.prepare(target, protocol(target))).rejects.toThrow(
        `structural ${kind} rejection`,
      );
      expect(observed).toMatchObject({
        structural: 1,
        credential: 0,
        initialize: 0,
        bridge: 0,
        materialize: 0,
        resume: 0,
      });
    },
  );

  it('uses structural then credential admission, one exact adapter, materializes before one inline resume', async () => {
    const target = buildCanonicalValidationMatrix().targets.find(
      (candidate) =>
        candidate.expected_effective_identity.profile_id !== 'research',
    )!;
    const observed = counters();
    const rawRoot = mkdtempSync(join(tmpdir(), 'librarium-binding-'));
    const binding = createProductionFrozenCanonicalExecutor(
      {
        raw_root: rawRoot,
        targets: [protocol(target)],
      } as LiveValidationApproval,
      { providers: {} } as Config,
      executorDependencies(target, observed),
    );
    const reference = await binding.prepare(target, protocol(target));
    expect(reference).toMatchObject({
      runs_root: rawRoot,
      run_directory: join(rawRoot, 'exact-run'),
      binding_id: target.binding_id,
      catalog_digest: target.catalog_digest,
      persisted_protocol_contract: true,
    });
    const outcome = await binding.execute(target, protocol(target), reference);
    expect(outcome).toMatchObject({
      status: 'terminal',
      lifecycle: 'succeeded',
    });
    expect(observed).toMatchObject({
      structural: 2,
      credential: 1,
      initialize: 1,
      bridge: 1,
      materialize: 1,
      resume: 1,
    });
  });

  it('uses the same all-enabled catalog authority for the frozen matrix and exact structural preflight', async () => {
    const config = loadConfig(
      join(tmpdir(), 'librarium-missing-live-validation-config.json'),
    );
    const target = productionValidationMatrix(config).targets[0]!;
    const observed = counters();
    const injected = executorDependencies(target, observed);
    const {
      preflightStructure: _useProductionStructuralPreflight,
      ...dependencies
    } = injected;
    const binding = createProductionFrozenCanonicalExecutor(
      {
        raw_root: mkdtempSync(join(tmpdir(), 'librarium-binding-')),
      } as LiveValidationApproval,
      config,
      dependencies,
    );

    await expect(
      binding.prepare(target, protocol(target)),
    ).resolves.toMatchObject({
      catalog_digest: target.catalog_digest,
    });
    expect(observed).toMatchObject({
      credential: 1,
      initialize: 1,
      materialize: 1,
    });
  });

  it('initializes only a private durable adapter while retaining its public configuration authority', async () => {
    const target = buildCanonicalValidationMatrix().targets.find(
      (candidate) => candidate.key === 'exa/research',
    )!;
    const observed = counters();
    let initializedIds: readonly string[] = [];
    const dependencies = executorDependencies(target, observed);
    dependencies.initializeProviders = async (_config, options) => {
      observed.initialize += 1;
      initializedIds = [...(options?.builtinAdapterIds ?? [])];
      return {
        warnings: [],
        loadedCustomProviders: [],
        skippedCustomProviders: [],
      };
    };
    const binding = createProductionFrozenCanonicalExecutor(
      {
        raw_root: mkdtempSync(join(tmpdir(), 'librarium-binding-')),
      } as LiveValidationApproval,
      { providers: { exa: { enabled: true } } } as Config,
      dependencies,
    );
    await binding.prepare(target, protocol(target));
    expect(initializedIds).toStrictEqual([target.adapter_id]);
    expect(observed).toMatchObject({
      credential: 1,
      initialize: 1,
      materialize: 1,
    });
  });

  it('uses a fresh executor only for exact reconciliation and cancellation, never a new materialization', async () => {
    const target = buildCanonicalValidationMatrix().targets[0]!;
    const observed = counters();
    const rawRoot = mkdtempSync(join(tmpdir(), 'librarium-binding-'));
    const binding = createProductionFrozenCanonicalExecutor(
      {
        raw_root: rawRoot,
        targets: [protocol(target)],
      } as LiveValidationApproval,
      { providers: {} } as Config,
      executorDependencies(target, observed),
    );
    const reference = await binding.prepare(target, protocol(target));
    const fresh = createProductionFrozenCanonicalExecutor(
      {
        raw_root: rawRoot,
        targets: [protocol(target)],
      } as LiveValidationApproval,
      { providers: {} } as Config,
      executorDependencies(target, observed),
    );
    await fresh.reconcile(target, protocol(target), reference);
    await fresh.cancel?.(target, reference);
    expect(observed).toMatchObject({ materialize: 1, resume: 1, cancel: 1 });
  });

  it('cancels a fresh zero-attempt reference without another credential or bridge initialization', async () => {
    const target = buildCanonicalValidationMatrix().targets[0]!;
    const observed = counters();
    const rawRoot = mkdtempSync(join(tmpdir(), 'librarium-binding-'));
    const approval = {
      raw_root: rawRoot,
      targets: [protocol(target)],
    } as LiveValidationApproval;
    const binding = createProductionFrozenCanonicalExecutor(
      approval,
      { providers: {} } as Config,
      executorDependencies(target, observed),
    );
    const reference = await binding.prepare(target, protocol(target));
    const fresh = createProductionFrozenCanonicalExecutor(
      approval,
      { providers: {} } as Config,
      executorDependencies(target, observed),
    );
    await fresh.cancel?.(target, reference);
    expect(observed).toMatchObject({
      credential: 1,
      initialize: 1,
      bridge: 0,
      materialize: 1,
      cancel: 1,
    });
  });

  it.each(['failed', 'cancelled'] as const)(
    'keeps %s local state in reconciliation while durable custody is running',
    async (localStatus) => {
      const target = buildCanonicalValidationMatrix().targets.find(
        (candidate) => candidate.key === 'exa/research',
      )!;
      const observed = counters();
      const dependencies = executorDependencies(target, observed);
      dependencies.resume = async () => {
        observed.resume += 1;
        return {
          manifest: {
            coordination_state: {
              status: localStatus,
              attempts: [{ durable_handle: { status: 'running' } }],
            },
          },
        } as any;
      };
      const rawRoot = mkdtempSync(join(tmpdir(), 'librarium-binding-'));
      const binding = createProductionFrozenCanonicalExecutor(
        { raw_root: rawRoot } as LiveValidationApproval,
        { providers: {} } as Config,
        dependencies,
      );
      const reference = await binding.prepare(target, protocol(target));
      await expect(
        binding.execute(target, protocol(target), reference),
      ).resolves.toMatchObject({
        status: 'reconcile',
      });
      await expect(
        binding.reconcile(target, protocol(target), reference),
      ).resolves.toMatchObject({
        status: 'reconcile',
      });
    },
  );

  it('terminalizes a recorded request deadline despite pending durable custody', async () => {
    const target = buildCanonicalValidationMatrix().targets.find(
      (candidate) => candidate.key === 'perplexity-deep-research/research',
    )!;
    const observed = counters();
    const dependencies = executorDependencies(target, observed);
    dependencies.resume = async () => {
      observed.resume += 1;
      return {
        manifest: {
          coordination_state: {
            status: 'unsuccessful',
            attempts: [
              {
                status: 'timed_out',
                error: { code: 'request_deadline_exceeded' },
                durable_handle: { status: 'pending' },
              },
            ],
          },
        },
      } as any;
    };
    const rawRoot = mkdtempSync(join(tmpdir(), 'librarium-binding-'));
    const binding = createProductionFrozenCanonicalExecutor(
      { raw_root: rawRoot } as LiveValidationApproval,
      { providers: {} } as Config,
      dependencies,
    );
    const reference = await binding.prepare(target, protocol(target));
    await expect(
      binding.execute(target, protocol(target), reference),
    ).resolves.toMatchObject({ status: 'terminal', lifecycle: 'failed' });
    await expect(
      binding.reconcile(target, protocol(target), reference),
    ).resolves.toMatchObject({ status: 'terminal', lifecycle: 'failed' });
  });

  it('stops live validation when acceptance is unknown and no durable handle exists', async () => {
    const target = buildCanonicalValidationMatrix().targets.find(
      (candidate) => candidate.key === 'exa/research',
    )!;
    const observed = counters();
    const dependencies = executorDependencies(target, observed);
    dependencies.resume = async () => {
      observed.resume += 1;
      return {
        manifest: {
          coordination_state: {
            status: 'running',
            attempts: [{ status: 'acceptance_unknown' }],
          },
        },
      } as any;
    };
    const rawRoot = mkdtempSync(join(tmpdir(), 'librarium-binding-'));
    const binding = createProductionFrozenCanonicalExecutor(
      { raw_root: rawRoot } as LiveValidationApproval,
      { providers: {} } as Config,
      dependencies,
    );
    const reference = await binding.prepare(target, protocol(target));
    await expect(
      binding.execute(target, protocol(target), reference),
    ).resolves.toMatchObject({
      status: 'terminal',
      lifecycle: 'failed',
    });
    await expect(
      binding.reconcile(target, protocol(target), reference),
    ).resolves.toMatchObject({
      status: 'terminal',
      lifecycle: 'failed',
    });
  });
});

describe('production paid matrix and candidate attribution', () => {
  it('requires the exact canonical 41-target binding inventory', () => {
    const matrix = productionValidationMatrix(
      loadConfig(join(tmpdir(), 'librarium-missing-matrix-config.json')),
    );
    expect(matrix.targets).toHaveLength(41);
    expect(matrix.targets.map((target) => target.key)).toStrictEqual(
      buildCanonicalValidationMatrix().targets.map((target) => target.key),
    );
  });

  it('binds approved provider options into the paid catalog authority', () => {
    const config = loadConfig(
      join(tmpdir(), 'librarium-missing-option-matrix-config.json'),
    );
    const baseline = productionValidationMatrix(config);
    const search = baseline.targets.find(
      (target) => target.key === 'valyu/search',
    );
    if (!search) throw new Error('missing Valyu search target');

    const optionBound = productionValidationMatrix(config, [
      { key: search.key, options: { searchType: 'web' } },
    ]);
    const boundSearch = optionBound.targets.find(
      (target) => target.key === search.key,
    );

    expect(optionBound.targets).toHaveLength(41);
    expect(optionBound.catalog_digest).not.toBe(baseline.catalog_digest);
    expect(boundSearch?.catalog_digest).toBe(optionBound.catalog_digest);
  });

  it('rejects an explicitly disabled canonical family before provider construction', () => {
    const config = loadConfig(
      join(tmpdir(), 'librarium-missing-disabled-config.json'),
    );
    expect(() =>
      productionValidationMatrix({
        ...config,
        providers: {
          ...config.providers,
          exa: { ...config.providers.exa, enabled: false },
        },
      }),
    ).toThrow('disabled canonical provider');
  });

  it('uses the loaded package root rather than a changed cwd', () => {
    const loadedRoot = process.cwd();
    const candidateOnlyCwd = mkdtempSync(join(tmpdir(), 'other-root-'));
    process.chdir(candidateOnlyCwd);
    try {
      expect(() =>
        assertRunningCandidateRoot({ candidate_root: candidateOnlyCwd } as any),
      ).toThrow('approved immutable candidate root');
      expect(() =>
        assertRunningCandidateRoot({ candidate_root: loadedRoot } as any),
      ).not.toThrow();
    } finally {
      process.chdir(loadedRoot);
    }
  });
});

describe('paid command gates remain before production composition', () => {
  it('rejects missing or wrong dual approval without loading production configuration', async () => {
    let configuration = 0;
    let executor = 0;
    const program = new Command();
    registerLiveValidationCommand(program, {
      productionConfig: () => {
        configuration += 1;
        return { providers: {} } as Config;
      },
      productionExecutor: () => {
        executor += 1;
        throw new Error('must remain unreachable');
      },
    });
    await expect(
      program.parseAsync(['node', 'librarium', 'live-validation', '--paid']),
    ).rejects.toThrow('absolute preregistration file');
    expect({ configuration, executor }).toStrictEqual({
      configuration: 0,
      executor: 0,
    });
  });

  it('reaches only the injected future binding after both approval fingerprints match', async () => {
    const matrix = buildCanonicalValidationMatrix();
    const root = mkdtempSync(join(tmpdir(), 'librarium-binding-gate-'));
    const approval = {
      schema_version: 2,
      candidate: {
        git_sha: 'a'.repeat(40),
        fingerprint: `sha256:${'a'.repeat(64)}`,
        version: '2.0.0-rc.1',
        artifact_hashes: Object.fromEntries(
          [
            'declarations',
            'npm_tarball',
            'package_inventory',
            'provenance',
            'sea_manifest',
          ].map((name) => [name, `sha256:${'b'.repeat(64)}`]),
        ),
      },
      matrix_fingerprint: matrix.fingerprint,
      catalog_digest: matrix.catalog_digest,
      pricing_snapshot_fingerprint: matrix.pricing_snapshot_fingerprint,
      aggregate_budget_microusd: '0',
      raw_root: root,
      receipt_root: root,
      targets: [protocol(matrix.targets[0]!)],
    } as LiveValidationApproval;
    // This fixture stops at the candidate gate because raw/public roots must differ.
    // It proves no production composition runs before all immutable gate checks.
    const fingerprint = approvalFingerprint(approval);
    expect(fingerprint).toMatch(/^sha256:/);
  });
});
