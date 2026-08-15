import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { z } from 'zod/v4';
import {
  BUILTIN_PROVIDER_CATALOG,
  declaredExecutionProfile,
} from '../core/provider-profiles.js';
import type { CanonicalRunManifestV3Schema } from '../node-canonical-run.js';
import {
  buildCanonicalValidationMatrix,
  CanonicalLiveValidationError,
  type CanonicalValidationCheckpoint,
  CanonicalValidationCheckpointRepository,
  type CanonicalValidationTarget,
  deterministicReceiptSensibility,
  type FrozenAttemptReference,
  type FrozenCanonicalRequestContract,
  quoteCanonicalValidationTarget,
  readPrivateRawEvidence,
  sanitizeCanonicalReceipt,
  validateCanonicalValidationCheckpoint,
  writePrivateRawEvidence,
  writeSanitizedCanonicalReceipt,
} from '../node-live-validation.js';
import {
  createFilesystemCandidateAuthority,
  type FrozenReferencePhase,
  readTrustedFrozenReferenceManifest,
} from '../node-live-validation-binding.js';
import {
  createProductionFrozenCanonicalExecutor,
  loadProductionValidationConfig,
  productionValidationMatrix,
} from '../node-live-validation-production.js';

const SAFE_ID = /^[a-z][a-z0-9._-]{0,127}$/;
const RC_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rc\.(?:0|[1-9]\d*)$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MICROUSD = /^(?:0|[1-9]\d*)$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/;
const REQUIRED_CANDIDATE_ARTIFACTS = [
  'declarations',
  'npm_tarball',
  'package_inventory',
  'provenance',
  'sea_manifest',
] as const;

const FixtureReplaySchema = z.strictObject({
  schema_version: z.literal(1),
  fixture_id: z.string().regex(SAFE_ID),
  target: z.string().regex(/^[a-z][a-z0-9-]{0,127}\/[a-z][a-z0-9-]{0,127}$/),
  scenario: z.enum(['inline', 'durable']),
  state_root: z.string().min(1).max(1_024),
});
export type LiveValidationFixtureReplay = z.infer<typeof FixtureReplaySchema>;

function readFixtureReplay(reference: string): LiveValidationFixtureReplay {
  if (!isAbsolute(reference)) {
    throw new CanonicalLiveValidationError(
      'Fixture replay manifest must be an absolute regular file.',
    );
  }
  const lexical = resolve(reference);
  if (lstatSync(lexical).isSymbolicLink() || !lstatSync(lexical).isFile()) {
    throw new CanonicalLiveValidationError(
      'Fixture replay manifest must be a non-symlink regular file.',
    );
  }
  const parsed = FixtureReplaySchema.safeParse(
    JSON.parse(readFileSync(realpathSync(lexical), 'utf8')),
  );
  if (!parsed.success || !isAbsolute(parsed.data.state_root)) {
    throw new CanonicalLiveValidationError(
      'Fixture replay manifest has an invalid strict schema.',
    );
  }
  return parsed.data;
}

const TargetProtocolSchema = z
  .strictObject({
    key: z.string().regex(/^[a-z][a-z0-9-]{0,127}\/[a-z][a-z0-9-]{0,127}$/),
    query: z.string().trim().min(1).max(8_000),
    account: z.string().regex(SAFE_ID),
    region: z.string().regex(SAFE_ID),
    credential_reference: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
    options: z.record(z.string(), z.unknown()),
    timeout_seconds: z.number().int().min(1).max(3_600),
    poll_deadline_seconds: z.number().int().min(1).max(86_400),
    pacing_ms: z.number().int().min(0).max(3_600_000),
    max_requests: z.literal(1),
    retry: z.literal('disabled'),
    cancel_policy: z.enum(['supported_exact_profile', 'reconcile_only']),
    sensibility_policy: z.literal('deterministic_required'),
    pricing: z.strictObject({
      status: z.enum(['complete', 'partial', 'unavailable']),
      currency: z.literal('USD'),
      amount_decimal: z.string().regex(DECIMAL).optional(),
      known_maximum_decimal: z.string().regex(DECIMAL).optional(),
      reserved_microusd: z.string().regex(MICROUSD).optional(),
      /** Explicit operator stop amount for an otherwise unpriced operation. */
      approved_maximum_microusd: z.string().regex(MICROUSD).optional(),
      unknown_reason: z.string().trim().min(1).max(256).optional(),
      unknown_approved: z.boolean(),
    }),
  })
  .superRefine((target, ctx) => {
    if (
      target.pricing.reserved_microusd
        ? target.pricing.approved_maximum_microusd !== undefined
        : !target.pricing.unknown_reason ||
          !target.pricing.unknown_approved ||
          !target.pricing.approved_maximum_microusd ||
          target.pricing.approved_maximum_microusd === '0'
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Unreserved pricing requires a non-zero approved maximum included in the hard budget',
      });
    }
  });

const ApprovalSchema = z
  .strictObject({
    schema_version: z.literal(2),
    candidate: z.strictObject({
      git_sha: z.string().regex(/^[a-f0-9]{40}$/),
      fingerprint: z.string().regex(SHA256),
      version: z.string().regex(RC_VERSION),
      artifact_hashes: z.record(
        z.string().regex(SAFE_ID),
        z.string().regex(SHA256),
      ),
    }),
    matrix_fingerprint: z.string().regex(SHA256),
    catalog_digest: z.string().regex(/^fnv1a64\.1:[a-f0-9]{16}$/),
    pricing_snapshot_fingerprint: z.string().regex(SHA256),
    aggregate_budget_microusd: z.string().regex(MICROUSD),
    raw_root: z.string().min(1).max(1_024),
    receipt_root: z.string().min(1).max(1_024),
    targets: z.array(TargetProtocolSchema).min(1).max(40),
  })
  .superRefine((approval, ctx) => {
    if (
      Object.keys(approval.candidate.artifact_hashes).length === 0 ||
      Object.keys(approval.candidate.artifact_hashes).length > 64
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['candidate', 'artifact_hashes'],
        message: 'artifact hashes must contain 1 to 64 entries',
      });
    }
    const keys = new Set<string>();
    for (const [index, target] of approval.targets.entries()) {
      if (keys.has(target.key))
        ctx.addIssue({
          code: 'custom',
          path: ['targets', index, 'key'],
          message: 'duplicate target',
        });
      keys.add(target.key);
    }
    if (
      canonicalJson(Object.keys(approval.candidate.artifact_hashes).sort()) !==
      canonicalJson([...REQUIRED_CANDIDATE_ARTIFACTS])
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['candidate', 'artifact_hashes'],
        message: 'candidate artifact inventory is not immutable and complete',
      });
    }
  });

export type LiveValidationApproval = z.infer<typeof ApprovalSchema>;

function authoritativeReserve(
  target: CanonicalValidationTarget,
  protocol: LiveValidationApproval['targets'][number],
): bigint {
  if (protocol.credential_reference !== target.credential_family) {
    throw new CanonicalLiveValidationError(
      `Frozen credential family differs from canonical target: ${target.key}.`,
    );
  }
  const authority = quoteCanonicalValidationTarget(target);
  if (
    protocol.pricing.status !== authority.quote.status ||
    protocol.pricing.amount_decimal !== authority.quote.amount_decimal ||
    protocol.pricing.known_maximum_decimal !==
      authority.quote.known_maximum_decimal
  ) {
    throw new CanonicalLiveValidationError(
      `Frozen pricing quote differs from Wave 0A authority: ${target.key}.`,
    );
  }
  if (authority.quote.status === 'complete' && authority.reserved_microusd) {
    if (
      protocol.pricing.reserved_microusd !== authority.reserved_microusd ||
      authority.reserved_microusd === '0'
    ) {
      throw new CanonicalLiveValidationError(
        `Frozen known-price reservation differs from Wave 0A authority: ${target.key}.`,
      );
    }
    return BigInt(authority.reserved_microusd);
  }
  if (
    protocol.pricing.reserved_microusd !== undefined ||
    !protocol.pricing.unknown_approved ||
    !protocol.pricing.unknown_reason ||
    !protocol.pricing.approved_maximum_microusd ||
    protocol.pricing.approved_maximum_microusd === '0'
  ) {
    throw new CanonicalLiveValidationError(
      `Frozen unknown-price approval is invalid: ${target.key}.`,
    );
  }
  return BigInt(protocol.pricing.approved_maximum_microusd);
}

export interface ApprovalGate {
  readonly approval: LiveValidationApproval;
  readonly fingerprint: string;
}

/**
 * The future production binding supplies this from its already-verified
 * candidate checkout/artifact store.  Keeping it injected makes the command
 * preflight testable without ever resolving a credential or transport.
 */
export interface FrozenCandidateAuthority {
  readonly candidate_root: string;
  readonly git_sha: () => string;
  readonly candidate_fingerprint: () => string;
  /** @deprecated Use candidate_fingerprint. */
  readonly candidate_sha256: () => string;
  readonly candidate_version: () => string;
  readonly artifact_names: () => readonly string[];
  readonly artifact_sha256: (name: string) => string;
  /** Re-check source/package/artifact bytes against the frozen snapshot. */
  readonly verify: () => void;
}

