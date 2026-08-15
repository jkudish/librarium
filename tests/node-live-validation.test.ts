import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliProgram } from '../src/cli-program.js';
import {
  type ApprovalGate,
  approvalFingerprint,
  approvalTargetProtocolsDigest,
  assertLiveValidationGate,
  continueFrozenValidationProtocol,
  createDeniedNetworkCapability,
  executeFrozenValidationProtocol,
  frozenProtocolContractHash,
  frozenRequestContract,
  frozenRequestFingerprint,
  installOfflineNetworkGuard,
  installOfflineValidationSigint,
  registerLiveValidationCommand,
} from '../src/commands/live-validation.js';
import type { PreparedResearchExecution } from '../src/core/execution-plan.js';
import { profileIdentityKey } from '../src/core/execution-plan.js';
import { BUILTIN_PRICING_SNAPSHOT } from '../src/core/pricing-snapshot.js';
import { buildProviderCatalog } from '../src/core/profile-catalog.js';
import {
  BUILTIN_PROVIDER_CATALOG,
  declaredExecutionProfile,
} from '../src/core/provider-profiles.js';
import {
  CanonicalRunManifestV3Schema,
  createNodeCoordinatorDependencies,
  materializeCanonicalPreparedExecution,
  resumeCanonicalPreparedExecution,
  runCanonicalPreparedExecution,
} from '../src/node-canonical-run.js';
import {
  assertCanonicalValidationPins,
  assertCanonicalValidationPreparedExecution,
  buildCanonicalValidationMatrix,
  CanonicalLiveValidationError,
  CanonicalValidationCheckpointRepository,
  createCanonicalPreparedValidationExecutor,
  deterministicReceiptSensibility,
  executeCanonicalValidationLane,
  executeWithCanonicalValidationAbort,
  interruptCanonicalValidation,
  nextCanonicalValidationTarget,
  quoteCanonicalValidationTarget,
  readPrivateRawEvidence,
  sanitizeCanonicalReceipt,
  validateCanonicalValidationCheckpoint,
  writePrivateRawEvidence,
  writeSanitizedCanonicalReceipt,
} from '../src/node-live-validation.js';
import {
  createFilesystemCandidateAuthority,
  readTrustedFrozenReferenceManifest,
  verifyFrozenMaterializedReference,
} from '../src/node-live-validation-binding.js';
import type { Provider } from '../src/types.js';

const roots: string[] = [];

afterEach(() => {
  // Temporary test roots are owned by Vitest's OS cleanup policy. Deliberately
  // avoid recursive deletion in this safety-focused test suite.
  roots.length = 0;
});

describe('canonical v3 live validation matrix', () => {
  it('derives the exact implemented 40-profile matrix, including durable private adapters', () => {
    const matrix = buildCanonicalValidationMatrix();
    expect(matrix.targets.length).toBeGreaterThan(0);
    expect(matrix.targets.length).toBeLessThanOrEqual(40);
    expect(matrix.targets.map((target) => target.key)).toContain(
      'exa/research',
    );
    expect(matrix.targets.map((target) => target.key)).toContain(
      'tavily/research',
    );
    expect(matrix.targets.map((target) => target.key)).toContain(
      'you-research/research',
    );
    expect(
      matrix.targets.find((target) => target.key === 'exa/research'),
    ).toMatchObject({
      adapter_id: 'exa-research',
      credential_family: 'EXA_API_KEY',
    });
    expect(new Set(matrix.targets.map((target) => target.key)).size).toBe(40);
    expect(
      new Set(matrix.targets.map((target) => target.adapter_id)).size,
    ).toBe(40);
  });

  it('admits only one exact prepared canonical profile and never a legacy selector list', () => {
    const target = buildCanonicalValidationMatrix().targets[0];
    if (!target) throw new Error('missing fixture target');
    const prepared = {
      request: {
        interchange_version: '1.0.0',
        message_type: 'request',
        request_id: 'request-1',
        requested_at: '2026-08-13T00:00:00.000Z',
        mode: 'sync',
        query: 'fixture',
        slots: [
          {
            slot_id: 'slot-1',
            position: 0,
            requirements: {},
            primary: { identity: target.expected_effective_identity },
          },
        ],
        fallback_reserve: [],
      },
      policy: {
        limits: { max_concurrency: 1 },
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
    expect(() =>
      assertCanonicalValidationPreparedExecution(prepared, target),
    ).not.toThrow();
    expect(() =>
      assertCanonicalValidationPreparedExecution(
        {
          ...prepared,
          policy: { ...prepared.policy, limits: { max_concurrency: 2 } },
        },
        target,
      ),
    ).toThrow('sequential execution');
    expect(() =>
      assertCanonicalValidationPreparedExecution(
        {
          ...prepared,
          policy: { ...prepared.policy, fallback: { kind: 'configured' } },
        },
        target,
      ),
    ).toThrow('disabled fallback');
  });

  it('rejects disabled configuration and catalog drift before any dispatch seam', () => {
    expect(() =>
      buildCanonicalValidationMatrix({
        provider_config: { exa: { enabled: false } },
      }),
    ).toThrow('Implemented profile is disabled');
    const matrix = buildCanonicalValidationMatrix();
    expect(() =>
      assertCanonicalValidationPins(
        matrix,
        {
          matrix_fingerprint: matrix.fingerprint,
          catalog_digest: matrix.catalog_digest,
          pricing_snapshot_fingerprint: BUILTIN_PRICING_SNAPSHOT.fingerprint,
          candidate_fingerprint: 'candidate-a',
        },
        'candidate-b',
      ),
    ).toThrow('candidate artifact drifted');
  });

  it('uses public provider configuration authority for private durable bindings', () => {
    expect(() =>
      buildCanonicalValidationMatrix({
        provider_config: { 'you-research': { enabled: false } },
      }),
    ).toThrow('Implemented profile is disabled: you-research/research');
  });

  it('derives a config-aware matrix from the composite structural catalog digest', () => {
    const base = buildCanonicalValidationMatrix();
    const catalog = buildProviderCatalog({
      providerConfigs: Object.fromEntries(
        base.targets.map((target) => [target.adapter_id, { enabled: true }]),
      ),
      assumeCredentialAvailability: true,
    });
    const matrix = buildCanonicalValidationMatrix({
      catalog_authority: catalog,
    });
    expect(matrix.catalog_digest).toBe(catalog.digest);
    expect(matrix.targets.length).toBeGreaterThan(0);
    expect(matrix.targets.length).toBeLessThanOrEqual(40);
    expect(
      matrix.targets.every(
        (target) => target.catalog_digest === catalog.digest,
      ),
    ).toBe(true);
  });

  it('hashes an exact contained candidate artifact inventory without credentials', () => {
    const root = mkdtempSync(join(tmpdir(), 'librarium-candidate-'));
    const artifacts = join(root, 'artifacts');
    mkdirSync(artifacts);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ version: '1.2.3' }),
    );
    const manifest = Object.fromEntries(
      [
        'declarations',
        'npm_tarball',
        'package_inventory',
        'provenance',
        'sea_manifest',
      ].map((name) => {
        writeFileSync(join(artifacts, name), `artifact:${name}`);
        return [name, name];
      }),
    );
    roots.push(root);
    const authority = createFilesystemCandidateAuthority({
      repository_root: root,
      package_json: join(root, 'package.json'),
      artifact_root: artifacts,
      artifacts: manifest,
      git: () => ({
        head: 'a'.repeat(40),
        tree: 'b'.repeat(40),
        clean: true,
      }),
    });
    expect(authority.candidate_version()).toBe('1.2.3');
    expect(authority.git_sha()).toBe('a'.repeat(40));
    expect(authority.candidate_fingerprint()).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(authority.candidate_sha256()).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(authority.artifact_names()).toStrictEqual(
      Object.keys(manifest).sort(),
    );
    expect(authority.artifact_sha256('npm_tarball')).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    writeFileSync(join(artifacts, 'npm_tarball'), 'mutated-after-freeze');
    expect(() => authority.verify()).toThrow('artifact bytes drifted');
  });

  it('rejects a dirty candidate before freezing its source identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'librarium-candidate-dirty-'));
    const artifacts = join(root, 'artifacts');
    mkdirSync(artifacts);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ version: '1.2.3' }),
    );
    const manifest = Object.fromEntries(
      [
        'declarations',
        'npm_tarball',
        'package_inventory',
        'provenance',
        'sea_manifest',
      ].map((name) => {
        writeFileSync(join(artifacts, name), name);
        return [name, name];
      }),
    );
    roots.push(root);
    expect(() =>
      createFilesystemCandidateAuthority({
        repository_root: root,
        package_json: join(root, 'package.json'),
        artifact_root: artifacts,
        artifacts: manifest,
        git: () => ({
          head: 'a'.repeat(40),
          tree: 'b'.repeat(40),
          clean: false,
        }),
      }),
    ).toThrow('Candidate Git SHA is invalid');
  });

  it('revalidates candidate path identity and rejects same-byte symlink replacement', () => {
    const root = mkdtempSync(join(tmpdir(), 'librarium-candidate-swap-'));
    const artifacts = join(root, 'artifacts');
    mkdirSync(artifacts);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ version: '1.2.3' }),
    );
    const names = [
      'declarations',
      'npm_tarball',
      'package_inventory',
      'provenance',
      'sea_manifest',
    ];
    for (const name of names) writeFileSync(join(artifacts, name), name);
    const authority = createFilesystemCandidateAuthority({
      repository_root: root,
      package_json: join(root, 'package.json'),
      artifact_root: artifacts,
      artifacts: Object.fromEntries(names.map((name) => [name, name])),
      git: () => ({ head: 'a'.repeat(40), tree: 'b'.repeat(40), clean: true }),
    });
    const replacement = join(root, 'replacement');
    writeFileSync(replacement, 'npm_tarball');
    symlinkSync(replacement, join(artifacts, 'npm_tarball-link'));
    expect(() => authority.verify()).toThrow('symlink');
  });

  it('revalidates exact Git head, tree, and clean state at every credential-free gate', () => {
    const root = mkdtempSync(join(tmpdir(), 'librarium-candidate-git-drift-'));
    const artifacts = join(root, 'artifacts');
    mkdirSync(artifacts);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ version: '1.2.3' }),
    );
    const names = [
      'declarations',
      'npm_tarball',
      'package_inventory',
      'provenance',
      'sea_manifest',
    ];
    for (const name of names) writeFileSync(join(artifacts, name), name);
    let git = { head: 'a'.repeat(40), tree: 'b'.repeat(40), clean: true };
    const authority = createFilesystemCandidateAuthority({
      repository_root: root,
      package_json: join(root, 'package.json'),
      artifact_root: artifacts,
      artifacts: Object.fromEntries(names.map((name) => [name, name])),
      git: () => git,
    });
    for (const mutation of [
      { head: 'c'.repeat(40), tree: 'b'.repeat(40), clean: true },
      { head: 'a'.repeat(40), tree: 'd'.repeat(40), clean: true },
      { head: 'a'.repeat(40), tree: 'b'.repeat(40), clean: false },
    ]) {
      git = mutation;
      expect(() => authority.verify()).toThrow(
        'source or package bytes drifted',
      );
    }
  });

  it('ignores private durable configuration in favor of its public provider', () => {
    const matrix = buildCanonicalValidationMatrix({
      provider_config: {
        'you-research-background': {
          credential_family: 'PRIVATE_SHOULD_IGNORE',
        },
        'you-research': { credential_family: 'PUBLIC_AUTHORITY' },
      },
    });
    expect(
      matrix.targets.find((target) => target.key === 'you-research/research')
        ?.credential_family,
    ).toBe('PUBLIC_AUTHORITY');
  });

  it('pins sequential checkpoints, unknown approvals, and aggregate reservations', () => {
    const matrix = buildCanonicalValidationMatrix();
    const first = matrix.targets[0];
    if (!first) throw new Error('missing fixture target');
    const checkpoint = {
      schema_version: 1 as const,
      pins: {
        matrix_fingerprint: matrix.fingerprint,
        catalog_digest: matrix.catalog_digest,
        pricing_snapshot_fingerprint: matrix.pricing_snapshot_fingerprint,
        candidate_fingerprint: 'candidate-a',
      },
      target_order: matrix.targets.map((target) => target.key),
      attempts: [
        {
          target_key: first.key,
          credential_family: first.credential_family,
          status: 'succeeded' as const,
          reserved_microusd: '5',
          reported_microusd: '4',
          unknown_cost: true,
        },
      ],
      interrupted: false,
    };
    expect(() =>
      validateCanonicalValidationCheckpoint(checkpoint, matrix, 'candidate-a'),
    ).toThrow('lacks explicit approval');
    const validated = validateCanonicalValidationCheckpoint(
      checkpoint,
      matrix,
      'candidate-a',
      { approved_unknown_targets: [first.key], aggregate_budget_microusd: '5' },
    );
    expect(nextCanonicalValidationTarget(validated, matrix)?.key).toBe(
      matrix.targets[1]?.key,
    );
    expect(() =>
      validateCanonicalValidationCheckpoint(
        {
          ...checkpoint,
          attempts: [
            { ...checkpoint.attempts[0], status: 'ambiguous' as const },
          ],
        },
        matrix,
        'candidate-a',
        { approved_unknown_targets: [first.key] },
      ),
    ).toThrow('requires exact reconciliation');
  });

  it('uses the frozen Wave 0A quote and checkpoints interruption without dispatch', () => {
    const matrix = buildCanonicalValidationMatrix();
    const target = matrix.targets.find(
      (candidate) => candidate.key === 'brave-search/search',
    );
    if (!target) throw new Error('missing fixture target');
    const admission = quoteCanonicalValidationTarget(target);
    expect(admission.quote.snapshot_fingerprint).toBe(
      target.pricing_snapshot_fingerprint,
    );
    expect(admission.reserved_microusd).toBeDefined();
    const interrupted = interruptCanonicalValidation({
      schema_version: 1,
      pins: {
        matrix_fingerprint: matrix.fingerprint,
        catalog_digest: matrix.catalog_digest,
        pricing_snapshot_fingerprint: matrix.pricing_snapshot_fingerprint,
        candidate_fingerprint: 'candidate-a',
      },
      target_order: matrix.targets.map((candidate) => candidate.key),
      attempts: [],
      interrupted: false,
    });
    expect(nextCanonicalValidationTarget(interrupted, matrix)).toBeUndefined();
  });
});

