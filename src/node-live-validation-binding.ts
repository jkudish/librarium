/** Credential-free prerequisites for the future production binding. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { FrozenCandidateAuthority } from './commands/live-validation.js';
import { CanonicalRunManifestV3Schema } from './node-canonical-run.js';
import {
  CanonicalLiveValidationError,
  type CanonicalValidationTarget,
  type FrozenAttemptReference,
  LIVE_VALIDATION_CONTRACT_EXTENSION_KEY,
} from './node-live-validation.js';
import { RUN_JSON_FILE } from './node-run-json-lock.js';

export interface FilesystemCandidateAuthorityOptions {
  readonly repository_root: string;
  readonly package_json: string;
  readonly artifact_root: string;
  /** Exact preregistered name to relative regular-file path mapping. */
  readonly artifacts: Readonly<Record<string, string>>;
  readonly git?: (repositoryRoot: string) => {
    readonly head: string;
    readonly tree: string;
    readonly clean: boolean;
  };
}

export type FrozenReferencePhase =
  | 'materialized'
  | 'pre_dispatch'
  /** Submitted outer custody may resume any trusted canonical lifecycle. */
  | 'resume'
  | 'active'
  | 'cancellable'
  | 'terminal';

/** Read the exact pinned run.json and validate it for the requested lifecycle phase. */
export function readTrustedFrozenReferenceManifest(
  reference: FrozenAttemptReference,
  target: CanonicalValidationTarget,
  phase: FrozenReferencePhase,
): ReturnType<typeof CanonicalRunManifestV3Schema.parse> {
  const runsRoot = realpathSync(resolve(reference.runs_root));
  const runDirectory = realpathSync(resolve(reference.run_directory));
  if (!contained(runsRoot, runDirectory) || runsRoot === runDirectory) {
    throw new CanonicalLiveValidationError(
      'Frozen canonical run directory escapes its runs root.',
    );
  }
  let current = runsRoot;
  for (const component of relative(runsRoot, runDirectory)
    .split(sep)
    .filter(Boolean)) {
    current = resolve(current, component);
    if (lstatSync(current).isSymbolicLink()) {
      throw new CanonicalLiveValidationError(
        'Frozen canonical run path contains a symlink.',
      );
    }
  }
  const manifestPath = resolve(runDirectory, RUN_JSON_FILE);
  const stat = lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new CanonicalLiveValidationError(
      'Frozen canonical run.json must be a regular non-symlink file.',
    );
  }
  const manifest = CanonicalRunManifestV3Schema.parse(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
  );
  if (
    manifest.request.request_id !== reference.request_id ||
    manifest.coordination_state.catalog_digest !== reference.catalog_digest ||
    reference.binding_id !== target.binding_id ||
    reference.catalog_digest !== target.catalog_digest
  ) {
    throw new CanonicalLiveValidationError(
      'Frozen canonical run.json differs from its persisted reference.',
    );
  }
  const plans = Object.values(
    manifest.coordination_state.profile_plans_by_identity,
  );
  const exactPlan = plans.find(
    (plan) =>
      plan.binding.adapter_id === target.adapter_id &&
      plan.binding.binding_id === target.binding_id &&
      JSON.stringify(plan.identity) ===
        JSON.stringify(target.expected_effective_identity),
  );
  if (!exactPlan) {
    throw new CanonicalLiveValidationError(
      'Frozen canonical run.json has the wrong effective identity.',
    );
  }
  const runtimeContract = {
    query: manifest.request.query,
    requested_identity: reference.request_contract.requested_identity,
    effective_identity: exactPlan.identity,
    binding_id: exactPlan.binding.binding_id,
    catalog_digest: manifest.coordination_state.catalog_digest,
    options: reference.request_contract.options,
    timeout_seconds: reference.request_contract.timeout_seconds,
    poll_deadline_seconds: reference.request_contract.poll_deadline_seconds,
    max_concurrency: manifest.coordination_state.max_concurrency,
    fallback:
      manifest.request.fallback_reserve.length === 0 ? 'disabled' : 'enabled',
    max_requests: reference.request_contract.max_requests,
    retry: reference.request_contract.retry,
    cancel_policy: reference.request_contract.cancel_policy,
    account: reference.request_contract.account,
    region: reference.request_contract.region,
  };
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  };
  const requestHash = `sha256:${createHash('sha256')
    .update(canonical(runtimeContract))
    .digest('hex')}`;
  if (
    requestHash !== reference.request_fingerprint ||
    (reference.persisted_protocol_contract === true &&
      manifest.request.extensions?.[LIVE_VALIDATION_CONTRACT_EXTENSION_KEY] !==
        reference.protocol_contract_hash) ||
    manifest.coordination_state.request_deadline_at <=
      manifest.coordination_state.created_at
  ) {
    throw new CanonicalLiveValidationError(
      'Frozen canonical run request contract differs from its persisted reference.',
    );
  }
  const runtimeDeadlineMs =
    Date.parse(manifest.coordination_state.request_deadline_at) -
    Date.parse(manifest.coordination_state.created_at);
  const primary = manifest.request.slots[0]?.primary;
  const expectedRequestDeadlineMs =
    primary?.invocation === 'background'
      ? reference.request_contract.poll_deadline_seconds * 1_000
      : reference.request_contract.timeout_seconds * 1_000;
  if (
    reference.persisted_protocol_contract === true &&
    (runtimeDeadlineMs !== expectedRequestDeadlineMs ||
      manifest.coordination_state.inline_attempt_deadline_ms !==
        Math.min(
          reference.request_contract.timeout_seconds * 1_000,
          expectedRequestDeadlineMs,
        ) ||
      manifest.coordination_state.background_attempt_deadline_ms !==
        Math.min(
          reference.request_contract.poll_deadline_seconds * 1_000,
          expectedRequestDeadlineMs,
        ))
  ) {
    throw new CanonicalLiveValidationError(
      'Frozen canonical run deadlines differ from its persisted protocol.',
    );
  }
  const attempts = manifest.coordination_state.attempts;
  if (phase === 'materialized' || phase === 'pre_dispatch') {
    if (
      manifest.coordination_state.status !== 'running' ||
      attempts.length !== 0
    ) {
      throw new CanonicalLiveValidationError(
        'Frozen canonical run is not an undispatched materialized request.',
      );
    }
  } else if (phase === 'resume') {
    const terminalCustody = [
      'succeeded',
      'unsuccessful',
      'cancelled',
      'failed',
    ].includes(manifest.coordination_state.status);
    const activeCustody =
      manifest.coordination_state.status === 'running' && attempts.length > 0;
    const undispatched =
      manifest.coordination_state.status === 'running' && attempts.length === 0;
    if (!undispatched && !activeCustody && !terminalCustody) {
      throw new CanonicalLiveValidationError(
        'Frozen canonical run is not resumable canonical custody.',
      );
    }
  } else if (phase === 'active' || phase === 'cancellable') {
    const terminalCustody = [
      'succeeded',
      'unsuccessful',
      'cancelled',
      'failed',
    ].includes(manifest.coordination_state.status);
    if (
      !terminalCustody &&
      (manifest.coordination_state.status !== 'running' ||
        (phase === 'active' && attempts.length === 0))
    ) {
      throw new CanonicalLiveValidationError(
        'Frozen canonical run is not active canonical custody.',
      );
    }
  } else if (
    !manifest.terminal_response ||
    !['succeeded', 'unsuccessful', 'cancelled', 'failed'].includes(
      manifest.coordination_state.status,
    )
  ) {
    throw new CanonicalLiveValidationError(
      'Frozen canonical run has no trusted terminal response.',
    );
  }
  return manifest;
}