/** Fixture/preflight callers must provide this capability boundary instead of
 * constructing a transport. Its only valid behavior is to throw on use. */
export interface OfflineNetworkCapability {
  assertDenied(operation: string): never;
}

export function createDeniedNetworkCapability(): OfflineNetworkCapability {
  return Object.freeze({
    assertDenied(operation: string): never {
      throw new CanonicalLiveValidationError(
        `Network capability is denied during offline validation: ${operation}.`,
      );
    },
  });
}

/** Install a process-local offline guard for fixture/preflight command execution. */
export function installOfflineNetworkGuard(): () => void {
  const previous = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
  };
  const blocked = (): never => {
    throw new CanonicalLiveValidationError(
      'Network access is denied during canonical validation preflight.',
    );
  };
  globalThis.fetch = async () => blocked();
  http.request = blocked as typeof http.request;
  http.get = blocked as typeof http.get;
  https.request = blocked as typeof https.request;
  https.get = blocked as typeof https.get;
  net.connect = blocked as typeof net.connect;
  net.createConnection = blocked as typeof net.createConnection;
  return () => {
    globalThis.fetch = previous.fetch;
    http.request = previous.httpRequest;
    http.get = previous.httpGet;
    https.request = previous.httpsRequest;
    https.get = previous.httpsGet;
    net.connect = previous.netConnect;
    net.createConnection = previous.netCreateConnection;
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertFrozenAttemptReference(
  reference: FrozenAttemptReference,
  target: CanonicalValidationTarget,
  protocol: LiveValidationApproval['targets'][number],
): void {
  const root = resolve(reference.runs_root);
  const directory = resolve(reference.run_directory);
  const path = relative(root, directory);
  const contract = frozenRequestContract(target, protocol);
  if (
    !isAbsolute(reference.runs_root) ||
    !isAbsolute(reference.run_directory) ||
    path === '' ||
    path === '..' ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path) ||
    !reference.request_id.trim() ||
    reference.binding_id !== target.binding_id ||
    reference.catalog_digest !== target.catalog_digest ||
    reference.request_fingerprint !==
      frozenRequestFingerprint(target, protocol) ||
    canonicalJson(reference.request_contract) !== canonicalJson(contract) ||
    reference.protocol_contract_hash !== frozenProtocolContractHash(contract)
  ) {
    throw new CanonicalLiveValidationError(
      `Frozen canonical attempt reference is invalid: ${target.key}.`,
    );
  }
}

export function frozenProtocolContractHash(
  contract: FrozenCanonicalRequestContract,
): string {
  return `sha256:${createHash('sha256').update(canonicalJson(contract)).digest('hex')}`;
}

export function frozenRequestContract(
  target: CanonicalValidationTarget,
  protocol: LiveValidationApproval['targets'][number],
): FrozenCanonicalRequestContract {
  return {
    query: protocol.query,
    requested_identity: target.requested_identity,
    effective_identity: target.expected_effective_identity,
    binding_id: target.binding_id,
    catalog_digest: target.catalog_digest,
    options: protocol.options,
    timeout_seconds: protocol.timeout_seconds,
    poll_deadline_seconds: protocol.poll_deadline_seconds,
    max_concurrency: 1,
    fallback: 'disabled',
    max_requests: protocol.max_requests,
    retry: protocol.retry,
    cancel_policy: protocol.cancel_policy,
    account: protocol.account,
    region: protocol.region,
  };
}

export function frozenRequestFingerprint(
  target: CanonicalValidationTarget,
  protocol: LiveValidationApproval['targets'][number],
): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(frozenRequestContract(target, protocol)))
    .digest('hex')}`;
}

export function approvalFingerprint(approval: LiveValidationApproval): string {
  return `sha256:${createHash('sha256').update(canonicalJson(approval)).digest('hex')}`;
}

/** Bind every future target protocol, in its approved order, to one checkpoint. */
export function approvalTargetProtocolsDigest(
  approval: LiveValidationApproval,
): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(approval.targets))
    .digest('hex')}`;
}

function assertFrozenApprovalPins(
  pins: CanonicalValidationCheckpoint['pins'],
  gate: ApprovalGate,
): void {
  if (
    pins.approval_fingerprint !== gate.fingerprint ||
    pins.target_protocols_digest !==
      approvalTargetProtocolsDigest(gate.approval)
  ) {
    throw new CanonicalLiveValidationError(
      'Checkpoint approval protocol continuity drifted.',
    );
  }
}

function safeExistingDirectory(path: string, label: string): string {
  if (!isAbsolute(path) || !existsSync(path))
    throw new CanonicalLiveValidationError(
      `${label} must be an existing absolute directory.`,
    );
  const resolved = resolve(path);
  let current: string = sep;
  for (const component of resolved.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    // macOS exposes its temporary directory through /var -> /private/var.
    // Keep that platform alias explicit; every other symlink component is
    // rejected, including a symlink at the root leaf.
    if (lstatSync(current).isSymbolicLink() && current !== '/var') {
      throw new CanonicalLiveValidationError(
        `${label} must not contain a symlink path component.`,
      );
    }
  }
  const stat = lstatSync(resolved);
  if (!stat.isDirectory())
    throw new CanonicalLiveValidationError(
      `${label} must be a non-symlink directory.`,
    );
  return realpathSync(resolved);
}

function assertSeparateEvidenceRoots(approval: LiveValidationApproval): void {
  const raw = safeExistingDirectory(approval.raw_root, 'Private raw root');
  const receipt = safeExistingDirectory(
    approval.receipt_root,
    'Sanitized receipt root',
  );
  const receiptFromRaw = relative(raw, receipt);
  const rawFromReceipt = relative(receipt, raw);
  if (
    raw === receipt ||
    (!receiptFromRaw.startsWith(`..${sep}`) &&
      receiptFromRaw !== '..' &&
      !isAbsolute(receiptFromRaw)) ||
    (!rawFromReceipt.startsWith(`..${sep}`) &&
      rawFromReceipt !== '..' &&
      !isAbsolute(rawFromReceipt))
  ) {
    throw new CanonicalLiveValidationError(
      'Private raw and sanitized receipt roots must be distinct and non-nested.',
    );
  }
}

/**
 * Paid execution may only load the package that the immutable authority
 * verified. A matching artifact digest alone is not enough if this process is
 * running a different checkout.
 */
export function assertRunningCandidateRoot(
  candidateAuthority: FrozenCandidateAuthority,
): void {
  let runtimePackageRoot: string | undefined;
  let approvedRoot: string;
  try {
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    let directory = resolve(modulePath, '..');
    for (let depth = 0; depth < 8; depth += 1) {
      const packageJson = resolve(directory, 'package.json');
      const stat = lstatSync(packageJson, { throwIfNoEntry: false });
      if (stat?.isFile() && !stat.isSymbolicLink()) {
        runtimePackageRoot = realpathSync(directory);
        break;
      }
      const parent = resolve(directory, '..');
      if (parent === directory) break;
      directory = parent;
    }
    if (!runtimePackageRoot) throw new Error('runtime-package-root-not-found');
    approvedRoot = realpathSync(resolve(candidateAuthority.candidate_root));
  } catch {
    throw new CanonicalLiveValidationError(
      'Production paid validation cannot resolve its running candidate root.',
    );
  }
  if (runtimePackageRoot !== approvedRoot) {
    throw new CanonicalLiveValidationError(
      'Production paid validation must run from the approved immutable candidate root.',
    );
  }
}

export function readLiveValidationApproval(path: string): ApprovalGate {
  if (!path || !isAbsolute(path))
    throw new CanonicalLiveValidationError(
      'Paid validation requires an absolute preregistration file path.',
    );
  const resolved = resolve(path);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new CanonicalLiveValidationError(
      'Preregistration must be a regular non-symlink file.',
    );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch {
    throw new CanonicalLiveValidationError(
      'Preregistration must be valid JSON.',
    );
  }
  const parsed = ApprovalSchema.safeParse(raw);
  if (!parsed.success)
    throw new CanonicalLiveValidationError(
      `Preregistration file has an invalid schema: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ')}.`,
    );
  return {
    approval: parsed.data,
    fingerprint: approvalFingerprint(parsed.data),
  };
}

