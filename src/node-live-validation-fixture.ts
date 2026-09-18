/** Credential-free canonical v3 fixture replay used by the normal Node CLI. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { LiveValidationFixtureReplay } from './commands/live-validation.js';
import type { PreparedResearchExecution } from './core/execution-plan.js';
import { profileIdentityKey } from './core/execution-plan.js';
import {
  BUILTIN_PROVIDER_CATALOG,
  declaredExecutionProfile,
} from './core/provider-profiles.js';
import {
  createNodeCoordinatorDependencies,
  materializeCanonicalPreparedExecution,
  resumeCanonicalPreparedExecution,
} from './node-canonical-run.js';
import {
  buildCanonicalValidationMatrix,
  CanonicalLiveValidationError,
} from './node-live-validation.js';
import type { Provider } from './types.js';

interface FixtureState {
  readonly schema_version: 1;
  readonly request_id: string;
  readonly run_directory: string;
  readonly materialize_count: number;
  readonly resume_count: number;
  readonly submit_count: number;
  readonly poll_count: number;
  readonly retrieve_count: number;
}

function stateFile(root: string, id: string): string {
  if (!isAbsolute(root)) {
    throw new CanonicalLiveValidationError(
      'Fixture state root must be absolute.',
    );
  }
  const resolved = resolve(root);
  if (
    lstatSync(resolved).isSymbolicLink() ||
    !lstatSync(resolved).isDirectory()
  ) {
    throw new CanonicalLiveValidationError(
      'Fixture state root must be a non-symlink directory.',
    );
  }
  return join(resolved, `${id}.fixture-state.json`);
}

/** Execute only deterministic fake providers through the real canonical runtime. */
export async function replayCanonicalLiveValidationFixture(
  fixture: LiveValidationFixtureReplay,
): Promise<Readonly<Record<string, unknown>>> {
  const matrix = buildCanonicalValidationMatrix();
  const target = matrix.targets.find(
    (candidate) => candidate.key === fixture.target,
  );
  if (!target)
    throw new CanonicalLiveValidationError('Fixture target is not canonical.');
  const entry = BUILTIN_PROVIDER_CATALOG.find(
    (candidate) =>
      candidate.provider_id === target.requested_identity.provider_id,
  );
  const declaration = entry?.profiles.find(
    (candidate) =>
      candidate.profile_id === target.requested_identity.profile_id,
  );
  if (!entry || !declaration)
    throw new CanonicalLiveValidationError('Fixture profile is missing.');
  const profile = declaredExecutionProfile(entry.provider_id, declaration);
  const requestId = `fixture-${fixture.fixture_id}`;
  const runDirectory = join(
    resolve(fixture.state_root),
    `run-${fixture.fixture_id}`,
  );
  const statePath = stateFile(fixture.state_root, fixture.fixture_id);
  const prepared = {
    request: {
      interchange_version: '1.0.0',
      message_type: 'request',
      request_id: requestId,
      requested_at: '2026-08-13T00:00:00.000Z',
      mode: 'sync',
      query: 'offline fixture query',
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
  let state = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, 'utf8')) as FixtureState)
    : undefined;
  const persist = (patch: Partial<FixtureState>): void => {
    if (!state) return;
    state = { ...state, ...patch };
    writeFileSync(statePath, JSON.stringify(state));
  };
  const inlineProvider: Provider = {
    id: target.adapter_id,
    displayName: 'Offline fixture',
    tier: 'ai-grounded',
    envVar: '',
    execution: 'inline',
    execute: async () => ({
      provider: target.adapter_id,
      tier: 'ai-grounded',
      content: 'offline canonical fixture output',
      citations: [
        {
          provider: target.adapter_id,
          url: 'https://example.com/fixture',
          title: 'Fixture',
        },
      ],
      durationMs: 1,
    }),
  };
  const durableProvider: Provider = {
    id: target.adapter_id,
    displayName: 'Offline durable fixture',
    tier: 'deep-research',
    envVar: '',
    execution: 'background',
    execute: async () => {
      throw new CanonicalLiveValidationError(
        'Durable fixture must use submit/poll/retrieve.',
      );
    },
    submit: async (query) => {
      persist({ submit_count: (state?.submit_count ?? 0) + 1 });
      return {
        provider: target.adapter_id,
        taskId: `task-${fixture.fixture_id}`,
        query,
        submittedAt: Date.parse('2026-08-13T00:00:01.000Z'),
        status: 'running',
      };
    },
    poll: async () => {
      persist({ poll_count: (state?.poll_count ?? 0) + 1 });
      return { status: 'completed', progress: 100 };
    },
    retrieve: async () => {
      persist({ retrieve_count: (state?.retrieve_count ?? 0) + 1 });
      return {
        provider: target.adapter_id,
        tier: 'deep-research',
        content: 'offline durable canonical fixture output',
        citations: [
          {
            provider: target.adapter_id,
            url: 'https://example.com/fixture',
            title: 'Fixture',
          },
        ],
        durationMs: 1,
      };
    },
  };
  const provider =
    fixture.scenario === 'durable' ? durableProvider : inlineProvider;
  const dependencies = {
    runs_root: resolve(fixture.state_root),
    run_directory: runDirectory,
    coordinator: createNodeCoordinatorDependencies(() =>
      Date.parse('2026-08-13T00:00:01.000Z'),
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
      now: () => Date.parse('2026-08-13T00:00:01.000Z'),
      wait: async () => {},
    },
  };
  if (!existsSync(statePath)) {
    mkdirSync(runDirectory);
    await materializeCanonicalPreparedExecution(prepared, dependencies);
    const initial: FixtureState = {
      schema_version: 1,
      request_id: requestId,
      run_directory: runDirectory,
      materialize_count: 1,
      resume_count: 0,
      submit_count: 0,
      poll_count: 0,
      retrieve_count: 0,
    };
    state = initial;
    writeFileSync(statePath, JSON.stringify(initial));
    if (fixture.scenario === 'durable') {
      return {
        status: 'materialized',
        profile: target.key,
        binding_id: target.binding_id,
        ...initial,
      };
    }
  }
  state = JSON.parse(readFileSync(statePath, 'utf8')) as FixtureState;
  const result = await resumeCanonicalPreparedExecution(dependencies);
  const finished = { ...state, resume_count: state.resume_count + 1 };
  writeFileSync(statePath, JSON.stringify(finished));
  return {
    schema_version: 1,
    status: result.manifest.coordination_state.status,
    artifact_name: result.manifest.artifact_name,
    request_id: result.manifest.request.request_id,
    profile: target.key,
    binding_id: target.binding_id,
    materialize_count: finished.materialize_count,
    resume_count: finished.resume_count,
    submit_count: finished.submit_count,
    poll_count: finished.poll_count,
    retrieve_count: finished.retrieve_count,
  };
}