/** Validate the exact zero-attempt state immediately after materialization. */
export function verifyFrozenMaterializedReference(
  reference: FrozenAttemptReference,
  target: CanonicalValidationTarget,
): ReturnType<typeof CanonicalRunManifestV3Schema.parse> {
  return readTrustedFrozenReferenceManifest(reference, target, 'materialized');
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  );
}

function regularContainedFile(root: string, reference: string): string {
  if (!reference || isAbsolute(reference)) {
    throw new CanonicalLiveValidationError(
      'Candidate artifact reference must be relative.',
    );
  }
  const realRoot = realpathSync(resolve(root));
  const lexical = resolve(realRoot, reference);
  if (!contained(realRoot, lexical)) {
    throw new CanonicalLiveValidationError(
      'Candidate artifact escapes its immutable root.',
    );
  }
  let current = realRoot;
  for (const component of relative(realRoot, lexical)
    .split(sep)
    .filter(Boolean)) {
    current = resolve(current, component);
    if (lstatSync(current).isSymbolicLink()) {
      throw new CanonicalLiveValidationError(
        'Candidate artifact path contains a symlink.',
      );
    }
  }
  const real = realpathSync(lexical);
  if (!contained(realRoot, real) || !lstatSync(real).isFile()) {
    throw new CanonicalLiveValidationError(
      'Candidate artifact must be a contained regular file.',
    );
  }
  return real;
}