/** All validation below is credential-free. Keep it before any production binding. */
export function assertLiveValidationGate(
  gate: ApprovalGate,
  confirmation: string | undefined,
  optIn: string | undefined,
  candidateAuthority?: FrozenCandidateAuthority,
  matrix = buildCanonicalValidationMatrix(),
): ReturnType<typeof buildCanonicalValidationMatrix> {
  const approval = gate.approval;
  if (confirmation !== gate.fingerprint || optIn !== gate.fingerprint) {
    throw new CanonicalLiveValidationError(
      'Paid validation requires matching full preregistration --confirm and LIBRARIUM_LIVE_VALIDATION_APPROVED.',
    );
  }
  if (
    approval.matrix_fingerprint !== matrix.fingerprint ||
    approval.catalog_digest !== matrix.catalog_digest ||
    approval.pricing_snapshot_fingerprint !==
      matrix.pricing_snapshot_fingerprint
  ) {
    throw new CanonicalLiveValidationError(
      'Frozen paid preregistration drifted from canonical authority.',
    );
  }
  if (
    JSON.stringify(approval.targets.map((target) => target.key)) !==
    JSON.stringify(matrix.targets.map((target) => target.key))
  ) {
    throw new CanonicalLiveValidationError(
      'Frozen paid preregistration target order differs from canonical matrix.',
    );
  }
  assertSeparateEvidenceRoots(approval);
  if (!candidateAuthority) {
    throw new CanonicalLiveValidationError(
      'Paid validation requires a verified candidate authority before credential resolution.',
    );
  }
  candidateAuthority.verify();
  if (
    candidateAuthority.candidate_fingerprint() !==
    approval.candidate.fingerprint
  ) {
    throw new CanonicalLiveValidationError(
      'Frozen candidate fingerprint drifted.',
    );
  }
  if (candidateAuthority.git_sha() !== approval.candidate.git_sha) {
    throw new CanonicalLiveValidationError('Frozen candidate Git SHA drifted.');
  }
  if (candidateAuthority.candidate_version() !== approval.candidate.version) {
    throw new CanonicalLiveValidationError('Frozen candidate version drifted.');
  }
  if (
    canonicalJson([...candidateAuthority.artifact_names()].sort()) !==
    canonicalJson([...REQUIRED_CANDIDATE_ARTIFACTS])
  ) {
    throw new CanonicalLiveValidationError(
      'Candidate artifact inventory differs from the frozen immutable contract.',
    );
  }
  for (const [name, expected] of Object.entries(
    approval.candidate.artifact_hashes,
  )) {
    if (candidateAuthority.artifact_sha256(name) !== expected) {
      throw new CanonicalLiveValidationError(
        `Frozen candidate artifact drifted: ${name}.`,
      );
    }
  }
  let reserved = 0n;
  for (const protocol of approval.targets) {
    const target = matrix.targets.find(
      (candidate) => candidate.key === protocol.key,
    );
    if (!target)
      throw new CanonicalLiveValidationError(
        `Frozen target is not canonical: ${protocol.key}.`,
      );
    reserved += authoritativeReserve(target, protocol);
    if (reserved > BigInt(approval.aggregate_budget_microusd)) {
      throw new CanonicalLiveValidationError(
        'Frozen aggregate reservation exceeds hard budget.',
      );
    }
  }
  return matrix;
}

export type FrozenExecutionOutcome =
  | {
      readonly status: 'terminal';
      readonly lifecycle: 'succeeded' | 'failed' | 'cancelled';
      readonly request_id: string;
      readonly raw_manifest: string;
    }
  | {
      readonly status: 'reconcile';
      readonly request_id: string;
      readonly raw_manifest: string;
    };

export interface FrozenCanonicalExecutor {
  /** Must structurally prepare one public profile and may read credentials only here. */
  prepare(
    target: CanonicalValidationTarget,
    protocol: LiveValidationApproval['targets'][number],
  ): Promise<FrozenAttemptReference>;
  /** New work only. The caller has persisted its single active operation first. */
  execute(
    target: CanonicalValidationTarget,
    protocol: LiveValidationApproval['targets'][number],
    reference: FrozenAttemptReference,
  ): Promise<FrozenExecutionOutcome>;
  /** Resume/retrieve/custody only. It must never call submit. */
  reconcile(
    target: CanonicalValidationTarget,
    protocol: LiveValidationApproval['targets'][number],
    attempt?: FrozenAttemptReference,
  ): Promise<FrozenExecutionOutcome>;
  cancel?(
    target: CanonicalValidationTarget,
    reference?: FrozenAttemptReference,
  ): Promise<void>;
}

export interface OfflineSignalProcess {
  on(event: 'SIGINT', listener: () => void): unknown;
  removeListener(event: 'SIGINT', listener: () => void): unknown;
}

/** Injectable command-level SIGINT seam; no handler is installed by default. */
export function installOfflineValidationSigint(
  processLike: OfflineSignalProcess,
  controller: AbortController,
): () => void {
  const onSignal = () => controller.abort();
  processLike.on('SIGINT', onSignal);
  return () => processLike.removeListener('SIGINT', onSignal);
}

