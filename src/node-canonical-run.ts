import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod/v4';
import { VERSION } from './constants.js';
import { OpaqueIdSchema, Rfc3339UtcSchema } from './contracts/common.js';
import {
  executionProfilesEqual,
  providerIdentitiesEqual,
  providerIdentityKey,
} from './contracts/domain/index.js';
import type { InterchangeRequest } from './contracts/interchange/request.js';
import { InterchangeRequestSchema } from './contracts/interchange/request.js';
import type { ResearchResponse } from './contracts/interchange/research-response.js';
import { ResearchResponseSchema } from './contracts/interchange/research-response.js';
import type { CoordinatorDependencies } from './core/coordinator.js';
import {
  type CoordinatorState,
  cancelCoordination,
  recordAttemptFinished,
  recordDurableCustodyObservation,
  setRefinedSlotQuery,
} from './core/coordinator.js';
import { CoordinatorStateSchema } from './core/coordinator-state-schema.js';
import type {
  CoordinationCompareAndSwapResult,
  CoordinationStateStore,
  VersionedCoordinationState,
} from './core/coordinator-store.js';
import { updateCoordinationState } from './core/coordinator-store.js';
import type {
  AdapterBindingIdentity,
  PreparedResearchExecution,
} from './core/execution-plan.js';
import type {
  ExecutionRuntimeResult,
  PersistExecutionSuccessInput,
} from './core/execution-runtime.js';
import { runPreparedExecution } from './core/execution-runtime.js';
import { safeWriteFile } from './core/fs-utils.js';
import {
  createProviderAttemptBridge,
  type ProviderAttemptBridgeDependencies,
} from './core/provider-attempt-bridge.js';
import {
  assertResearchResponseProjectableProfile,
  CanonicalProviderOutputSchema,
  normalizeProviderAttemptOutput,
  projectResearchResponse,
  type ResearchResponseProjectionOptions,
} from './core/research-response-projector.js';
import {
  DEFAULT_FS,
  resolveContainedPathWithFs,
  resolveRunDirectoryWithFs,
} from './node-run-artifact-codecs.js';
import { RUN_JSON_FILE, withRunJsonLock } from './node-run-json-lock.js';
import type { Provider } from './types.js';

const CANONICAL_RUN_KIND = 'canonical-research-run' as const;
const CANONICAL_RUN_FORMAT = 'librarium.run-json.v3' as const;

function inspectPrivateExtensions(
  value: unknown,
  path: PropertyKey[],
  ctx: z.RefinementCtx,
  insideExtensions = false,
): void {
  if (insideExtensions && typeof value === 'string') {
    if (
      /(?:bearer\s+[A-Za-z0-9._~+/=-]+|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*\S+)/i.test(
        value,
      ) ||
      /^(?:file:\/\/|\.{1,2}[\\/]|\/(?!\/)|[A-Za-z]:[\\/]|\\\\)/i.test(value)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Private run extensions cannot contain secret material or local filesystem paths',
        path,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      inspectPrivateExtensions(child, [...path, index], ctx, insideExtensions);
    });
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const inExtensions = insideExtensions || key === 'extensions';
    const normalized = key
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .replace(/([a-z\d])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z\d]+/g, '_');
    if (
      inExtensions &&
      /(?:^|_)(?:path|paths|directory|directories|filename|filenames)(?:_|$)/.test(
        normalized,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Private run extensions cannot contain filesystem paths',
        path: [...path, key],
      });
    }
    inspectPrivateExtensions(child, [...path, key], ctx, inExtensions);
  }
}