function sha256Bytes(value: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

const RC_RECORD_NAMES = [
  'declarations',
  'npm_tarball',
  'package_inventory',
  'provenance',
  'sea_manifest',
] as const;

const RC_SEA_TARGETS = [
  { platform: 'darwin', arch: 'arm64', name: 'librarium-macos-arm64' },
  { platform: 'darwin', arch: 'x64', name: 'librarium-macos-x64' },
  { platform: 'linux', arch: 'arm64', name: 'librarium-linux-arm64' },
  { platform: 'linux', arch: 'x64', name: 'librarium-linux-x64' },
  { platform: 'win32', arch: 'x64', name: 'librarium-windows-x64.exe' },
] as const;

interface RcArtifactReference {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

interface RcAuthoritySource {
  readonly repositoryRoot: string;
  readonly head: string;
  readonly tree: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly packageJsonSha256: string;
}

function rcRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CanonicalLiveValidationError(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function rcExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    throw new CanonicalLiveValidationError(`${label} fields are invalid.`);
  }
}

function rcCompareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rcCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(rcCanonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${rcCanonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function rcCanonicalText(value: unknown): string {
  return `${rcCanonicalJson(value)}\n`;
}

function rcArtifactReference(
  value: unknown,
  label: string,
): RcArtifactReference {
  const reference = rcRecord(value, label);
  if (
    Object.keys(reference).sort().join(',') !== 'path,sha256,size' ||
    typeof reference.path !== 'string' ||
    typeof reference.sha256 !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(reference.sha256) ||
    !Number.isSafeInteger(reference.size) ||
    (reference.size as number) < 0
  ) {
    throw new CanonicalLiveValidationError(`${label} is invalid.`);
  }
  return reference as unknown as RcArtifactReference;
}

function verifyRcReferencedFile(
  root: string,
  reference: {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  },
): void {
  const path = regularContainedFile(root, reference.path);
  const bytes = readFileSync(path);
  if (
    bytes.byteLength !== reference.size ||
    sha256Bytes(bytes) !== reference.sha256
  ) {
    throw new CanonicalLiveValidationError(
      `Candidate transitive artifact bytes drifted: ${reference.path}.`,
    );
  }
}

function exactRcArtifactMap(
  artifacts: Readonly<Record<string, string>>,
): boolean {
  const names = Object.keys(artifacts).sort();
  return (
    JSON.stringify(names) === JSON.stringify([...RC_RECORD_NAMES].sort()) &&
    RC_RECORD_NAMES.every((name) => artifacts[name] === `records/${name}.json`)
  );
}

function verifyRcInstalledMatrix(value: unknown): void {
  const matrix = rcRecord(value, 'RC installed-package matrix');
  rcExactKeys(
    matrix,
    [
      'catalog_digest',
      'matrix_fingerprint',
      'pricing_snapshot_fingerprint',
      'target_count',
      'targets',
    ],
    'RC installed-package matrix',
  );
  if (
    matrix.target_count !== 41 ||
    typeof matrix.catalog_digest !== 'string' ||
    !/^fnv1a64\.1:[0-9a-f]{16}$/.test(matrix.catalog_digest) ||
    typeof matrix.pricing_snapshot_fingerprint !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(matrix.pricing_snapshot_fingerprint) ||
    typeof matrix.matrix_fingerprint !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(matrix.matrix_fingerprint) ||
    !Array.isArray(matrix.targets) ||
    matrix.targets.length !== 41
  ) {
    throw new CanonicalLiveValidationError(
      'RC installed-package matrix identity is invalid.',
    );
  }
  const keys = matrix.targets.map((value, index) => {
    const target = rcRecord(value, `RC installed-package target ${index}`);
    rcExactKeys(
      target,
      [
        'adapter_id',
        'binding_id',
        'catalog_digest',
        'credential_family',
        'expected_effective_identity',
        'key',
        'pricing_snapshot_fingerprint',
        'requested_identity',
      ],
      `RC installed-package target ${index}`,
    );
    if (
      typeof target.key !== 'string' ||
      !target.key ||
      typeof target.adapter_id !== 'string' ||
      !target.adapter_id ||
      typeof target.binding_id !== 'string' ||
      !target.binding_id ||
      typeof target.credential_family !== 'string' ||
      !target.credential_family ||
      target.catalog_digest !== matrix.catalog_digest ||
      target.pricing_snapshot_fingerprint !==
        matrix.pricing_snapshot_fingerprint
    ) {
      throw new CanonicalLiveValidationError(
        `RC installed-package target ${index} is invalid.`,
      );
    }
    rcRecord(
      target.requested_identity,
      `RC installed-package target ${index} requested identity`,
    );
    rcRecord(
      target.expected_effective_identity,
      `RC installed-package target ${index} effective identity`,
    );
    return target.key;
  });
  if (
    new Set(keys).size !== 41 ||
    JSON.stringify(keys) !== JSON.stringify([...keys].sort(rcCompareText)) ||
    sha256Bytes(
      rcCanonicalJson({
        schema_version: 1,
        catalog_digest: matrix.catalog_digest,
        pricing_snapshot_fingerprint: matrix.pricing_snapshot_fingerprint,
        targets: matrix.targets,
      }),
    ) !== matrix.matrix_fingerprint
  ) {
    throw new CanonicalLiveValidationError(
      'RC installed-package matrix fingerprint is invalid.',
    );
  }
}

function rcSourceContracts(repositoryRoot: string): {
  readonly fingerprint: string;
  readonly files: readonly RcArtifactReference[];
} {
  const sourceRoot = resolve(repositoryRoot, 'contracts', 'v1');
  const files: RcArtifactReference[] = [];
  const visit = (directory: string): void => {
    const entries = (() => {
      try {
        return readdirSync(directory, { withFileTypes: true });
      } catch {
        throw new CanonicalLiveValidationError(
          'RC source contracts/v1 inventory is missing.',
        );
      }
    })();
    for (const entry of entries.sort((left, right) =>
      rcCompareText(left.name, right.name),
    )) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)) {
        throw new CanonicalLiveValidationError(
          'RC source contracts/v1 contains an unsafe name.',
        );
      }
      const path = resolve(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new CanonicalLiveValidationError(
          'RC source contracts/v1 contains a symlink or special file.',
        );
      }
      if (stat.isDirectory()) visit(path);
      else {
        const bytes = readFileSync(path);
        files.push({
          path: `contracts/v1/${relative(sourceRoot, path).split(sep).join('/')}`,
          sha256: sha256Bytes(bytes),
          size: bytes.byteLength,
        });
      }
    }
  };
  visit(sourceRoot);
  files.sort((left, right) => rcCompareText(left.path, right.path));
  if (
    !files.some((row) => row.path === 'contracts/v1/manifest.json') ||
    !files.some((row) => row.path === 'contracts/v1/checksums.sha256') ||
    !files.some(
      (row) => row.path === 'contracts/v1/schema/interchange.schema.json',
    )
  ) {
    throw new CanonicalLiveValidationError(
      'RC source contracts/v1 inventory is incomplete.',
    );
  }
  return { files, fingerprint: sha256Bytes(rcCanonicalJson(files)) };
}