/** Explicit human continuation after a run has no unsettled work. */
export function continueFrozenValidationProtocol(
  repository: CanonicalValidationCheckpointRepository,
  gate: ApprovalGate,
  matrix: ReturnType<typeof buildCanonicalValidationMatrix>,
  confirmation: string,
  candidateAuthority: FrozenCandidateAuthority,
  referenceAuthority: FrozenReferenceManifestAuthority = Object.freeze({
    read: readTrustedFrozenReferenceManifest,
  }),
): void {
  const checkpoint = repository.read();
  if (!checkpoint) {
    throw new CanonicalLiveValidationError(
      'No frozen validation checkpoint exists.',
    );
  }
  candidateAuthority.verify();
  if (
    candidateAuthority.git_sha() !== gate.approval.candidate.git_sha ||
    candidateAuthority.candidate_fingerprint() !==
      gate.approval.candidate.fingerprint
  ) {
    throw new CanonicalLiveValidationError(
      'Frozen candidate drifted before continuation.',
    );
  }
  if (
    checkpoint.pins.candidate_fingerprint !==
    gate.approval.candidate.fingerprint
  ) {
    throw new CanonicalLiveValidationError(
      'Continuation preregistration fingerprint drifted.',
    );
  }
  assertFrozenApprovalPins(checkpoint.pins, gate);
  if (
    confirmation !== gate.fingerprint ||
    gate.fingerprint !== approvalFingerprint(gate.approval)
  ) {
    throw new CanonicalLiveValidationError(
      'Continuation requires the exact frozen preregistration fingerprint.',
    );
  }
  validateCanonicalValidationCheckpoint(
    checkpoint,
    matrix,
    gate.approval.candidate.fingerprint,
    {
      approved_unknown_targets: gate.approval.targets
        .filter((target) => target.pricing.unknown_approved)
        .map((target) => target.key),
      aggregate_budget_microusd: gate.approval.aggregate_budget_microusd,
    },
  );
  if (
    checkpoint.attempts.some((attempt) =>
      ['submitted', 'running', 'ambiguous'].includes(attempt.status),
    )
  ) {
    throw new CanonicalLiveValidationError(
      'Exact reconciliation is required before continuation.',
    );
  }
  if (
    checkpoint.attempts.some(
      (attempt) =>
        ['succeeded', 'failed', 'cancelled'].includes(attempt.status) &&
        attempt.evidence_state !== 'complete',
    )
  ) {
    throw new CanonicalLiveValidationError(
      'Complete terminal evidence is required before continuation.',
    );
  }
  const byKey = new Map(matrix.targets.map((target) => [target.key, target]));
  const protocolByKey = new Map(
    gate.approval.targets.map((target) => [target.key, target]),
  );
  for (const attempt of checkpoint.attempts) {
    if (!['succeeded', 'failed', 'cancelled'].includes(attempt.status))
      continue;
    const target = byKey.get(attempt.target_key);
    const protocol = protocolByKey.get(attempt.target_key);
    if (
      !target ||
      !protocol ||
      !attempt.reference ||
      !attempt.raw_evidence_name ||
      !attempt.receipt_evidence_name
    ) {
      throw new CanonicalLiveValidationError(
        'Continuation terminal evidence is incomplete.',
      );
    }
    const manifest = referenceAuthority.read(
      attempt.reference,
      target,
      'terminal',
    );
    const terminal = trustedTerminalOutcome(
      target,
      protocol,
      attempt.reference,
      {
        status: 'terminal',
        lifecycle:
          manifest.coordination_state.status === 'succeeded'
            ? 'succeeded'
            : manifest.coordination_state.status === 'cancelled'
              ? 'cancelled'
              : 'failed',
        request_id: manifest.request.request_id,
        raw_manifest: JSON.stringify(manifest),
      },
      referenceAuthority,
    );
    const quality = frozenEvidenceQuality(target, terminal);
    const expectedStatus =
      terminal.lifecycle === 'succeeded' && quality.passed !== true
        ? 'failed'
        : terminal.lifecycle;
    const rawEvidence = readPrivateRawEvidence(
      gate.approval.raw_root,
      attempt.raw_evidence_name,
    );
    let receipt: Record<string, unknown>;
    try {
      const receiptRoot = safeExistingDirectory(
        gate.approval.receipt_root,
        'Sanitized receipt root',
      );
      const receiptPath = resolve(receiptRoot, attempt.receipt_evidence_name);
      const stat = lstatSync(receiptPath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe');
      receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      throw new CanonicalLiveValidationError(
        'Continuation sanitized receipt evidence is missing or invalid.',
      );
    }
    const rebuilt = rebuildFrozenValidationEvidence(
      gate,
      target,
      protocol,
      { ...terminal, raw_manifest: rawEvidence },
      expectedStatus,
    );
    if (
      attempt.status !== expectedStatus ||
      canonicalJson(JSON.parse(rawEvidence)) !== canonicalJson(manifest) ||
      canonicalJson(receipt) !== canonicalJson(rebuilt.receipt) ||
      canonicalJson(quality) !== canonicalJson(rebuilt.quality)
    ) {
      throw new CanonicalLiveValidationError(
        `Continuation evidence drifted: ${attempt.target_key}.`,
      );
    }
  }
  const blocker = gate.approval.targets
    .map((target) =>
      checkpoint.attempts.find((attempt) => attempt.target_key === target.key),
    )
    .find(
      (attempt) =>
        attempt !== undefined &&
        ['failed', 'cancelled'].includes(attempt.status) &&
        !attempt.continuation_acknowledged,
    );
  if (!blocker && !checkpoint.interrupted) return;
  const nextCheckpoint = {
    ...checkpoint,
    interrupted: false,
    attempts: checkpoint.attempts.map((attempt) =>
      blocker && attempt.target_key === blocker.target_key
        ? { ...attempt, continuation_acknowledged: true as const }
        : attempt,
    ),
  };
  if (!repository.compareAndSwap(checkpoint, nextCheckpoint)) {
    throw new CanonicalLiveValidationError(
      'Checkpoint changed during continuation.',
    );
  }
}

export interface FrozenExecutionState {
  readonly completed: readonly string[];
  readonly failed: readonly string[];
  readonly cancelled: readonly string[];
  readonly active?: string;
  readonly reserved_microusd: string;
}

export function terminalValidationCertification(
  state: FrozenExecutionState,
  targetCount: number,
):
  | undefined
  | {
      readonly mode: 'paid';
      readonly certification: 'passed' | 'failed';
      readonly target_count: number;
      readonly succeeded: readonly string[];
      readonly failed: readonly string[];
      readonly cancelled: readonly string[];
      readonly reserved_microusd: string;
    } {
  const settled =
    state.completed.length + state.failed.length + state.cancelled.length;
  if (state.active || settled !== targetCount) return undefined;
  return Object.freeze({
    mode: 'paid',
    certification:
      state.failed.length === 0 && state.cancelled.length === 0
        ? 'passed'
        : 'failed',
    target_count: targetCount,
    succeeded: state.completed,
    failed: state.failed,
    cancelled: state.cancelled,
    reserved_microusd: state.reserved_microusd,
  });
}

interface TrustedTerminalOutcome {
  readonly status: 'terminal';
  readonly lifecycle: 'succeeded' | 'failed' | 'cancelled';
  readonly request_id: string;
  readonly raw_manifest: string;
  readonly manifest: z.infer<typeof CanonicalRunManifestV3Schema>;
}

export interface FrozenReferenceManifestAuthority {
  read(
    reference: FrozenAttemptReference,
    target: CanonicalValidationTarget,
    phase: FrozenReferencePhase,
    diagnostic_outcome?: FrozenExecutionOutcome,
  ): z.infer<typeof CanonicalRunManifestV3Schema>;
}

function trustedTerminalOutcome(
  target: CanonicalValidationTarget,
  protocol: LiveValidationApproval['targets'][number],
  reference: FrozenAttemptReference,
  outcome: FrozenExecutionOutcome,
  authority: FrozenReferenceManifestAuthority,
): TrustedTerminalOutcome {
  if (outcome.status !== 'terminal') {
    throw new CanonicalLiveValidationError(
      `Exact reconciliation required: ${target.key}`,
    );
  }
  const manifest = authority.read(reference, target, 'terminal', outcome);
  assertFrozenAttemptReference(reference, target, protocol);
  const plan = Object.values(
    manifest.coordination_state.profile_plans_by_identity,
  ).find(
    (candidate) =>
      candidate.binding.adapter_id === target.adapter_id &&
      candidate.binding.binding_id === target.binding_id &&
      canonicalJson(candidate.identity) ===
        canonicalJson(target.expected_effective_identity),
  );
  if (
    !plan ||
    manifest.coordination_state.catalog_digest !== target.catalog_digest ||
    manifest.request.request_id !== reference.request_id ||
    manifest.request.request_id !== outcome.request_id ||
    !manifest.terminal_response
  ) {
    throw new CanonicalLiveValidationError(
      `Executor canonical result does not match exact target ${target.key}.`,
    );
  }
  if (manifest.request.query !== protocol.query) {
    throw new CanonicalLiveValidationError(
      `Executor canonical request differs from frozen query for ${target.key}.`,
    );
  }
  if (
    manifest.coordination_state.max_concurrency !== 1 ||
    manifest.request.fallback_reserve.length !== 0
  ) {
    throw new CanonicalLiveValidationError(
      `Executor canonical request violates frozen one-target contract for ${target.key}.`,
    );
  }
  const lifecycle =
    manifest.coordination_state.status === 'succeeded'
      ? 'succeeded'
      : manifest.coordination_state.status === 'cancelled'
        ? 'cancelled'
        : 'failed';
  return {
    status: 'terminal',
    lifecycle,
    request_id: manifest.request.request_id,
    raw_manifest: JSON.stringify(manifest),
    manifest,
  };
}

function frozenEvidenceQuality(
  target: CanonicalValidationTarget,
  result: TrustedTerminalOutcome,
): Readonly<Record<string, boolean>> {
  const response = result.manifest.terminal_response;
  if (!response) {
    throw new CanonicalLiveValidationError(
      'Canonical terminal receipt is missing from the v3 manifest.',
    );
  }
  const resultBodies = response.results.map((item) =>
    typeof item.content === 'string'
      ? item.content
      : canonicalJson(item.content),
  );
  const citations = response.results.flatMap((item) =>
    item.citations.flatMap((citation) =>
      citation.source.url
        ? [
            {
              url: citation.source.url,
              // This comes from the canonical terminal response, never the
              // selected target or an adapter identifier.
              provider: citation.source.provider_reference ?? citation.id,
            },
          ]
        : [],
    ),
  );
  const provenance = response.results[0]?.provenance;
  const declaration = BUILTIN_PROVIDER_CATALOG.find(
    (entry) => entry.provider_id === target.requested_identity.provider_id,
  )?.profiles.find(
    (profile) => profile.profile_id === target.requested_identity.profile_id,
  );
  const profile = declaration
    ? declaredExecutionProfile(
        target.requested_identity.provider_id,
        declaration,
      )
    : undefined;
  return deterministicReceiptSensibility({
    target,
    content: resultBodies.join('\n'),
    citations,
    provenance: provenance
      ? {
          access_mode: profile?.access_mode,
          operator_id: profile?.operator_id,
          ...(provenance.collector && { collector_id: provenance.collector }),
          ...(provenance.surface && { surface_id: provenance.surface }),
          result_kind: provenance.result_kind,
          retrieval_methods: provenance.retrieval_methods,
          corpora: provenance.corpora,
        }
      : undefined,
  });
}

const ACTUAL_COST_SOURCES = new Set([
  'provider_reported',
  'computed_from_tokens',
  'computed_from_request',
  'computed_from_credits',
  'account_usage_delta',
]);
const METERING_KINDS = new Set([
  'native_cost',
  'native_tokens',
  'request_priced',
  'credit_priced',
  'api_unit_priced',
  'manual_unmetered',
]);

interface SafeCanonicalMetering {
  readonly kind: string;
  readonly pricing_version?: string;
  readonly actual_cost_source?: string;
  readonly source_class?: string;
  readonly billable_units?: number;
  readonly billable_unit?: string;
  readonly actual_completeness?: 'complete' | 'partial' | 'unknown';
  readonly actual_evidence?: string;
  readonly missing_units?: readonly string[];
}

function canonicalMeteringMetadata(
  providerMeta: Readonly<Record<string, unknown>> | undefined,
): SafeCanonicalMetering | undefined {
  const input = providerMeta?.['librarium:metering'];
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  const allowed = new Set([
    'kind',
    'pricing_version',
    'actual_cost_source',
    'source_class',
    'billable_units',
    'billable_unit',
    'actual_completeness',
    'actual_evidence',
    'missing_units',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (typeof value.kind !== 'string' || !METERING_KINDS.has(value.kind))
    return undefined;
  if (
    value.actual_cost_source !== undefined &&
    (typeof value.actual_cost_source !== 'string' ||
      !ACTUAL_COST_SOURCES.has(value.actual_cost_source))
  )
    return undefined;
  for (const key of [
    'pricing_version',
    'source_class',
    'billable_unit',
  ] as const) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'string' ||
        !/^[a-z0-9._-]{1,128}$/.test(value[key]))
    )
      return undefined;
  }
  if (
    value.actual_completeness !== undefined &&
    value.actual_completeness !== 'complete' &&
    value.actual_completeness !== 'partial' &&
    value.actual_completeness !== 'unknown'
  )
    return undefined;
  if (
    value.actual_evidence !== undefined &&
    (typeof value.actual_evidence !== 'string' ||
      !/^[a-z0-9._-]{1,128}$/.test(value.actual_evidence))
  )
    return undefined;
  if (
    value.missing_units !== undefined &&
    (!Array.isArray(value.missing_units) ||
      value.missing_units.length > 32 ||
      value.missing_units.some(
        (unit) =>
          typeof unit !== 'string' || !/^[a-z0-9._-]{1,128}$/.test(unit),
      ))
  )
    return undefined;
  if (
    value.billable_units !== undefined &&
    (typeof value.billable_units !== 'number' ||
      !Number.isFinite(value.billable_units) ||
      value.billable_units < 0)
  )
    return undefined;
  return value as unknown as SafeCanonicalMetering;
}

