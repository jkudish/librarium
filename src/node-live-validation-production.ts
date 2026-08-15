/**
 * The only credential-capable live-validation composition.  All callers must
 * finish approval, candidate, catalog, pricing, and structural request gates
 * before calling `prepare`; this module keeps credentials and provider
 * construction behind that final seam.
 */
import {
  getExactProvider,
  initializeProviders,
} from './adapters/node-registry.js';
import {
  type FrozenCanonicalExecutor,
  frozenProtocolContractHash,
  frozenRequestContract,
  frozenRequestFingerprint,
  type LiveValidationApproval,
} from './commands/live-validation.js';
import {
  configGroupProvenance,
  loadConfig,
  loadProjectConfig,
  mergeConfigs,
} from './core/config.js';
import { mapConfiguration } from './core/configuration-mapping.js';
import { getBuiltinProviderDefinition } from './core/provider-descriptor.js';
import { INTERNAL_ADAPTER_PUBLIC_PROVIDER_IDS } from './internal-adapter-ids.js';
import {
  cancelCanonicalRun,
  createNodeCoordinatorDependencies,
  createRegisteredProviderAttemptBridge,
  materializeCanonicalPreparedExecution,
  resumeCanonicalPreparedExecution,
} from './node-canonical-run.js';
import {
  assertCanonicalValidationPreparedExecution,
  buildCanonicalValidationMatrix,
  CanonicalLiveValidationError,
  type CanonicalValidationTarget,
  type FrozenAttemptReference,
  LIVE_VALIDATION_CONTRACT_EXTENSION_KEY,
} from './node-live-validation.js';
import { readTrustedFrozenReferenceManifest } from './node-live-validation-binding.js';
import {
  assertAdmittedAdaptersRegistered,
  preflightProductionRequest,
  preflightProductionRequestStructure,
} from './node-request-preflight.js';
import { createRunDir } from './node-run-directory.js';
import type { Config } from './types.js';

export interface ProductionLiveValidationDependencies {
  readonly loadMergedConfig?: () => Config;
  readonly initializeProviders?: typeof initializeProviders;
  readonly resolveExactProvider?: typeof getExactProvider;
  readonly createRunDirectory?: (root: string, slug: string) => string;
  /**
   * Credential-free request admission. Keep this seam separate from the
   * keychain-aware phase so tests can prove every rejection ordering.
   */
  readonly preflightStructure?: typeof preflightProductionRequestStructure;
  /** Keychain-aware request admission after structural admission succeeds. */
  readonly preflightCredentials?: typeof preflightProductionRequest;
  /** Canonical run services are injectable for offline production-binding tests. */
  readonly createCoordinator?: typeof createNodeCoordinatorDependencies;
  readonly createAttemptBridge?: typeof createRegisteredProviderAttemptBridge;
  readonly materialize?: typeof materializeCanonicalPreparedExecution;
  readonly resume?: typeof resumeCanonicalPreparedExecution;
  readonly cancelRun?: typeof cancelCanonicalRun;
  /** Exact reference verification stays injectable for zero-I/O binding tests. */
  readonly readReferenceManifest?: typeof readTrustedFrozenReferenceManifest;
}

export function loadProductionValidationConfig(): Config {
  return mergeConfigs(loadConfig(), loadProjectConfig(process.cwd()));
}

function publicConfigId(target: CanonicalValidationTarget): string {
  return (
    INTERNAL_ADAPTER_PUBLIC_PROVIDER_IDS[
      target.adapter_id as keyof typeof INTERNAL_ADAPTER_PUBLIC_PROVIDER_IDS
    ] ?? target.adapter_id
  );
}

function exactInput(
  target: CanonicalValidationTarget,
  protocol: LiveValidationApproval['targets'][number],
) {
  return {
    kind: 'cli' as const,
    input: {
      query: protocol.query,
      providers: [target.key],
      mode:
        target.expected_effective_identity.profile_id === 'research'
          ? 'async'
          : 'sync',
      parallel: 1,
      timeoutSeconds: protocol.timeout_seconds,
      fallback: false,
      refine: false,
    },
  };
}