function verifyRcCandidateTree(
  artifactRoot: string,
  artifacts: Readonly<Record<string, string>>,
):
  | false
  | {
      readonly candidate: {
        readonly name: string;
        readonly version: string;
        readonly gitSha: string;
        readonly gitTree: string;
        readonly fingerprint: string;
      };
      readonly packageJsonSha256: string;
      readonly packageLockSha256: string;
      readonly tarball: RcArtifactReference;
      readonly npmInventory: unknown;
      readonly declarations: unknown;
      readonly installedPackage: unknown;
      readonly contractsFingerprint: string;
      readonly contractFiles: unknown;
      readonly seaRows: readonly unknown[];
      readonly provenance: {
        readonly path: string;
        readonly sha256: string;
        readonly subjectCount: number;
      };
      readonly liveRecords: Readonly<Record<string, RcArtifactReference>>;
      readonly artifactHashes: Readonly<Record<string, string>>;
    } {
  const candidatePath = resolve(artifactRoot, 'candidate.json');
  const candidateStat = lstatSync(candidatePath, { throwIfNoEntry: false });
  const exactMap = exactRcArtifactMap(artifacts);
  if (!candidateStat && !exactMap) return false;
  if (
    !candidateStat ||
    candidateStat.isSymbolicLink() ||
    !candidateStat.isFile() ||
    !exactMap
  ) {
    throw new CanonicalLiveValidationError(
      'RC candidate authority requires candidate.json and the exact five record paths.',
    );
  }
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)) {
        throw new CanonicalLiveValidationError(
          'RC candidate tree contains an unsafe artifact name.',
        );
      }
      const path = resolve(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new CanonicalLiveValidationError(
          'RC candidate tree contains a symlink or special artifact.',
        );
      }
      if (stat.isDirectory()) visit(path);
      else paths.push(relative(artifactRoot, path).split(sep).join('/'));
    }
  };
  visit(artifactRoot);
  paths.sort();
  const checksumPath = resolve(artifactRoot, 'SHA256SUMS');
  const checksumStat = lstatSync(checksumPath, { throwIfNoEntry: false });
  if (
    !checksumStat ||
    checksumStat.isSymbolicLink() ||
    !checksumStat.isFile()
  ) {
    throw new CanonicalLiveValidationError(
      'RC candidate authority requires SHA256SUMS.',
    );
  }
  const lines = readFileSync(checksumPath, 'utf8').split('\n');
  if (lines.pop() !== '' || lines.length === 0) {
    throw new CanonicalLiveValidationError('RC SHA256SUMS is malformed.');
  }
  const checksums = new Map<string, string>();
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (
      !match?.[2] ||
      match[2].startsWith('/') ||
      match[2].includes('\\') ||
      match[2]
        .split('/')
        .some(
          (segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment),
        ) ||
      checksums.has(match[2])
    ) {
      throw new CanonicalLiveValidationError('RC SHA256SUMS is malformed.');
    }
    checksums.set(match[2], `sha256:${match[1]}`);
  }
  const checksummedPaths = [...checksums.keys()];
  if (
    JSON.stringify(checksummedPaths) !==
      JSON.stringify([...checksummedPaths].sort()) ||
    JSON.stringify(checksummedPaths) !==
      JSON.stringify(paths.filter((path) => path !== 'SHA256SUMS'))
  ) {
    throw new CanonicalLiveValidationError(
      'RC SHA256SUMS inventory is missing, extra, or unsorted.',
    );
  }
  for (const path of checksummedPaths) {
    if (
      sha256Bytes(readFileSync(resolve(artifactRoot, ...path.split('/')))) !==
      checksums.get(path)
    ) {
      throw new CanonicalLiveValidationError(`RC SHA256SUMS drifted: ${path}.`);
    }
  }
  let candidate: Record<string, unknown>;
  try {
    const sourceText = readFileSync(candidatePath, 'utf8');
    candidate = rcRecord(JSON.parse(sourceText), 'RC candidate manifest');
    if (rcCanonicalText(candidate) !== sourceText) {
      throw new CanonicalLiveValidationError(
        'RC candidate manifest is not canonical JSON.',
      );
    }
  } catch (error) {
    if (error instanceof CanonicalLiveValidationError) throw error;
    throw new CanonicalLiveValidationError(
      'RC candidate manifest is invalid JSON.',
    );
  }
  rcExactKeys(
    candidate,
    [
      'candidate',
      'checksum_index',
      'contract',
      'contracts_v1',
      'installed_package',
      'live_validation',
      'npm',
      'provenance',
      'schema_version',
      'sea',
      'source_metadata',
    ],
    'RC candidate manifest',
  );
  if (
    candidate.schema_version !== 1 ||
    candidate.contract !== 'librarium-release-candidate'
  ) {
    throw new CanonicalLiveValidationError(
      'RC candidate manifest contract is invalid.',
    );
  }
  const identity = rcRecord(candidate.candidate, 'RC candidate identity');
  rcExactKeys(
    identity,
    ['fingerprint', 'git_sha', 'git_tree', 'name', 'version'],
    'RC candidate identity',
  );
  if (
    typeof identity.name !== 'string' ||
    !identity.name ||
    typeof identity.version !== 'string' ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rc\.[1-9]\d*$/.test(
      identity.version,
    ) ||
    typeof identity.git_sha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(identity.git_sha) ||
    typeof identity.git_tree !== 'string' ||
    !/^[0-9a-f]{40}$/.test(identity.git_tree) ||
    typeof identity.fingerprint !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(identity.fingerprint)
  ) {
    throw new CanonicalLiveValidationError('RC candidate identity is invalid.');
  }
  const source = rcRecord(candidate.source_metadata, 'RC source metadata');
  const npm = rcRecord(candidate.npm, 'RC npm metadata');
  const contracts = rcRecord(candidate.contracts_v1, 'RC contracts metadata');
  const sea = rcRecord(candidate.sea, 'RC SEA metadata');
  const live = rcRecord(
    candidate.live_validation,
    'RC live-validation metadata',
  );
  const provenance = rcRecord(candidate.provenance, 'RC provenance metadata');
  const checksumIndex = rcRecord(
    candidate.checksum_index,
    'RC checksum metadata',
  );
  rcExactKeys(source, ['package_json', 'package_lock'], 'RC source metadata');
  rcExactKeys(npm, ['declarations', 'inventory', 'tarball'], 'RC npm metadata');
  rcExactKeys(contracts, ['files', 'fingerprint'], 'RC contracts metadata');
  rcExactKeys(sea, ['rows'], 'RC SEA metadata');
  rcExactKeys(
    live,
    ['artifact_hashes', 'record_names', 'records'],
    'RC live-validation metadata',
  );
  rcExactKeys(
    provenance,
    ['path', 'sha256', 'subject_count'],
    'RC provenance metadata',
  );
  rcExactKeys(checksumIndex, ['algorithm', 'path'], 'RC checksum metadata');
  if (
    !Array.isArray(npm.inventory) ||
    !Array.isArray(npm.declarations) ||
    !Array.isArray(contracts.files) ||
    !Array.isArray(sea.rows) ||
    checksumIndex.algorithm !== 'sha256' ||
    checksumIndex.path !== 'SHA256SUMS'
  ) {
    throw new CanonicalLiveValidationError(
      'RC candidate manifest inventories are invalid.',
    );
  }
  if (
    typeof contracts.fingerprint !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(contracts.fingerprint) ||
    sha256Bytes(rcCanonicalJson(contracts.files)) !== contracts.fingerprint
  ) {
    throw new CanonicalLiveValidationError(
      'RC contracts fingerprint is invalid.',
    );
  }
  const packageJsonReference = rcArtifactReference(
    source.package_json,
    'RC package.json reference',
  );
  const packageLockValue = rcRecord(
    source.package_lock,
    'RC package-lock reference',
  );
  rcExactKeys(
    packageLockValue,
    ['lockfile_version', 'path', 'sha256', 'size'],
    'RC package-lock reference',
  );
  const packageLockReference = rcArtifactReference(
    {
      path: packageLockValue.path,
      sha256: packageLockValue.sha256,
      size: packageLockValue.size,
    },
    'RC package-lock reference',
  );
  const tarball = rcArtifactReference(npm.tarball, 'RC npm tarball reference');
  if (
    packageJsonReference.path !== 'source/package.json' ||
    packageLockReference.path !== 'source/package-lock.json' ||
    !Number.isSafeInteger(packageLockValue.lockfile_version) ||
    tarball.path !== `npm/${identity.name}-${identity.version}.tgz`
  ) {
    throw new CanonicalLiveValidationError(
      'RC candidate manifest uses a noncanonical source or npm path.',
    );
  }
  const seaRows = sea.rows.map((value, index) => {
    const row = rcRecord(value, `RC SEA reference ${index}`);
    rcExactKeys(
      row,
      ['arch', 'name', 'path', 'platform', 'sha256', 'size'],
      `RC SEA reference ${index}`,
    );
    const expected = RC_SEA_TARGETS[index];
    const reference = rcArtifactReference(
      { path: row.path, sha256: row.sha256, size: row.size },
      `RC SEA reference ${index}`,
    );
    if (
      !expected ||
      row.platform !== expected.platform ||
      row.arch !== expected.arch ||
      row.name !== expected.name ||
      reference.path !== `sea/${expected.name}`
    ) {
      throw new CanonicalLiveValidationError(
        'RC candidate SEA rows differ from the exact five targets.',
      );
    }
    return { value: row, reference };
  });
  if (seaRows.length !== RC_SEA_TARGETS.length) {
    throw new CanonicalLiveValidationError(
      'RC candidate SEA rows differ from the exact five targets.',
    );
  }
  if (
    !Array.isArray(live.record_names) ||
    JSON.stringify(live.record_names) !== JSON.stringify(RC_RECORD_NAMES)
  ) {
    throw new CanonicalLiveValidationError(
      'RC candidate live-validation record names are invalid.',
    );
  }
  const liveRecordsValue = rcRecord(
    live.records,
    'RC live-validation record map',
  );
  const artifactHashesValue = rcRecord(
    live.artifact_hashes,
    'RC live-validation hash map',
  );
  rcExactKeys(liveRecordsValue, RC_RECORD_NAMES, 'RC record map');
  rcExactKeys(artifactHashesValue, RC_RECORD_NAMES, 'RC artifact hash map');
  const liveRecords = Object.fromEntries(
    RC_RECORD_NAMES.map((name) => {
      const reference = rcArtifactReference(
        liveRecordsValue[name],
        `RC ${name} record reference`,
      );
      if (
        reference.path !== `records/${name}.json` ||
        artifactHashesValue[name] !== reference.sha256
      ) {
        throw new CanonicalLiveValidationError(
          `RC ${name} record mapping is invalid.`,
        );
      }
      return [name, reference];
    }),
  ) as Record<string, RcArtifactReference>;
  if (
    provenance.path !== liveRecords.provenance!.path ||
    provenance.sha256 !== liveRecords.provenance!.sha256 ||
    provenance.subject_count !== 6
  ) {
    throw new CanonicalLiveValidationError(
      'RC provenance metadata differs from its approved record.',
    );
  }
  verifyRcInstalledMatrix(candidate.installed_package);
  const references = [
    packageJsonReference,
    packageLockReference,
    tarball,
    ...contracts.files.map((value, index) =>
      rcArtifactReference(value, `RC contract reference ${index}`),
    ),
    ...seaRows.map((row) => row.reference),
    ...RC_RECORD_NAMES.map((name) => liveRecords[name]!),
  ];
  for (const reference of references) {
    verifyRcReferencedFile(artifactRoot, reference);
  }
  const expectedPaths = [
    'candidate.json',
    ...references.map((reference) => reference.path),
  ].sort();
  if (
    new Set(expectedPaths).size !== expectedPaths.length ||
    JSON.stringify(expectedPaths) !==
      JSON.stringify(paths.filter((path) => path !== 'SHA256SUMS'))
  ) {
    throw new CanonicalLiveValidationError(
      'RC candidate manifest has a missing, duplicate, or extra artifact.',
    );
  }
  return {
    candidate: {
      name: identity.name as string,
      version: identity.version as string,
      gitSha: identity.git_sha as string,
      gitTree: identity.git_tree as string,
      fingerprint: identity.fingerprint as string,
    },
    packageJsonSha256: packageJsonReference.sha256,
    packageLockSha256: packageLockReference.sha256,
    tarball,
    npmInventory: npm.inventory,
    declarations: npm.declarations,
    installedPackage: candidate.installed_package,
    contractsFingerprint: contracts.fingerprint,
    contractFiles: contracts.files,
    seaRows: sea.rows,
    provenance: {
      path: provenance.path as string,
      sha256: provenance.sha256 as string,
      subjectCount: provenance.subject_count as number,
    },
    liveRecords,
    artifactHashes: artifactHashesValue as Record<string, string>,
  };
}