export function rebuildFrozenValidationEvidence(
  gate: ApprovalGate,
  target: CanonicalValidationTarget,
  protocol: LiveValidationApproval['targets'][number],
  result: TrustedTerminalOutcome,
  lifecycleOverride?: 'succeeded' | 'failed' | 'cancelled',
): {
  readonly quality: Readonly<Record<string, boolean>>;
  readonly receipt: Record<string, unknown>;
} {
  const response = result.manifest.terminal_response;
  if (!response) {
    throw new CanonicalLiveValidationError(
      'Canonical terminal receipt is missing from the v3 manifest.',
    );
  }
  const resultBodies = response.results.map((item) =>
    typeof item.content === 'string'
      ? item.content
      : canonicalJson(item.content),
  );
  const citations = response.results.flatMap((item) =>
    item.citations.flatMap((citation) =>
      citation.source.url
        ? [
            {
              url: citation.source.url,
              provider: citation.source.provider_reference ?? citation.id,
            },
          ]
        : [],
    ),
  );
  const primary = response.results[0];
  const provenance = primary?.provenance;
  const declaration = BUILTIN_PROVIDER_CATALOG.find(
    (entry) => entry.provider_id === target.requested_identity.provider_id,
  )?.profiles.find(
    (profile) => profile.profile_id === target.requested_identity.profile_id,
  );
  const profile = declaration
    ? declaredExecutionProfile(
        target.requested_identity.provider_id,
        declaration,
      )
    : undefined;
  const quote = quoteCanonicalValidationTarget(target).quote;
  const providerMeta = primary?.provider_meta;
  const canonicalMetering = canonicalMeteringMetadata(providerMeta);
  const actualSource = canonicalMetering?.actual_cost_source ?? 'unknown';
  const quality = frozenEvidenceQuality(target, result);
  const receipt = sanitizeCanonicalReceipt({
    target,
    candidate_fingerprint: gate.approval.candidate.fingerprint,
    candidate_git_sha: gate.approval.candidate.git_sha,
    candidate_version: gate.approval.candidate.version,
    artifact_hashes: gate.approval.candidate.artifact_hashes,
    pricing_quote: {
      status: protocol.pricing.status,
      reserved_microusd: protocol.pricing.reserved_microusd ?? '0',
      ...(protocol.pricing.approved_maximum_microusd && {
        approved_maximum_microusd: protocol.pricing.approved_maximum_microusd,
      }),
      currency: quote.currency,
      completeness: quote.status,
      missing_units: quote.missing_units,
      source_class: quote.provenance?.source_class ?? 'unknown',
      snapshot_fingerprint: quote.snapshot_fingerprint,
    },
    request_fingerprint: frozenRequestFingerprint(target, protocol),
    run_evidence_sha256: `sha256:${createHash('sha256')
      .update(result.raw_manifest)
      .digest('hex')}`,
    request_id: result.request_id,
    account: protocol.account,
    region: protocol.region,
    lifecycle: lifecycleOverride ?? result.lifecycle,
    response: {
      content: resultBodies.join('\n'),
      citations,
    },
    usage: response.usage,
    // Namespaced canonical metering is authoritative even when a provider
    // has no token/USD usage object. Unit-priced, token-computed, and
    // account-delta evidence must survive the public receipt boundary.
    metering:
      primary?.usage || canonicalMetering
        ? {
            ...(canonicalMetering && { kind: canonicalMetering.kind }),
            ...(canonicalMetering?.pricing_version && {
              pricing_version: canonicalMetering.pricing_version,
            }),
            ...(primary?.usage?.actual_cost !== undefined && {
              actual_cost: primary.usage.actual_cost,
            }),
            ...(primary?.usage?.estimated_cost !== undefined && {
              estimated_cost: primary.usage.estimated_cost,
            }),
            ...(primary?.usage?.currency && {
              currency: primary.usage.currency,
            }),
            source: actualSource,
            source_class: canonicalMetering?.source_class ?? 'unknown',
            completeness: canonicalMetering?.actual_completeness ?? 'unknown',
            missing_units: canonicalMetering?.missing_units ?? [],
            ...(canonicalMetering?.billable_units !== undefined && {
              billable_units: canonicalMetering.billable_units,
            }),
            ...(canonicalMetering?.billable_unit && {
              billable_unit: canonicalMetering.billable_unit,
            }),
            evidence_source: canonicalMetering
              ? (canonicalMetering.actual_evidence ?? 'librarium_metering')
              : 'unknown',
            ...(primary?.usage?.prompt_tokens !== undefined && {
              prompt_tokens: primary.usage.prompt_tokens,
            }),
            ...(primary?.usage?.completion_tokens !== undefined && {
              completion_tokens: primary.usage.completion_tokens,
            }),
          }
        : { completeness: 'unknown' },
    provenance: provenance
      ? {
          result_kind: provenance.result_kind,
          retrieval_methods_sha256: `sha256:${createHash('sha256')
            .update(canonicalJson(provenance.retrieval_methods))
            .digest('hex')}`,
          corpora_sha256: `sha256:${createHash('sha256')
            .update(canonicalJson(provenance.corpora))
            .digest('hex')}`,
          access_mode: profile?.access_mode ?? 'unverified',
          operator_id: profile?.operator_id ?? 'unverified',
          evidence_source: 'effective_profile',
          ...(profile?.collector_id && {
            collector_id: profile.collector_id,
          }),
          ...(profile?.surface_id && { surface_id: profile.surface_id }),
        }
      : undefined,
    quality,
  });
  return { quality, receipt };
}

function writeFrozenEvidence(
  gate: ApprovalGate,
  target: CanonicalValidationTarget,
  protocol: LiveValidationApproval['targets'][number],
  result: TrustedTerminalOutcome,
  lifecycleOverride?: 'succeeded' | 'failed' | 'cancelled',
): { readonly passed: boolean; readonly reason?: string } {
  const built = rebuildFrozenValidationEvidence(
    gate,
    target,
    protocol,
    result,
    lifecycleOverride,
  );
  writePrivateRawEvidence(
    gate.approval.raw_root,
    `${target.key.replace('/', '-')}.manifest`,
    result.raw_manifest,
  );
  writeSanitizedCanonicalReceipt(
    gate.approval.receipt_root,
    `${target.key.replace('/', '-')}.json`,
    built.receipt,
  );
  return built.quality.passed === true
    ? { passed: true }
    : { passed: false, reason: 'deterministic_sensibility_failed' };
}

/**
 * Zero-network state machine shared by future production binding and fixtures.
 * It has no credential accessor: all gates and state decisions complete before
 * the injected executor's `prepare` boundary.
 */