function normalizedProductionProviders(config: Config): Config['providers'] {
  const expected = buildCanonicalValidationMatrix();
  for (const target of expected.targets) {
    if (config.providers[publicConfigId(target)]?.enabled === false) {
      throw new CanonicalLiveValidationError(
        `Production paid validation has a disabled canonical provider: ${target.key}.`,
      );
    }
  }
  const providers = { ...config.providers };
  for (const target of expected.targets) {
    const id = publicConfigId(target);
    providers[id] = { ...providers[id], enabled: true };
  }
  return providers;
}

/** Build the config-aware public matrix before any credential context exists. */
export function productionValidationMatrix(config: Config) {
  const expected = buildCanonicalValidationMatrix();
  // A paid matrix is a complete fixed audit. An explicit disabled public
  // family must fail admission; it must never silently remove that family.
  const providers = normalizedProductionProviders(config);
  const normalizedConfig = { ...config, providers };
  const mapped = mapConfiguration(normalizedConfig, {
    authoredGroups: configGroupProvenance(normalizedConfig),
    assumeCredentialAvailability: true,
  });
  if (mapped.preflight.issues.length > 0) {
    throw new CanonicalLiveValidationError(
      'Production paid validation configuration cannot build a canonical catalog.',
    );
  }
  const matrix = buildCanonicalValidationMatrix({
    provider_config: providers,
    catalog_authority: mapped.catalog,
  });
  const expectedInventory = expected.targets.map(
    (target) => `${target.key}:${target.binding_id}:${target.adapter_id}`,
  );
  const actualInventory = matrix.targets.map(
    (target) => `${target.key}:${target.binding_id}:${target.adapter_id}`,
  );
  if (
    matrix.targets.length !== 40 ||
    new Set(actualInventory).size !== 40 ||
    JSON.stringify(actualInventory) !== JSON.stringify(expectedInventory)
  ) {
    throw new CanonicalLiveValidationError(
      'Production paid validation requires the exact 40-target canonical binding inventory.',
    );
  }
  return matrix;
}

function hasDurableCustody(manifest: {
  readonly coordination_state: {
    readonly attempts?: readonly {
      readonly durable_handle?: { readonly status?: string };
    }[];
  };
}): boolean {
  return (
    manifest.coordination_state.attempts?.some((attempt) =>
      ['pending', 'running'].includes(attempt.durable_handle?.status ?? ''),
    ) ?? false
  );
}

function classifyCustodyOutcome(
  reference: FrozenAttemptReference,
  manifest: {
    readonly coordination_state: {
      readonly status: string;
      readonly attempts?: readonly {
        readonly durable_handle?: { readonly status?: string };
      }[];
    };
  },
): import('./commands/live-validation.js').FrozenExecutionOutcome {
  if (
    manifest.coordination_state.status === 'running' ||
    hasDurableCustody(manifest)
  ) {
    return {
      status: 'reconcile',
      request_id: reference.request_id,
      raw_manifest: JSON.stringify(manifest),
    };
  }
  return {
    status: 'terminal',
    lifecycle:
      manifest.coordination_state.status === 'succeeded'
        ? 'succeeded'
        : manifest.coordination_state.status === 'cancelled'
          ? 'cancelled'
          : 'failed',
    request_id: reference.request_id,
    raw_manifest: JSON.stringify(manifest),
  };
}

/**
 * Creates an exact one-target executor. `prepare` performs both request
 * preflight phases only after all upstream gates have admitted the target.
 */