export const CanonicalRunManifestV3Schema = z
  .strictObject({
    schemaVersion: z.literal(3),
    kind: z.literal(CANONICAL_RUN_KIND),
    format: z.literal(CANONICAL_RUN_FORMAT),
    artifact_name: z.literal('run_manifest'),
    artifact_version: z.literal('3.0.0'),
    generated_at: Rfc3339UtcSchema,
    producer: z.strictObject({
      id: OpaqueIdSchema,
      version: OpaqueIdSchema,
    }),
    revision: z.number().int().safe().positive(),
    request: InterchangeRequestSchema,
    coordination_state: CoordinatorStateSchema,
    provider_outputs_by_attempt: z.record(
      OpaqueIdSchema,
      CanonicalProviderOutputSchema,
    ),
    terminal_response: ResearchResponseSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    const state = manifest.coordination_state;
    inspectPrivateExtensions(manifest.request, ['request'], ctx);
    inspectPrivateExtensions(state, ['coordination_state'], ctx);
    if (
      manifest.request.request_id !== state.request_id ||
      manifest.request.mode !== state.mode ||
      manifest.request.query !== state.original_query
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Canonical request must match its coordinator state',
        path: ['request'],
      });
    }
    const createdAt = Date.parse(state.created_at);
    const requestedAt = Date.parse(manifest.request.requested_at);
    const requestDeadline = Date.parse(state.request_deadline_at);
    const firstLifecycle = state.lifecycle[0];
    const terminalLifecycle = state.lifecycle.at(-1);
    const expectedTerminalKind =
      state.status === 'cancelled'
        ? 'request_cancelled'
        : state.status === 'failed'
          ? 'request_failed'
          : state.status === 'running'
            ? undefined
            : 'request_completed';
    if (createdAt < requestedAt || requestDeadline <= createdAt) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Coordinator creation must follow the request and precede its deadline',
        path: ['coordination_state', 'created_at'],
      });
    }
    state.slots.forEach((slot, index) => {
      const deadline = Date.parse(slot.deadline_at);
      if (deadline < createdAt || deadline > requestDeadline) {
        ctx.addIssue({
          code: 'custom',
          message: 'Slot deadlines must remain inside the request window',
          path: ['coordination_state', 'slots', index, 'deadline_at'],
        });
      }
    });
    state.attempts.forEach((attempt, index) => {
      const queued = Date.parse(attempt.queued_at);
      const started = attempt.started_at
        ? Date.parse(attempt.started_at)
        : undefined;
      const finished = attempt.finished_at
        ? Date.parse(attempt.finished_at)
        : undefined;
      const attemptDeadline = Date.parse(attempt.deadline_at);
      const handleSubmitted = attempt.durable_handle
        ? Date.parse(attempt.durable_handle.submitted_at)
        : undefined;
      const terminalAttempt = [
        'succeeded',
        'failed',
        'timed_out',
        'cancelled',
      ].includes(attempt.status);
      const finishedEvents = state.lifecycle.filter(
        (event) =>
          event.event_kind === 'attempt_finished' &&
          event.attempt_id === attempt.attempt_id,
      );
      if (
        queued < createdAt ||
        attemptDeadline < queued ||
        attemptDeadline > requestDeadline ||
        ((attempt.delivery_lease_id !== undefined ||
          attempt.delivery_lease_expires_at !== undefined) &&
          attempt.status !== 'dispatch_pending') ||
        (attempt.delivery_lease_expires_at !== undefined &&
          (Date.parse(attempt.delivery_lease_expires_at) < queued ||
            Date.parse(attempt.delivery_lease_expires_at) > attemptDeadline)) ||
        (started !== undefined &&
          (started < queued || started > attemptDeadline)) ||
        (finished !== undefined &&
          (finished < (started ?? queued) ||
            (attempt.status !== 'timed_out' && finished > attemptDeadline))) ||
        (started !== undefined &&
          terminalAttempt &&
          (finished === undefined ||
            finishedEvents.length !== 1 ||
            finishedEvents[0]?.occurred_at !== attempt.finished_at)) ||
        (started === undefined &&
          terminalAttempt &&
          (finished === undefined ||
            finishedEvents.length !== 0 ||
            terminalLifecycle?.occurred_at !== attempt.finished_at)) ||
        (handleSubmitted !== undefined &&
          (handleSubmitted < createdAt || handleSubmitted < queued)) ||
        (attempt.durable_handle?.last_observed_at !== undefined &&
          Date.parse(attempt.durable_handle.last_observed_at) <
            Date.parse(attempt.durable_handle.submitted_at))
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Attempt timestamps must follow canonical run chronology',
          path: ['coordination_state', 'attempts', index],
        });
      }
    });
    if (
      firstLifecycle?.occurred_at !== state.created_at ||
      (expectedTerminalKind !== undefined &&
        terminalLifecycle?.event_kind !== expectedTerminalKind) ||
      (expectedTerminalKind !== undefined &&
        Date.parse(terminalLifecycle?.occurred_at ?? '') < createdAt)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Lifecycle start and terminal timestamps must match coordinator chronology',
        path: ['coordination_state', 'lifecycle'],
      });
    }
    if (manifest.request.slots.length !== state.slots.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Canonical request slots must match coordinator slots',
        path: ['coordination_state', 'slots'],
      });
    }
    manifest.request.slots.forEach((requestSlot, index) => {
      const stateSlot = state.slots[index];
      if (
        !stateSlot ||
        requestSlot.slot_id !== stateSlot.slot_id ||
        requestSlot.position !== stateSlot.position ||
        !executionProfilesEqual(requestSlot.primary, stateSlot.primary)
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Coordinator slots must preserve exact requested order and primary profiles',
          path: ['coordination_state', 'slots', index],
        });
      }
    });
    if (manifest.request.fallback_reserve.length !== state.reserve.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Canonical fallback reserve must match coordinator reserve',
        path: ['coordination_state', 'reserve'],
      });
    }
    manifest.request.fallback_reserve.forEach((requestCandidate, index) => {
      const stateCandidate = state.reserve[index];
      if (
        !stateCandidate ||
        requestCandidate.candidate_id !== stateCandidate.candidate_id ||
        requestCandidate.position !== stateCandidate.position ||
        JSON.stringify(requestCandidate.eligible_slot_ids) !==
          JSON.stringify(stateCandidate.eligible_slot_ids) ||
        !executionProfilesEqual(
          requestCandidate.profile,
          stateCandidate.profile,
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Coordinator reserve must preserve exact requested fallback candidates',
          path: ['coordination_state', 'reserve', index],
        });
      }
    });
    const plannedProfileKeys = new Set([
      ...manifest.request.slots.map((slot) =>
        providerIdentityKey(slot.primary.identity),
      ),
      ...manifest.request.fallback_reserve.map((candidate) =>
        providerIdentityKey(candidate.profile.identity),
      ),
    ]);
    for (const [profileKey, plan] of Object.entries(
      state.profile_plans_by_identity,
    )) {
      if (
        profileKey !== plan.profile_key ||
        profileKey !== providerIdentityKey(plan.identity) ||
        !plannedProfileKeys.has(profileKey)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Frozen profile plan identity is incoherent',
          path: ['coordination_state', 'profile_plans_by_identity', profileKey],
        });
      }
    }
    for (const profileKey of plannedProfileKeys) {
      if (!state.profile_plans_by_identity[profileKey]) {
        ctx.addIssue({
          code: 'custom',
          message: 'Every requested profile requires one frozen binding plan',
          path: ['coordination_state', 'profile_plans_by_identity', profileKey],
        });
      }
    }
    [
      ...manifest.request.slots.map((slot) => slot.primary),
      ...manifest.request.fallback_reserve.map(
        (candidate) => candidate.profile,
      ),
    ].forEach((profile, index) => {
      try {
        assertResearchResponseProjectableProfile(profile);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          message:
            error instanceof Error
              ? error.message
              : 'Profile cannot project into ResearchResponse',
          path: ['request', 'profiles', index],
        });
      }
    });
    const attempts = new Map(
      state.attempts.map((attempt) => [attempt.attempt_id, attempt]),
    );
    for (const [attemptId, output] of Object.entries(
      manifest.provider_outputs_by_attempt,
    )) {
      const attempt = attempts.get(attemptId);
      if (!attempt) {
        ctx.addIssue({
          code: 'custom',
          message: 'Provider outputs must reference a persisted attempt',
          path: ['provider_outputs_by_attempt', attemptId],
        });
      } else if (attempt.status !== 'succeeded') {
        ctx.addIssue({
          code: 'custom',
          message: 'Provider outputs may exist only for succeeded attempts',
          path: ['provider_outputs_by_attempt', attemptId],
        });
      } else if (attempt.result_id !== output.result_id) {
        ctx.addIssue({
          code: 'custom',
          message: 'Provider output result_id must match its attempt',
          path: ['provider_outputs_by_attempt', attemptId, 'result_id'],
        });
      }
    }
    state.attempts.forEach((attempt, index) => {
      const slot = state.slots.find(
        (candidate) => candidate.slot_id === attempt.slot_id,
      );
      const candidate = attempt.candidate_id
        ? state.reserve.find(
            (entry) => entry.candidate_id === attempt.candidate_id,
          )
        : undefined;
      if (attempt.attempt_number === 1) {
        if (
          !slot ||
          attempt.candidate_id ||
          attempt.replaces_attempt_id ||
          !executionProfilesEqual(attempt.profile, slot.primary)
        ) {
          ctx.addIssue({
            code: 'custom',
            message:
              'First attempts must execute their exact requested primary',
            path: ['coordination_state', 'attempts', index],
          });
        }
      } else if (
        !slot ||
        !candidate?.eligible_slot_ids.includes(slot.slot_id) ||
        !executionProfilesEqual(attempt.profile, candidate.profile) ||
        !attempt.replaces_attempt_id
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Replacement attempts must use an eligible exact fallback candidate',
          path: ['coordination_state', 'attempts', index],
        });
      }
      if (
        attempt.durable_handle &&
        !providerIdentitiesEqual(
          attempt.durable_handle.provider,
          attempt.profile.identity,
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Durable handle provider must match attempt profile',
          path: ['coordination_state', 'attempts', index, 'durable_handle'],
        });
      }
    });
    state.attempts.forEach((attempt, index) => {
      if (
        attempt.status === 'succeeded' &&
        !manifest.provider_outputs_by_attempt[attempt.attempt_id]
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Succeeded attempts require a durable provider output in run.json',
          path: ['coordination_state', 'attempts', index, 'result_id'],
        });
      }
    });
    if (manifest.terminal_response) {
      if (
        manifest.terminal_response.generator !== manifest.producer.id ||
        manifest.terminal_response.generator_version !==
          manifest.producer.version
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Terminal response producer must match the run manifest',
          path: ['terminal_response', 'generator'],
        });
      }
      if (
        Date.parse(manifest.terminal_response.completed_at) < createdAt ||
        Date.parse(manifest.terminal_response.completed_at) <
          Date.parse(manifest.generated_at)
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Terminal response completion must follow run generation and creation',
          path: ['terminal_response', 'completed_at'],
        });
      }
      if (state.status === 'running') {
        ctx.addIssue({
          code: 'custom',
          message: 'A running coordinator cannot have a terminal response',
          path: ['terminal_response'],
        });
      } else {
        try {
          const expected = projectResearchResponse(
            state as CoordinatorState,
            manifest.provider_outputs_by_attempt,
            {
              generator: manifest.terminal_response.generator,
              generator_version: manifest.terminal_response.generator_version,
            },
          );
          if (
            canonicalJson(expected) !==
            canonicalJson(manifest.terminal_response)
          ) {
            ctx.addIssue({
              code: 'custom',
              message:
                'Terminal response must be the deterministic coordinator projection',
              path: ['terminal_response'],
            });
          }
        } catch (error) {
          ctx.addIssue({
            code: 'custom',
            message:
              error instanceof Error
                ? error.message
                : 'Terminal response cannot be projected',
            path: ['terminal_response'],
          });
        }
      }
    }
  });