export async function executeFrozenValidationProtocol(input: {
  readonly gate: ApprovalGate;
  readonly matrix: ReturnType<typeof buildCanonicalValidationMatrix>;
  readonly executor: FrozenCanonicalExecutor;
  /** Durable scheduler checkpoint. Defaults under the isolated private root. */
  readonly repository?: CanonicalValidationCheckpointRepository;
  readonly signal?: AbortSignal;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly reference_manifest_authority?: FrozenReferenceManifestAuthority;
  readonly candidate_authority: FrozenCandidateAuthority;
}): Promise<FrozenExecutionState> {
  const referenceAuthority =
    input.reference_manifest_authority ??
    Object.freeze({ read: readTrustedFrozenReferenceManifest });
  const verifyCandidate = (): void => {
    input.candidate_authority.verify();
    if (
      input.candidate_authority.git_sha() !==
        input.gate.approval.candidate.git_sha ||
      input.candidate_authority.candidate_fingerprint() !==
        input.gate.approval.candidate.fingerprint ||
      canonicalJson([...input.candidate_authority.artifact_names()].sort()) !==
        canonicalJson([...REQUIRED_CANDIDATE_ARTIFACTS])
    ) {
      throw new CanonicalLiveValidationError(
        'Frozen candidate authority drifted before canonical operation.',
      );
    }
    for (const [name, hash] of Object.entries(
      input.gate.approval.candidate.artifact_hashes,
    )) {
      if (input.candidate_authority.artifact_sha256(name) !== hash) {
        throw new CanonicalLiveValidationError(
          `Frozen candidate artifact drifted before canonical operation: ${name}.`,
        );
      }
    }
  };
  verifyCandidate();
  const repository =
    input.repository ??
    new CanonicalValidationCheckpointRepository(input.gate.approval.raw_root);
  let checkpoint =
    repository.read() ??
    repository.create({
      schema_version: 1,
      pins: {
        matrix_fingerprint: input.matrix.fingerprint,
        catalog_digest: input.matrix.catalog_digest,
        pricing_snapshot_fingerprint: input.matrix.pricing_snapshot_fingerprint,
        candidate_fingerprint: input.gate.approval.candidate.fingerprint,
        approval_fingerprint: input.gate.fingerprint,
        target_protocols_digest: approvalTargetProtocolsDigest(
          input.gate.approval,
        ),
      },
      target_order: input.gate.approval.targets.map((target) => target.key),
      attempts: [],
      interrupted: false,
    });
  // A fresh process must reject malformed or drifted state before it can
  // reach either reconcile or the credential-capable prepare seam.
  checkpoint = validateCanonicalValidationCheckpoint(
    checkpoint,
    input.matrix,
    input.gate.approval.candidate.fingerprint,
    {
      approved_unknown_targets: input.gate.approval.targets
        .filter((target) => target.pricing.unknown_approved)
        .map((target) => target.key),
      aggregate_budget_microusd: input.gate.approval.aggregate_budget_microusd,
    },
  );
  assertFrozenApprovalPins(checkpoint.pins, input.gate);
  const activeFromCheckpoint = checkpoint.attempts.find((attempt) =>
    ['submitted', 'running', 'ambiguous'].includes(attempt.status),
  )?.target_key;
  let state: FrozenExecutionState = {
    completed: [],
    failed: [],
    cancelled: [],
    ...(activeFromCheckpoint && { active: activeFromCheckpoint }),
    reserved_microusd: checkpoint.attempts
      .reduce(
        (sum, attempt) => sum + BigInt(attempt.reserved_microusd ?? '0'),
        0n,
      )
      .toString(),
  };
  const byKey = new Map(
    input.matrix.targets.map((target) => [target.key, target]),
  );
  const protocolByKey = new Map(
    input.gate.approval.targets.map((target) => [target.key, target]),
  );
  for (const attempt of checkpoint.attempts) {
    const target = byKey.get(attempt.target_key);
    const protocol = protocolByKey.get(attempt.target_key);
    if (!target || !protocol) continue;
    const expectedReserve = authoritativeReserve(target, protocol).toString();
    if (attempt.reserved_microusd !== expectedReserve) {
      throw new CanonicalLiveValidationError(
        `Checkpoint reservation differs from the frozen approval: ${target.key}.`,
      );
    }
  }
  for (const attempt of checkpoint.attempts) {
    const target = byKey.get(attempt.target_key);
    const protocol = protocolByKey.get(attempt.target_key);
    if (!target || !protocol) {
      throw new CanonicalLiveValidationError(
        'Checkpoint request contract target drifted.',
      );
    }
    if (
      attempt.request_fingerprint !== frozenRequestFingerprint(target, protocol)
    ) {
      throw new CanonicalLiveValidationError(
        `Checkpoint frozen request contract drifted: ${attempt.target_key}.`,
      );
    }
    if (attempt.reference) {
      assertFrozenAttemptReference(attempt.reference, target, protocol);
    }
    if (['succeeded', 'failed', 'cancelled'].includes(attempt.status)) {
      if (!attempt.reference) {
        throw new CanonicalLiveValidationError(
          'Terminal checkpoint lacks its exact frozen canonical reference.',
        );
      }
      const manifest = referenceAuthority.read(
        attempt.reference,
        target,
        'terminal',
      );
      const terminal = trustedTerminalOutcome(
        target,
        protocol,
        attempt.reference,
        {
          status: 'terminal',
          lifecycle:
            manifest.coordination_state.status === 'succeeded'
              ? 'succeeded'
              : manifest.coordination_state.status === 'cancelled'
                ? 'cancelled'
                : 'failed',
          request_id: manifest.request.request_id,
          raw_manifest: JSON.stringify(manifest),
        },
        referenceAuthority,
      );
      const quality = frozenEvidenceQuality(target, terminal);
      const expectedStatus =
        terminal.lifecycle === 'succeeded' && quality.passed !== true
          ? 'failed'
          : terminal.lifecycle;
      if (
        attempt.evidence_state === 'complete' &&
        attempt.status !== expectedStatus
      ) {
        throw new CanonicalLiveValidationError(
          `Terminal checkpoint differs from canonical lifecycle or quality: ${target.key}.`,
        );
      }
      if (attempt.evidence_state === 'complete') {
        if (attempt.status === 'succeeded') {
          state = { ...state, completed: [...state.completed, target.key] };
        } else if (attempt.status === 'failed') {
          state = { ...state, failed: [...state.failed, target.key] };
        } else if (attempt.status === 'cancelled') {
          state = { ...state, cancelled: [...state.cancelled, target.key] };
        }
      }
    }
  }
  // A prior process can crash after terminal custody is persisted but before
  // public/private evidence finishes. Reconcile again (never submit) and
  // regenerate deterministic evidence before scheduling or continuation.
  for (const pending of checkpoint.attempts.filter(
    (attempt) =>
      ['succeeded', 'failed', 'cancelled'].includes(attempt.status) &&
      attempt.evidence_state === 'pending',
  )) {
    const target = byKey.get(pending.target_key);
    const protocol = protocolByKey.get(pending.target_key);
    if (!target || !protocol || !pending.reference) {
      throw new CanonicalLiveValidationError(
        'Pending evidence lacks its exact frozen canonical reference.',
      );
    }
    referenceAuthority.read(pending.reference, target, 'active');
    verifyCandidate();
    const terminal = trustedTerminalOutcome(
      target,
      protocol,
      pending.reference,
      await input.executor.reconcile(target, protocol, pending.reference),
      referenceAuthority,
    );
    const quality = frozenEvidenceQuality(target, terminal);
    const lifecycle = quality.passed === true ? terminal.lifecycle : 'failed';
    try {
      const evidence = writeFrozenEvidence(
        input.gate,
        target,
        protocol,
        terminal,
        lifecycle,
      );
      if (evidence.passed !== true && lifecycle === 'succeeded') {
        throw new CanonicalLiveValidationError(
          `Recovered evidence failed deterministic sensibility: ${target.key}.`,
        );
      }
    } catch (error) {
      const failedEvidence = {
        ...checkpoint,
        attempts: checkpoint.attempts.map((attempt) =>
          attempt.target_key === pending.target_key
            ? {
                ...attempt,
                evidence_state: 'failed' as const,
                evidence_error: 'evidence_write_failed',
              }
            : attempt,
        ),
      };
      repository.compareAndSwap(checkpoint, failedEvidence);
      throw error;
    }
    const completedEvidence = {
      ...checkpoint,
      attempts: checkpoint.attempts.map((attempt) =>
        attempt.target_key === pending.target_key
          ? {
              ...attempt,
              status: lifecycle,
              ...(quality.passed !== true && {
                validation_failure_reason: 'deterministic_sensibility_failed',
              }),
              evidence_state: 'complete' as const,
            }
          : attempt,
      ),
    };
    if (!repository.compareAndSwap(checkpoint, completedEvidence)) {
      throw new CanonicalLiveValidationError(
        'Checkpoint changed after evidence recovery.',
      );
    }
    checkpoint = completedEvidence;
    if (lifecycle === 'succeeded') {
      state = {
        ...state,
        completed: [...new Set([...state.completed, target.key])],
      };
    }
  }
  if (state.active) {
    const target = byKey.get(state.active);
    const protocol = protocolByKey.get(state.active);
    if (!target || !protocol)
      throw new CanonicalLiveValidationError(
        'Active checkpoint target drifted.',
      );
    const activeAttempt = checkpoint.attempts.find(
      (attempt) => attempt.target_key === target.key,
    );
    if (!activeAttempt?.reference) {
      throw new CanonicalLiveValidationError(
        'Active checkpoint lacks its exact frozen canonical reference.',
      );
    }
    // A submitted outer checkpoint can survive a crash at any inner lifecycle
    // point. The trusted run.json decides whether it remains materialized,
    // active, or terminal. Only a verified running zero-attempt request may
    // reach the dispatch-capable execute seam; existing custody is retrieval-only.
    const authoritativeManifest = referenceAuthority.read(
      activeAttempt.reference,
      target,
      activeAttempt.status === 'submitted' ? 'resume' : 'active',
    );
    verifyCandidate();
    let cancellation: Promise<void> | undefined;
    const onAbort = () => {
      cancellation =
        protocol.cancel_policy === 'supported_exact_profile'
          ? (input.executor.cancel?.(target, activeAttempt.reference) ??
            Promise.resolve())
          : Promise.resolve();
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    let recovered: FrozenExecutionOutcome;
    try {
      if (input.signal?.aborted) onAbort();
      recovered =
        activeAttempt.status === 'submitted' &&
        authoritativeManifest.coordination_state.status === 'running' &&
        authoritativeManifest.coordination_state.attempts.length === 0
          ? await input.executor.execute(
              target,
              protocol,
              activeAttempt.reference,
            )
          : await input.executor.reconcile(
              target,
              protocol,
              activeAttempt.reference,
            );
      await cancellation;
      if (input.signal?.aborted) {
        const interrupted = { ...checkpoint, interrupted: true };
        if (!repository.compareAndSwap(checkpoint, interrupted)) {
          throw new CanonicalLiveValidationError(
            'Checkpoint changed while recording active reconciliation interruption.',
          );
        }
        return state;
      }
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
    }
    if (recovered.status === 'reconcile') {
      const running = {
        ...checkpoint,
        attempts: checkpoint.attempts.map((attempt) =>
          attempt.target_key === target.key
            ? { ...attempt, status: 'running' as const }
            : attempt,
        ),
      };
      if (!repository.compareAndSwap(checkpoint, running)) {
        throw new CanonicalLiveValidationError(
          'Checkpoint changed while recording resumed canonical custody.',
        );
      }
      return state;
    }
    const terminal = trustedTerminalOutcome(
      target,
      protocol,
      activeAttempt.reference,
      recovered,
      referenceAuthority,
    );
    const quality = frozenEvidenceQuality(target, terminal);
    const qualityPassed = quality.passed === true;
    const lifecycle = qualityPassed ? terminal.lifecycle : 'failed';
    const rawName = `${target.key.replace('/', '-')}.manifest`;
    const receiptName = `${target.key.replace('/', '-')}.json`;
    const nextCheckpoint = {
      ...checkpoint,
      attempts: checkpoint.attempts.map((attempt) =>
        attempt.target_key === target.key
          ? {
              ...attempt,
              status: lifecycle,
              ...(!qualityPassed && {
                validation_failure_reason: 'deterministic_sensibility_failed',
              }),
              evidence_state: 'pending' as const,
              raw_evidence_name: rawName,
              receipt_evidence_name: receiptName,
            }
          : attempt,
      ),
    };
    if (!repository.compareAndSwap(checkpoint, nextCheckpoint)) {
      throw new CanonicalLiveValidationError(
        'Checkpoint changed during exact reconciliation.',
      );
    }
    checkpoint = nextCheckpoint;
    try {
      writeFrozenEvidence(input.gate, target, protocol, terminal, lifecycle);
    } catch (error) {
      const failedEvidence = {
        ...checkpoint,
        attempts: checkpoint.attempts.map((attempt) =>
          attempt.target_key === target.key
            ? {
                ...attempt,
                evidence_state: 'failed' as const,
                evidence_error: 'evidence_write_failed',
              }
            : attempt,
        ),
      };
      repository.compareAndSwap(checkpoint, failedEvidence);
      throw error;
    }
    const completedEvidence = {
      ...checkpoint,
      attempts: checkpoint.attempts.map((attempt) =>
        attempt.target_key === target.key
          ? { ...attempt, evidence_state: 'complete' as const }
          : attempt,
      ),
    };
    if (!repository.compareAndSwap(checkpoint, completedEvidence)) {
      throw new CanonicalLiveValidationError(
        'Checkpoint changed after evidence write.',
      );
    }
    checkpoint = completedEvidence;
    if (lifecycle !== 'succeeded') {
      throw new CanonicalLiveValidationError(
        `Canonical lifecycle ${lifecycle} stops frozen validation for ${target.key}.`,
      );
    }
    if (!qualityPassed) {
      throw new CanonicalLiveValidationError(
        `Validation failed deterministic sensibility for ${target.key}.`,
      );
    }
    state = {
      ...state,
      active: undefined,
      completed: [...state.completed, target.key],
    };
  }
  const stopped = checkpoint.attempts.find(
    (attempt) =>
      (attempt.status !== 'succeeded' && !attempt.continuation_acknowledged) ||
      attempt.evidence_state === 'failed' ||
      (attempt.status === 'succeeded' && attempt.evidence_state !== 'complete'),
  );
  if (stopped) {
    throw new CanonicalLiveValidationError(
      `Frozen validation remains stopped by terminal state: ${stopped.target_key}.`,
    );
  }
  // An interrupted run may reconcile its durable active request above, but it
  // cannot schedule another paid request without explicit continuation.
  if (checkpoint.interrupted) return state;
  let lastCredential: string | undefined;
  let lastNow = 0;
  const now = (): number => {
    const value = input.now?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < lastNow) {
      throw new CanonicalLiveValidationError(
        'Validation clock moved backwards or is invalid.',
      );
    }
    lastNow = value;
    return value;
  };
  const interrupt = (): FrozenExecutionState => {
    const interrupted = { ...checkpoint, interrupted: true };
    if (!repository.compareAndSwap(checkpoint, interrupted)) {
      throw new CanonicalLiveValidationError(
        'Checkpoint changed while recording interruption.',
      );
    }
    checkpoint = interrupted;
    return { ...state };
  };
  const settledTargetKeys = new Set(
    checkpoint.attempts
      .filter(
        (attempt) =>
          ['succeeded', 'failed', 'cancelled'].includes(attempt.status) &&
          attempt.evidence_state === 'complete' &&
          (attempt.status === 'succeeded' ||
            attempt.continuation_acknowledged === true),
      )
      .map((attempt) => attempt.target_key),
  );
  for (const protocol of input.gate.approval.targets) {
    if (settledTargetKeys.has(protocol.key)) continue;
    const target = byKey.get(protocol.key);
    if (!target)
      throw new CanonicalLiveValidationError(
        `Frozen target drifted: ${protocol.key}`,
      );
    const nextReserve =
      BigInt(state.reserved_microusd) + authoritativeReserve(target, protocol);
    if (nextReserve > BigInt(input.gate.approval.aggregate_budget_microusd))
      throw new CanonicalLiveValidationError(
        'Hard budget stops the next frozen target before prepare.',
      );
    if (input.signal?.aborted) {
      return interrupt();
    }
    if (
      lastCredential === protocol.credential_reference &&
      protocol.pacing_ms > 0
    )
      await (
        input.wait ?? ((ms) => new Promise((done) => setTimeout(done, ms)))
      )(protocol.pacing_ms);
    verifyCandidate();
    if (input.signal?.aborted) return interrupt();
    const priorPacing =
      checkpoint.credential_pacing?.[protocol.credential_reference];
    const dispatchedAt = now();
    if (priorPacing && dispatchedAt < priorPacing.next_eligible_at) {
      throw new CanonicalLiveValidationError(
        `Credential family pacing has not elapsed: ${protocol.credential_reference}.`,
      );
    }
    // This is intentionally the first credential-capable seam.
    const preparedRun = await input.executor.prepare(target, protocol);
    assertFrozenAttemptReference(preparedRun, target, protocol);
    referenceAuthority.read(preparedRun, target, 'materialized');
    if (input.signal?.aborted) return interrupt();
    const submitted = {
      ...checkpoint,
      credential_pacing: {
        ...checkpoint.credential_pacing,
        [protocol.credential_reference]: {
          last_dispatched_at: dispatchedAt,
          next_eligible_at: dispatchedAt + protocol.pacing_ms,
        },
      },
      attempts: [
        ...checkpoint.attempts,
        {
          target_key: target.key,
          credential_family: protocol.credential_reference,
          status: 'submitted' as const,
          request_fingerprint: frozenRequestFingerprint(target, protocol),
          reference: preparedRun,
          reserved_microusd: authoritativeReserve(target, protocol).toString(),
          unknown_cost: protocol.pricing.status !== 'complete',
        },
      ],
    };
    if (input.signal?.aborted) return interrupt();
    if (!repository.compareAndSwap(checkpoint, submitted)) {
      throw new CanonicalLiveValidationError(
        'Checkpoint changed before dispatch.',
      );
    }
    checkpoint = submitted;
    state = {
      ...state,
      active: protocol.key,
      reserved_microusd: nextReserve.toString(),
    };
    let cancellation: Promise<void> | undefined;
    const onAbort = () => {
      cancellation =
        protocol.cancel_policy === 'supported_exact_profile'
          ? (input.executor.cancel?.(target, preparedRun) ?? Promise.resolve())
          : Promise.resolve();
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // Close the narrow post-checkpoint/pre-execute signal window. The
      // submitted intent remains durable for exact reconciliation, but this
      // process never issues its first provider call after SIGINT.
      if (input.signal?.aborted) {
        await cancellation;
        const interrupted = { ...checkpoint, interrupted: true };
        if (!repository.compareAndSwap(checkpoint, interrupted)) {
          throw new CanonicalLiveValidationError(
            'Checkpoint changed while recording pre-execute interruption.',
          );
        }
        checkpoint = interrupted;
        return state;
      }
      referenceAuthority.read(preparedRun, target, 'pre_dispatch');
      verifyCandidate();
      const execution = await input.executor.execute(
        target,
        protocol,
        preparedRun,
      );
      if (execution.status === 'reconcile') {
        const runningCheckpoint = {
          ...checkpoint,
          interrupted: input.signal?.aborted ?? false,
          attempts: checkpoint.attempts.map((attempt) =>
            attempt.target_key === target.key
              ? { ...attempt, status: 'running' as const }
              : attempt,
          ),
        };
        if (!repository.compareAndSwap(checkpoint, runningCheckpoint)) {
          throw new CanonicalLiveValidationError(
            'Checkpoint changed while recording running canonical custody.',
          );
        }
        checkpoint = runningCheckpoint;
        return state;
      }
      const result = trustedTerminalOutcome(
        target,
        protocol,
        preparedRun,
        execution,
        referenceAuthority,
      );
      // Do not make another paid slot eligible until an exact cancellation has
      // settled and the canonical terminal result has been recorded.
      await cancellation;
      const quality = frozenEvidenceQuality(target, result);
      const qualityPassed = quality.passed === true;
      const lifecycle = qualityPassed ? result.lifecycle : 'failed';
      const terminalCheckpoint = {
        ...checkpoint,
        interrupted: input.signal?.aborted ?? false,
        attempts: checkpoint.attempts.map((attempt) =>
          attempt.target_key === target.key
            ? {
                ...attempt,
                status: lifecycle,
                ...(!qualityPassed && {
                  validation_failure_reason: 'deterministic_sensibility_failed',
                }),
                evidence_state: 'pending' as const,
                raw_evidence_name: `${target.key.replace('/', '-')}.manifest`,
                receipt_evidence_name: `${target.key.replace('/', '-')}.json`,
              }
            : attempt,
        ),
      };
      if (!repository.compareAndSwap(checkpoint, terminalCheckpoint)) {
        throw new CanonicalLiveValidationError(
          'Checkpoint changed before terminal reconciliation.',
        );
      }
      checkpoint = terminalCheckpoint;
      try {
        writeFrozenEvidence(input.gate, target, protocol, result, lifecycle);
      } catch (error) {
        const failedEvidence = {
          ...checkpoint,
          attempts: checkpoint.attempts.map((attempt) =>
            attempt.target_key === target.key
              ? {
                  ...attempt,
                  evidence_state: 'failed' as const,
                  evidence_error: 'evidence_write_failed',
                }
              : attempt,
          ),
        };
        repository.compareAndSwap(checkpoint, failedEvidence);
        throw error;
      }
      const completedEvidence = {
        ...checkpoint,
        attempts: checkpoint.attempts.map((attempt) =>
          attempt.target_key === target.key
            ? { ...attempt, evidence_state: 'complete' as const }
            : attempt,
        ),
      };
      if (!repository.compareAndSwap(checkpoint, completedEvidence)) {
        throw new CanonicalLiveValidationError(
          'Checkpoint changed after evidence write.',
        );
      }
      checkpoint = completedEvidence;
      if (lifecycle !== 'succeeded') {
        throw new CanonicalLiveValidationError(
          `Canonical lifecycle ${lifecycle} stops frozen validation for ${target.key}.`,
        );
      }
      if (!qualityPassed) {
        throw new CanonicalLiveValidationError(
          `Validation failed deterministic sensibility for ${target.key}.`,
        );
      }
      state = {
        ...state,
        active: undefined,
        completed: [...state.completed, target.key],
      };
      if (checkpoint.interrupted) return state;
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
    }
    lastCredential = protocol.credential_reference;
  }
  return state;
}