export function createProductionFrozenCanonicalExecutor(
  approval: LiveValidationApproval,
  config: Config,
  dependencies: ProductionLiveValidationDependencies = {},
): FrozenCanonicalExecutor {
  const productionProviders = normalizedProductionProviders(config);
  const initialize = dependencies.initializeProviders ?? initializeProviders;
  const resolveProvider = dependencies.resolveExactProvider ?? getExactProvider;
  const createDirectory = dependencies.createRunDirectory ?? createRunDir;
  const structuralPreflight =
    dependencies.preflightStructure ?? preflightProductionRequestStructure;
  const credentialPreflight =
    dependencies.preflightCredentials ?? preflightProductionRequest;
  const createCoordinator =
    dependencies.createCoordinator ?? createNodeCoordinatorDependencies;
  const createAttemptBridge =
    dependencies.createAttemptBridge ?? createRegisteredProviderAttemptBridge;
  const materialize =
    dependencies.materialize ?? materializeCanonicalPreparedExecution;
  const resume = dependencies.resume ?? resumeCanonicalPreparedExecution;
  const cancelRun = dependencies.cancelRun ?? cancelCanonicalRun;
  const readReference =
    dependencies.readReferenceManifest ?? readTrustedFrozenReferenceManifest;
  const preparedByRequest = new Map<
    string,
    {
      readonly target: CanonicalValidationTarget;
      readonly prepared: ReturnType<
        typeof preflightProductionRequest
      >['prepared'];
    }
  >();

  const admit = async (
    target: CanonicalValidationTarget,
    protocol: LiveValidationApproval['targets'][number],
  ) => {
    // This repeats the credential-free structural gate immediately before the
    // keychain-aware phase. It proves one exact public profile, frozen input,
    // disabled fallback, and sequential limits before a provider exists.
    const configured: Config = {
      ...config,
      providers: {
        ...productionProviders,
        [publicConfigId(target)]: {
          ...productionProviders[publicConfigId(target)],
          enabled: true,
          options: protocol.options,
        },
      },
    };
    const descriptor = getBuiltinProviderDefinition(target.adapter_id);
    if (!descriptor?.optionsSchema.safeParse(protocol.options).success) {
      throw new CanonicalLiveValidationError(
        'Frozen provider options are invalid before credential resolution.',
      );
    }
    const structural = structuralPreflight({
      config: configured,
      transport: exactInput(target, protocol),
    });
    assertCanonicalValidationPreparedExecution(structural.prepared, target);
    if (
      structural.admittedAdapterIds.length !== 1 ||
      structural.admittedAdapterIds[0] !== target.adapter_id
    ) {
      throw new CanonicalLiveValidationError(
        'Structural paid validation admitted an unexpected adapter.',
      );
    }

    // Credential phase: resolve only the admitted public family and construct
    // only the exact adapter, including private durable adapters which consume
    // their mapped public configuration.
    const admitted = credentialPreflight({
      config: configured,
      transport: exactInput(target, protocol),
    });
    assertCanonicalValidationPreparedExecution(admitted.prepared, target);
    if (
      admitted.admittedAdapterIds.length !== 1 ||
      admitted.admittedAdapterIds[0] !== target.adapter_id
    ) {
      throw new CanonicalLiveValidationError(
        'Credential paid validation admitted an unexpected adapter.',
      );
    }
    await initialize(
      { ...configured, credentials: admitted.credentials },
      {
        builtinAdapterIds: admitted.admittedAdapterIds,
        customProviderIds: admitted.admittedAdapterIds,
      },
    );
    assertAdmittedAdaptersRegistered(
      admitted.prepared,
      admitted.admittedAdapterIds.filter(
        (id) => resolveProvider(id)?.id === id,
      ),
    );
    return admitted.prepared;
  };

  const prepare = async (
    target: CanonicalValidationTarget,
    protocol: LiveValidationApproval['targets'][number],
  ): Promise<FrozenAttemptReference> => {
    const admittedPrepared = await admit(target, protocol);
    const contract = frozenRequestContract(target, protocol);
    const primary = admittedPrepared.request.slots[0]?.primary;
    if (!primary) {
      throw new CanonicalLiveValidationError(
        'Exact paid validation has no primary profile.',
      );
    }
    const requestDeadlineMs =
      primary.invocation === 'background'
        ? protocol.poll_deadline_seconds * 1_000
        : protocol.timeout_seconds * 1_000;
    const preparedWithContract = {
      ...admittedPrepared,
      policy: {
        ...admittedPrepared.policy,
        limits: {
          ...admittedPrepared.policy.limits,
          max_concurrency: 1,
          request_deadline_ms: requestDeadlineMs,
          inline_attempt_deadline_ms: Math.min(
            protocol.timeout_seconds * 1_000,
            requestDeadlineMs,
          ),
          background_attempt_deadline_ms: Math.min(
            protocol.poll_deadline_seconds * 1_000,
            requestDeadlineMs,
          ),
          poll_interval_ms: Math.min(
            admittedPrepared.policy.limits.poll_interval_ms,
            protocol.poll_deadline_seconds * 1_000,
          ),
        },
      },
      request: {
        ...admittedPrepared.request,
        extensions: {
          ...admittedPrepared.request.extensions,
          [LIVE_VALIDATION_CONTRACT_EXTENSION_KEY]:
            frozenProtocolContractHash(contract),
        },
      },
    };

    const runDirectory = createDirectory(
      approval.raw_root,
      `canonical-${target.key.replace('/', '-')}`,
    );
    const coordinator = createCoordinator();
    await materialize(preparedWithContract, {
      runs_root: approval.raw_root,
      run_directory: runDirectory,
      coordinator,
    });
    const reference: FrozenAttemptReference = {
      runs_root: approval.raw_root,
      run_directory: runDirectory,
      request_id: admittedPrepared.request.request_id,
      binding_id: target.binding_id,
      catalog_digest: target.catalog_digest,
      request_fingerprint: frozenRequestFingerprint(target, protocol),
      protocol_contract_hash: frozenProtocolContractHash(contract),
      persisted_protocol_contract: true,
      request_contract: contract,
    };
    preparedByRequest.set(reference.request_id, {
      target,
      prepared: preparedWithContract,
    });
    return reference;
  };

  const bridgeFor = async (
    reference: FrozenAttemptReference,
    target: CanonicalValidationTarget,
    protocol: LiveValidationApproval['targets'][number],
  ) => {
    const stored = preparedByRequest.get(reference.request_id) ?? {
      target,
      prepared: await admit(target, protocol),
    };
    if (!stored || stored.target.key !== target.key) {
      throw new CanonicalLiveValidationError(
        'Exact canonical prepared state is unavailable for this run reference.',
      );
    }
    preparedByRequest.set(reference.request_id, stored);
    return createAttemptBridge(stored.prepared, resolveProvider);
  };

  return {
    prepare,
    async execute(target, protocol, reference) {
      const result = await resume({
        runs_root: reference.runs_root,
        run_directory: reference.run_directory,
        coordinator: createCoordinator(),
        attempt_bridge: await bridgeFor(reference, target, protocol),
      });
      return classifyCustodyOutcome(reference, result.manifest);
    },
    async reconcile(target, protocol, reference) {
      if (!reference)
        throw new CanonicalLiveValidationError(
          'Exact reconciliation requires a frozen run reference.',
        );
      const result = await resume({
        runs_root: reference.runs_root,
        run_directory: reference.run_directory,
        coordinator: createCoordinator(),
        attempt_bridge: await bridgeFor(reference, target, protocol),
      });
      return classifyCustodyOutcome(reference, result.manifest);
    },
    async cancel(target, reference) {
      if (!reference) return;
      // A SIGINT can land after the scheduler persists a zero-attempt
      // materialization and before first dispatch. Cancellation must still
      // commit local custody without pretending a remote attempt exists.
      const manifest = readReference(reference, target, 'cancellable');
      const protocol = approval.targets.find(
        (candidate) => candidate.key === target.key,
      );
      if (!protocol) {
        throw new CanonicalLiveValidationError(
          'Exact cancellation target is absent from the frozen approval.',
        );
      }
      const attemptBridge =
        manifest.coordination_state.attempts.length === 0
          ? undefined
          : await bridgeFor(reference, target, protocol);
      await cancelRun({
        runs_root: reference.runs_root,
        run_directory: reference.run_directory,
        coordinator: createCoordinator(),
        ...(attemptBridge && { attempt_bridge: attemptBridge }),
      });
    },
  };
}
