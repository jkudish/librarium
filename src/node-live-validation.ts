/**
 * Canonical v3 live-validation planning and receipt projection.
 *
 * This module deliberately contains no provider construction, credential
 * lookup, network client, or child-process code.  A caller may only supply an
 * already-prepared exact canonical execution.  That keeps fixture replay and
 * preflight incapable of accidentally dispatching a paid request.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod/v4';
import type {
  ExecutionProfile,
  ProviderIdentity,
} from './contracts/domain/index.js';
import {
  canonicalJson,
  catalogFingerprint,
} from './core/catalog-fingerprint.js';
import {
  type PreparedResearchExecution,
  profileIdentityKey,
} from './core/execution-plan.js';
import { safeWriteFile } from './core/fs-utils.js';
import {
  budgetEstimateFromQuote,
  PricingCatalog,
  type PricingQuote,
} from './core/pricing.js';
import { BUILTIN_PRICING_SNAPSHOT } from './core/pricing-snapshot.js';
import {
  type AdapterProfileBinding,
  buildProfileBindings,
  executionAdapterProfileBindings,
} from './core/profile-bindings.js';
import type { ProviderCatalog } from './core/profile-catalog.js';
import { getBuiltinProviderDefinition } from './core/provider-descriptor.js';
import {
  BUILTIN_PROVIDER_CATALOG,
  catalogProfileKey,
  catalogProfileRefs,
  declaredExecutionProfile,
  type ProviderCatalogEntry,
} from './core/provider-profiles.js';
import { INTERNAL_ADAPTER_PUBLIC_PROVIDER_IDS } from './internal-adapter-ids.js';
import {
  type CanonicalRunManifestV3,
  CanonicalRunManifestV3Schema,
} from './node-canonical-run.js';
import { withRunJsonLock } from './node-run-json-lock.js';

export class CanonicalLiveValidationError extends Error {}

export interface CanonicalValidationProviderConfig {
  /** Named account/credential boundary; never a credential or durable ID. */
  readonly credential_family?: string;
  readonly enabled?: boolean;
  readonly model?: string;
  readonly options?: unknown;
}

/** Namespaced canonical request extension binding a run to its frozen live protocol. */
export const LIVE_VALIDATION_CONTRACT_EXTENSION_KEY =
  'build.librarium:liveValidationContractSha256';

export interface CanonicalValidationTarget {
  readonly key: string;
  readonly adapter_id: string;
  readonly binding_id: string;
  readonly catalog_digest: string;
  readonly requested_identity: ProviderIdentity;
  readonly expected_effective_identity: ProviderIdentity;
  /** Derived from descriptor/config authority, never from an adapter id. */
  readonly credential_family: string;
  readonly pricing_snapshot_fingerprint: string;
}

export interface CanonicalValidationMatrix {
  readonly schema_version: 1;
  readonly catalog_digest: string;
  readonly pricing_snapshot_fingerprint: string;
  readonly fingerprint: string;
  readonly targets: readonly CanonicalValidationTarget[];
}

function targetIdentity(profile: ExecutionProfile): ProviderIdentity {
  return structuredClone(profile.identity);
}

function isImplemented(value: { readonly status: string }): boolean {
  return value.status === 'implemented';
}

/**
 * Build the complete canonical target set.  This is intentionally separate
 * from the legacy benchmark's adapter selector.  Internal durable adapters
 * are included because bindings, rather than public CLI provider ids, are the
 * execution authority.
 */