/** Verify the exact five RC records before they become live-validation authority. */
function verifyRcTransitiveRecords(
  artifactRoot: string,
  artifacts: Readonly<Record<string, string>>,
  source: RcAuthoritySource,
): void {
  const candidateFacts = verifyRcCandidateTree(artifactRoot, artifacts);
  if (!candidateFacts) return;
  const packageLockPath = regularContainedFile(
    source.repositoryRoot,
    'package-lock.json',
  );
  const packageLockSha256 = sha256Bytes(readFileSync(packageLockPath));
  const sourceContracts = rcSourceContracts(source.repositoryRoot);
  const expectedFingerprint = sha256Bytes(
    JSON.stringify({
      head: source.head,
      tree: source.tree,
      version: source.packageVersion,
      package: source.packageJsonSha256,
      artifacts: Object.fromEntries(
        RC_RECORD_NAMES.map((name) => [
          name,
          candidateFacts.artifactHashes[name],
        ]),
      ),
    }),
  );
  if (
    candidateFacts.candidate.name !== source.packageName ||
    candidateFacts.candidate.version !== source.packageVersion ||
    candidateFacts.candidate.gitSha !== source.head ||
    candidateFacts.candidate.gitTree !== source.tree ||
    candidateFacts.candidate.fingerprint !== expectedFingerprint ||
    candidateFacts.packageJsonSha256 !== source.packageJsonSha256 ||
    candidateFacts.packageLockSha256 !== packageLockSha256 ||
    candidateFacts.contractsFingerprint !== sourceContracts.fingerprint ||
    rcCanonicalJson(candidateFacts.contractFiles) !==
      rcCanonicalJson(sourceContracts.files)
  ) {
    throw new CanonicalLiveValidationError(
      'RC candidate identity differs from its exact clean source.',
    );
  }
  const names = Object.keys(artifacts).sort();
  if (JSON.stringify(names) !== JSON.stringify([...RC_RECORD_NAMES].sort())) {
    throw new CanonicalLiveValidationError(
      'RC candidate authority requires the exact five transitive records.',
    );
  }
  const records = Object.fromEntries(
    RC_RECORD_NAMES.map((name) => {
      if (artifacts[name] !== `records/${name}.json`) {
        throw new CanonicalLiveValidationError(
          `RC candidate record path drifted: ${name}.`,
        );
      }
      const path = regularContainedFile(artifactRoot, artifacts[name]!);
      try {
        const sourceText = readFileSync(path, 'utf8');
        const value = JSON.parse(sourceText);
        if (rcCanonicalText(value) !== sourceText) {
          throw new CanonicalLiveValidationError(
            `RC candidate record is not canonical JSON: ${name}.`,
          );
        }
        return [name, value];
      } catch {
        throw new CanonicalLiveValidationError(
          `RC candidate record is invalid JSON: ${name}.`,
        );
      }
    }),
  ) as Record<(typeof RC_RECORD_NAMES)[number], unknown>;
  const npm = rcRecord(records.npm_tarball, 'RC npm_tarball record');
  rcExactKeys(
    npm,
    [
      'artifact',
      'kind',
      'package_json_sha256',
      'package_lock_sha256',
      'schema_version',
    ],
    'RC npm_tarball record',
  );
  if (npm.schema_version !== 1 || npm.kind !== 'npm_tarball') {
    throw new CanonicalLiveValidationError('RC npm_tarball record is invalid.');
  }
  const tarball = rcArtifactReference(npm.artifact, 'RC npm tarball artifact');
  if (
    rcCanonicalJson(tarball) !== rcCanonicalJson(candidateFacts.tarball) ||
    npm.package_json_sha256 !== candidateFacts.packageJsonSha256 ||
    npm.package_lock_sha256 !== candidateFacts.packageLockSha256
  ) {
    throw new CanonicalLiveValidationError(
      'RC source metadata drifted from the approved npm record.',
    );
  }
  verifyRcReferencedFile(artifactRoot, tarball);
  const declarations = rcRecord(records.declarations, 'RC declarations record');
  rcExactKeys(
    declarations,
    ['files', 'kind', 'npm_tarball', 'schema_version'],
    'RC declarations record',
  );
  if (
    declarations.schema_version !== 1 ||
    declarations.kind !== 'declarations' ||
    rcCanonicalJson(declarations.npm_tarball) !== rcCanonicalJson(tarball) ||
    !Array.isArray(declarations.files) ||
    rcCanonicalJson(declarations.files) !==
      rcCanonicalJson(candidateFacts.declarations)
  ) {
    throw new CanonicalLiveValidationError(
      'RC declarations record is invalid.',
    );
  }
  const inventory = rcRecord(
    records.package_inventory,
    'RC package_inventory record',
  );
  rcExactKeys(
    inventory,
    ['files', 'installed_package', 'kind', 'npm_tarball', 'schema_version'],
    'RC package_inventory record',
  );
  verifyRcInstalledMatrix(inventory.installed_package);
  if (
    inventory.schema_version !== 1 ||
    inventory.kind !== 'package_inventory' ||
    rcCanonicalJson(inventory.npm_tarball) !== rcCanonicalJson(tarball) ||
    !Array.isArray(inventory.files) ||
    rcCanonicalJson(inventory.files) !==
      rcCanonicalJson(candidateFacts.npmInventory) ||
    rcCanonicalJson(inventory.installed_package) !==
      rcCanonicalJson(candidateFacts.installedPackage)
  ) {
    throw new CanonicalLiveValidationError(
      'RC package_inventory record is invalid.',
    );
  }
  const sea = rcRecord(records.sea_manifest, 'RC sea_manifest record');
  rcExactKeys(
    sea,
    ['kind', 'rows', 'schema_version'],
    'RC sea_manifest record',
  );
  if (
    sea.schema_version !== 1 ||
    sea.kind !== 'sea_manifest' ||
    !Array.isArray(sea.rows) ||
    sea.rows.length !== 5
  ) {
    throw new CanonicalLiveValidationError(
      'RC sea_manifest record is invalid.',
    );
  }
  if (rcCanonicalJson(sea.rows) !== rcCanonicalJson(candidateFacts.seaRows)) {
    throw new CanonicalLiveValidationError(
      'RC sea_manifest record drifted from candidate SEA rows.',
    );
  }
  const seaArtifacts = sea.rows.map((row, index) => {
    const value = rcRecord(row, `RC SEA row ${index}`);
    const reference = rcArtifactReference(
      { path: value.path, sha256: value.sha256, size: value.size },
      `RC SEA row ${index}`,
    );
    verifyRcReferencedFile(artifactRoot, reference);
    return reference;
  });
  const provenance = rcRecord(records.provenance, 'RC provenance record');
  rcExactKeys(
    provenance,
    ['_type', 'predicate', 'predicateType', 'subject'],
    'RC provenance record',
  );
  if (
    provenance._type !== 'https://in-toto.io/Statement/v1' ||
    provenance.predicateType !== 'https://slsa.dev/provenance/v1'
  ) {
    throw new CanonicalLiveValidationError('RC provenance record is invalid.');
  }
  if (!Array.isArray(provenance.subject) || provenance.subject.length !== 6) {
    throw new CanonicalLiveValidationError(
      'RC provenance subject set is invalid.',
    );
  }
  const expectedSubjects = [tarball, ...seaArtifacts]
    .map((reference) => ({
      name: reference.path,
      digest: { sha256: reference.sha256.slice('sha256:'.length) },
    }))
    .sort((left, right) => rcCompareText(left.name, right.name));
  const subjectPairs = provenance.subject.map((value, index) => {
    const subject = rcRecord(value, `RC provenance subject ${index}`);
    rcExactKeys(subject, ['digest', 'name'], `RC provenance subject ${index}`);
    const digest = rcRecord(
      subject.digest,
      `RC provenance subject ${index} digest`,
    );
    rcExactKeys(digest, ['sha256'], `RC provenance subject ${index} digest`);
    return [subject.name, digest.sha256];
  });
  const expectedPairs = expectedSubjects.map((subject) => [
    subject.name,
    subject.digest.sha256,
  ]);
  if (JSON.stringify(subjectPairs) !== JSON.stringify(expectedPairs)) {
    throw new CanonicalLiveValidationError(
      'RC provenance subject set drifted from transitive artifact bytes.',
    );
  }
  const predicate = rcRecord(provenance.predicate, 'RC provenance predicate');
  rcExactKeys(
    predicate,
    ['buildDefinition', 'runDetails'],
    'RC provenance predicate',
  );
  const definition = rcRecord(
    predicate.buildDefinition,
    'RC provenance build definition',
  );
  rcExactKeys(
    definition,
    [
      'buildType',
      'externalParameters',
      'internalParameters',
      'resolvedDependencies',
    ],
    'RC provenance build definition',
  );
  const external = rcRecord(
    definition.externalParameters,
    'RC provenance external parameters',
  );
  const internal = rcRecord(
    definition.internalParameters,
    'RC provenance internal parameters',
  );
  rcExactKeys(
    external,
    ['git_sha', 'git_tree', 'version'],
    'RC provenance external parameters',
  );
  rcExactKeys(internal, [], 'RC provenance internal parameters');
  const runDetails = rcRecord(
    predicate.runDetails,
    'RC provenance run details',
  );
  rcExactKeys(runDetails, ['builder'], 'RC provenance run details');
  const builder = rcRecord(runDetails.builder, 'RC provenance builder');
  rcExactKeys(builder, ['id'], 'RC provenance builder');
  if (
    definition.buildType !==
      'https://librarium.agentsy.build/release-candidate/v1' ||
    external.git_sha !== candidateFacts.candidate.gitSha ||
    external.git_tree !== candidateFacts.candidate.gitTree ||
    external.version !== candidateFacts.candidate.version ||
    builder.id !==
      `https://github.com/jkudish/librarium/tree/${candidateFacts.candidate.gitSha}/scripts/rc-artifacts` ||
    !Array.isArray(definition.resolvedDependencies) ||
    definition.resolvedDependencies.length !== 4
  ) {
    throw new CanonicalLiveValidationError(
      'RC provenance dependencies are invalid.',
    );
  }
  const dependencyDigests = new Map<string, Record<string, unknown>>(
    definition.resolvedDependencies.map((value, index) => {
      const dependency = rcRecord(value, `RC provenance dependency ${index}`);
      rcExactKeys(
        dependency,
        ['digest', 'uri'],
        `RC provenance dependency ${index}`,
      );
      const digest = rcRecord(
        dependency.digest,
        `RC provenance dependency ${index} digest`,
      );
      if (typeof dependency.uri !== 'string') {
        throw new CanonicalLiveValidationError(
          `RC provenance dependency ${index} URI is invalid.`,
        );
      }
      return [dependency.uri, digest];
    }),
  );
  const gitUri = `git+https://github.com/jkudish/librarium@${candidateFacts.candidate.gitSha}`;
  if (
    dependencyDigests.size !== 4 ||
    dependencyDigests.get(gitUri)?.gitTree !==
      candidateFacts.candidate.gitTree ||
    dependencyDigests.get('file:source/package.json')?.sha256 !==
      candidateFacts.packageJsonSha256.slice('sha256:'.length) ||
    dependencyDigests.get('file:source/package-lock.json')?.sha256 !==
      candidateFacts.packageLockSha256.slice('sha256:'.length) ||
    dependencyDigests.get('file:contracts/v1')?.sha256 !==
      candidateFacts.contractsFingerprint.slice('sha256:'.length)
  ) {
    throw new CanonicalLiveValidationError(
      'RC provenance dependencies drifted from candidate source bytes.',
    );
  }
}