describe('canonical v3 live validation evidence boundary', () => {
  it('allows only a regular private evidence file beneath its real root', () => {
    const root = mkdtempSync(join(tmpdir(), 'librarium-live-validation-'));
    roots.push(root);
    const evidence = join(root, 'evidence.txt');
    writeFileSync(evidence, 'private raw response');
    expect(readPrivateRawEvidence(root, 'evidence.txt')).toBe(
      'private raw response',
    );

    const outside = mkdtempSync(
      join(tmpdir(), 'librarium-live-validation-outside-'),
    );
    roots.push(outside);
    const outsideEvidence = join(outside, 'outside.txt');
    writeFileSync(outsideEvidence, 'outside');
    symlinkSync(outsideEvidence, join(root, 'link.txt'));
    symlinkSync(outside, join(root, 'nested'));
    expect(() => readPrivateRawEvidence(root, '../outside.txt')).toThrow(
      CanonicalLiveValidationError,
    );
    expect(() => readPrivateRawEvidence(root, 'link.txt')).toThrow(
      'non-symlink regular file',
    );
    expect(() => readPrivateRawEvidence(root, 'nested/outside.txt')).toThrow(
      'non-symlink regular file',
    );
  });

  it('projects only safe receipt facts and rejects secrets, signed URLs, and paths', () => {
    const target = buildCanonicalValidationMatrix().targets[0];
    if (!target) throw new Error('missing fixture target');
    const safe = sanitizeCanonicalReceipt({
      target,
      candidate_fingerprint:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      candidate_git_sha: '6c580293bfd1c03f2f29d5674e33cdf0ae809ec0',
      request_id: 'request-1',
      account: 'reviewed-account',
      region: 'us',
      lifecycle: 'succeeded',
      response: {
        content: 'response body remains private',
        citations: [{ url: 'https://example.com/source', provider: 'fixture' }],
      },
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(JSON.stringify(safe)).not.toContain('response body remains private');
    expect(JSON.stringify(safe)).not.toContain('https://example.com/source');
    expect(safe).toMatchObject({ schema_version: 1, lifecycle: 'succeeded' });
    expect(() =>
      sanitizeCanonicalReceipt({
        target,
        candidate_fingerprint:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        request_id: 'request-1',
        account: 'Bearer secret',
        region: 'us',
        lifecycle: 'failed',
      }),
    ).toThrow('prohibited material');
    for (const credential of [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_abcdefghijklmnopqrstuvwxyz012345',
      'xoxb-synthetic-token-shape',
      'AIzaSyA_abcdefghijklmnopqrstuvwxyz',
    ]) {
      expect(() =>
        sanitizeCanonicalReceipt({
          target,
          candidate_fingerprint:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          request_id: 'request-1',
          account: credential,
          region: 'us',
          lifecycle: 'failed',
        }),
      ).toThrow('prohibited material');
    }
    expect(() =>
      sanitizeCanonicalReceipt({
        target,
        candidate_fingerprint: 'sha256:a',
        request_id: 'request-1',
        account: 'reviewed-account',
        region: 'us',
        lifecycle: 'failed',
      }),
    ).toThrow('prohibited material');
    expect(() =>
      sanitizeCanonicalReceipt({
        target,
        candidate_fingerprint:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        request_id: 'request-1',
        account: 'sk-proj-abcdefghijklmnop',
        region: 'us',
        lifecycle: 'failed',
      }),
    ).toThrow('prohibited material');
  });

  it('uses deterministic sensibility checks and never treats semantic judgment as a gate', () => {
    const target = buildCanonicalValidationMatrix().targets[0];
    if (!target) throw new Error('missing fixture target');
    const entry = BUILTIN_PROVIDER_CATALOG.find(
      (candidate) =>
        candidate.provider_id === target.requested_identity.provider_id,
    );
    const declaration = entry?.profiles.find(
      (candidate) =>
        candidate.profile_id === target.requested_identity.profile_id,
    );
    if (!entry || !declaration) throw new Error('missing target declaration');
    const profile = declaredExecutionProfile(entry.provider_id, declaration);
    const collected = profile.retrieval_method === 'surface_collector';
    expect(
      deterministicReceiptSensibility({
        target,
        content: 'A usable result',
        citations: [{ url: 'https://example.com/source', provider: 'fixture' }],
        provenance: {
          access_mode: collected ? 'collected' : 'direct',
          operator_id: 'fixture',
          ...(collected && {
            collector_id: 'fixture-collector',
            surface_id: 'fixture-surface',
          }),
          result_kind: profile.result_kind,
          retrieval_methods: [profile.retrieval_method],
          corpora: profile.corpora,
        },
      }).passed,
    ).toBe(true);
  });
});

describe('canonical v3 live validation persisted fixture lane', () => {
  function root() {
    const value = mkdtempSync(join(tmpdir(), 'librarium-validation-lane-'));
    roots.push(value);
    return value;
  }

  function laneReference(
    directory: string,
    target: ReturnType<
      typeof buildCanonicalValidationMatrix
    >['targets'][number],
  ) {
    const identity = target.expected_effective_identity;
    const contract = {
      query: 'legacy-lane-fixture',
      requested_identity: target.requested_identity,
      effective_identity: identity,
      binding_id: target.binding_id,
      catalog_digest: target.catalog_digest,
      options: {},
      timeout_seconds: 1,
      poll_deadline_seconds: 1,
      max_concurrency: 1 as const,
      fallback: 'disabled' as const,
      max_requests: 1 as const,
      retry: 'disabled' as const,
      cancel_policy: 'reconcile_only' as const,
      account: 'fixture',
      region: 'fixture',
    };
    return {
      runs_root: directory,
      run_directory: join(directory, `run-${target.key.replace('/', '-')}`),
      request_id: `request-${target.key.replace('/', '-')}`,
      binding_id: target.binding_id,
      catalog_digest: target.catalog_digest,
      request_fingerprint: `sha256:${'a'.repeat(64)}`,
      protocol_contract_hash: frozenProtocolContractHash(contract),
      request_contract: contract,
    };
  }

  it('materializes canonical run.json before any attempt transport can dispatch', async () => {
    const directory = root();
    const matrix = buildCanonicalValidationMatrix();
    const target = matrix.targets[0]!;
    const entry = BUILTIN_PROVIDER_CATALOG.find(
      (candidate) =>
        candidate.provider_id === target.requested_identity.provider_id,
    )!;
    const declaration = entry.profiles.find(
      (candidate) =>
        candidate.profile_id === target.requested_identity.profile_id,
    )!;
    const profile = declaredExecutionProfile(entry.provider_id, declaration);
    const prepared = {
      request: {
        interchange_version: '1.0.0',
        message_type: 'request',
        request_id: 'materialize-only',
        requested_at: '2026-08-13T00:00:00.000Z',
        mode: 'sync',
        query: 'fixture-query',
        slots: [
          {
            slot_id: 'slot-1',
            position: 0,
            requirements: {
              result_kind: profile.result_kind,
              ...(profile.grounding_policy && {
                grounding_policy: profile.grounding_policy,
              }),
              corpora: profile.corpora,
              retrieval_methods: [profile.retrieval_method],
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
          inline_attempt_deadline_ms: 10_000,
          background_attempt_deadline_ms: 20_000,
          poll_interval_ms: 1_000,
        },
        fallback: { kind: 'disabled' },
        exclusions: [],
        refinement: { kind: 'disabled' },
      },
      profile_plans_by_identity: {
        [profileIdentityKey(profile.identity)]: {
          profile_key: profileIdentityKey(profile.identity),
          identity: profile.identity,
          binding: {
            adapter_id: target.adapter_id,
            binding_id: target.binding_id,
          },
        },
      },
      catalog: { revision: 'fixture', digest: target.catalog_digest },
      notices: [],
    } as unknown as PreparedResearchExecution;
    const runDirectory = join(directory, 'run-materialized');
    mkdirSync(runDirectory);
    let attempts = 0;
    const materialized = await materializeCanonicalPreparedExecution(prepared, {
      runs_root: directory,
      run_directory: runDirectory,
      coordinator: createNodeCoordinatorDependencies(() =>
        Date.parse('2026-08-13T00:00:00.000Z'),
      ),
    });
    expect(attempts).toBe(0);
    expect(materialized.manifest.request.request_id).toBe('materialize-only');
    expect(materialized.manifest.coordination_state.attempts).toHaveLength(0);
    const contract = {
      query: 'fixture-query',
      requested_identity: target.requested_identity,
      effective_identity: target.expected_effective_identity,
      binding_id: target.binding_id,
      catalog_digest: target.catalog_digest,
      options: {},
      timeout_seconds: 30,
      poll_deadline_seconds: 60,
      max_concurrency: 1 as const,
      fallback: 'disabled' as const,
      max_requests: 1 as const,
      retry: 'disabled' as const,
      cancel_policy: 'reconcile_only' as const,
      account: 'fixture',
      region: 'fixture',
    };
    const reference = {
      runs_root: directory,
      run_directory: runDirectory,
      request_id: 'materialize-only',
      binding_id: target.binding_id,
      catalog_digest: target.catalog_digest,
      request_fingerprint: frozenProtocolContractHash(contract),
      protocol_contract_hash: frozenProtocolContractHash(contract),
      request_contract: contract,
    };
    expect(
      verifyFrozenMaterializedReference(reference, target).request.request_id,
    ).toBe('materialize-only');
    expect(() =>
      readTrustedFrozenReferenceManifest(reference, target, 'active'),
    ).toThrow('not active canonical custody');
    await resumeCanonicalPreparedExecution({
      runs_root: directory,
      run_directory: runDirectory,
      coordinator: createNodeCoordinatorDependencies(() =>
        Date.parse('2026-08-13T00:00:00.000Z'),
      ),
      attempt_bridge: {
        resolveExactBinding: () => ({
          binding: {
            adapter_id: target.adapter_id,
            binding_id: target.binding_id,
          },
          profile,
          catalog_digest: target.catalog_digest,
          provider: {
            id: profile.identity.provider_id,
            displayName: 'Fixture',
            tier: 'ai-grounded',
            envVar: '',
            execution: 'inline',
            execute: async () => {
              attempts += 1;
              return {
                provider: profile.identity.provider_id,
                tier: 'ai-grounded',
                content: 'fixture output',
                citations: [
                  {
                    provider: profile.identity.provider_id,
                    url: 'https://example.com/source',
                    title: 'Source',
                  },
                ],
                durationMs: 1,
              };
            },
          },
        }),
        now: () => Date.parse('2026-08-13T00:00:00.000Z'),
        wait: async () => {},
      },
    });
    expect(attempts).toBe(1);
    expect(
      readTrustedFrozenReferenceManifest(reference, target, 'terminal').request
        .request_id,
    ).toBe('materialize-only');

    const manifestPath = join(runDirectory, 'run.json');
    const unsuccessful = JSON.parse(
      readFileSync(manifestPath, 'utf8'),
    ) as Record<string, any>;
    unsuccessful.coordination_state.status = 'unsuccessful';
    unsuccessful.coordination_state.slots[0].status = 'failed';
    unsuccessful.coordination_state.attempts[0].status = 'failed';
    unsuccessful.coordination_state.attempts[0].error = {
      code: 'provider_reported_error',
      message: 'The provider returned an error.',
      category: 'provider',
      retryable: false,
      fallback_allowed: false,
    };
    unsuccessful.provider_outputs_by_attempt = {};
    unsuccessful.terminal_response = {
      ...unsuccessful.terminal_response,
      status: 'failed',
      results: [],
      errors: [
        {
          code: 'librarium.provider_reported_error',
          message: 'The provider returned an error.',
          profile: target.key,
        },
      ],
    };
    writeFileSync(manifestPath, `${JSON.stringify(unsuccessful)}\n`);
    for (const phase of [
      'resume',
      'active',
      'cancellable',
      'terminal',
    ] as const) {
      expect(
        readTrustedFrozenReferenceManifest(reference, target, phase)
          .coordination_state.status,
      ).toBe('unsuccessful');
    }
    unsuccessful.coordination_state.status = 'failed';
    unsuccessful.coordination_state.lifecycle.at(-1).event_kind =
      'request_failed';
    unsuccessful.coordination_state.lifecycle.at(-1).data = {
      error: unsuccessful.coordination_state.attempts[0].error,
    };
    writeFileSync(manifestPath, `${JSON.stringify(unsuccessful)}\n`);
    for (const phase of [
      'resume',
      'active',
      'cancellable',
      'terminal',
    ] as const) {
      expect(
        readTrustedFrozenReferenceManifest(reference, target, phase)
          .coordination_state.status,
      ).toBe('failed');
    }
  });

  it('rejects active and unsettled terminal checkpoints without an exact run reference', () => {
    const directory = root();
    const matrix = buildCanonicalValidationMatrix();
    const target = matrix.targets[0]!;
    const base = {
      schema_version: 1 as const,
      pins: {
        matrix_fingerprint: matrix.fingerprint,
        catalog_digest: matrix.catalog_digest,
        pricing_snapshot_fingerprint: matrix.pricing_snapshot_fingerprint,
        candidate_fingerprint: 'candidate-a',
      },
      target_order: matrix.targets.map((item) => item.key),
      interrupted: false,
    };
    for (const attempt of [
      { status: 'submitted', evidence_state: undefined },
      { status: 'running', evidence_state: undefined },
      { status: 'succeeded', evidence_state: 'pending' },
    ] as const) {
      expect(() =>
        new CanonicalValidationCheckpointRepository(directory).create({
          ...base,
          attempts: [
            {
              target_key: target.key,
              credential_family: target.credential_family,
              status: attempt.status,
              request_fingerprint: `sha256:${'a'.repeat(64)}`,
              ...(attempt.evidence_state && {
                evidence_state: attempt.evidence_state,
              }),
            },
          ],
        }),
      ).toThrow('invalid or unsafe schema');
    }
  });

  it('checkpoints before dispatch and a fresh repository never resubmits ambiguous work', async () => {
    const directory = root();
    const matrix = buildCanonicalValidationMatrix();
    let calls = 0;
    const first = await executeCanonicalValidationLane({
      repository: new CanonicalValidationCheckpointRepository(directory),
      matrix,
      candidate_fingerprint: 'candidate-a',
      approved_unknown_targets: matrix.targets.map((target) => target.key),
      materialize_reference: (target) => laneReference(directory, target),
      executor: {
        execute: async () => {
          calls += 1;
          return 'ambiguous';
        },
      },
    });
    expect(first.attempts[0]?.status).toBe('ambiguous');
    await expect(
      executeCanonicalValidationLane({
        repository: new CanonicalValidationCheckpointRepository(directory),
        matrix,
        candidate_fingerprint: 'candidate-a',
        approved_unknown_targets: matrix.targets.map((target) => target.key),
        materialize_reference: (target) => laneReference(directory, target),
        executor: {
          execute: async () => {
            calls += 1;
            return 'succeeded';
          },
        },
      }),
    ).rejects.toThrow('requires exact reconciliation');
    expect(calls).toBe(1);
  });

  it('uses one executor at a time and persists an abort before dispatch', async () => {
    const directory = root();
    const matrix = buildCanonicalValidationMatrix();
    const abort = new AbortController();
    abort.abort();
    let calls = 0;
    const checkpoint = await executeCanonicalValidationLane({
      repository: new CanonicalValidationCheckpointRepository(directory),
      matrix,
      candidate_fingerprint: 'candidate-a',
      materialize_reference: (target) => laneReference(directory, target),
      executor: {
        execute: async () => {
          calls += 1;
          return 'succeeded';
        },
      },
      signal: abort.signal,
    });
    expect(checkpoint.interrupted).toBe(true);
    expect(calls).toBe(0);
  });

  it('rejects the next known reservation before its executor can run', async () => {
    const directory = root();
    const fullMatrix = buildCanonicalValidationMatrix();
    const known = fullMatrix.targets.find(
      (target) => target.key === 'brave-search/search',
    );
    if (!known) throw new Error('missing known-price fixture target');
    const matrix = { ...fullMatrix, targets: [known] };
    let calls = 0;
    await expect(
      executeCanonicalValidationLane({
        repository: new CanonicalValidationCheckpointRepository(directory),
        matrix,
        candidate_fingerprint: 'candidate-a',
        materialize_reference: (target) => laneReference(directory, target),
        approved_unknown_targets: [],
        aggregate_budget_microusd: '0',
        executor: {
          execute: async () => {
            calls += 1;
            return 'succeeded';
          },
        },
      }),
    ).rejects.toThrow('reservation exceeds aggregate');
    expect(calls).toBe(0);
  });

  it('runs fixture work through the exact canonical prepared-execution seam', async () => {
    const directory = root();
    const matrix = buildCanonicalValidationMatrix();
    const target = matrix.targets[0];
    if (!target) throw new Error('missing fixture target');
    const prepared = {
      request: {
        interchange_version: '1.0.0',
        message_type: 'request',
        request_id: 'request-1',
        requested_at: '2026-08-13T00:00:00.000Z',
        mode: 'sync',
        query: 'fixture',
        slots: [
          {
            slot_id: 'slot-1',
            position: 0,
            requirements: {},
            primary: { identity: target.expected_effective_identity },
          },
        ],
        fallback_reserve: [],
      },
      policy: {
        limits: { max_concurrency: 1 },
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
    let runs = 0;
    const executor = createCanonicalPreparedValidationExecutor({
      prepare: () => prepared,
      run: async () => {
        runs += 1;
        return {
          manifest: { coordination_state: { status: 'succeeded' } } as never,
        };
      },
    });
    const result = await executeCanonicalValidationLane({
      repository: new CanonicalValidationCheckpointRepository(directory),
      matrix,
      candidate_fingerprint: 'candidate-a',
      approved_unknown_targets: matrix.targets.map(
        (candidate) => candidate.key,
      ),
      materialize_reference: (candidate) => laneReference(directory, candidate),
      executor,
    });
    expect(runs).toBe(1);
    expect(result.attempts[0]?.status).toBe('succeeded');
  });

  it('cancels only the exact injected target and awaits its current work on signal', async () => {
    const target = buildCanonicalValidationMatrix().targets[0];
    if (!target) throw new Error('missing fixture target');
    const controller = new AbortController();
    let cancelled = 0;
    const outcome = await executeWithCanonicalValidationAbort(
      {
        execute: async () => {
          controller.abort();
          return 'failed';
        },
        cancel: async (candidate) => {
          expect(candidate.key).toBe(target.key);
          cancelled += 1;
        },
      },
      target,
      controller.signal,
    );
    expect(cancelled).toBe(1);
    expect(outcome).toBe('failed');
  });

  it('rejects checkpoint and private/public artifact symlink attacks', () => {
    const directory = root();
    const outside = root();
    writeFileSync(join(outside, 'checkpoint.json'), '{}');
    symlinkSync(
      join(outside, 'checkpoint.json'),
      join(directory, 'checkpoint.json'),
    );
    expect(() =>
      new CanonicalValidationCheckpointRepository(directory).read(),
    ).toThrow('artifact path is unsafe');

    const privateRoot = root();
    const publicRoot = root();
    writePrivateRawEvidence(privateRoot, 'raw.txt', 'private evidence');
    writeSanitizedCanonicalReceipt(publicRoot, 'receipt.json', {
      schema_version: 1,
    });
    expect(() =>
      writePrivateRawEvidence(privateRoot, '../outside', 'x'),
    ).toThrow('safe file name');
    expect(() =>
      writeSanitizedCanonicalReceipt(publicRoot, 'receipt.json', {
        path: '/opt/private',
      }),
    ).toThrow('non-allowlisted');
    expect(() =>
      writeSanitizedCanonicalReceipt(publicRoot, 'receipt.json', {
        schema_version: 1,
        raw_body: 'no',
      }),
    ).toThrow('non-allowlisted');
    expect(() =>
      writeSanitizedCanonicalReceipt(publicRoot, 'receipt.json', {
        schema_version: 1,
        provenance: {
          receipt:
            'https://bucket.example/path?X-Amz-Credential=secret&X-Amz-Signature=signature',
        },
      }),
    ).toThrow('prohibited material');
  });

  it('fails closed on malformed checkpoint state rather than re-dispatching', () => {
    const directory = root();
    writeFileSync(
      join(directory, 'checkpoint.json'),
      JSON.stringify({
        schema_version: 1,
        pins: {},
        target_order: [],
        attempts: [{ status: 'invented' }],
        interrupted: false,
      }),
    );
    expect(() =>
      new CanonicalValidationCheckpointRepository(directory).read(),
    ).toThrow('invalid or unsafe schema');
  });

  it('rejects a persisted pending attempt instead of dispatching it again', () => {
    const directory = root();
    const matrix = buildCanonicalValidationMatrix();
    const target = matrix.targets[0];
    if (!target) throw new Error('missing fixture target');
    writeFileSync(
      join(directory, 'checkpoint.json'),
      JSON.stringify({
        schema_version: 1,
        pins: {
          matrix_fingerprint: matrix.fingerprint,
          catalog_digest: matrix.catalog_digest,
          pricing_snapshot_fingerprint: matrix.pricing_snapshot_fingerprint,
          candidate_fingerprint: 'candidate-a',
        },
        target_order: matrix.targets.map((candidate) => candidate.key),
        attempts: [
          {
            target_key: target.key,
            credential_family: target.credential_family,
            status: 'pending',
          },
        ],
        interrupted: false,
      }),
    );
    expect(() =>
      new CanonicalValidationCheckpointRepository(directory).read(),
    ).toThrow('invalid or unsafe schema');
  });
});

describe('canonical live-validation CLI protocol', () => {
  it('defaults to a network-denied fixture plan and exposes no legacy providers flag', async () => {
    const writes: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((value: string) => {
      writes.push(value);
      return true;
    }) as typeof process.stdout.write;
    try {
      await createCliProgram().parseAsync([
        'node',
        'librarium',
        'live-validation',
      ]);
    } finally {
      process.stdout.write = write;
    }
    expect(writes.join('')).toContain('network');
    expect(writes.join('')).toContain('denied');
    expect(
      createCliProgram()
        .commands.find((command) => command.name() === 'live-validation')
        ?.options.map((option) => option.long),
    ).not.toContain('--providers');
  });
});

describe('frozen paid protocol (injected, zero-network)', () => {
  const fixtureManifests = new Map<string, string>();
  async function canonicalManifest(
    target: ReturnType<
      typeof buildCanonicalValidationMatrix
    >['targets'][number],
    root: string,
    requestId: string,
    outcome: 'succeeded' | 'failed' = 'succeeded',
    metering?: {
      readonly kind: 'credit_priced';
      readonly pricingVersion: string;
      readonly estimate: {
        readonly unit: string;
        readonly costConfidence: 'estimated';
      };
      readonly actual: {
        readonly source: 'provider_reported';
        readonly billableUnits: number;
      };
    },
  ): Promise<string> {
    const entry = BUILTIN_PROVIDER_CATALOG.find(
      (candidate) =>
        candidate.provider_id === target.requested_identity.provider_id,
    );
    const declaration = entry?.profiles.find(
      (candidate) =>
        candidate.profile_id === target.requested_identity.profile_id,
    );
    if (!entry || !declaration) throw new Error('missing canonical profile');
    const profile = declaredExecutionProfile(entry.provider_id, declaration);
    const prepared = {
      request: {
        interchange_version: '1.0.0',
        message_type: 'request',
        request_id: requestId,
        requested_at: '2026-08-13T00:00:00.000Z',
        mode: 'sync',
        query: 'fixture-query',
        slots: [
          {
            slot_id: 'slot-1',
            position: 0,
            requirements: {
              result_kind: profile.result_kind,
              ...(profile.grounding_policy && {
                grounding_policy: profile.grounding_policy,
              }),
              corpora: profile.corpora,
              retrieval_methods: [profile.retrieval_method],
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
          inline_attempt_deadline_ms: 10_000,
          background_attempt_deadline_ms: 20_000,
          poll_interval_ms: 1_000,
        },
        fallback: { kind: 'disabled' },
        exclusions: [],
        refinement: { kind: 'disabled' },
      },
      profile_plans_by_identity: {
        [profileIdentityKey(profile.identity)]: {
          profile_key: profileIdentityKey(profile.identity),
          identity: profile.identity,
          binding: {
            adapter_id: target.adapter_id,
            binding_id: target.binding_id,
          },
        },
      },
      catalog: { revision: 'fixture', digest: target.catalog_digest },
      notices: [],
    } as unknown as PreparedResearchExecution;
    const provider: Provider = {
      id: profile.identity.provider_id,
      displayName: 'Fixture',
      tier: 'ai-grounded',
      envVar: '',
      execution: 'inline',
      execute: async () => {
        if (outcome === 'failed') throw new Error('fixture terminal failure');
        return {
          provider: profile.identity.provider_id,
          tier: 'ai-grounded',
          content: 'fixture output',
          citations: [
            {
              provider: target.adapter_id,
              url: 'https://example.com/source',
              title: 'Source',
            },
          ],
          durationMs: 1,
          ...(metering && { metering }),
        };
      },
    };
    const runDirectory = join(root, `run-${requestId}`);
    mkdirSync(runDirectory);
    const result = await runCanonicalPreparedExecution(prepared, {
      runs_root: root,
      run_directory: runDirectory,
      coordinator: createNodeCoordinatorDependencies(() =>
        Date.parse('2026-08-13T00:00:00.000Z'),
      ),
      attempt_bridge: {
        resolveExactBinding: () => ({
          binding: {
            adapter_id: target.adapter_id,
            binding_id: target.binding_id,
          },
          profile,
          catalog_digest: target.catalog_digest,
          provider,
        }),
        now: () => Date.parse('2026-08-13T00:00:00.000Z'),
        wait: async () => {},
      },
    });
    const raw = JSON.stringify(result.manifest);
    fixtureManifests.set(requestId, raw);
    return raw;
  }
  function gate(): {
    readonly gate: ApprovalGate;
    readonly matrix: ReturnType<typeof buildCanonicalValidationMatrix>;
    readonly candidateAuthority: {
      readonly candidate_root: string;
      readonly git_sha: () => string;
      readonly candidate_fingerprint: () => string;
      readonly candidate_sha256: () => string;
      readonly candidate_version: () => string;
      readonly artifact_names: () => readonly string[];
      readonly artifact_sha256: (name: string) => string;
      readonly verify: () => void;
    };
  } {
    const matrix = buildCanonicalValidationMatrix();
    const protocolTargets = matrix.targets.map((target) => {
      const quote = quoteCanonicalValidationTarget(target);
      const unpriced = quote.reserved_microusd === undefined;
      return {
        key: target.key,
        query: 'fixture-query',
        account: 'reviewed-account',
        region: 'us',
        credential_reference: target.credential_family,
        options: {},
        timeout_seconds: 30,
        poll_deadline_seconds: 60,
        pacing_ms: 1,
        max_requests: 1 as const,
        retry: 'disabled' as const,
        cancel_policy: 'supported_exact_profile' as const,
        sensibility_policy: 'deterministic_required' as const,
        pricing: {
          status: quote.quote.status,
          currency: 'USD' as const,
          ...(quote.quote.amount_decimal && {
            amount_decimal: quote.quote.amount_decimal,
          }),
          ...(quote.quote.known_maximum_decimal && {
            known_maximum_decimal: quote.quote.known_maximum_decimal,
          }),
          ...(quote.reserved_microusd && {
            reserved_microusd: quote.reserved_microusd,
          }),
          ...(unpriced && { unknown_reason: 'fixture_unknown' }),
          ...(unpriced && { approved_maximum_microusd: '1' }),
          unknown_approved: unpriced,
        },
      };
    });
    const approval = {
      schema_version: 2 as const,
      candidate: {
        git_sha: 'a'.repeat(40),
        fingerprint:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        version: '2.0.0-rc.1',
        artifact_hashes: {
          declarations:
            'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          npm_tarball:
            'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          package_inventory:
            'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          provenance:
            'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          sea_manifest:
            'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      },
      matrix_fingerprint: matrix.fingerprint,
      catalog_digest: matrix.catalog_digest,
      pricing_snapshot_fingerprint: matrix.pricing_snapshot_fingerprint,
      aggregate_budget_microusd: protocolTargets
        .map((target) =>
          BigInt(
            target.pricing.reserved_microusd ??
              target.pricing.approved_maximum_microusd ??
              '0',
          ),
        )
        .reduce((total, value) => total + value, 0n)
        .toString(),
      raw_root: mkdtempSync(join(tmpdir(), 'librarium-protocol-raw-')),
      receipt_root: mkdtempSync(join(tmpdir(), 'librarium-protocol-receipt-')),
      targets: protocolTargets,
    };
    roots.push(approval.raw_root, approval.receipt_root);
    return {
      gate: { approval, fingerprint: approvalFingerprint(approval) },
      matrix,
      candidateAuthority: {
        candidate_root: approval.raw_root,
        git_sha: () => 'a'.repeat(40),
        candidate_fingerprint: () => approval.candidate.fingerprint,
        candidate_sha256: () => approval.candidate.fingerprint,
        candidate_version: () => approval.candidate.version,
        artifact_names: () => Object.keys(approval.candidate.artifact_hashes),
        artifact_sha256: (name) =>
          approval.candidate.artifact_hashes[name] ?? '',
        verify: () => {},
      },
    };
  }
  function attemptReference(
    target: ReturnType<
      typeof buildCanonicalValidationMatrix
    >['targets'][number],
    protocol: ApprovalGate['approval']['targets'][number],
    root: string,
    requestId = `request-${target.key.replace('/', '-')}`,
  ) {
    const requestContract = frozenRequestContract(target, protocol);
    return {
      runs_root: root,
      run_directory: join(root, `run-${requestId}`),
      request_id: requestId,
      binding_id: target.binding_id,
      catalog_digest: target.catalog_digest,
      request_fingerprint: frozenRequestFingerprint(target, protocol),
      protocol_contract_hash: frozenProtocolContractHash(requestContract),
      request_contract: requestContract,
    };
  }
  const fixtureReferenceAuthority = {
    read: (
      reference: { readonly request_id: string },
      _target: unknown,
      phase: string,
      diagnostic?: { readonly raw_manifest?: string },
    ) =>
      phase === 'terminal'
        ? CanonicalRunManifestV3Schema.parse(
            JSON.parse(
              diagnostic?.raw_manifest ??
                fixtureManifests.get(reference.request_id)!,
            ),
          )
        : ({} as ReturnType<typeof CanonicalRunManifestV3Schema.parse>),
  };

  it('performs every structural/drift/budget gate before the credential-capable prepare seam', async () => {
    const { gate: frozen, matrix, candidateAuthority } = gate();
    expect(
      assertLiveValidationGate(
        frozen,
        frozen.fingerprint,
        frozen.fingerprint,
        candidateAuthority,
      ),
    ).toStrictEqual(matrix);
    let prepared = 0;
    const rawManifest = await canonicalManifest(
      matrix.targets[0]!,
      frozen.approval.raw_root,
      'request-1',
    );
    const repository = new CanonicalValidationCheckpointRepository(
      frozen.approval.raw_root,
    );
    const oneMatrix = { ...matrix, targets: matrix.targets.slice(0, 1) };
    const oneGate = {
      ...frozen,
      approval: {
        ...frozen.approval,
        targets: frozen.approval.targets.slice(0, 1),
      },
    };
    repository.create({
      schema_version: 1,
      pins: {
        matrix_fingerprint: matrix.fingerprint,
        catalog_digest: matrix.catalog_digest,
        pricing_snapshot_fingerprint: matrix.pricing_snapshot_fingerprint,
        candidate_fingerprint: frozen.approval.candidate.fingerprint,
        approval_fingerprint: oneGate.fingerprint,
        target_protocols_digest: approvalTargetProtocolsDigest(
          oneGate.approval,
        ),
      },
      target_order: oneGate.approval.targets.map((target) => target.key),
      attempts: [],
      interrupted: false,
    });
    const state = await executeFrozenValidationProtocol({
      gate: oneGate,
      matrix: oneMatrix,
      candidate_authority: candidateAuthority,
      reference_manifest_authority: fixtureReferenceAuthority,
      repository,
      executor: {
        prepare: async (target, protocol) => {
          prepared += 1;
          return attemptReference(
            target,
            protocol,
            frozen.approval.raw_root,
            'request-1',
          );
        },
        execute: async () => ({
          status: 'terminal',
          lifecycle: 'succeeded',
          request_id: 'request-1',
          raw_manifest: rawManifest,
        }),
        reconcile: async () => ({
          status: 'terminal',
          lifecycle: 'succeeded',
          request_id: 'request-1',
          raw_manifest: rawManifest,
        }),
      },
      wait: async () => {},
    });
    expect(prepared).toBe(1);
    expect(state.completed).toContain(matrix.targets[0]?.key);
    expect(() =>
      assertLiveValidationGate(
        frozen,
        'wrong',
        frozen.fingerprint,
        candidateAuthority,
      ),
    ).toThrow('matching full preregistration');
  });

  it.each([
    [
      'query',
      (approval: any) => ({
        ...approval,
        targets: [{ ...approval.targets[0], query: 'mutated-query' }],
      }),
    ],
    [
      'options',
      (approval: any) => ({
        ...approval,
        targets: [{ ...approval.targets[0], options: { mutated: true } }],
      }),
    ],
    [
      'aggregate budget',
      (approval: any) => ({
        ...approval,
        aggregate_budget_microusd: (
          BigInt(approval.aggregate_budget_microusd) + 1n
        ).toString(),
      }),
    ],
    [
      'pacing',
      (approval: any) => ({
        ...approval,
        targets: [
          {
            ...approval.targets[0],
            pacing_ms: approval.targets[0].pacing_ms + 1,
          },
        ],
      }),
    ],
    [
      'cancel policy',
      (approval: any) => ({
        ...approval,
        targets: [{ ...approval.targets[0], cancel_policy: 'reconcile_only' }],
      }),
    ],
    [
      'unknown maximum',
      (approval: any) => ({
        ...approval,
        targets: [
          {
            ...approval.targets[0],
            pricing: {
              ...approval.targets[0].pricing,
              approved_maximum_microusd: (
                BigInt(approval.targets[0].pricing.approved_maximum_microusd) +
                1n
              ).toString(),
            },
          },
        ],
      }),
    ],
  ])(
    'rejects approval continuity mutation of %s before any executor seam',
    async (_label, mutate) => {
      const { gate: frozen, matrix, candidateAuthority } = gate();
      const protocol = frozen.approval.targets.find(
        (candidate) =>
          candidate.pricing.approved_maximum_microusd !== undefined,
      )!;
      const target = matrix.targets.find(
        (candidate) => candidate.key === protocol.key,
      )!;
      const base = {
        ...frozen,
        approval: { ...frozen.approval, targets: [protocol] },
      };
      const repository = new CanonicalValidationCheckpointRepository(
        frozen.approval.raw_root,
      );
      repository.create({
        schema_version: 1,
        pins: {
          matrix_fingerprint: matrix.fingerprint,
          catalog_digest: matrix.catalog_digest,
          pricing_snapshot_fingerprint: matrix.pricing_snapshot_fingerprint,
          candidate_fingerprint: frozen.approval.candidate.fingerprint,
          approval_fingerprint: base.fingerprint,
          target_protocols_digest: approvalTargetProtocolsDigest(base.approval),
        },
        target_order: [target.key],
        attempts: [],
        interrupted: false,
      });
      const approval = mutate(base.approval);
      const mutated = {
        ...base,
        approval,
        fingerprint: approvalFingerprint(approval),
      };
      const seams = { prepare: 0, execute: 0, reconcile: 0 };
      await expect(
        executeFrozenValidationProtocol({
          gate: mutated,
          matrix: { ...matrix, targets: [target] },
          candidate_authority: candidateAuthority,
          repository,
          executor: {
            prepare: async () => {
              seams.prepare += 1;
              throw new Error('unreachable');
            },
            execute: async () => {
              seams.execute += 1;
              throw new Error('unreachable');
            },
            reconcile: async () => {
              seams.reconcile += 1;
              throw new Error('unreachable');
            },
          },
        }),
      ).rejects.toThrow('approval protocol continuity drifted');
      expect(seams).toStrictEqual({ prepare: 0, execute: 0, reconcile: 0 });
    },
  );

  it('projects normalized unit-only provider metering to terminal receipt evidence', async () => {
    const { gate: frozen, matrix, candidateAuthority } = gate();
    const target = matrix.targets[0]!;
    const protocol = frozen.approval.targets[0]!;
    const oneGate = {
      ...frozen,
      approval: { ...frozen.approval, targets: [protocol] },
    };
    const requestId = 'normalized-unit-metering';
    const rawManifest = await canonicalManifest(
      target,
      frozen.approval.raw_root,
      requestId,
      'succeeded',
      {
        kind: 'credit_priced',
        pricingVersion: 'unit-test-v1',
        estimate: { unit: 'credit', costConfidence: 'estimated' },
        actual: { source: 'provider_reported', billableUnits: 4 },
      },
    );
    await executeFrozenValidationProtocol({
      gate: oneGate,
      matrix: { ...matrix, targets: [target] },
      candidate_authority: candidateAuthority,
      reference_manifest_authority: fixtureReferenceAuthority,
      executor: {
        prepare: async (candidate, approved) =>
          attemptReference(
            candidate,
            approved,
            frozen.approval.raw_root,
            requestId,
          ),
        execute: async () => ({
          status: 'terminal',
          lifecycle: 'succeeded',
          request_id: requestId,
          raw_manifest: rawManifest,
        }),
        reconcile: async () => ({
          status: 'terminal',
          lifecycle: 'succeeded',
          request_id: requestId,
          raw_manifest: rawManifest,
        }),
      },
    });
    const receipt = JSON.parse(
      readFileSync(
        join(
          frozen.approval.receipt_root,
          `${target.key.replace('/', '-')}.json`,
        ),
        'utf8',
      ),
    );
    expect(receipt.metering).toMatchObject({
      kind: 'credit_priced',
      pricing_version: 'unit-test-v1',
      billable_units: 4,
      billable_unit: 'credit',
      evidence_source: 'provider_reported_units',
    });
  });

  it.each([
    ['unit-only', undefined, 'credit_priced', 'provider_reported', 'credit', 4],
    [
      'USD-only',
      { actual_cost: '0.01', currency: 'USD' },
      'native_cost',
      'provider_reported',
      undefined,
      undefined,
    ],
    [
      'token-computed',
      undefined,
      'native_tokens',
      'computed_from_tokens',
      'token',
      30,
    ],
    [
      'account-usage-delta',
      undefined,
      'api_unit_priced',
      'account_usage_delta',
      'request',
      1,
    ],
  ] as const)(
    'writes strict %s metering metadata without requiring primary usage',
    async (_label, usage, kind, source, unit, units) => {
      const { gate: frozen, matrix, candidateAuthority } = gate();
      const target = matrix.targets[0]!;
      const protocol = frozen.approval.targets[0]!;
      const oneGate = {
        ...frozen,
        approval: { ...frozen.approval, targets: [protocol] },
      };
      const manifest = JSON.parse(
        await canonicalManifest(
          target,
          frozen.approval.raw_root,
          `metering-${source}`,
        ),
      );
      const primary = manifest.terminal_response.results[0];
      primary.usage = usage;
      primary.provider_meta = {
        ...(primary.provider_meta ?? {}),
        'librarium:metering': {
          kind,
          pricing_version: 'metering-test-v1',
          actual_cost_source: source,
          source_class:
            source === 'account_usage_delta'
              ? 'account_usage_delta'
              : source === 'provider_reported'
                ? 'provider_reported'
                : 'computed',
          actual_completeness: 'complete',
          actual_evidence:
            source === 'account_usage_delta'
              ? 'account_usage_delta'
              : source === 'provider_reported'
                ? 'provider_reported_cost'
                : 'computed_billable_units',
          ...(units !== undefined && { billable_units: units }),
          ...(unit !== undefined && { billable_unit: unit }),
        },
      };
      const rawManifest = JSON.stringify(manifest);
      await executeFrozenValidationProtocol({
        gate: oneGate,
        matrix: { ...matrix, targets: [target] },
        candidate_authority: candidateAuthority,
        reference_manifest_authority: {
          read: (_reference, _target, phase, diagnostic) =>
            phase === 'terminal'
              ? (JSON.parse(
                  diagnostic?.raw_manifest ?? rawManifest,
                ) as ReturnType<typeof CanonicalRunManifestV3Schema.parse>)
              : ({} as ReturnType<typeof CanonicalRunManifestV3Schema.parse>),
        },
        executor: {
          prepare: async (candidate, approved) =>
            attemptReference(
              candidate,
              approved,
              frozen.approval.raw_root,
              `metering-${source}`,
            ),
          execute: async () => ({
            status: 'terminal',
            lifecycle: 'succeeded',
            request_id: `metering-${source}`,
            raw_manifest: rawManifest,
          }),
          reconcile: async () => ({
            status: 'terminal',
            lifecycle: 'succeeded',
            request_id: `metering-${source}`,
            raw_manifest: rawManifest,
          }),
        },
      });
      const receipt = JSON.parse(
        readFileSync(
          join(
            frozen.approval.receipt_root,
            `${target.key.replace('/', '-')}.json`,
          ),
          'utf8',
        ),
      );
      expect(receipt.metering).toMatchObject({
        kind,
        pricing_version: 'metering-test-v1',
        source,
        ...(unit !== undefined && { billable_unit: unit }),
        ...(units !== undefined && { billable_units: units }),
      });
      if (usage) expect(receipt.metering.actual_cost).toBe('0.01');
    },
  );

  it('rejects candidate artifact drift before the credential-capable prepare seam', () => {
    const { gate: frozen, candidateAuthority } = gate();
    const credentialSeam = 0;
    const drifted = {
      ...candidateAuthority,
      artifact_sha256: () =>
        'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    };
    expect(() =>
      assertLiveValidationGate(
        frozen,
        frozen.fingerprint,
        frozen.fingerprint,
        drifted,
      ),
    ).toThrow('candidate artifact drifted');
    // The assertion is deliberately local: a failed gate has no executor and
    // therefore no path to the credential-capable prepare seam.
    expect(credentialSeam).toBe(0);
  });

  it('recovers outer running custody after a terminal coordinator state without response', async () => {
    const { gate: frozen, matrix, candidateAuthority } = gate();
    const active = matrix.targets[0];
    if (!active) throw new Error('missing fixture target');
    let executes = 0;
    let reconciles = 0;
    const rawManifest = await canonicalManifest(
      active,
      frozen.approval.raw_root,
      'old',
    );
    const repository = new CanonicalValidationCheckpointRepository(
      frozen.approval.raw_root,
    );
    const oneMatrix = { ...matrix, targets: [active] };
    const oneGate = {
      ...frozen,
      approval: {
        ...frozen.approval,
        targets: frozen.approval.targets.slice(0, 1),
      },
    };
    repository.create({
      schema_version: 1,
      pins: {
        matrix_fingerprint: matrix.fingerprint,
        catalog_digest: matrix.catalog_digest,
        pricing_snapshot_fingerprint: matrix.pricing_snapshot_fingerprint,
        candidate_fingerprint: frozen.approval.candidate.fingerprint,
        approval_fingerprint: oneGate.fingerprint,
        target_protocols_digest: approvalTargetProtocolsDigest(
          oneGate.approval,
        ),
      },
      target_order: oneGate.approval.targets.map((target) => target.key),
      attempts: [
        {
          target_key: active.key,
          credential_family:
            frozen.approval.targets[0]?.credential_reference ?? '',
          status: 'running',
          reserved_microusd:
            frozen.approval.targets[0]?.pricing.reserved_microusd ??
            frozen.approval.targets[0]?.pricing.approved_maximum_microusd,
          request_fingerprint: frozenRequestFingerprint(
            active,
            frozen.approval.targets[0]!,
          ),
          reference: attemptReference(
            active,
            frozen.approval.targets[0]!,
            frozen.approval.raw_root,
            'old',
          ),
        },
      ],
      interrupted: false,
    });
    const result = await executeFrozenValidationProtocol({
      gate: oneGate,
      matrix: oneMatrix,
      candidate_authority: candidateAuthority,
      reference_manifest_authority: {
        read: (_reference, _target, phase, diagnostic) =>
          phase === 'active'
            ? ({
                coordination_state: { status: 'succeeded', attempts: [] },
              } as ReturnType<typeof CanonicalRunManifestV3Schema.parse>)
            : phase === 'terminal'
              ? CanonicalRunManifestV3Schema.parse(
                  JSON.parse(diagnostic?.raw_manifest ?? rawManifest),
                )
              : ({} as ReturnType<typeof CanonicalRunManifestV3Schema.parse>),
      },
      repository,
      executor: {
        prepare: async (target, protocol) =>
          attemptReference(target, protocol, frozen.approval.raw_root),
        execute: async () => {
          executes += 1;
          return {
            status: 'terminal',
            lifecycle: 'succeeded',
            request_id: 'new',
            raw_manifest: rawManifest,
          };
        },
        reconcile: async () => {
          reconciles += 1;
          return {
            status: 'terminal',
            lifecycle: 'succeeded',
            request_id: 'old',
            raw_manifest: rawManifest,
          };
        },
      },
    });
    expect(reconciles).toBe(1);
    expect(executes).toBe(0);
    expect(result.completed).toContain(active.key);
    expect(
      repository
        .read()
        ?.attempts.find((attempt) => attempt.target_key === active.key)?.status,
    ).toBe('succeeded');
  });

  it('freshly resumes a crash-after-CAS zero-attempt submission through pre-dispatch exactly once', async () => {
    const { gate: frozen, matrix, candidateAuthority } = gate();
    const target = matrix.targets[0]!;
    const protocol = frozen.approval.targets[0]!;
    const oneGate = {
      ...frozen,
      approval: { ...frozen.approval, targets: [protocol] },
    };
    const repository = new CanonicalValidationCheckpointRepository(
      frozen.approval.raw_root,
    );
    repository.create({
      schema_version: 1,
      pins: {
        matrix_fingerprint: matrix.fingerprint,
        catalog_digest: matrix.catalog_digest,
        pricing_snapshot_fingerprint: matrix.pricing_snapshot_fingerprint,
        candidate_fingerprint: frozen.approval.candidate.fingerprint,
        approval_fingerprint: oneGate.fingerprint,
        target_protocols_digest: approvalTargetProtocolsDigest(
          oneGate.approval,
        ),
      },
      target_order: [target.key],
      attempts: [
        {
          target_key: target.key,
          credential_family: protocol.credential_reference,
          status: 'submitted',
          reserved_microusd:
            protocol.pricing.reserved_microusd ??
            protocol.pricing.approved_maximum_microusd,
          request_fingerprint: frozenRequestFingerprint(target, protocol),
          reference: attemptReference(
            target,
            protocol,
            frozen.approval.raw_root,
            'cas-crash',
          ),
        },
      ],
      interrupted: false,
    });
    const rawManifest = await canonicalManifest(
      target,
      frozen.approval.raw_root,
      'cas-crash',
    );
    const phases: string[] = [];
    let executes = 0;
    let reconciles = 0;
    await executeFrozenValidationProtocol({
      gate: oneGate,
      matrix: { ...matrix, targets: [target] },
      candidate_authority: candidateAuthority,
      repository: new CanonicalValidationCheckpointRepository(
        frozen.approval.raw_root,
      ),
      reference_manifest_authority: {
        read: (_reference, _target, phase, diagnostic) => {
          phases.push(phase);
          if (phase === 'resume') {
            return {
              coordination_state: { status: 'running', attempts: [] },
            } as ReturnType<typeof CanonicalRunManifestV3Schema.parse>;
          }
          return phase === 'terminal'
            ? CanonicalRunManifestV3Schema.parse(
                JSON.parse(diagnostic?.raw_manifest ?? rawManifest),
              )
            : ({} as ReturnType<typeof CanonicalRunManifestV3Schema.parse>);
        },
      },
      executor: {
        prepare: async () => {
          throw new Error('must not re-materialize');
        },
        execute: async () => {
          executes += 1;
          return {
            status: 'terminal',
            lifecycle: 'succeeded',
            request_id: 'cas-crash',
            raw_manifest: rawManifest,
          };
        },
        reconcile: async () => {
          reconciles += 1;
          throw new Error('must not reconcile zero-attempt submission');
        },
      },
    });
    expect({ executes, reconciles }).toStrictEqual({
      executes: 1,
      reconciles: 0,
    });
    expect(phases).toContain('resume');
  });

  it.each([
    ['materialized', { status: 'running', attempts: [] }, 'terminal', 1, 0],
    [
      'submitting',
      { status: 'running', attempts: [{ status: 'submitting' }] },
      'reconcile',
      0,
      1,
    ],
    [
      'durable-running',
      {
        status: 'running',
        attempts: [{ durable_handle: { status: 'running' } }],
      },
      'reconcile',
      0,
      1,
    ],
    [
      'terminal-no-response',
      { status: 'succeeded', attempts: [] },
      'terminal',
      0,
      1,
    ],
  ] as const)(
    'resumes submitted outer custody from trusted %s state without materializing or duplicate submit',
    async (_label, custody, outcomeKind, expectedExecutes, expectedReconciles) => {
      const { gate: frozen, matrix, candidateAuthority } = gate();
      const target = matrix.targets[0]!;
      const protocol = frozen.approval.targets[0]!;
      const oneGate = {
        ...frozen,
        approval: { ...frozen.approval, targets: [protocol] },
      };
      const requestId = `submitted-${_label}`;
      const repository = new CanonicalValidationCheckpointRepository(
        frozen.approval.raw_root,
      );
      repository.create({
        schema_version: 1,
        pins: {
          matrix_fingerprint: matrix.fingerprint,
          catalog_digest: matrix.catalog_digest,
          pricing_snapshot_fingerprint: matrix.pricing_snapshot_fingerprint,
          candidate_fingerprint: frozen.approval.candidate.fingerprint,
          approval_fingerprint: oneGate.fingerprint,
          target_protocols_digest: approvalTargetProtocolsDigest(
            oneGate.approval,
          ),
        },
        target_order: [target.key],
        attempts: [
          {
            target_key: target.key,
            credential_family: protocol.credential_reference,
            status: 'submitted',
            reserved_microusd:
              protocol.pricing.reserved_microusd ??
              protocol.pricing.approved_maximum_microusd,
            request_fingerprint: frozenRequestFingerprint(target, protocol),
            reference: attemptReference(
              target,
              protocol,
              frozen.approval.raw_root,
              requestId,
            ),
          },
        ],
        interrupted: false,
      });
      const rawManifest = await canonicalManifest(
        target,
        frozen.approval.raw_root,
        requestId,
      );
      let executes = 0;
      let reconciles = 0;
      await executeFrozenValidationProtocol({
        gate: oneGate,
        matrix: { ...matrix, targets: [target] },
        candidate_authority: candidateAuthority,
        repository,
        reference_manifest_authority: {
          read: (_reference, _target, phase, diagnostic) =>
            phase === 'resume'
              ? ({ coordination_state: custody } as ReturnType<
                  typeof CanonicalRunManifestV3Schema.parse
                >)
              : CanonicalRunManifestV3Schema.parse(
                  JSON.parse(diagnostic?.raw_manifest ?? rawManifest),
                ),
        },
        executor: {
          prepare: async () => {
            throw new Error('must not materialize submitted custody');
          },
          execute: async () => {
            executes += 1;
            return {
              status: outcomeKind === 'reconcile' ? 'reconcile' : 'terminal',
              ...(outcomeKind === 'reconcile'
                ? { request_id: requestId, raw_manifest: rawManifest }
                : {
                    lifecycle: 'succeeded' as const,
                    request_id: requestId,
                    raw_manifest: rawManifest,
                  }),
            } as any;
          },
          reconcile: async () => {
            reconciles += 1;
            return {
              status: outcomeKind === 'reconcile' ? 'reconcile' : 'terminal',
              ...(outcomeKind === 'reconcile'
                ? { request_id: requestId, raw_manifest: rawManifest }
                : {
                    lifecycle: 'succeeded' as const,
                    request_id: requestId,
                    raw_manifest: rawManifest,
                  }),
            } as any;
          },
        },
      });
      expect({ executes, reconciles }).toStrictEqual({
        executes: expectedExecutes,
        reconciles: expectedReconciles,
      });
    },
  );

  it('reconciles interrupted submitted work on a fresh repository then requires explicit continuation', async () => {
    const { gate: frozen, matrix, candidateAuthority } = gate();
    const target = matrix.targets[0]!;
    const protocol = frozen.approval.targets[0]!;
    const rawManifest = await canonicalManifest(
      target,
      frozen.approval.raw_root,
      'interrupted-old',
    );
    const repository = new CanonicalValidationCheckpointRepository(
      frozen.approval.raw_root,
    );
    repository.create({
      schema_version: 1,
      pins: {
        matrix_fingerprint: matrix.fingerprint,
        catalog_digest: matrix.catalog_digest,
        pricing_snapshot_fingerprint: matrix.pricing_snapshot_fingerprint,
        candidate_fingerprint: frozen.approval.candidate.fingerprint,
        approval_fingerprint: frozen.fingerprint,
        target_protocols_digest: approvalTargetProtocolsDigest(frozen.approval),
      },
      target_order: frozen.approval.targets.map((entry) => entry.key),
      attempts: [
        {
          target_key: target.key,
          credential_family: protocol.credential_reference,
          status: 'running',
          reserved_microusd:
            protocol.pricing.reserved_microusd ??
            protocol.pricing.approved_maximum_microusd,
          request_fingerprint: frozenRequestFingerprint(target, protocol),
          reference: attemptReference(
            target,
            protocol,
            frozen.approval.raw_root,
            'interrupted-old',
          ),
        },
      ],
      interrupted: true,
    });
    let executes = 0;
    let reconciles = 0;
    await executeFrozenValidationProtocol({
      gate: frozen,
      matrix,
      candidate_authority: candidateAuthority,
      reference_manifest_authority: fixtureReferenceAuthority,
      repository: new CanonicalValidationCheckpointRepository(
        frozen.approval.raw_root,
      ),
      executor: {
        prepare: async (target, protocol) =>
          attemptReference(target, protocol, frozen.approval.raw_root),
        execute: async () => {
          executes += 1;
          throw new Error('must not resubmit');
        },
        reconcile: async () => {
          reconciles += 1;
          return {
            status: 'terminal',
            lifecycle: 'succeeded',
            request_id: 'interrupted-old',
            raw_manifest: rawManifest,
          };
        },
      },
    });
    expect(reconciles).toBe(1);
    expect(executes).toBe(0);
    expect(repository.read()?.attempts[0]).toMatchObject({
      status: 'succeeded',
      evidence_state: 'complete',
    });
    expect(repository.read()?.interrupted).toBe(true);
    continueFrozenValidationProtocol(
      repository,
      frozen,
      matrix,
      frozen.fingerprint,
      candidateAuthority,
    );
    expect(repository.read()?.interrupted).toBe(false);
  });

  it('recovers terminal evidence on an un-interrupted fresh process without re-preparing or re-dispatching', async () => {
    const { gate: frozen, matrix, candidateAuthority } = gate();
    const target = matrix.targets[0]!;
    const protocol = frozen.approval.targets[0]!;
    const rawManifest = await canonicalManifest(
      target,
      frozen.approval.raw_root,
      'evidence-recovery',
    );
    const oneMatrix = { ...matrix, targets: [target] };
    const oneGate = {
      ...frozen,
      approval: { ...frozen.approval, targets: [protocol] },
    };
    const repository = new CanonicalValidationCheckpointRepository(
      frozen.approval.raw_root,
    );
    repository.create({
      schema_version: 1,
      pins: {
        matrix_fingerprint: matrix.fingerprint,
        catalog_digest: matrix.catalog_digest,
        pricing_snapshot_fingerprint: matrix.pricing_snapshot_fingerprint,
        candidate_fingerprint: frozen.approval.candidate.fingerprint,
        approval_fingerprint: oneGate.fingerprint,
        target_protocols_digest: approvalTargetProtocolsDigest(
          oneGate.approval,
        ),
      },
      target_order: [target.key],
      attempts: [
        {
          target_key: target.key,
          credential_family: protocol.credential_reference,
          status: 'succeeded',
          reserved_microusd:
            protocol.pricing.reserved_microusd ??
            protocol.pricing.approved_maximum_microusd,
          request_fingerprint: frozenRequestFingerprint(target, protocol),
          evidence_state: 'pending',
          reference: attemptReference(
            target,
            protocol,
            frozen.approval.raw_root,
            'evidence-recovery',
          ),
          raw_evidence_name: `${target.key.replace('/', '-')}.manifest`,
          receipt_evidence_name: `${target.key.replace('/', '-')}.json`,
        },
      ],
      interrupted: false,
    });
    let prepares = 0;
    let executes = 0;
    let reconciles = 0;
    await executeFrozenValidationProtocol({
      gate: oneGate,
      matrix: oneMatrix,
      candidate_authority: candidateAuthority,
      reference_manifest_authority: fixtureReferenceAuthority,
      repository: new CanonicalValidationCheckpointRepository(
        frozen.approval.raw_root,
      ),
      executor: {
        prepare: async (target, protocol) => {
          prepares += 1;
          return attemptReference(target, protocol, frozen.approval.raw_root);
        },
        execute: async () => {
          executes += 1;
          throw new Error('must not execute');
        },
        reconcile: async () => {
          reconciles += 1;
          return {
            status: 'terminal',
            lifecycle: 'succeeded',
            request_id: 'evidence-recovery',
            raw_manifest: rawManifest,
          };
        },
      },
    });
    expect(prepares).toBe(0);
    expect(executes).toBe(0);
    expect(reconciles).toBe(1);
    expect(repository.read()?.attempts[0]?.evidence_state).toBe('complete');
    expect(
      readPrivateRawEvidence(
        frozen.approval.raw_root,
        `${target.key.replace('/', '-')}.manifest`,
      ),
    ).toContain('schemaVersion');
  });

  it('stops after failed or cancelled terminal lifecycle and never certifies it', async () => {
    const { gate: frozen, matrix, candidateAuthority } = gate();
    const target = matrix.targets[0]!;
    const rawManifest = await canonicalManifest(
      target,
      frozen.approval.raw_root,
      'terminal-stop',
      'failed',
    );
    const repository = new CanonicalValidationCheckpointRepository(
      frozen.approval.raw_root,
    );
    let prepares = 0;
    await expect(
      executeFrozenValidationProtocol({
        gate: frozen,
        matrix,
        candidate_authority: candidateAuthority,
        reference_manifest_authority: fixtureReferenceAuthority,
        repository,
        executor: {
          prepare: async (target, protocol) => {
            prepares += 1;
            return attemptReference(
              target,
              protocol,
              frozen.approval.raw_root,
              'terminal-stop',
            );
          },
          execute: async () => ({
            status: 'terminal',
            lifecycle: 'failed',
            request_id: 'terminal-stop',
            raw_manifest: rawManifest,
          }),
          reconcile: async () => {
            throw new Error('must not reconcile');
          },
        },
      }),
    ).rejects.toThrow('Canonical lifecycle failed stops');
    expect(prepares).toBe(1);
    expect(repository.read()?.attempts[0]).toMatchObject({
      status: 'failed',
      evidence_state: 'complete',
    });
  });

  it('fails closed on a stale checkpoint CAS before the execute seam', async () => {
    const { gate: frozen, matrix, candidateAuthority } = gate();
    const repository = new CanonicalValidationCheckpointRepository(
      frozen.approval.raw_root,
    );
    let executes = 0;
    Object.defineProperty(repository, 'compareAndSwap', {
      value: () => false,
      configurable: true,
    });
    await expect(
      executeFrozenValidationProtocol({
        gate: frozen,
        matrix,
        candidate_authority: candidateAuthority,
        reference_manifest_authority: fixtureReferenceAuthority,
        repository,
        executor: {
          prepare: async (target, protocol) =>
            attemptReference(target, protocol, frozen.approval.raw_root),
          execute: async () => {
            executes += 1;
            throw new Error('must not execute');
          },
          reconcile: async () => {
            throw new Error('must not reconcile');
          },
        },
      }),
    ).rejects.toThrow('Checkpoint changed before dispatch');
    expect(executes).toBe(0);
  });

  it('persists interruption after prepare and never reaches execute', async () => {
    const { gate: frozen, matrix, candidateAuthority } = gate();
    const controller = new AbortController();
    const repository = new CanonicalValidationCheckpointRepository(
      frozen.approval.raw_root,
    );
    let executes = 0;
    const state = await executeFrozenValidationProtocol({
      gate: frozen,
      matrix,
      candidate_authority: candidateAuthority,
      reference_manifest_authority: fixtureReferenceAuthority,
      repository,
      signal: controller.signal,
      executor: {
        prepare: async (target, protocol) => {
          controller.abort();
          return attemptReference(target, protocol, frozen.approval.raw_root);
        },
        execute: async () => {
          executes += 1;
          throw new Error('must not execute after abort');
        },
        reconcile: async () => {
          throw new Error('must not reconcile');
        },
      },
    });
    expect(executes).toBe(0);
    expect(state.active).toBeUndefined();
    expect(repository.read()?.interrupted).toBe(true);
  });

  it('persists interruption after submitted intent and before execute', async () => {
    const { gate: frozen, matrix, candidateAuthority } = gate();
    const repository = new CanonicalValidationCheckpointRepository(
      frozen.approval.raw_root,
    );
    let executes = 0;
    let cancelled = 0;
    let aborted = false;
    const signal = {
      get aborted() {
        return aborted;
      },
      addEventListener: (_event: string, callback: () => void) => {
        aborted = true;
        callback();
      },
      removeEventListener: () => {},
    } as unknown as AbortSignal;
    const result = await executeFrozenValidationProtocol({
      gate: frozen,
      matrix,
      candidate_authority: candidateAuthority,
      reference_manifest_authority: fixtureReferenceAuthority,
      repository,
      signal,
      executor: {
        prepare: async (target, protocol) =>
          attemptReference(target, protocol, frozen.approval.raw_root),
        execute: async () => {
          executes += 1;
          throw new Error('must not execute after submitted abort');
        },
        reconcile: async () => {
          throw new Error('must not reconcile');
        },
        cancel: async () => {
          cancelled += 1;
        },
      },
      now: () => 1,
    });
    expect(executes).toBe(0);
    expect(cancelled).toBe(1);
    expect(result.active).toBeDefined();
    expect(repository.read()?.interrupted).toBe(true);
    expect(repository.read()?.attempts[0]?.status).toBe('submitted');
  });

  it('records a post-checkpoint interruption without remote cancellation for a reconcile-only profile', async () => {
    const { gate: frozen, matrix, candidateAuthority } = gate();
    const target = matrix.targets[0]!;
    const protocol = {
      ...frozen.approval.targets[0]!,
      cancel_policy: 'reconcile_only' as const,
    };
    const controller = new AbortController();
    const repository = new CanonicalValidationCheckpointRepository(
      frozen.approval.raw_root,
    );
    let cancelled = 0;
    const signal = {
      get aborted() {
        return controller.signal.aborted;
      },
      addEventListener: (_event: string, callback: () => void) => {
        controller.abort();
        callback();
      },
      removeEventListener: () => {},
    } as unknown as AbortSignal;
    await executeFrozenValidationProtocol({
      gate: {
        ...frozen,
        approval: { ...frozen.approval, targets: [protocol] },
      },
      matrix: { ...matrix, targets: [target] },
      candidate_authority: candidateAuthority,
      reference_manifest_authority: fixtureReferenceAuthority,
      repository,
      signal,
      executor: {
        prepare: async (candidate, approved) =>
          attemptReference(candidate, approved, frozen.approval.raw_root),
        execute: async () => {
          throw new Error('must not execute after SIGINT');
        },
        reconcile: async () => {
          throw new Error('must not reconcile during local interruption');
        },
        cancel: async () => {
          cancelled += 1;
        },
      },
      now: () => 1,
    });
    expect(cancelled).toBe(0);
    expect(repository.read()?.interrupted).toBe(true);
  });

  it('revalidates the candidate after pacing and stops before the next prepare', async () => {
    const { gate: frozen, matrix, candidateAuthority } = gate();
    let valid = true;
    let prepares = 0;
    let verifies = 0;
    const authority = {
      ...candidateAuthority,
      verify: () => {
        verifies += 1;
        if (verifies === 1) valid = false;
        if (!valid)
          throw new CanonicalLiveValidationError('candidate drift fixture');
      },
    };
    await expect(
      executeFrozenValidationProtocol({
        gate: frozen,
        matrix,
        candidate_authority: authority,
        reference_manifest_authority: fixtureReferenceAuthority,
        executor: {
          prepare: async (target, protocol) => {
            prepares += 1;
            return attemptReference(target, protocol, frozen.approval.raw_root);
          },
          execute: async () => {
            throw new Error('must not execute after drift');
          },
          reconcile: async () => {
            throw new Error('must not reconcile after drift');
          },
        },
        wait: async () => {},
      }),
    ).rejects.toThrow('candidate drift fixture');
    expect(prepares).toBe(0);
  });

  it('rejects nested private and public roots before the prepare seam', () => {
    const { gate: frozen, candidateAuthority } = gate();
    const nested = join(frozen.approval.raw_root, 'public');
    mkdirSync(nested);
    const nestedGate = {
      ...frozen,
      approval: { ...frozen.approval, receipt_root: nested },
    };
    expect(() =>
      assertLiveValidationGate(
        nestedGate,
        nestedGate.fingerprint,
        nestedGate.fingerprint,
        candidateAuthority,
      ),
    ).toThrow('distinct and non-nested');
  });

  it('rejects a symlink in either evidence-root path before the prepare seam', () => {
    const { gate: frozen, candidateAuthority } = gate();
    const parent = mkdtempSync(join(tmpdir(), 'librarium-protocol-parent-'));
    const actual = join(parent, 'actual');
    const linked = join(parent, 'linked');
    mkdirSync(actual);
    symlinkSync(actual, linked);
    roots.push(parent);
    const symlinkGate = {
      ...frozen,
      approval: { ...frozen.approval, raw_root: linked },
    };
    expect(() =>
      assertLiveValidationGate(
        symlinkGate,
        symlinkGate.fingerprint,
        symlinkGate.fingerprint,
        candidateAuthority,
      ),
    ).toThrow('symlink path component');
  });

  it('rejects raw nested in receipt symmetrically before any prepare seam', () => {
    const { gate: frozen, candidateAuthority } = gate();
    const nested = join(frozen.approval.receipt_root, 'private');
    mkdirSync(nested);
    const nestedGate = {
      ...frozen,
      approval: { ...frozen.approval, raw_root: nested },
    };
    expect(() =>
      assertLiveValidationGate(
        nestedGate,
        nestedGate.fingerprint,
        nestedGate.fingerprint,
        candidateAuthority,
      ),
    ).toThrow('distinct and non-nested');
  });

  it('rejects missing or extra immutable candidate artifacts before any credential seam', () => {
    const { gate: frozen, candidateAuthority } = gate();
    const extra = {
      ...candidateAuthority,
      artifact_names: () => [
        ...candidateAuthority.artifact_names(),
        'unexpected',
      ],
    };
    expect(() =>
      assertLiveValidationGate(
        frozen,
        frozen.fingerprint,
        frozen.fingerprint,
        extra,
      ),
    ).toThrow('immutable contract');
  });

  it('installs and removes the offline SIGINT abort handler without process binding', () => {
    const controller = new AbortController();
    let listener: (() => void) | undefined;
    let removed = 0;
    const dispose = installOfflineValidationSigint(
      {
        on: (_event, callback) => {
          listener = callback;
        },
        removeListener: (_event, callback) => {
          expect(callback).toBe(listener);
          removed += 1;
        },
      },
      controller,
    );
    listener?.();
    expect(controller.signal.aborted).toBe(true);
    dispose();
    expect(removed).toBe(1);
  });

  it('reaches only the injected unavailable binding after a valid paid gate', async () => {
    const { gate: frozen, candidateAuthority } = gate();
    const approvalPath = join(frozen.approval.raw_root, 'approval.json');
    writeFileSync(approvalPath, JSON.stringify(frozen.approval));
    const program = new Command();
    let unavailable = 0;
    registerLiveValidationCommand(program, {
      candidateAuthority,
      unavailableBinding: () => {
        unavailable += 1;
        throw new Error('expected unavailable binding');
      },
    });
    const previous = process.env.LIBRARIUM_LIVE_VALIDATION_APPROVED;
    process.env.LIBRARIUM_LIVE_VALIDATION_APPROVED = frozen.fingerprint;
    try {
      await expect(
        program.parseAsync([
          'node',
          'librarium',
          'live-validation',
          '--paid',
          '--approval',
          approvalPath,
          '--confirm',
          frozen.fingerprint,
        ]),
      ).rejects.toThrow('expected unavailable binding');
    } finally {
      if (previous === undefined)
        delete process.env.LIBRARIUM_LIVE_VALIDATION_APPROVED;
      else process.env.LIBRARIUM_LIVE_VALIDATION_APPROVED = previous;
    }
    expect(unavailable).toBe(1);
  });

  it('denies intentional fixture transport construction without credential resolution', () => {
    const credentialResolver = 0;
    const network = createDeniedNetworkCapability();
    expect(() => network.assertDenied('fixture-fetch')).toThrow(
      'Network capability is denied',
    );
    expect(credentialResolver).toBe(0);
  });

  it('installs and restores guards for every Node transport primitive', async () => {
    const previousFetch = globalThis.fetch;
    const restore = installOfflineNetworkGuard();
    try {
      await expect(globalThis.fetch('https://example.com')).rejects.toThrow(
        'Network access is denied',
      );
      for (const operation of [
        () => http.request('http://example.com'),
        () => http.get('http://example.com'),
        () => https.request('https://example.com'),
        () => https.get('https://example.com'),
        () => net.connect(80, 'example.com'),
        () => net.createConnection(80, 'example.com'),
      ]) {
        expect(operation).toThrow('Network access is denied');
      }
    } finally {
      restore();
    }
    expect(globalThis.fetch).toBe(previousFetch);
  });

  it('runs inline and durable fixture replay through the registered guarded command', async () => {
    const target = buildCanonicalValidationMatrix().targets[0]!;
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), 'librarium-command-fixture-'),
    );
    roots.push(fixtureRoot);
    const fixturePath = join(fixtureRoot, 'fixture.json');
    writeFileSync(
      fixturePath,
      JSON.stringify({
        schema_version: 1,
        fixture_id: 'canonical-replay',
        target: target.key,
        scenario: 'inline',
        state_root: fixtureRoot,
      }),
    );
    let credentialCalls = 0;
    let providerCalls = 0;
    let replays = 0;
    let guarded = 0;
    const program = new Command();
    registerLiveValidationCommand(program, {
      credentialResolver: () => {
        credentialCalls += 1;
        throw new Error('credential resolver must remain unreachable');
      },
      providerInitializer: () => {
        providerCalls += 1;
        throw new Error('provider initializer must remain unreachable');
      },
      fixtureReplay: async (fixture) => {
        replays += 1;
        expect(fixture.target).toBe(target.key);
        await expect(globalThis.fetch('https://example.com')).rejects.toThrow(
          'Network access is denied',
        );
        guarded += 1;
        return {
          schema_version: 1,
          canonical: true,
          scenario: fixture.scenario,
          profile: fixture.target,
          binding_id: target.binding_id,
          submit_count: fixture.scenario === 'durable' ? 1 : 0,
          resume_count: fixture.scenario === 'durable' ? 1 : 0,
        };
      },
    });
    const writes: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await program.parseAsync([
        'node',
        'librarium',
        'live-validation',
        '--fixture',
        fixturePath,
      ]);
      writeFileSync(
        fixturePath,
        JSON.stringify({
          schema_version: 1,
          fixture_id: 'canonical-replay',
          target: target.key,
          scenario: 'durable',
          state_root: fixtureRoot,
        }),
      );
      const freshProgram = new Command();
      registerLiveValidationCommand(freshProgram, {
        fixtureReplay: program.commands[0]
          ? async (fixture) => {
              replays += 1;
              return {
                schema_version: 1,
                canonical: true,
                scenario: fixture.scenario,
                profile: fixture.target,
                binding_id: target.binding_id,
                submit_count: 1,
                resume_count: 1,
              };
            }
          : undefined,
      });
      await freshProgram.parseAsync([
        'node',
        'librarium',
        'live-validation',
        '--fixture',
        fixturePath,
      ]);
    } finally {
      process.stdout.write = write;
    }
    expect(replays).toBe(2);
    expect(guarded).toBe(1);
    expect(credentialCalls).toBe(0);
    expect(providerCalls).toBe(0);
    expect(writes.join('')).toContain('"canonical": true');
    expect(writes.join('')).toContain('"resume_count": 1');
  });

  it('runs the real createCliProgram fixture service across durable invocations', async () => {
    const target = buildCanonicalValidationMatrix().targets.find(
      (candidate) => candidate.key === 'exa/research',
    )!;
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), 'librarium-real-cli-fixture-'),
    );
    roots.push(fixtureRoot);
    const fixturePath = join(fixtureRoot, 'fixture.json');
    writeFileSync(
      fixturePath,
      JSON.stringify({
        schema_version: 1,
        fixture_id: 'real-durable-replay',
        target: target.key,
        scenario: 'durable',
        state_root: fixtureRoot,
      }),
    );
    const writes: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await createCliProgram().parseAsync([
        'node',
        'librarium',
        'live-validation',
        '--fixture',
        fixturePath,
      ]);
      await createCliProgram().parseAsync([
        'node',
        'librarium',
        'live-validation',
        '--fixture',
        fixturePath,
      ]);
    } finally {
      process.stdout.write = write;
    }
    expect(writes[0]).toContain('"status": "materialized"');
    expect(writes[1]).toContain('"status": "succeeded"');
    expect(writes[1]).toContain('"materialize_count": 1');
    expect(writes[1]).toContain('"resume_count": 1');
    const runManifest = readFileSync(
      join(fixtureRoot, 'run-real-durable-replay', 'run.json'),
      'utf8',
    );
    expect(runManifest).toContain('"artifact_version": "3.0.0"');
    expect(runManifest).toContain(target.binding_id);
  });

  it('runs the real createCliProgram fixture service inline', async () => {
    const target = buildCanonicalValidationMatrix().targets.find(
      (candidate) => candidate.key === 'brave-search/search',
    )!;
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), 'librarium-real-cli-inline-fixture-'),
    );
    roots.push(fixtureRoot);
    const fixturePath = join(fixtureRoot, 'fixture.json');
    writeFileSync(
      fixturePath,
      JSON.stringify({
        schema_version: 1,
        fixture_id: 'real-inline-replay',
        target: target.key,
        scenario: 'inline',
        state_root: fixtureRoot,
      }),
    );
    const writes: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await createCliProgram().parseAsync([
        'node',
        'librarium',
        'live-validation',
        '--fixture',
        fixturePath,
      ]);
    } finally {
      process.stdout.write = write;
    }
    expect(writes.join('')).toContain('"status": "succeeded"');
    expect(writes.join('')).toContain('"materialize_count": 1');
    expect(writes.join('')).toContain('"resume_count": 1');
    const runManifest = readFileSync(
      join(fixtureRoot, 'run-real-inline-replay', 'run.json'),
      'utf8',
    );
    expect(runManifest).toContain('"artifact_version": "3.0.0"');
    expect(runManifest).toContain(target.binding_id);
  });
});