export function buildCanonicalValidationMatrix(
  options: {
    readonly catalog?: readonly ProviderCatalogEntry[];
    readonly provider_config?: Readonly<
      Record<string, CanonicalValidationProviderConfig>
    >;
    readonly bindings?: ReadonlyMap<string, AdapterProfileBinding>;
    /** Composite config/catalog authority produced by structural preflight. */
    readonly catalog_authority?: ProviderCatalog;
  } = {},
): CanonicalValidationMatrix {
  if (options.catalog_authority) {
    const authority = options.catalog_authority;
    const targets = authority.resolved.flatMap((resolved) => {
      if (!resolved.binding || resolved.declaration.status !== 'implemented') {
        return [];
      }
      if (!resolved.availability.enabled) {
        return [];
      }
      const descriptor = getBuiltinProviderDefinition(
        resolved.binding.adapter_id,
      );
      if (!descriptor) {
        throw new CanonicalLiveValidationError(
          `Exact binding has no descriptor: ${resolved.profile.identity.provider_id}/${resolved.profile.identity.profile_id}`,
        );
      }
      const publicAdapterId =
        INTERNAL_ADAPTER_PUBLIC_PROVIDER_IDS[
          resolved.binding
            .adapter_id as keyof typeof INTERNAL_ADAPTER_PUBLIC_PROVIDER_IDS
        ] ?? resolved.binding.adapter_id;
      const family =
        options.provider_config?.[publicAdapterId]?.credential_family?.trim() ||
        descriptor.credential.envVar;
      const declarationEntry = authority.entries.find(
        (entry) => entry.provider_id === resolved.profile.identity.provider_id,
      );
      const declaration = declarationEntry?.profiles.find(
        (profile) =>
          profile.profile_id === resolved.profile.identity.profile_id,
      );
      const requested =
        declarationEntry && declaration
          ? declaredExecutionProfile(declarationEntry.provider_id, declaration)
          : resolved.profile;
      return [
        Object.freeze({
          key: `${resolved.profile.identity.provider_id}/${resolved.profile.identity.profile_id}`,
          adapter_id: resolved.binding.adapter_id,
          binding_id: resolved.binding.binding_id,
          catalog_digest: authority.digest,
          requested_identity: targetIdentity(requested),
          expected_effective_identity: targetIdentity(resolved.profile),
          credential_family: family,
          pricing_snapshot_fingerprint: BUILTIN_PRICING_SNAPSHOT.fingerprint,
        }),
      ];
    });
    const ordered = [...targets].sort((left, right) =>
      left.key.localeCompare(right.key),
    );
    const frozen = {
      schema_version: 1 as const,
      catalog_digest: authority.digest,
      pricing_snapshot_fingerprint: BUILTIN_PRICING_SNAPSHOT.fingerprint,
      targets: ordered,
    };
    return Object.freeze({
      ...frozen,
      fingerprint: sha256(canonicalJson(frozen)),
    });
  }
  const catalog = options.catalog ?? BUILTIN_PROVIDER_CATALOG;
  const refs = catalogProfileRefs(catalog);
  const bindings = options.bindings ?? executionAdapterProfileBindings();
  const declarations = new Map(
    refs.map(({ entry, declaration }) => [
      catalogProfileKey(entry.provider_id, declaration.profile_id),
      declaration,
    ]),
  );
  const resolvers = buildProfileBindings(declarations);
  const byKey = new Map<string, AdapterProfileBinding>();
  const adapterIds = new Set<string>();

  for (const binding of bindings.values()) {
    const key = catalogProfileKey(binding.provider_id, binding.profile_id);
    if (byKey.has(key)) {
      throw new CanonicalLiveValidationError(
        `Ambiguous canonical binding: ${key}`,
      );
    }
    if (adapterIds.has(binding.adapter_id)) {
      throw new CanonicalLiveValidationError(
        `Duplicate canonical adapter binding: ${binding.adapter_id}`,
      );
    }
    byKey.set(key, binding);
    adapterIds.add(binding.adapter_id);
  }

  const catalogDigest = catalogFingerprint(catalog);
  const targets: CanonicalValidationTarget[] = [];
  const declared = new Set<string>();
  for (const { entry, declaration } of refs) {
    const key = catalogProfileKey(entry.provider_id, declaration.profile_id);
    if (declared.has(key)) {
      throw new CanonicalLiveValidationError(
        `Duplicate canonical declaration: ${key}`,
      );
    }
    declared.add(key);
    const binding = byKey.get(key);
    if (!isImplemented(declaration)) {
      if (binding) {
        throw new CanonicalLiveValidationError(
          `Planned or disabled profile is bound: ${key}`,
        );
      }
      continue;
    }
    if (!binding) {
      throw new CanonicalLiveValidationError(
        `Implemented profile has no exact binding: ${key}`,
      );
    }
    const descriptor = getBuiltinProviderDefinition(binding.adapter_id);
    if (!descriptor) {
      throw new CanonicalLiveValidationError(
        `Exact binding has no descriptor: ${key}`,
      );
    }
    const publicAdapterId =
      INTERNAL_ADAPTER_PUBLIC_PROVIDER_IDS[
        binding.adapter_id as keyof typeof INTERNAL_ADAPTER_PUBLIC_PROVIDER_IDS
      ] ?? binding.adapter_id;
    // Internal durable adapters are implementation detail only. Their public
    // provider configuration is the canonical authority, exactly as the core
    // catalog resolves `INTERNAL_ADAPTER_PUBLIC_PROVIDER_IDS`.
    const config = options.provider_config?.[publicAdapterId];
    if (config?.enabled === false) {
      throw new CanonicalLiveValidationError(
        `Implemented profile is disabled: ${key}`,
      );
    }
    // Resolve through the same exact canonical binding used by catalog
    // preparation, so configuration cannot silently change the expected
    // effective identity.
    const profile = declaredExecutionProfile(entry.provider_id, declaration);
    const resolver = resolvers.get(key);
    if (!resolver) {
      throw new CanonicalLiveValidationError(
        `Implemented profile has no resolver: ${key}`,
      );
    }
    let effective: ExecutionProfile;
    try {
      effective = resolver.resolve({
        model: config?.model,
        options: config?.options,
      }).profile;
    } catch (error) {
      throw new CanonicalLiveValidationError(
        `Exact binding configuration is unresolved for ${key}: ${error instanceof Error ? error.message : 'invalid configuration'}`,
      );
    }
    const family =
      config?.credential_family?.trim() || descriptor.credential.envVar;
    if (!family) {
      throw new CanonicalLiveValidationError(
        `Exact binding has no credential family: ${key}`,
      );
    }
    targets.push(
      Object.freeze({
        key,
        adapter_id: binding.adapter_id,
        binding_id: `${binding.provider_id}.${binding.profile_id}.${binding.adapter_id}`,
        catalog_digest: catalogDigest,
        requested_identity: targetIdentity(profile),
        expected_effective_identity: targetIdentity(effective),
        credential_family: family,
        pricing_snapshot_fingerprint: BUILTIN_PRICING_SNAPSHOT.fingerprint,
      }),
    );
  }
  for (const [key] of byKey) {
    if (!declared.has(key)) {
      throw new CanonicalLiveValidationError(
        `Orphan canonical binding: ${key}`,
      );
    }
  }
  const ordered = [...targets].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
  const matrix = {
    schema_version: 1 as const,
    catalog_digest: catalogDigest,
    pricing_snapshot_fingerprint: BUILTIN_PRICING_SNAPSHOT.fingerprint,
    targets: ordered,
  };
  return Object.freeze({
    ...matrix,
    fingerprint: sha256(canonicalJson(matrix)),
  });
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export interface CanonicalValidationPins {
  readonly matrix_fingerprint: string;
  readonly catalog_digest: string;
  readonly pricing_snapshot_fingerprint: string;
  readonly candidate_fingerprint: string;
  /** Present for paid frozen protocols; generic offline lanes do not use it. */
  readonly approval_fingerprint?: string;
  /** SHA-256 of the complete ordered frozen target protocol list. */
  readonly target_protocols_digest?: string;
}

export type CanonicalValidationAttemptStatus =
  | 'submitted'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'ambiguous';

export interface CanonicalValidationAttempt {
  readonly target_key: string;
  readonly credential_family: string;
  readonly status: CanonicalValidationAttemptStatus;
  readonly reserved_microusd?: string;
  readonly reported_microusd?: string;
  readonly estimated_microusd?: string;
  readonly unknown_cost?: boolean;
  readonly request_fingerprint: string;
  readonly evidence_state?: 'pending' | 'complete' | 'failed';
  readonly raw_evidence_name?: string;
  readonly receipt_evidence_name?: string;
  readonly validation_failure_reason?: string;
  /** Explicit durable operator acknowledgement of a settled non-success. */
  readonly continuation_acknowledged?: true;
  readonly reference?: FrozenAttemptReference;
}

export interface FrozenAttemptReference {
  readonly runs_root: string;
  readonly run_directory: string;
  readonly request_id: string;
  readonly binding_id: string;
  readonly catalog_digest: string;
  readonly request_fingerprint: string;
  readonly protocol_contract_hash: string;
  readonly persisted_protocol_contract?: true;
  readonly request_contract: FrozenCanonicalRequestContract;
}

export interface FrozenCanonicalRequestContract {
  readonly query: string;
  readonly requested_identity: CanonicalValidationTarget['requested_identity'];
  readonly effective_identity: CanonicalValidationTarget['expected_effective_identity'];
  readonly binding_id: string;
  readonly catalog_digest: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly timeout_seconds: number;
  readonly poll_deadline_seconds: number;
  readonly max_concurrency: 1;
  readonly fallback: 'disabled';
  readonly max_requests: 1;
  readonly retry: 'disabled';
  readonly cancel_policy: 'supported_exact_profile' | 'reconcile_only';
  readonly account: string;
  readonly region: string;
}

export interface CanonicalValidationCredentialPacing {
  readonly last_dispatched_at: number;
  readonly next_eligible_at: number;
}

/**
 * Serializable state for the external scheduler. `run.json` remains the
 * lifecycle authority for a dispatched request; this checkpoint only pins
 * admission order, cost reservation and the fact that no next target may be
 * selected while a prior target is unsettled.
 */
export interface CanonicalValidationCheckpoint {
  readonly schema_version: 1;
  readonly pins: CanonicalValidationPins;
  readonly target_order: readonly string[];
  readonly attempts: readonly CanonicalValidationAttempt[];
  readonly credential_pacing?: Readonly<
    Record<string, CanonicalValidationCredentialPacing>
  >;
  readonly interrupted: boolean;
}

const CheckpointSchema = z
  .strictObject({
    schema_version: z.literal(1),
    pins: z.strictObject({
      matrix_fingerprint: z.string().min(1),
      catalog_digest: z.string().min(1),
      pricing_snapshot_fingerprint: z.string().min(1),
      candidate_fingerprint: z.string().min(1),
      approval_fingerprint: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .optional(),
      target_protocols_digest: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .optional(),
    }),
    target_order: z.array(z.string().min(1)),
    attempts: z.array(
      z
        .strictObject({
          target_key: z.string().min(1),
          credential_family: z.string().min(1),
          status: z.enum([
            'submitted',
            'running',
            'succeeded',
            'failed',
            'cancelled',
            'ambiguous',
          ]),
          reserved_microusd: z
            .string()
            .regex(/^(?:0|[1-9]\d*)$/)
            .optional(),
          reported_microusd: z
            .string()
            .regex(/^(?:0|[1-9]\d*)$/)
            .optional(),
          estimated_microusd: z
            .string()
            .regex(/^(?:0|[1-9]\d*)$/)
            .optional(),
          unknown_cost: z.boolean().optional(),
          request_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          evidence_state: z.enum(['pending', 'complete', 'failed']).optional(),
          raw_evidence_name: z
            .string()
            .regex(/^[a-z0-9._-]{1,128}$/)
            .optional(),
          receipt_evidence_name: z
            .string()
            .regex(/^[a-z0-9._-]{1,128}$/)
            .optional(),
          evidence_error: z
            .string()
            .regex(/^[a-z0-9._-]{1,128}$/)
            .optional(),
          validation_failure_reason: z.string().min(1).max(128).optional(),
          continuation_acknowledged: z.literal(true).optional(),
          reference: z
            .strictObject({
              runs_root: z.string().min(1).max(512),
              run_directory: z.string().min(1).max(512),
              request_id: z.string().min(1).max(255),
              binding_id: z.string().min(1).max(255),
              catalog_digest: z.string().min(1).max(255),
              request_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
              protocol_contract_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
              persisted_protocol_contract: z.literal(true).optional(),
              request_contract: z.strictObject({
                query: z.string().min(1).max(8_000),
                requested_identity: z.record(z.string(), z.unknown()),
                effective_identity: z.record(z.string(), z.unknown()),
                binding_id: z.string().min(1),
                catalog_digest: z.string().min(1),
                options: z.record(z.string(), z.unknown()),
                timeout_seconds: z.number().int().positive(),
                poll_deadline_seconds: z.number().int().positive(),
                max_concurrency: z.literal(1),
                fallback: z.literal('disabled'),
                max_requests: z.literal(1),
                retry: z.literal('disabled'),
                cancel_policy: z.enum([
                  'supported_exact_profile',
                  'reconcile_only',
                ]),
                account: z.string().min(1),
                region: z.string().min(1),
              }),
            })
            .optional(),
        })
        .superRefine((attempt, ctx) => {
          const active = ['submitted', 'running', 'ambiguous'].includes(
            attempt.status,
          );
          const terminal = ['succeeded', 'failed', 'cancelled'].includes(
            attempt.status,
          );
          if ((active || terminal) && !attempt.reference) {
            ctx.addIssue({
              code: 'custom',
              message:
                'Active and unsettled evidence attempts require an exact frozen reference',
              path: ['reference'],
            });
          }
          if (
            terminal &&
            (!attempt.evidence_state ||
              !attempt.raw_evidence_name ||
              !attempt.receipt_evidence_name ||
              attempt.raw_evidence_name === attempt.receipt_evidence_name ||
              (attempt.evidence_state === 'failed' &&
                !attempt.evidence_error) ||
              (attempt.evidence_state !== 'failed' && attempt.evidence_error))
          ) {
            ctx.addIssue({
              code: 'custom',
              message:
                'Terminal evidence state, names, and failure reason are inconsistent',
              path: ['evidence_state'],
            });
          }
          if (
            attempt.continuation_acknowledged &&
            (!['failed', 'cancelled'].includes(attempt.status) ||
              attempt.evidence_state !== 'complete')
          ) {
            ctx.addIssue({
              code: 'custom',
              message:
                'Continuation acknowledgement requires settled failed or cancelled evidence',
              path: ['continuation_acknowledged'],
            });
          }
        })
        .readonly(),
    ),
    credential_pacing: z
      .record(
        z.string().min(1),
        z.strictObject({
          last_dispatched_at: z.number().int().nonnegative(),
          next_eligible_at: z.number().int().nonnegative(),
        }),
      )
      .optional(),
    interrupted: z.boolean(),
  })
  .readonly();

function parseCheckpoint(value: unknown): CanonicalValidationCheckpoint {
  try {
    return CheckpointSchema.parse(value) as CanonicalValidationCheckpoint;
  } catch {
    throw new CanonicalLiveValidationError(
      'Checkpoint has an invalid or unsafe schema.',
    );
  }
}

export interface CanonicalValidationCostAdmission {
  readonly target_key: string;
  readonly quote: PricingQuote;
  readonly reserved_microusd?: string;
  readonly unknown_cost: boolean;
  readonly approval_required: boolean;
}

/** Frozen Wave 0A pricing admission; it never refreshes or calls a provider. */
export function quoteCanonicalValidationTarget(
  target: CanonicalValidationTarget,
): CanonicalValidationCostAdmission {
  const primary = target.expected_effective_identity.target.primary;
  const quote = new PricingCatalog(BUILTIN_PRICING_SNAPSHOT).quote({
    requested_identity: target.requested_identity,
    effective_identity: {
      provider_id: target.expected_effective_identity.provider_id,
      ...(primary.kind && { kind: primary.kind }),
      ...(primary.target_id && { target_id: primary.target_id }),
    },
  });
  const estimate = budgetEstimateFromQuote(quote);
  return Object.freeze({
    target_key: target.key,
    quote,
    ...(estimate && { reserved_microusd: estimate.estimated_cost_microusd }),
    unknown_cost: estimate === undefined,
    approval_required: estimate === undefined || quote.status !== 'complete',
  });
}

/** SIGINT-facing checkpoint transition. It cannot dispatch or cancel remotely. */
export function interruptCanonicalValidation(
  checkpoint: CanonicalValidationCheckpoint,
): CanonicalValidationCheckpoint {
  return Object.freeze({ ...structuredClone(checkpoint), interrupted: true });
}

function validationPath(root: string, fileName: string): string {
  if (
    !fileName ||
    isAbsolute(fileName) ||
    fileName.includes('/') ||
    fileName.includes('\\')
  ) {
    throw new CanonicalLiveValidationError(
      'Validation artifact name must be one safe file name.',
    );
  }
  const lexicalRoot = resolve(root);
  try {
    assertNoSymlinkRootComponents(lexicalRoot);
    if (lstatSync(lexicalRoot).isSymbolicLink()) throw new Error('symlink');
    if (!lstatSync(lexicalRoot).isDirectory()) throw new Error('not-dir');
    const realRoot = realpathSync(lexicalRoot);
    const candidate = resolve(realRoot, fileName);
    if (!contained(realRoot, candidate)) throw new Error('escape');
    if (lstatSync(realRoot).isSymbolicLink()) throw new Error('symlink');
    if (lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('symlink');
    }
    return candidate;
  } catch (error) {
    if (error instanceof CanonicalLiveValidationError) throw error;
    throw new CanonicalLiveValidationError(
      'Validation root or artifact path is unsafe.',
    );
  }
}

function assertNoSymlinkRootComponents(root: string): void {
  let current: string = sep;
  for (const component of root.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    // macOS's temporary-directory spelling legitimately crosses /var, which
    // is its documented alias for /private/var. All caller-controlled path
    // components must remain real directories.
    if (lstatSync(current).isSymbolicLink() && current !== '/var') {
      throw new CanonicalLiveValidationError(
        'Validation root contains a symlink path component.',
      );
    }
  }
}

/** Atomic, CAS-protected, owner-only checkpoint repository. */
export class CanonicalValidationCheckpointRepository {
  readonly #path: string;

  constructor(root: string) {
    this.#path = validationPath(root, 'checkpoint.json');
  }

  read(): CanonicalValidationCheckpoint | undefined {
    if (!lstatSync(this.#path, { throwIfNoEntry: false })) return undefined;
    const stat = lstatSync(this.#path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new CanonicalLiveValidationError(
        'Checkpoint must be a regular non-symlink file.',
      );
    }
    try {
      return parseCheckpoint(JSON.parse(readFileSync(this.#path, 'utf8')));
    } catch (error) {
      if (error instanceof CanonicalLiveValidationError) throw error;
      throw new CanonicalLiveValidationError('Checkpoint is not valid JSON.');
    }
  }

  create(
    checkpoint: CanonicalValidationCheckpoint,
  ): CanonicalValidationCheckpoint {
    return withRunJsonLock(this.#path, () => {
      if (this.read())
        throw new CanonicalLiveValidationError('Checkpoint already exists.');
      const parsed = parseCheckpoint(checkpoint);
      safeWriteFile(this.#path, `${JSON.stringify(parsed, null, 2)}\n`, {
        ownerOnly: true,
      });
      return parsed;
    });
  }

  compareAndSwap(
    expected: CanonicalValidationCheckpoint,
    next: CanonicalValidationCheckpoint,
  ): boolean {
    return withRunJsonLock(this.#path, () => {
      const current = this.read();
      if (!current || canonicalJson(current) !== canonicalJson(expected))
        return false;
      const parsed = parseCheckpoint(next);
      safeWriteFile(this.#path, `${JSON.stringify(parsed, null, 2)}\n`, {
        ownerOnly: true,
      });
      return true;
    });
  }
}

/** Private raw-only writer. It never writes to a public receipt directory. */
export function writePrivateRawEvidence(
  root: string,
  name: string,
  content: string,
): void {
  const path = validationPath(root, name);
  safeWriteFile(path, content, { ownerOnly: true });
}

export function writeSanitizedCanonicalReceipt(
  root: string,
  name: string,
  receipt: Record<string, unknown>,
  target?: CanonicalValidationTarget,
): void {
  const path = validationPath(root, name);
  const allowed = new Set([
    'schema_version',
    'candidate_fingerprint',
    'candidate_git_sha',
    'candidate_version',
    'artifact_hashes',
    'request_id',
    'account',
    'region',
    'profile',
    'requested_identity',
    'effective_identity',
    'binding_id',
    'catalog_digest',
    'pricing_snapshot_fingerprint',
    'pricing_quote',
    'request_fingerprint',
    'run_evidence_sha256',
    'lifecycle',
    'response',
    'usage',
    'metering',
    'provenance',
    'quality',
  ]);
  if (Object.keys(receipt).some((key) => !allowed.has(key))) {
    throw new CanonicalLiveValidationError(
      'Public receipt contains a non-allowlisted field.',
    );
  }
  if (
    target &&
    (receipt.profile !== target.key ||
      receipt.catalog_digest !== target.catalog_digest ||
      receipt.pricing_snapshot_fingerprint !==
        target.pricing_snapshot_fingerprint)
  ) {
    throw new CanonicalLiveValidationError(
      'Public receipt target authority does not match its frozen profile.',
    );
  }
  // Re-serialize through the allowlist boundary before making evidence public.
  const frozenPricingUnits = new Set(
    target ? quoteCanonicalValidationTarget(target).quote.missing_units : [],
  );
  assertSafeReceiptValue(receipt, 'receipt', frozenPricingUnits);
  safeWriteFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

export interface CanonicalValidationExecutor {
  execute(
    target: CanonicalValidationTarget,
  ): Promise<'succeeded' | 'failed' | 'cancelled' | 'ambiguous'>;
  cancel?(target: CanonicalValidationTarget): Promise<void>;
}

/**
 * Convert the real canonical prepared-execution service seam into this lane's
 * one-target executor. Production wiring supplies the established preflight
 * materializer and `runCanonicalPreparedExecution`; tests inject the same
 * shape with a fake exact bridge. There is no adapter-id selector path here.
 */
export function createCanonicalPreparedValidationExecutor(input: {
  readonly prepare: (
    target: CanonicalValidationTarget,
  ) => Promise<PreparedResearchExecution> | PreparedResearchExecution;
  readonly run: (
    prepared: PreparedResearchExecution,
    target: CanonicalValidationTarget,
  ) => Promise<{ readonly manifest: CanonicalRunManifestV3 }>;
  readonly cancel?: (target: CanonicalValidationTarget) => Promise<void>;
}): CanonicalValidationExecutor {
  return {
    async execute(target) {
      const prepared = await input.prepare(target);
      assertCanonicalValidationPreparedExecution(prepared, target);
      const result = await input.run(prepared, target);
      const state = result.manifest.coordination_state.status;
      if (state === 'succeeded') return 'succeeded';
      if (state === 'cancelled') return 'cancelled';
      if (state === 'running') return 'ambiguous';
      return 'failed';
    },
    ...(input.cancel && { cancel: input.cancel }),
  };
}

/**
 * Fixture and future paid orchestration. The executor is injected so this
 * module cannot construct a network provider. Each checkpoint transition is
 * written before and after the one allowed execution; a fresh repository can
 * resume only terminal work and never repeats a submitted/ambiguous target.
 */
export async function executeCanonicalValidationLane(input: {
  readonly repository: CanonicalValidationCheckpointRepository;
  readonly matrix: CanonicalValidationMatrix;
  readonly candidate_fingerprint: string;
  readonly candidate_git_sha?: string;
  readonly executor: CanonicalValidationExecutor;
  /** Exact durable run reference materialized before any executor dispatch. */
  readonly materialize_reference: (
    target: CanonicalValidationTarget,
  ) => FrozenAttemptReference;
  readonly approved_unknown_targets?: readonly string[];
  readonly aggregate_budget_microusd?: string;
  readonly signal?: AbortSignal;
}): Promise<CanonicalValidationCheckpoint> {
  let checkpoint = input.repository.read();
  if (!checkpoint) {
    checkpoint = input.repository.create({
      schema_version: 1,
      pins: {
        matrix_fingerprint: input.matrix.fingerprint,
        catalog_digest: input.matrix.catalog_digest,
        pricing_snapshot_fingerprint: input.matrix.pricing_snapshot_fingerprint,
        candidate_fingerprint: input.candidate_fingerprint,
      },
      target_order: input.matrix.targets.map((target) => target.key),
      attempts: [],
      interrupted: false,
    });
  }
  validateCanonicalValidationCheckpoint(
    checkpoint,
    input.matrix,
    input.candidate_fingerprint,
    {
      approved_unknown_targets: input.approved_unknown_targets,
      aggregate_budget_microusd: input.aggregate_budget_microusd,
    },
  );
  if (input.signal?.aborted) {
    const interrupted = interruptCanonicalValidation(checkpoint);
    if (!input.repository.compareAndSwap(checkpoint, interrupted)) {
      throw new CanonicalLiveValidationError(
        'Checkpoint changed while recording interruption.',
      );
    }
    return interrupted;
  }
  const target = nextCanonicalValidationTarget(checkpoint, input.matrix);
  if (!target) return checkpoint;
  const admission = quoteCanonicalValidationTarget(target);
  if (
    admission.approval_required &&
    !input.approved_unknown_targets?.includes(target.key)
  ) {
    throw new CanonicalLiveValidationError(
      `Target requires preregistered pricing approval: ${target.key}`,
    );
  }
  const reservedSoFar = checkpoint.attempts.reduce(
    (total, attempt) =>
      total + parseMicrousd(attempt.reserved_microusd, 'reserved_microusd'),
    0n,
  );
  const nextReservation = parseMicrousd(
    admission.reserved_microusd,
    'reserved_microusd',
  );
  if (
    input.aggregate_budget_microusd !== undefined &&
    reservedSoFar + nextReservation >
      parseMicrousd(
        input.aggregate_budget_microusd,
        'aggregate_budget_microusd',
      )
  ) {
    throw new CanonicalLiveValidationError(
      'Canonical validation reservation exceeds aggregate hard budget.',
    );
  }
  const submitted: CanonicalValidationCheckpoint = {
    ...checkpoint,
    attempts: [
      ...checkpoint.attempts,
      {
        target_key: target.key,
        credential_family: target.credential_family,
        status: 'submitted',
        request_fingerprint: sha256(
          canonicalJson({
            target_key: target.key,
            requested_identity: target.requested_identity,
            expected_effective_identity: target.expected_effective_identity,
          }),
        ),
        reference: input.materialize_reference(target),
        ...(admission.reserved_microusd && {
          reserved_microusd: admission.reserved_microusd,
        }),
        unknown_cost: admission.unknown_cost,
      },
    ],
  };
  if (!input.repository.compareAndSwap(checkpoint, submitted)) {
    throw new CanonicalLiveValidationError(
      'Checkpoint changed before dispatch.',
    );
  }
  if (input.signal?.aborted) {
    await input.executor.cancel?.(target);
    const interrupted = { ...submitted, interrupted: true };
    if (!input.repository.compareAndSwap(submitted, interrupted)) {
      throw new CanonicalLiveValidationError(
        'Checkpoint changed while recording interruption.',
      );
    }
    return interrupted;
  }
  const outcome = await executeWithCanonicalValidationAbort(
    input.executor,
    target,
    input.signal,
  );
  const finished: CanonicalValidationCheckpoint = {
    ...submitted,
    attempts: submitted.attempts.map((attempt) =>
      attempt.target_key === target.key
        ? {
            ...attempt,
            status: outcome,
            ...(['succeeded', 'failed', 'cancelled'].includes(outcome) && {
              evidence_state: 'pending' as const,
              raw_evidence_name: `${target.key.replace('/', '-')}.manifest`,
              receipt_evidence_name: `${target.key.replace('/', '-')}.json`,
            }),
          }
        : attempt,
    ),
  };
  if (!input.repository.compareAndSwap(submitted, finished)) {
    throw new CanonicalLiveValidationError(
      'Checkpoint changed before terminal reconciliation.',
    );
  }
  return finished;
}

/**
 * Abort-aware wrapper for a single exact executor. It persists the submitted
 * state before starting, asks only the injected exact cancellation seam, then
 * waits for the original work to settle before the caller writes terminal
 * reconciliation. This prevents a signal from opening a second dispatch slot.
 */
export async function executeWithCanonicalValidationAbort(
  executor: CanonicalValidationExecutor,
  target: CanonicalValidationTarget,
  signal?: AbortSignal,
): Promise<'succeeded' | 'failed' | 'cancelled' | 'ambiguous'> {
  if (signal?.aborted) {
    await executor.cancel?.(target);
    return 'cancelled';
  }
  let _aborted = false;
  const onAbort = () => {
    _aborted = true;
    void executor.cancel?.(target);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const outcome = await executor.execute(target);
    // A best-effort cancellation request does not prove remote terminal
    // cancellation. Preserve provider-reported ambiguity for reconciliation.
    return outcome;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function parseMicrousd(value: string | undefined, label: string): bigint {
  if (value === undefined) return 0n;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new CanonicalLiveValidationError(
      `${label} must be a non-negative integer microusd string.`,
    );
  }
  return BigInt(value);
}

/**
 * Validate a frozen checkpoint before an executor exists. This makes resume
 * fail closed on duplicate targets, order drift, missing approvals, malformed
 * money values, or an unsettled billable attempt.
 */
export function validateCanonicalValidationCheckpoint(
  checkpoint: CanonicalValidationCheckpoint,
  matrix: CanonicalValidationMatrix,
  candidateFingerprint: string,
  options: {
    readonly approved_unknown_targets?: readonly string[];
    readonly aggregate_budget_microusd?: string;
  } = {},
): CanonicalValidationCheckpoint {
  if (checkpoint.schema_version !== 1) {
    throw new CanonicalLiveValidationError(
      'Unsupported canonical validation checkpoint version.',
    );
  }
  assertCanonicalValidationPins(matrix, checkpoint.pins, candidateFingerprint);
  const expectedOrder = matrix.targets.map((target) => target.key);
  if (canonicalJson(checkpoint.target_order) !== canonicalJson(expectedOrder)) {
    throw new CanonicalLiveValidationError(
      'Canonical validation target order drifted.',
    );
  }
  const targetByKey = new Map(
    matrix.targets.map((target) => [target.key, target]),
  );
  const seen = new Set<string>();
  let reserved = 0n;
  const approvedUnknown = new Set(options.approved_unknown_targets ?? []);
  for (const attempt of checkpoint.attempts) {
    const target = targetByKey.get(attempt.target_key);
    if (!target)
      throw new CanonicalLiveValidationError(
        `Checkpoint contains an unknown target: ${attempt.target_key}`,
      );
    if (seen.has(attempt.target_key))
      throw new CanonicalLiveValidationError(
        `Checkpoint duplicates target: ${attempt.target_key}`,
      );
    seen.add(attempt.target_key);
    if (attempt.credential_family !== target.credential_family) {
      throw new CanonicalLiveValidationError(
        `Checkpoint credential family drifted for ${attempt.target_key}`,
      );
    }
    if (attempt.unknown_cost && !approvedUnknown.has(attempt.target_key)) {
      throw new CanonicalLiveValidationError(
        `Unknown-cost target lacks explicit approval: ${attempt.target_key}`,
      );
    }
    reserved += parseMicrousd(attempt.reserved_microusd, 'reserved_microusd');
    parseMicrousd(attempt.reported_microusd, 'reported_microusd');
    parseMicrousd(attempt.estimated_microusd, 'estimated_microusd');
    if (attempt.status === 'ambiguous') {
      throw new CanonicalLiveValidationError(
        `Ambiguous billable submission requires exact reconciliation: ${attempt.target_key}`,
      );
    }
  }
  for (const [family, pacing] of Object.entries(
    checkpoint.credential_pacing ?? {},
  )) {
    if (!family || pacing.next_eligible_at < pacing.last_dispatched_at) {
      throw new CanonicalLiveValidationError(
        'Checkpoint credential pacing is invalid or tampered.',
      );
    }
  }
  const budget = options.aggregate_budget_microusd;
  if (
    budget !== undefined &&
    reserved > parseMicrousd(budget, 'aggregate_budget_microusd')
  ) {
    throw new CanonicalLiveValidationError(
      'Canonical validation reservation exceeds aggregate hard budget.',
    );
  }
  return structuredClone(checkpoint);
}

/**
 * Strict scheduler: at most one unsettled target, in pinned order. A caller
 * must reconcile the returned target's canonical run.json before calling this
 * again; this function never performs submission itself.
 */
export function nextCanonicalValidationTarget(
  checkpoint: CanonicalValidationCheckpoint,
  matrix: CanonicalValidationMatrix,
): CanonicalValidationTarget | undefined {
  if (checkpoint.interrupted) return undefined;
  const unsettled = checkpoint.attempts.find(
    (attempt) =>
      attempt.status === 'submitted' ||
      attempt.status === 'running' ||
      attempt.status === 'ambiguous',
  );
  if (unsettled) {
    throw new CanonicalLiveValidationError(
      `Cannot schedule after unsettled target: ${unsettled.target_key}`,
    );
  }
  const completed = new Set(
    checkpoint.attempts
      .filter((attempt) =>
        ['succeeded', 'failed', 'cancelled'].includes(attempt.status),
      )
      .map((attempt) => attempt.target_key),
  );
  return matrix.targets.find((target) => !completed.has(target.key));
}

/** Deterministic, non-semantic receipt quality gate. It never calls an LLM. */
export function deterministicReceiptSensibility(input: {
  readonly target: CanonicalValidationTarget;
  readonly content?: string;
  readonly citations?: readonly {
    readonly url: string;
    readonly provider: string;
  }[];
  readonly provenance?: {
    readonly access_mode?: string;
    readonly operator_id?: string;
    readonly collector_id?: string;
    readonly surface_id?: string;
    readonly result_kind?: string;
    readonly retrieval_methods?: readonly string[];
    readonly corpora?: readonly string[];
  };
}): Readonly<Record<string, boolean>> {
  const contentPresent = Boolean(input.content?.trim());
  const [providerId, profileId] = input.target.key.split('/');
  const declaration = BUILTIN_PROVIDER_CATALOG.find(
    (entry) => entry.provider_id === providerId,
  )?.profiles.find((candidate) => candidate.profile_id === profileId);
  if (!providerId || !declaration) {
    throw new CanonicalLiveValidationError(
      `Canonical target has no declared sensibility authority: ${input.target.key}`,
    );
  }
  const profile = declaredExecutionProfile(providerId, declaration);
  const citationsRequired = profile.result_kind !== 'model_answer';
  const citations = input.citations ?? [];
  const citationsValid = citations.every(
    (citation) =>
      citation.provider.trim().length > 0 &&
      /^https:\/\/[A-Za-z0-9.-]+(?:\/|$)/.test(citation.url) &&
      !/[?&](?:sig|signature|token|key)=/i.test(citation.url),
  );
  const citationRequirementMet = !citationsRequired || citations.length > 0;
  const provenancePresent = Boolean(
    input.provenance?.access_mode && input.provenance?.operator_id,
  );
  const profileMatch =
    input.provenance?.result_kind === profile.result_kind &&
    input.provenance?.retrieval_methods?.includes(profile.retrieval_method) ===
      true &&
    profile.corpora.every((corpus) =>
      input.provenance?.corpora?.includes(corpus),
    );
  const collectionModeRequired =
    profile.result_kind === 'surface_observation' ||
    profile.retrieval_method === 'surface_collector';
  const collectionMatch = collectionModeRequired
    ? input.provenance?.access_mode === 'collected' &&
      Boolean(input.provenance.collector_id) &&
      Boolean(input.provenance.surface_id)
    : true;
  return Object.freeze({
    content_present: contentPresent,
    citations_valid: citationsValid,
    citation_requirement_met: citationRequirementMet,
    provenance_present: provenancePresent,
    provenance_profile_match: profileMatch,
    collection_mode_match: collectionMatch,
    passed:
      contentPresent &&
      citationsValid &&
      citationRequirementMet &&
      provenancePresent &&
      profileMatch &&
      collectionMatch,
  });
}

/** Reject a changed candidate, matrix, catalog, or pricing snapshot before dispatch. */
export function assertCanonicalValidationPins(
  matrix: CanonicalValidationMatrix,
  pins: CanonicalValidationPins,
  candidateFingerprint: string,
): void {
  if (pins.matrix_fingerprint !== matrix.fingerprint) {
    throw new CanonicalLiveValidationError(
      'Canonical validation matrix drifted.',
    );
  }
  if (pins.catalog_digest !== matrix.catalog_digest) {
    throw new CanonicalLiveValidationError(
      'Canonical provider catalog drifted.',
    );
  }
  if (
    pins.pricing_snapshot_fingerprint !== matrix.pricing_snapshot_fingerprint
  ) {
    throw new CanonicalLiveValidationError(
      'Canonical pricing snapshot drifted.',
    );
  }
  if (pins.candidate_fingerprint !== candidateFingerprint) {
    throw new CanonicalLiveValidationError(
      'Canonical candidate artifact drifted.',
    );
  }
}

/**
 * Validate the only lifecycle authority before an executor gets a target.
 * A running, reconciled, terminal, or ambiguous billable attempt is never
 * eligible for a fresh submission.
 */
export function assertCanonicalTargetDispatchable(
  manifestInput: unknown,
  target: CanonicalValidationTarget,
): CanonicalRunManifestV3 {
  const manifest = CanonicalRunManifestV3Schema.parse(manifestInput);
  const plans = manifest.coordination_state.profile_plans_by_identity;
  const plan = Object.values(plans).find(
    (candidate) =>
      candidate.binding.adapter_id === target.adapter_id &&
      candidate.binding.binding_id === target.binding_id,
  );
  if (!plan) {
    throw new CanonicalLiveValidationError(
      `run.json does not contain exact target ${target.key}`,
    );
  }
  if (manifest.coordination_state.catalog_digest !== target.catalog_digest) {
    throw new CanonicalLiveValidationError(
      `run.json catalog digest differs for ${target.key}`,
    );
  }
  const attempts = manifest.coordination_state.attempts.filter(
    (attempt) =>
      attempt.profile.identity.provider_id ===
        target.expected_effective_identity.provider_id &&
      attempt.profile.identity.profile_id ===
        target.expected_effective_identity.profile_id &&
      canonicalJson(attempt.profile.identity) ===
        canonicalJson(target.expected_effective_identity),
  );
  if (attempts.length === 0) {
    throw new CanonicalLiveValidationError(
      `run.json has no exact attempt for ${target.key}`,
    );
  }
  // A canonical fallback history is permitted only when its target differs.
  // For this exact provider/profile, every prior attempt must already be
  // terminal and there must be one dispatch-pending candidate.
  const pending = attempts.filter(
    (attempt) => attempt.status === 'dispatch_pending',
  );
  const unsettled = attempts.find((attempt) =>
    ['submitting', 'submitted', 'running', 'acceptance_unknown'].includes(
      attempt.status,
    ),
  );
  if (unsettled) {
    throw new CanonicalLiveValidationError(
      `Refusing to resubmit ${target.key} from ${unsettled.status} state.`,
    );
  }
  if (pending.length !== 1) {
    throw new CanonicalLiveValidationError(
      `run.json has ambiguous dispatch candidates for ${target.key}`,
    );
  }
  const status = pending[0]?.status;
  if (status !== 'dispatch_pending') {
    throw new CanonicalLiveValidationError(
      `Refusing to resubmit ${target.key} from ${status ?? 'missing'} state.`,
    );
  }
  return manifest;
}

/**
 * Verify a prepared execution immediately before it crosses the Node runtime
 * boundary. This is the sole ingress for the validation lane: it accepts one
 * public provider/profile identity and its exact frozen binding, including a
 * private durable adapter. It intentionally has no legacy `--providers`
 * selector parameter.
 */
export function assertCanonicalValidationPreparedExecution(
  prepared: PreparedResearchExecution,
  target: CanonicalValidationTarget,
): void {
  if (prepared.catalog.digest !== target.catalog_digest) {
    throw new CanonicalLiveValidationError(
      `Prepared execution catalog digest differs for ${target.key}`,
    );
  }
  if (
    prepared.request.slots.length !== 1 ||
    prepared.request.fallback_reserve.length !== 0 ||
    prepared.policy.limits.max_concurrency !== 1 ||
    prepared.policy.fallback.kind !== 'disabled'
  ) {
    throw new CanonicalLiveValidationError(
      'Canonical validation requires one exact profile, disabled fallback, and sequential execution.',
    );
  }
  const profile = prepared.request.slots[0]?.primary;
  if (
    !profile ||
    canonicalJson(profile.identity) !==
      canonicalJson(target.expected_effective_identity)
  ) {
    throw new CanonicalLiveValidationError(
      `Prepared execution identity differs for ${target.key}`,
    );
  }
  const plan =
    prepared.profile_plans_by_identity[profileIdentityKey(profile.identity)];
  if (
    !plan ||
    plan.binding.adapter_id !== target.adapter_id ||
    plan.binding.binding_id !== target.binding_id
  ) {
    throw new CanonicalLiveValidationError(
      `Prepared execution binding differs for ${target.key}`,
    );
  }
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  );
}

function assertNoSymlinkPathComponent(root: string, candidate: string): void {
  const relativePath = relative(root, candidate);
  let current = root;
  for (const component of relativePath.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    if (lstatSync(current).isSymbolicLink()) {
      throw new CanonicalLiveValidationError(
        'Raw evidence path contains a symlink.',
      );
    }
  }
}

/** Read raw evidence only from a real, regular file under the private root. */
export function readPrivateRawEvidence(
  root: string,
  reference: string,
): string {
  if (!reference || isAbsolute(reference)) {
    throw new CanonicalLiveValidationError(
      'Raw evidence reference must be a non-empty relative path.',
    );
  }
  const lexicalRoot = resolve(root);
  const lexicalCandidate = resolve(lexicalRoot, reference);
  if (!contained(lexicalRoot, lexicalCandidate)) {
    throw new CanonicalLiveValidationError(
      'Raw evidence escapes its private root.',
    );
  }
  let realRoot: string;
  let realCandidate: string;
  try {
    if (
      lstatSync(lexicalRoot).isSymbolicLink() ||
      lstatSync(lexicalCandidate).isSymbolicLink()
    ) {
      throw new Error('symlink');
    }
    assertNoSymlinkPathComponent(lexicalRoot, lexicalCandidate);
    realRoot = realpathSync(lexicalRoot);
    realCandidate = realpathSync(lexicalCandidate);
    if (!lstatSync(realCandidate).isFile()) throw new Error('not-file');
  } catch {
    throw new CanonicalLiveValidationError(
      'Raw evidence must be an existing non-symlink regular file.',
    );
  }
  if (!contained(realRoot, realCandidate)) {
    throw new CanonicalLiveValidationError(
      'Raw evidence escapes its private root through a symlink.',
    );
  }
  return readFileSync(realCandidate, 'utf8');
}

const FORBIDDEN_RECEIPT_TEXT =
  /(?:bearer\s+|(?:sk|rk|pk)[_-][A-Za-z0-9_-]{12,}|akia[A-Z0-9]{12,}|ghp_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|aiza[A-Za-z0-9_-]{12,}|api[_-]?key|access[_-]?token|authorization|secret|signed(?:[_-]?url)?|x-amz-(?:credential|signature|security-token)|https?:\/\/|(?:^|["'])(?:\/?(?:Users|home|tmp|private|opt|var|etc|mnt|srv|proc|dev)|[A-Za-z]:[\\/]))/i;

const SAFE_RECEIPT_STRING =
  /^(?:USD|[a-z][a-z0-9._-]{0,127}(?:\/[a-z][a-z0-9._-]{0,127})?|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rc\.(?:0|[1-9]\d*)|(?:0|[1-9]\d*)(?:\.\d{1,36})?|[a-f0-9]{40}|sha256:[a-f0-9]{64}|fnv1a64\.1:[a-f0-9]{16})$/;
const SAFE_PROVIDER_PRICING_UNIT =
  /^[a-z][a-z0-9-]{0,62}:[a-z][a-z0-9_]{0,62}$/;
const PRICING_UNIT_RECEIPT_PATH =
  /^receipt\.pricing_quote\.missing_units\[\d+\]$/;

function assertSafeReceiptValue(
  value: unknown,
  path = 'receipt',
  frozenPricingUnits: ReadonlySet<string> = new Set(),
): void {
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value === 'string') {
    const isFrozenProviderPricingUnit =
      PRICING_UNIT_RECEIPT_PATH.test(path) &&
      SAFE_PROVIDER_PRICING_UNIT.test(value) &&
      frozenPricingUnits.has(value);
    if (
      value.length > 256 ||
      (!SAFE_RECEIPT_STRING.test(value) && !isFrozenProviderPricingUnit) ||
      FORBIDDEN_RECEIPT_TEXT.test(value)
    ) {
      throw new CanonicalLiveValidationError(
        `Public receipt contains prohibited material at ${path}.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) {
      throw new CanonicalLiveValidationError(
        `Public receipt array is too large at ${path}.`,
      );
    }
    value.forEach((item, index) => {
      assertSafeReceiptValue(item, `${path}[${index}]`, frozenPricingUnits);
    });
    return;
  }
  if (!value || typeof value !== 'object') {
    throw new CanonicalLiveValidationError(
      `Public receipt has an invalid value at ${path}.`,
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) {
    throw new CanonicalLiveValidationError(
      `Public receipt object is too large at ${path}.`,
    );
  }
  for (const [key, child] of entries) {
    if (
      !/^[a-z][a-z0-9_]{0,63}$/.test(key) ||
      /(?:raw|payload|body|header|secret|credential)/i.test(key)
    ) {
      throw new CanonicalLiveValidationError(
        `Public receipt has a prohibited field at ${path}.`,
      );
    }
    assertSafeReceiptValue(child, `${path}.${key}`, frozenPricingUnits);
  }
}

function citationProjection(
  url: string,
  provider: string,
): { readonly provider: string; readonly url_sha256: string } {
  return { provider, url_sha256: sha256(url) };
}

/** A shallow public receipt boundary: only allowlisted JSON-safe facts pass. */
export function sanitizeCanonicalReceipt(input: {
  readonly target: CanonicalValidationTarget;
  readonly candidate_fingerprint: string;
  readonly candidate_git_sha?: string;
  readonly candidate_version?: string;
  readonly artifact_hashes?: Readonly<Record<string, string>>;
  readonly pricing_quote?: Readonly<
    Record<string, string | number | boolean | readonly string[]>
  >;
  readonly request_id: string;
  readonly request_fingerprint?: string;
  readonly run_evidence_sha256?: string;
  readonly account: string;
  readonly region: string;
  readonly lifecycle: 'succeeded' | 'failed' | 'cancelled';
  readonly response?: {
    readonly content?: string;
    readonly citations?: readonly {
      readonly url: string;
      readonly provider: string;
    }[];
  };
  readonly usage?: Readonly<Record<string, string | number>>;
  readonly metering?: Readonly<
    Record<string, string | number | readonly string[]>
  >;
  readonly provenance?: Readonly<Record<string, string>>;
  readonly quality?: Readonly<Record<string, boolean | number | string>>;
}): Record<string, unknown> {
  const receipt = {
    schema_version: 1,
    candidate_fingerprint: input.candidate_fingerprint,
    candidate_git_sha: input.candidate_git_sha,
    candidate_version: input.candidate_version,
    artifact_hashes: input.artifact_hashes,
    request_id: input.request_id,
    request_fingerprint: input.request_fingerprint,
    run_evidence_sha256: input.run_evidence_sha256,
    account: input.account,
    region: input.region,
    profile: input.target.key,
    requested_identity: input.target.requested_identity,
    effective_identity: input.target.expected_effective_identity,
    binding_id: input.target.binding_id,
    catalog_digest: input.target.catalog_digest,
    pricing_snapshot_fingerprint: input.target.pricing_snapshot_fingerprint,
    pricing_quote: input.pricing_quote,
    lifecycle: input.lifecycle,
    response: input.response
      ? {
          content_sha256: input.response.content
            ? sha256(input.response.content)
            : undefined,
          citation_count: input.response.citations?.length ?? 0,
          citations:
            input.response.citations?.map((citation) =>
              citationProjection(citation.url, citation.provider),
            ) ?? [],
        }
      : undefined,
    usage: input.usage,
    metering: input.metering,
    provenance: input.provenance,
    quality: input.quality,
  };
  const serialized = canonicalJson(receipt);
  const frozenPricingUnits = new Set(
    quoteCanonicalValidationTarget(input.target).quote.missing_units,
  );
  assertSafeReceiptValue(JSON.parse(serialized), 'receipt', frozenPricingUnits);
  return JSON.parse(serialized) as Record<string, unknown>;
}