interface FrozenFileIdentity {
  readonly real: string;
  readonly dev: number;
  readonly ino: number;
  readonly hash: string;
}

function freezeFile(root: string, reference: string): FrozenFileIdentity {
  const real = regularContainedFile(root, reference);
  const stat = statSync(real);
  return {
    real,
    dev: stat.dev,
    ino: stat.ino,
    hash: sha256Bytes(readFileSync(real)),
  };
}

function treeSnapshot(root: string): string {
  const entries: Array<readonly [string, number, number, string]> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (directory === root && entry.name === '.git') continue;
      const path = resolve(directory, entry.name);
      const relativePath = relative(root, path);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new CanonicalLiveValidationError(
          'Candidate tree contains a symlink or special file.',
        );
      }
      if (stat.isDirectory()) visit(path);
      else
        entries.push([
          relativePath,
          stat.dev,
          stat.ino,
          sha256Bytes(readFileSync(path)),
        ]);
    }
  };
  visit(root);
  return sha256Bytes(JSON.stringify(entries));
}

/**
 * Verify Git/package/artifact identity without environment credentials,
 * provider initialization, dynamic imports, or network access.
 */
export function createFilesystemCandidateAuthority(
  options: FilesystemCandidateAuthorityOptions,
): FrozenCandidateAuthority {
  const repositoryLexical = resolve(options.repository_root);
  if (lstatSync(repositoryLexical).isSymbolicLink()) {
    throw new CanonicalLiveValidationError(
      'Candidate repository root must not be a symlink alias.',
    );
  }
  const repositoryRoot = realpathSync(repositoryLexical);
  const repositoryStat = statSync(repositoryRoot);
  const packageCanonical = realpathSync(resolve(options.package_json));
  const packageReference = relative(repositoryRoot, packageCanonical);
  const packagePath = regularContainedFile(repositoryRoot, packageReference);
  const packageValue = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    readonly name?: unknown;
    readonly version?: unknown;
  };
  if (typeof packageValue.version !== 'string' || !packageValue.version) {
    throw new CanonicalLiveValidationError(
      'Candidate package version is missing.',
    );
  }
  const readGit = () =>
    options.git?.(repositoryRoot) ?? {
      head: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
      tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
      clean:
        execFileSync(
          'git',
          ['status', '--porcelain', '--untracked-files=all'],
          {
            cwd: repositoryRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        ).trim() === '',
    };
  const git = readGit();
  if (
    !/^[a-f0-9]{40}$/.test(git.head) ||
    !/^[a-f0-9]{40}$/.test(git.tree) ||
    !git.clean
  ) {
    throw new CanonicalLiveValidationError('Candidate Git SHA is invalid.');
  }
  const names = Object.keys(options.artifacts).sort();
  const artifactRootLexical = resolve(options.artifact_root);
  if (lstatSync(artifactRootLexical).isSymbolicLink()) {
    throw new CanonicalLiveValidationError(
      'Candidate artifact root must not be a symlink alias.',
    );
  }
  const artifactRoot = realpathSync(artifactRootLexical);
  const artifactRootStat = statSync(artifactRoot);
  const packageBytesHash = sha256Bytes(readFileSync(packagePath));
  const rcSource: RcAuthoritySource = {
    repositoryRoot,
    head: git.head,
    tree: git.tree,
    packageName: typeof packageValue.name === 'string' ? packageValue.name : '',
    packageVersion: packageValue.version,
    packageJsonSha256: packageBytesHash,
  };
  verifyRcTransitiveRecords(artifactRoot, options.artifacts, rcSource);
  const paths = new Map(
    names.map((name) => [
      name,
      regularContainedFile(artifactRoot, options.artifacts[name]!),
    ]),
  );
  const artifactHashes = new Map(
    [...paths].map(([name, path]) => [name, sha256Bytes(readFileSync(path))]),
  );
  const identities = new Map(
    names.map((name) => [
      name,
      freezeFile(artifactRoot, options.artifacts[name]!),
    ]),
  );
  const packageIdentity = freezeFile(repositoryRoot, packageReference);
  const frozenTree = treeSnapshot(repositoryRoot);
  const frozenArtifactTree = treeSnapshot(artifactRoot);
  verifyRcTransitiveRecords(artifactRoot, options.artifacts, rcSource);
  for (const name of names) {
    const current = freezeFile(artifactRoot, options.artifacts[name]!);
    if (JSON.stringify(current) !== JSON.stringify(identities.get(name))) {
      throw new CanonicalLiveValidationError(
        `Candidate artifact bytes drifted while freezing: ${name}.`,
      );
    }
  }
  if (treeSnapshot(artifactRoot) !== frozenArtifactTree) {
    throw new CanonicalLiveValidationError(
      'Candidate transitive artifact tree drifted while freezing.',
    );
  }
  const fingerprint = sha256Bytes(
    JSON.stringify({
      head: git.head,
      tree: git.tree,
      version: packageValue.version,
      package: packageBytesHash,
      artifacts: Object.fromEntries(artifactHashes),
    }),
  );
  const verify = (): void => {
    const currentGit = readGit();
    if (
      currentGit.head !== git.head ||
      currentGit.tree !== git.tree ||
      !currentGit.clean ||
      realpathSync(resolve(options.repository_root)) !== repositoryRoot ||
      lstatSync(resolve(options.repository_root)).isSymbolicLink() ||
      realpathSync(resolve(options.artifact_root)) !== artifactRoot ||
      lstatSync(resolve(options.artifact_root)).isSymbolicLink() ||
      statSync(repositoryRoot).dev !== repositoryStat.dev ||
      statSync(repositoryRoot).ino !== repositoryStat.ino ||
      statSync(artifactRoot).dev !== artifactRootStat.dev ||
      statSync(artifactRoot).ino !== artifactRootStat.ino
    ) {
      throw new CanonicalLiveValidationError(
        'Candidate source or package bytes drifted.',
      );
    }
    const currentPackage = freezeFile(repositoryRoot, packageReference);
    if (JSON.stringify(currentPackage) !== JSON.stringify(packageIdentity)) {
      throw new CanonicalLiveValidationError(
        'Candidate source or package bytes drifted.',
      );
    }
    for (const name of names) {
      const current = freezeFile(artifactRoot, options.artifacts[name]!);
      if (JSON.stringify(current) !== JSON.stringify(identities.get(name))) {
        throw new CanonicalLiveValidationError(
          `Candidate artifact bytes drifted: ${name}.`,
        );
      }
    }
    if (treeSnapshot(repositoryRoot) !== frozenTree) {
      throw new CanonicalLiveValidationError(
        'Candidate source or package bytes drifted.',
      );
    }
    if (treeSnapshot(artifactRoot) !== frozenArtifactTree) {
      throw new CanonicalLiveValidationError(
        'Candidate transitive artifact tree drifted.',
      );
    }
  };
  verify();
  return Object.freeze({
    candidate_root: repositoryRoot,
    git_sha: () => git.head,
    candidate_fingerprint: () => fingerprint,
    candidate_sha256: () => fingerprint,
    candidate_version: () => packageValue.version as string,
    artifact_names: () => names,
    artifact_sha256: (name: string) => {
      const path = paths.get(name);
      if (!path) {
        throw new CanonicalLiveValidationError(
          'Candidate artifact is not in the immutable manifest.',
        );
      }
      return artifactHashes.get(name)!;
    },
    verify,
  });
}