/** @deprecated Kept as an explicit test seam; the registered command now binds production only after its full gate. */
export function productionLiveValidationBindingUnavailable(): never {
  throw new CanonicalLiveValidationError(
    'Production paid provider binding remains disabled pending explicit user authorization.',
  );
}

export interface LiveValidationCommandDependencies {
  readonly candidateAuthority?: FrozenCandidateAuthority;
  readonly unavailableBinding?: () => never;
  readonly installNetworkGuard?: () => () => void;
  readonly fixtureReplay?: (
    fixture: LiveValidationFixtureReplay,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly credentialResolver?: () => never;
  readonly providerInitializer?: () => never;
  readonly productionConfig?: () => import('../types.js').Config;
  readonly productionExecutor?: (
    approval: LiveValidationApproval,
    config: import('../types.js').Config,
  ) => FrozenCanonicalExecutor;
}

function parseArtifacts(
  values: readonly string[] | undefined,
): Record<string, string> {
  const artifacts: Record<string, string> = {};
  for (const value of values ?? []) {
    const [name, ...parts] = value.split('=');
    const path = parts.join('=');
    if (
      !name ||
      !path ||
      !SAFE_ID.test(name) ||
      Object.hasOwn(artifacts, name)
    ) {
      throw new CanonicalLiveValidationError(
        'Candidate artifacts must use unique name=relative-file entries.',
      );
    }
    artifacts[name] = path;
  }
  return artifacts;
}

export function registerLiveValidationCommand(
  program: Command,
  dependencies: LiveValidationCommandDependencies = {},
): void {
  program
    .command('live-validation')
    .description(
      'Prepare canonical-v3 provider validation; fixture mode is network-free',
    )
    .option('--targets <provider/profile,...>', 'public canonical profile keys')
    .option('--approval <absolute-file>', 'frozen paid preregistration JSON')
    .option(
      '--confirm <fingerprint>',
      'repeat the full preregistration fingerprint',
    )
    .option('--paid', 'request execution of a frozen paid preregistration')
    .option(
      '--continue',
      'acknowledge one settled failure or continue an interrupted validation',
    )
    .option('--candidate-root <absolute-dir>', 'immutable candidate checkout')
    .option(
      '--artifact-root <absolute-dir>',
      'immutable candidate artifact root',
    )
    .option(
      '--artifact <name=relative-file>',
      'immutable candidate artifact (repeatable)',
      (value, prior: string[] = []) => [...prior, value],
    )
    .option(
      '--fixture <absolute-file>',
      'replay a strict offline canonical fixture',
    )
    .action(
      async (options: {
        targets?: string;
        approval?: string;
        confirm?: string;
        paid?: boolean;
        continue?: boolean;
        fixture?: string;
        candidateRoot?: string;
        artifactRoot?: string;
        artifact?: string[];
      }) => {
        if (options.continue && !options.paid) {
          throw new CanonicalLiveValidationError(
            '--continue requires explicit --paid validation mode.',
          );
        }
        if (!options.paid) {
          const restoreNetwork = (
            dependencies.installNetworkGuard ?? installOfflineNetworkGuard
          )();
          try {
            const matrix = buildCanonicalValidationMatrix();
            if (options.fixture) {
              if (!dependencies.fixtureReplay) {
                throw new CanonicalLiveValidationError(
                  'Fixture replay dependency is unavailable.',
                );
              }
              const fixture = readFixtureReplay(options.fixture);
              if (
                !matrix.targets.some((target) => target.key === fixture.target)
              ) {
                throw new CanonicalLiveValidationError(
                  'Fixture replay target is not canonical.',
                );
              }
              const result = await dependencies.fixtureReplay(fixture);
              process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
              return;
            }
            const requested = options.targets
              ? options.targets
                  .split(',')
                  .map((key) => key.trim())
                  .filter(Boolean)
              : matrix.targets.map((target) => target.key);
            if (
              !requested.every((key) =>
                matrix.targets.some((target) => target.key === key),
              )
            )
              throw new CanonicalLiveValidationError(
                'Unknown canonical public profile.',
              );
            process.stdout.write(
              `${JSON.stringify({ mode: 'fixture', network: 'denied', matrix_fingerprint: matrix.fingerprint, targets: requested }, null, 2)}\n`,
            );
            return;
          } finally {
            restoreNetwork();
          }
        }
        // Paid mode has no offline transport guard. It is still inaccessible
        // until every credential-free gate below accepts the exact immutable
        // candidate and the user repeats both approval fingerprints.
        const gate = readLiveValidationApproval(options.approval ?? '');
        if (dependencies.unavailableBinding) {
          if (!dependencies.candidateAuthority) {
            throw new CanonicalLiveValidationError(
              'Credential-free filesystem candidate authority is not configured.',
            );
          }
          assertLiveValidationGate(
            gate,
            options.confirm,
            process.env.LIBRARIUM_LIVE_VALIDATION_APPROVED,
            dependencies.candidateAuthority,
          );
          dependencies.unavailableBinding();
        }
        const config = (
          dependencies.productionConfig ?? loadProductionValidationConfig
        )();
        const matrix = productionValidationMatrix(config);
        const candidateAuthority =
          dependencies.candidateAuthority ??
          (() => {
            if (!options.candidateRoot || !options.artifactRoot) {
              throw new CanonicalLiveValidationError(
                'Paid validation requires immutable --candidate-root and --artifact-root.',
              );
            }
            return createFilesystemCandidateAuthority({
              repository_root: options.candidateRoot,
              package_json: resolve(options.candidateRoot, 'package.json'),
              artifact_root: options.artifactRoot,
              artifacts: parseArtifacts(options.artifact),
            });
          })();
        assertLiveValidationGate(
          gate,
          options.confirm,
          process.env.LIBRARIUM_LIVE_VALIDATION_APPROVED,
          candidateAuthority,
          matrix,
        );
        // This check is deliberately after immutable gate verification and
        // before executor composition, which is the first credential-capable
        // production path.
        assertRunningCandidateRoot(candidateAuthority);
        if (options.continue) {
          continueFrozenValidationProtocol(
            new CanonicalValidationCheckpointRepository(gate.approval.raw_root),
            gate,
            matrix,
            options.confirm ?? '',
            candidateAuthority,
          );
        }
        const executor = (
          dependencies.productionExecutor ??
          createProductionFrozenCanonicalExecutor
        )(gate.approval, config);
        const controller = new AbortController();
        const dispose = installOfflineValidationSigint(process, controller);
        try {
          const state = await executeFrozenValidationProtocol({
            gate,
            matrix,
            executor,
            candidate_authority: candidateAuthority,
            signal: controller.signal,
          });
          const certification = terminalValidationCertification(
            state,
            matrix.targets.length,
          );
          if (certification) {
            process.stdout.write(`${JSON.stringify(certification, null, 2)}\n`);
            if (certification.certification === 'failed') process.exitCode = 1;
          }
        } finally {
          dispose();
        }
      },
    );
}
