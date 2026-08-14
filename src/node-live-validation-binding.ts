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
      manifest.request.extensions?.[
        'librarium:live_validation_contract_sha256'
      ] !== reference.protocol_contract_hash) ||
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
    const terminalCustody = ['succeeded', 'failed', 'cancelled'].includes(
      manifest.coordination_state.status,
    );
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
    const terminalCustody = ['succeeded', 'failed', 'cancelled'].includes(
      manifest.coordination_state.status,
    );
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
    !['succeeded', 'failed', 'cancelled'].includes(
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
  const packageBytesHash = sha256Bytes(readFileSync(packagePath));
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
      statSync(repositoryRoot).ino !== repositoryStat.ino
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
  };
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