export type CanonicalRunManifestV3 = z.infer<
  typeof CanonicalRunManifestV3Schema
>;

export class CanonicalRunManifestError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message}: ${path}`);
    this.name = 'CanonicalRunManifestError';
  }
}

export interface RunJsonCoordinationStateStoreOptions {
  /** Existing root under which the run directory must remain. */
  readonly runs_root: string;
  /** Existing directory which owns exactly one run.json. */
  readonly run_directory: string;
  /** Required only when create() will initialize a new run. */
  readonly request?: InterchangeRequest;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function containedRunDirectory(runsRoot: string, runDirectory: string): string {
  const resolved = resolveRunDirectoryWithFs(
    DEFAULT_FS,
    resolve(runsRoot),
    resolve(runDirectory),
  );
  if (resolved) return resolved;
  throw new CanonicalRunManifestError(
    'Run directory path is not contained by its runs root',
    resolve(runDirectory),
  );
}

function parseManifest(path: string): CanonicalRunManifestV3 {
  if (!existsSync(path)) {
    throw new CanonicalRunManifestError(
      'Canonical run manifest does not exist',
      path,
    );
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new CanonicalRunManifestError(
      'Canonical run manifest must be a regular file',
      path,
    );
  }
  try {
    return CanonicalRunManifestV3Schema.parse(
      JSON.parse(readFileSync(path, 'utf8')),
    );
  } catch (error) {
    throw new CanonicalRunManifestError(
      `Canonical run manifest is invalid (${error instanceof Error ? error.message : String(error)})`,
      path,
    );
  }
}

/** Read only the schema discriminator through the canonical containment gate. */
export function readRunJsonSchemaVersion(
  runsRoot: string,
  runDirectory: string,
): number | undefined {
  const directory = containedRunDirectory(runsRoot, runDirectory);
  const path = resolveContainedPathWithFs(DEFAULT_FS, directory, RUN_JSON_FILE);
  if (!existsSync(path)) return undefined;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new CanonicalRunManifestError(
      'Run manifest must be a regular file',
      path,
    );
  }
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CanonicalRunManifestError('Run manifest is not an object', path);
  }
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  return typeof schemaVersion === 'number' ? schemaVersion : undefined;
}

export function readCanonicalRunManifest(
  runsRoot: string,
  runDirectory: string,
): CanonicalRunManifestV3 {
  return new RunJsonCoordinationStateStore({
    runs_root: runsRoot,
    run_directory: runDirectory,
  }).readManifest();
}

export function discoverCanonicalRunDirectories(
  runsRoot: string,
  limit = 20,
): readonly string[] {
  let root: string;
  try {
    root = DEFAULT_FS.realpathSync(resolve(runsRoot));
  } catch {
    return [];
  }
  const discovered = readdirSync(root)
    .flatMap((name) => {
      const runDirectory = resolve(root, name);
      try {
        return readRunJsonSchemaVersion(root, runDirectory) === 3
          ? [
              {
                runDirectory,
                generatedAt: readCanonicalRunManifest(root, runDirectory)
                  .generated_at,
              },
            ]
          : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
  return discovered
    .slice(0, Math.max(0, limit))
    .map(({ runDirectory }) => runDirectory);
}

export function canonicalRunsRoot(runDirectory: string): string {
  return dirname(resolve(runDirectory));
}

export interface CancelCanonicalRunDependencies {
  readonly runs_root: string;
  readonly run_directory: string;
  readonly coordinator: CoordinatorDependencies;
  /** Exact frozen bridge used for best-effort provider-side cancellation. */
  readonly attempt_bridge?: ProviderAttemptBridgeDependencies;
  readonly max_compare_and_swap_attempts?: number;
}

/** Persist caller cancellation in the sole v3 run.json authority. */
export async function cancelCanonicalRun(
  dependencies: CancelCanonicalRunDependencies,
): Promise<CanonicalRunManifestV3> {
  const store = new RunJsonCoordinationStateStore({
    runs_root: dependencies.runs_root,
    run_directory: dependencies.run_directory,
  });
  const current = store.readManifest();
  if (current.coordination_state.status !== 'running') return current;
  const cancellationObservations = new Map<
    string,
    Parameters<typeof recordDurableCustodyObservation>[2]
  >();
  if (dependencies.attempt_bridge) {
    const bridge = createProviderAttemptBridge(dependencies.attempt_bridge);
    for (const attempt of current.coordination_state.attempts) {
      const handle = attempt.durable_handle;
      if (
        !handle ||
        !['pending', 'running'].includes(handle.status) ||
        !bridge.cancel
      ) {
        continue;
      }
      const plan =
        current.coordination_state.profile_plans_by_identity[
          providerIdentityKey(attempt.profile.identity)
        ];
      if (!plan) continue;
      try {
        const observed = await bridge.cancel(
          {
            attempt_id: attempt.attempt_id,
            slot_id: attempt.slot_id,
            profile: attempt.profile,
            binding: plan.binding,
            catalog_digest: current.coordination_state.catalog_digest,
            query: attempt.query,
            deadline_at: attempt.deadline_at,
            delivery_lease_id: 'durable-cancel',
            idempotency_key: `${current.request.request_id}:${attempt.attempt_id}`,
          },
          handle,
        );
        if (observed) {
          cancellationObservations.set(attempt.attempt_id, observed);
        }
      } catch {
        // Local cancellation still commits. The unchanged durable handle keeps
        // possible remote custody visible for later reconciliation.
      }
    }
  }
  await updateCoordinationState(
    store,
    current.request.request_id,
    (state) => {
      // Completion may win while provider cancellation is in flight. Never
      // replace that terminal outcome with a later local cancellation.
      if (state.status !== 'running') return undefined;
      let next = state;
      for (const [attemptId, handle] of cancellationObservations) {
        const attempt = next.attempts.find(
          (candidate) => candidate.attempt_id === attemptId,
        );
        if (
          !attempt?.durable_handle ||
          !['submitted', 'running'].includes(attempt.status) ||
          !['pending', 'running'].includes(attempt.durable_handle.status)
        ) {
          continue;
        }
        try {
          next = recordDurableCustodyObservation(next, attemptId, handle);
        } catch {
          // A stale or mismatched observation cannot block local cancellation.
        }
      }
      return cancelCoordination(next, dependencies.coordinator);
    },
    dependencies.max_compare_and_swap_attempts,
  );
  store.persistTerminalResponse({
    generator: current.producer.id,
    generator_version: current.producer.version,
  });
  return store.readManifest();
}

function writeManifest(
  path: string,
  manifest: CanonicalRunManifestV3,
): CanonicalRunManifestV3 {
  const parsed = CanonicalRunManifestV3Schema.parse(manifest);
  safeWriteFile(path, JSON.stringify(parsed, null, 2), { mode: 0o600 });
  return parsed;
}

function versioned(
  manifest: CanonicalRunManifestV3,
): VersionedCoordinationState {
  return {
    version: manifest.revision,
    state: structuredClone(manifest.coordination_state) as CoordinatorState,
  };
}

function persistedState(
  state: CoordinatorState,
): CanonicalRunManifestV3['coordination_state'] {
  return CoordinatorStateSchema.parse(structuredClone(state));
}

/**
 * Node filesystem CAS store. All coordinator facts, staged safe outputs, and
 * the final public projection share one atomic run.json revision.
 */
export class RunJsonCoordinationStateStore implements CoordinationStateStore {
  readonly #runsRoot: string;
  readonly #runDirectory: string;
  readonly #request?: InterchangeRequest;

  constructor(options: RunJsonCoordinationStateStoreOptions) {
    const runDirectory = containedRunDirectory(
      options.runs_root,
      options.run_directory,
    );
    this.#runsRoot = DEFAULT_FS.realpathSync(resolve(options.runs_root));
    this.#runDirectory = runDirectory;
    this.#request = options.request
      ? InterchangeRequestSchema.parse(structuredClone(options.request))
      : undefined;
  }

  get manifest_path(): string {
    return resolveContainedPathWithFs(
      DEFAULT_FS,
      containedRunDirectory(this.#runsRoot, this.#runDirectory),
      RUN_JSON_FILE,
    );
  }

  readManifest(): CanonicalRunManifestV3 {
    return deepFreeze(structuredClone(parseManifest(this.manifest_path)));
  }

  async load(
    requestId: string,
  ): Promise<VersionedCoordinationState | undefined> {
    const manifestPath = this.manifest_path;
    if (!existsSync(manifestPath)) return undefined;
    const manifest = parseManifest(manifestPath);
    return manifest.request.request_id === requestId
      ? versioned(manifest)
      : undefined;
  }

  async create(state: CoordinatorState): Promise<VersionedCoordinationState> {
    const request = this.#request;
    if (!request) {
      throw new CanonicalRunManifestError(
        'A canonical request is required to create a run',
        this.manifest_path,
      );
    }
    const manifestPath = this.manifest_path;
    const created = withRunJsonLock(manifestPath, () => {
      if (existsSync(manifestPath)) {
        throw new CanonicalRunManifestError(
          'Refusing to overwrite an existing canonical run manifest',
          manifestPath,
        );
      }
      return writeManifest(manifestPath, {
        schemaVersion: 3,
        kind: CANONICAL_RUN_KIND,
        format: CANONICAL_RUN_FORMAT,
        artifact_name: 'run_manifest',
        artifact_version: '3.0.0',
        generated_at: state.created_at,
        producer: { id: 'jkudish/librarium', version: VERSION },
        revision: 1,
        request: structuredClone(request),
        coordination_state: persistedState(state),
        provider_outputs_by_attempt: {},
      });
    });
    return versioned(created);
  }

  async compareAndSwap(
    requestId: string,
    expectedVersion: number,
    state: CoordinatorState,
  ): Promise<CoordinationCompareAndSwapResult> {
    if (state.request_id !== requestId) {
      throw new Error('Coordination state request id cannot change.');
    }
    const manifestPath = this.manifest_path;
    return withRunJsonLock(manifestPath, () => {
      const current = parseManifest(manifestPath);
      if (
        current.request.request_id !== requestId ||
        current.revision !== expectedVersion
      ) {
        return {
          ok: false as const,
          current:
            current.request.request_id === requestId
              ? versioned(current)
              : undefined,
        };
      }
      if (current.terminal_response) {
        throw new CanonicalRunManifestError(
          'A terminal canonical run is immutable outside custody observation',
          manifestPath,
        );
      }
      const next = writeManifest(manifestPath, {
        ...current,
        revision: current.revision + 1,
        coordination_state: persistedState(state),
      });
      return { ok: true as const, value: versioned(next) };
    });
  }

  async persistSuccess(
    input: PersistExecutionSuccessInput,
  ): Promise<VersionedCoordinationState> {
    for (
      let casAttempt = 0;
      casAttempt < input.max_compare_and_swap_attempts;
      casAttempt += 1
    ) {
      const manifestPath = this.manifest_path;
      const current = parseManifest(manifestPath);
      if (current.request.request_id !== input.request_id) {
        throw new CanonicalRunManifestError(
          'Successful attempt belongs to a different canonical request',
          manifestPath,
        );
      }
      const attempt = current.coordination_state.attempts.find(
        (candidate) => candidate.attempt_id === input.attempt_id,
      );
      if (!attempt) {
        throw new CanonicalRunManifestError(
          `Cannot persist success for unknown attempt ${input.attempt_id}`,
          manifestPath,
        );
      }
      if (
        attempt.status === 'succeeded' &&
        attempt.result_id === input.finished.result_id
      ) {
        const output = current.provider_outputs_by_attempt[input.attempt_id];
        if (!output) {
          throw new CanonicalRunManifestError(
            'Succeeded attempt has no atomically committed provider output',
            manifestPath,
          );
        }
        return versioned(current);
      }
      if (!['submitting', 'submitted', 'running'].includes(attempt.status)) {
        throw new CanonicalRunManifestError(
          `Attempt ${input.attempt_id} cannot commit success from ${attempt.status}`,
          manifestPath,
        );
      }
      const completedAt = new Date(input.coordinator.clock.now()).toISOString();
      const launch = {
        attempt_id: attempt.attempt_id,
        slot_id: attempt.slot_id,
        profile: attempt.profile,
        binding:
          current.coordination_state.profile_plans_by_identity[
            providerIdentityKey(attempt.profile.identity)
          ]?.binding ??
          (() => {
            throw new Error('Missing frozen attempt binding.');
          })(),
        catalog_digest: current.coordination_state.catalog_digest,
        query: attempt.query,
        deadline_at: attempt.deadline_at,
        delivery_lease_id: attempt.delivery_lease_id ?? '',
        idempotency_key: `${current.request.request_id}:${attempt.attempt_id}`,
      };
      let output:
        | CanonicalRunManifestV3['provider_outputs_by_attempt'][string]
        | undefined;
      let nextState: CoordinatorState;
      try {
        output = normalizeProviderAttemptOutput(
          launch,
          input.finished.result_id,
          input.output,
          completedAt,
        );
        nextState = recordAttemptFinished(
          current.coordination_state as CoordinatorState,
          input.attempt_id,
          input.finished,
          input.coordinator,
        );
      } catch {
        nextState = recordAttemptFinished(
          current.coordination_state as CoordinatorState,
          input.attempt_id,
          {
            outcome: 'failed',
            error: {
              code: 'provider_result_invalid',
              message:
                'The provider result could not be normalized into the canonical terminal contract.',
              category: 'provider',
              retryable: false,
              fallback_allowed: false,
            },
            ...(input.finished.durable_handle && {
              durable_handle: input.finished.durable_handle,
            }),
          },
          input.coordinator,
        );
      }
      const swapped = withRunJsonLock(manifestPath, () => {
        const latestPath = this.manifest_path;
        if (latestPath !== manifestPath) {
          throw new CanonicalRunManifestError(
            'Run directory changed during canonical mutation',
            manifestPath,
          );
        }
        const latest = parseManifest(latestPath);
        if (latest.revision !== current.revision) return undefined;
        if (latest.terminal_response) {
          throw new CanonicalRunManifestError(
            'A terminal canonical run is immutable',
            latestPath,
          );
        }
        return writeManifest(latestPath, {
          ...latest,
          revision: latest.revision + 1,
          coordination_state: persistedState(nextState),
          provider_outputs_by_attempt: output
            ? {
                ...latest.provider_outputs_by_attempt,
                [input.attempt_id]: output,
              }
            : latest.provider_outputs_by_attempt,
        });
      });
      if (swapped) return versioned(swapped);
    }
    throw new CanonicalRunManifestError(
      'Successful attempt exceeded its compare-and-swap budget',
      this.manifest_path,
    );
  }

  async persistCustodyObservation(
    requestId: string,
    attemptId: string,
    handle: Parameters<typeof recordDurableCustodyObservation>[2],
  ): Promise<VersionedCoordinationState> {
    const manifestPath = this.manifest_path;
    return withRunJsonLock(manifestPath, () => {
      const current = parseManifest(manifestPath);
      if (current.request.request_id !== requestId) {
        throw new CanonicalRunManifestError(
          'Custody observation belongs to a different request',
          manifestPath,
        );
      }
      const nextState = recordDurableCustodyObservation(
        current.coordination_state as CoordinatorState,
        attemptId,
        handle,
      );
      const next = writeManifest(manifestPath, {
        ...current,
        revision: current.revision + 1,
        coordination_state: persistedState(nextState),
      });
      return versioned(next);
    });
  }

  persistTerminalResponse(
    options: ResearchResponseProjectionOptions,
  ): ResearchResponse {
    const manifestPath = this.manifest_path;
    return withRunJsonLock(manifestPath, () => {
      const current = parseManifest(manifestPath);
      if (
        options.generator !== current.producer.id ||
        options.generator_version !== current.producer.version
      ) {
        throw new CanonicalRunManifestError(
          'Terminal response producer must match the run manifest producer',
          manifestPath,
        );
      }
      const response = projectResearchResponse(
        current.coordination_state as CoordinatorState,
        current.provider_outputs_by_attempt,
        options,
      );
      if (current.terminal_response) {
        if (
          canonicalJson(current.terminal_response) !== canonicalJson(response)
        ) {
          throw new CanonicalRunManifestError(
            'Stored terminal response does not match its canonical projection',
            manifestPath,
          );
        }
        return current.terminal_response;
      }
      writeManifest(manifestPath, {
        ...current,
        revision: current.revision + 1,
        terminal_response: response,
      });
      return response;
    });
  }
}

export interface RunCanonicalPreparedExecutionDependencies {
  readonly runs_root: string;
  readonly run_directory: string;
  readonly coordinator: Parameters<
    typeof runPreparedExecution
  >[1]['coordinator'];
  readonly attempt_bridge: ProviderAttemptBridgeDependencies;
  /** Optional one-shot refinements, applied before the first launch only. */
  readonly refined_queries_by_slot?: Readonly<Record<string, string>>;
  /** CLI cancellation latch, checked before the first authoritative write. */
  readonly is_cancelled?: () => boolean;
  /** Called only after run.json has been created successfully. */
  readonly on_state_created?: () => void;
  readonly max_compare_and_swap_attempts?: number;
  readonly projection?: ResearchResponseProjectionOptions;
}

/** Production coordinator dependencies with bounded, collision-resistant ids. */
export function createNodeCoordinatorDependencies(
  now: () => number = Date.now,
): CoordinatorDependencies {
  return {
    clock: { now },
    ids: {
      next(scope) {
        return `${scope}-${randomUUID()}`;
      },
    },
  };
}

interface FrozenBindingSource {
  readonly catalog: { readonly digest: string };
  readonly request: PreparedResearchExecution['request'];
  readonly profile_plans_by_identity: PreparedResearchExecution['profile_plans_by_identity'];
}

/** Bind the runtime only to exact adapters admitted in the frozen plan. */
export function createRegisteredProviderAttemptBridge(
  source: FrozenBindingSource,
  resolveProvider: (adapterId: string) => Provider | undefined,
  now?: () => number,
): ProviderAttemptBridgeDependencies {
  const byBinding = new Map<
    string,
    {
      readonly binding: AdapterBindingIdentity;
      readonly profile: PreparedResearchExecution['request']['slots'][number]['primary'];
    }
  >();
  const profiles = [
    ...source.request.slots.map((slot) => slot.primary),
    ...source.request.fallback_reserve.map((candidate) => candidate.profile),
  ];
  for (const plan of Object.values(source.profile_plans_by_identity)) {
    const profile = profiles.find((candidate) =>
      providerIdentitiesEqual(candidate.identity, plan.identity),
    );
    if (!profile) {
      throw new Error('A frozen adapter binding is missing its exact profile.');
    }
    const key = `${plan.binding.adapter_id}\u0000${plan.binding.binding_id}`;
    const existing = byBinding.get(key);
    if (existing && !executionProfilesEqual(existing.profile, profile)) {
      throw new Error(
        'One frozen adapter binding cannot identify two profiles.',
      );
    }
    byBinding.set(key, { binding: plan.binding, profile });
  }
  return {
    ...(now && { now }),
    resolveExactBinding(binding) {
      const resolved = byBinding.get(
        `${binding.adapter_id}\u0000${binding.binding_id}`,
      );
      if (!resolved) return undefined;
      const provider = resolveProvider(binding.adapter_id);
      if (!provider || provider.id !== binding.adapter_id) return undefined;
      return {
        binding: resolved.binding,
        profile: resolved.profile,
        catalog_digest: source.catalog.digest,
        provider,
      };
    },
  };
}

export interface CanonicalPreparedExecutionResult {
  readonly runtime: ExecutionRuntimeResult;
  readonly manifest: CanonicalRunManifestV3;
  readonly response?: ResearchResponse;
}

/**
 * Node application seam shared by CLI and MCP. It binds only the exact frozen
 * adapter bridge, stages safe output before coordinator success, and commits
 * a terminal projection to the same run.json.
 */
export async function runCanonicalPreparedExecution(
  prepared: PreparedResearchExecution,
  dependencies: RunCanonicalPreparedExecutionDependencies,
): Promise<CanonicalPreparedExecutionResult> {
  for (const slot of prepared.request.slots) {
    assertResearchResponseProjectableProfile(slot.primary);
  }
  for (const candidate of prepared.request.fallback_reserve) {
    assertResearchResponseProjectableProfile(candidate.profile);
  }
  if (
    prepared.request.slots.some(
      (entry) => entry.primary.resumability === 'process_local',
    ) ||
    prepared.request.fallback_reserve.some(
      (entry) => entry.profile.resumability === 'process_local',
    )
  ) {
    throw new Error(
      'Canonical run.json execution requires inline or durably resumable profiles; process_local background profiles are not supported.',
    );
  }
  const store = new RunJsonCoordinationStateStore({
    runs_root: dependencies.runs_root,
    run_directory: dependencies.run_directory,
    request: prepared.request,
  });
  const refinedEntries = Object.entries(
    dependencies.refined_queries_by_slot ?? {},
  );
  const executionStore: CoordinationStateStore = {
    load: (requestId) => store.load(requestId),
    compareAndSwap: (requestId, expectedVersion, state) =>
      store.compareAndSwap(requestId, expectedVersion, state),
    async create(state) {
      if (dependencies.is_cancelled?.()) {
        throw new Error('Canonical run cancelled before persistence.');
      }
      let refinedState = state;
      for (const [slotId, query] of refinedEntries) {
        refinedState = setRefinedSlotQuery(refinedState, slotId, query);
      }
      const created = await store.create(refinedState);
      dependencies.on_state_created?.();
      return created;
    },
  };
  const bridge = createProviderAttemptBridge(dependencies.attempt_bridge);
  const runtime = await runPreparedExecution(prepared, {
    store: executionStore,
    coordinator: dependencies.coordinator,
    attempts: {
      async execute(launch, context) {
        return bridge.execute(launch, context);
      },
      resume(launch, handle, context) {
        if (!bridge.resume) {
          throw new Error('The exact provider bridge cannot resume this run.');
        }
        return bridge.resume(launch, handle, context);
      },
    },
    persist_success: (input) => store.persistSuccess(input),
    max_compare_and_swap_attempts: dependencies.max_compare_and_swap_attempts,
  });
  const response =
    runtime.state.status === 'running'
      ? undefined
      : store.persistTerminalResponse(
          dependencies.projection ?? {
            generator: 'jkudish/librarium',
            generator_version: VERSION,
          },
        );
  return {
    runtime,
    manifest: store.readManifest(),
    ...(response && { response }),
  };
}

/**
 * Persist the initial canonical v3 run.json without advancing its coordinator
 * or invoking an attempt bridge. A later resume performs the first dispatch.
 */
export async function materializeCanonicalPreparedExecution(
  prepared: PreparedResearchExecution,
  dependencies: Omit<
    RunCanonicalPreparedExecutionDependencies,
    'attempt_bridge'
  >,
): Promise<CanonicalPreparedExecutionResult> {
  const store = new RunJsonCoordinationStateStore({
    runs_root: dependencies.runs_root,
    run_directory: dependencies.run_directory,
    request: prepared.request,
  });
  const runtime = await runPreparedExecution(prepared, {
    store,
    coordinator: dependencies.coordinator,
    attempts: {
      execute: async () => {
        throw new Error('Materialization cannot dispatch an attempt.');
      },
    },
    materialize_only: true,
    max_compare_and_swap_attempts: dependencies.max_compare_and_swap_attempts,
  });
  return { runtime, manifest: store.readManifest() };
}

export interface ResumeCanonicalPreparedExecutionDependencies
  extends Omit<RunCanonicalPreparedExecutionDependencies, 'projection'> {
  readonly projection?: ResearchResponseProjectionOptions;
}

function preparedFromManifest(
  manifest: CanonicalRunManifestV3,
): PreparedResearchExecution {
  const state = manifest.coordination_state;
  return {
    request: structuredClone(manifest.request),
    policy: {
      limits: {
        max_concurrency: state.max_concurrency,
        request_deadline_ms:
          Date.parse(state.request_deadline_at) - Date.parse(state.created_at),
        inline_attempt_deadline_ms: state.inline_attempt_deadline_ms,
        background_attempt_deadline_ms: state.background_attempt_deadline_ms,
        poll_interval_ms: state.poll_interval_ms,
      },
      ...(state.budget.max_estimated_cost_microusd !== undefined ||
      state.budget.max_actual_cost_microusd !== undefined
        ? {
            budgets: {
              ...(state.budget.max_estimated_cost_microusd !== undefined && {
                max_estimated_cost_microusd:
                  state.budget.max_estimated_cost_microusd,
              }),
              ...(state.budget.max_actual_cost_microusd !== undefined && {
                max_actual_cost_microusd: state.budget.max_actual_cost_microusd,
              }),
            },
          }
        : {}),
      fallback: { kind: 'disabled' },
      exclusions: [],
      refinement: { kind: 'disabled' },
    },
    profile_plans_by_identity: structuredClone(state.profile_plans_by_identity),
    catalog: {
      revision: state.catalog_revision,
      digest: state.catalog_digest,
    },
    notices: [],
  };
}

/** Resume an existing v3 run using only persisted state and exact bindings. */
export async function resumeCanonicalPreparedExecution(
  dependencies: ResumeCanonicalPreparedExecutionDependencies,
): Promise<CanonicalPreparedExecutionResult> {
  const store = new RunJsonCoordinationStateStore({
    runs_root: dependencies.runs_root,
    run_directory: dependencies.run_directory,
  });
  const manifest = store.readManifest();
  const hasRemoteCustody = manifest.coordination_state.attempts.some(
    (attempt) =>
      attempt.durable_handle &&
      !['failed', 'cancelled', 'succeeded'].includes(
        attempt.durable_handle.status,
      ),
  );
  if (manifest.terminal_response && !hasRemoteCustody) {
    return {
      runtime: {
        state: structuredClone(manifest.coordination_state) as CoordinatorState,
        outputs_by_attempt: Object.freeze({}),
      },
      manifest,
      response: manifest.terminal_response,
    };
  }
  const custodyMode =
    manifest.coordination_state.status !== 'running' && hasRemoteCustody;
  const bridge = createProviderAttemptBridge(dependencies.attempt_bridge);
  const runtime = await runPreparedExecution(preparedFromManifest(manifest), {
    store,
    coordinator: dependencies.coordinator,
    attempts: {
      execute(launch, context) {
        return bridge.execute(launch, context);
      },
      resume(launch, handle, context) {
        if (!bridge.resume) {
          throw new Error('The exact provider bridge cannot resume this run.');
        }
        return bridge.resume(launch, handle, context);
      },
    },
    resume_existing: true,
    reconcile_terminal_custody: custodyMode,
    persist_custody_observation: (requestId, attemptId, handle) =>
      store.persistCustodyObservation(requestId, attemptId, handle),
    persist_success: (input) => store.persistSuccess(input),
    max_compare_and_swap_attempts: dependencies.max_compare_and_swap_attempts,
  });
  const response =
    manifest.terminal_response ??
    (runtime.state.status === 'running'
      ? undefined
      : store.persistTerminalResponse(
          dependencies.projection ?? {
            generator: 'jkudish/librarium',
            generator_version: VERSION,
          },
        ));
  return {
    runtime,
    manifest: store.readManifest(),
    ...(response && { response }),
  };
}
