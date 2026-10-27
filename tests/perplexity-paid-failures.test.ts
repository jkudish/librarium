import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerplexityDeepResearchProvider } from '../src/adapters/perplexity-deep-research.js';
import { PerplexitySonarProProvider } from '../src/adapters/perplexity-sonar-pro.js';
import { profileIdentityKey } from '../src/core/execution-plan.js';
import type { HttpClient } from '../src/core/http-client.js';
import { createProviderAttemptBridge } from '../src/core/provider-attempt-bridge.js';
import {
  createNodeCoordinatorDependencies,
  createRegisteredProviderAttemptBridge,
  resumeCanonicalPreparedExecution,
  runCanonicalPreparedExecution,
} from '../src/node-canonical-run.js';
import {
  readPaidRunLedger,
  withPaidRunLedgerLock,
  writePaidRunLedger,
} from '../src/node-paid-attempt-ledger.js';
import { fingerprint, RunPaidWallet } from '../src/run-paid-wallet.js';
import type { Provider } from '../src/types.js';
import {
  canonicalFixturePrepared,
  canonicalFixtureProfile,
  canonicalFixtureResult,
} from './fixtures/canonical-run.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

it.each([
  {
    label: 'largest persisted 64-digit receipt',
    costUsd: 1e57,
    expectedMicrousd: `1${'0'.repeat(63)}`,
    expectedUsd: `1${'0'.repeat(57)}`,
  },
  {
    label: 'largest finite provider-reported number',
    costUsd: Number.MAX_VALUE,
    expectedMicrousd: `17976931348623157${'0'.repeat(298)}`,
    expectedUsd: `17976931348623157${'0'.repeat(292)}`,
  },
])(
  'preserves successful evidence and exact wallet billing at the $label boundary',
  async ({ costUsd, expectedMicrousd, expectedUsd }) => {
    const profile = canonicalFixtureProfile('reported-cost-boundary');
    const plan = canonicalFixturePrepared([profile], {
      requestedAtMs: Date.now(),
    });
    const profileKey = profileIdentityKey(profile.identity);
    const providerId = 'adapter-reported-cost-boundary';
    const provider: Provider = {
      id: providerId,
      displayName: 'Reported cost boundary',
      tier: 'ai-grounded',
      envVar: '',
      execution: 'inline',
      execute: vi.fn(async () => ({
        ...canonicalFixtureResult(providerId),
        usage: { costUsd },
      })),
    };
    const root = mkdtempSync(join(tmpdir(), 'librarium-cost-boundary-'));
    roots.push(root);
    const runDirectory = join(root, 'run');
    mkdirSync(runDirectory);
    const wallet = new RunPaidWallet({
      request_id: plan.request.request_id,
      request_fingerprint: fingerprint(plan.request),
      config_fingerprint: fingerprint('config'),
      created_at: plan.request.requested_at,
      deadline_at: new Date(
        Date.parse(plan.request.requested_at) + 60_000,
      ).toISOString(),
      stages: (
        ['refinement', 'research', 'synthesis', 'verification'] as const
      ).map((stage) => ({
        stage,
        requested: stage === 'research',
        fallback_authorized: false,
        prompt_version: 'v1',
        providers:
          stage === 'research'
            ? [{ provider: providerId, profile: profileKey }]
            : [],
      })),
      on_change: (ledger) => writePaidRunLedger(root, runDirectory, ledger),
      load_latest: () => readPaidRunLedger(root, runDirectory),
      with_mutation_lock: (action) =>
        withPaidRunLedgerLock(root, runDirectory, action),
    });

    const result = await runCanonicalPreparedExecution(plan, {
      runs_root: root,
      run_directory: runDirectory,
      coordinator: createNodeCoordinatorDependencies(),
      attempt_bridge: createRegisteredProviderAttemptBridge(
        plan,
        () => provider,
      ),
      paid_wallet: wallet,
    });

    expect(result.response).toMatchObject({
      status: 'succeeded',
      usage: { actual_cost: expectedUsd, currency: 'USD' },
      results: [
        expect.objectContaining({
          content: expect.stringContaining('Evidence.'),
          usage: { actual_cost: expectedUsd, currency: 'USD' },
        }),
      ],
    });
    expect(result.manifest.coordination_state.attempts[0]).toMatchObject({
      status: 'succeeded',
      actual_cost_microusd: expectedMicrousd,
    });
    expect(readPaidRunLedger(root, runDirectory)?.attempts[0]).toMatchObject({
      status: 'succeeded',
      reported: { state: 'known', cost_microusd: expectedMicrousd },
    });
  },
);

describe.each([true, false])(
  'Perplexity terminal billing with wallet=%s',
  (withWallet) => {
    describe.each(['inline', 'submit', 'sync-poll', 'resume-poll'] as const)(
      '%s boundary',
      (boundary) => {
        it.each(['incomplete', 'failed', 'cancelled', 'completed'])(
          'retains reported %s charges through canonical execution and wallet recovery',
          async (status) => {
            const terminal = {
              id: 'paid-task',
              status,
              model: 'openai/gpt-5.6-luna',
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: 'Provider content' }],
                },
              ],
              usage: { cost: { total_cost: 0.02 } },
            };
            const responses =
              boundary === 'sync-poll' || boundary === 'resume-poll'
                ? [{ id: 'paid-task', status: 'queued' }, terminal]
                : [terminal];
            if (status === 'completed' && boundary !== 'inline')
              responses.push(terminal);
            const httpClient = vi.fn<HttpClient>(async () => {
              const data = responses.shift();
              if (!data) throw new Error('Unexpected provider request');
              return {
                status: 200,
                statusText: 'OK',
                headers: {},
                data,
                durationMs: 1,
              };
            });
            const primary =
              boundary === 'inline'
                ? new PerplexitySonarProProvider({
                    apiKey: 'synthetic',
                    httpClient,
                  })
                : new PerplexityDeepResearchProvider({
                    apiKey: 'synthetic',
                    httpClient,
                  });
            const nextExecute = vi.fn(async () =>
              canonicalFixtureResult('next'),
            );
            const nextSubmit = vi.fn(async () => ({
              provider: 'next',
              taskId: 'next-task',
              query: 'next',
              submittedAt: Date.now(),
              status: 'completed' as const,
            }));
            const next: Provider = {
              id: 'next',
              displayName: 'Next paid provider',
              tier: 'ai-grounded',
              envVar: '',
              execution: 'background',
              execute: nextExecute,
              submit: nextSubmit,
              poll: vi.fn(),
              retrieve: nextExecute,
            };
            const profiles = [
              canonicalFixtureProfile(
                primary.id,
                boundary === 'inline' ? 'inline' : 'background',
              ),
              canonicalFixtureProfile(next.id, 'background'),
            ];
            const plan = canonicalFixturePrepared(profiles, {
              requestedAtMs: Date.now(),
              mode: boundary === 'resume-poll' ? 'async' : 'sync',
            });
            plan.policy.limits.max_concurrency = 1;
            plan.policy.budgets = { max_actual_cost_microusd: '10000' };
            for (const profile of profiles) {
              const key = profileIdentityKey(profile.identity);
              plan.profile_plans_by_identity[key] = {
                ...plan.profile_plans_by_identity[key]!,
                binding: {
                  adapter_id: profile.identity.provider_id,
                  binding_id: key,
                },
                estimate: { estimated_cost_microusd: '1000' },
              };
            }
            const root = mkdtempSync(join(tmpdir(), 'librarium-paid-failure-'));
            roots.push(root);
            const runDirectory = join(root, 'run');
            mkdirSync(runDirectory);
            const wallet = withWallet
              ? new RunPaidWallet({
                  request_id: plan.request.request_id,
                  request_fingerprint: fingerprint(plan.request),
                  config_fingerprint: fingerprint('config'),
                  created_at: plan.request.requested_at,
                  deadline_at: new Date(
                    Date.parse(plan.request.requested_at) + 60_000,
                  ).toISOString(),
                  limits: plan.policy.budgets,
                  stages: (
                    [
                      'refinement',
                      'research',
                      'synthesis',
                      'verification',
                    ] as const
                  ).map((stage) => ({
                    stage,
                    requested: stage === 'research',
                    fallback_authorized: false,
                    prompt_version: 'v1',
                    providers: profiles.map((profile) => ({
                      provider: profile.identity.provider_id,
                      profile: profileIdentityKey(profile.identity),
                    })),
                  })),
                  with_mutation_lock: (action) =>
                    withPaidRunLedgerLock(root, runDirectory, action),
                  load_latest: () => readPaidRunLedger(root, runDirectory),
                  on_change: (ledger) =>
                    writePaidRunLedger(root, runDirectory, ledger),
                })
              : undefined;
            const dependencies = {
              runs_root: root,
              run_directory: runDirectory,
              coordinator: createNodeCoordinatorDependencies(),
              attempt_bridge: createRegisteredProviderAttemptBridge(
                plan,
                (id) =>
                  id === primary.id
                    ? primary
                    : id === next.id
                      ? next
                      : undefined,
              ),
            };
            let result = await runCanonicalPreparedExecution(plan, {
              ...dependencies,
              paid_wallet: wallet,
            });
            if (boundary === 'resume-poll') {
              if (withWallet)
                expect(
                  readPaidRunLedger(root, runDirectory)?.attempts[0]?.status,
                ).toBe('accepted');
              expect(httpClient).toHaveBeenCalledTimes(1);
              result = await resumeCanonicalPreparedExecution(dependencies);
            }
            expect(
              result.manifest.coordination_state.attempts[0],
            ).toMatchObject({
              status:
                status === 'completed'
                  ? 'succeeded'
                  : status === 'cancelled' && boundary !== 'inline'
                    ? 'cancelled'
                    : 'failed',
              actual_cost_microusd: '20000',
            });
            expect(
              Object.keys(result.manifest.provider_outputs_by_attempt),
            ).toHaveLength(status === 'completed' ? 1 : 0);
            expect(result.response?.results).toHaveLength(
              status === 'completed' ? 1 : 0,
            );
            expect(nextExecute).not.toHaveBeenCalled();
            expect(nextSubmit).not.toHaveBeenCalled();
            if (withWallet) {
              const ledger = readPaidRunLedger(root, runDirectory)!;
              expect(ledger.attempts[0]).toMatchObject({
                reported: { state: 'known', cost_microusd: '20000' },
              });
              const restored = new RunPaidWallet({
                ...ledger,
                restored_ledger: ledger,
              });
              expect(() =>
                restored.begin({
                  stage: 'research',
                  provider: next.id,
                  profile: profileIdentityKey(profiles[1]!.identity),
                  estimated_cost_microusd: '2000',
                  input_fingerprint: fingerprint('next'),
                }),
              ).toThrow('actual_budget_exhausted');
            }
            expect(httpClient).toHaveBeenCalledTimes(
              (boundary.includes('poll') ? 2 : 1) +
                (status === 'completed' && boundary !== 'inline' ? 1 : 0),
            );
          },
        );
      },
    );
  },
);

it.each([
  { status: 'cancelled', reported: true },
  { status: 'completed', reported: true },
  { status: 'cancelled', reported: false },
  { status: 'completed', reported: false },
])(
  'reports cancellation billing for an explicitly supported exact profile without changing custody: %j',
  async ({ status, reported }) => {
    const httpClient = vi.fn<HttpClient>(async () => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      durationMs: 1,
      data: {
        id: 'cancel-task',
        status,
        model: 'openai/gpt-5.6-luna',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Race winner' }],
          },
        ],
        ...(reported && { usage: { cost: { total_cost: 0.02 } } }),
      },
    }));
    const provider = new PerplexityDeepResearchProvider({
      apiKey: 'synthetic',
      httpClient,
    });
    const profile = canonicalFixtureProfile(provider.id, 'background');
    const binding = { adapter_id: provider.id, binding_id: 'cancel-binding' };
    const onCancellationUsage = vi.fn();
    const bridge = createProviderAttemptBridge({
      resolveExactBinding: () => ({
        binding,
        profile,
        provider,
        catalog_digest: 'cancel-digest',
        cancel_policy: 'supported_exact_profile',
      }),
      onCancellationUsage,
    });
    const launch = {
      attempt_id: 'cancel-attempt',
      slot_id: 'slot-0',
      profile,
      binding,
      catalog_digest: 'cancel-digest',
      query: 'question',
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      delivery_lease_id: 'cancel-lease',
      idempotency_key: 'cancel-idempotency',
    };
    const result = await bridge.cancel!(launch, {
      handle_id: launch.attempt_id,
      provider_task_id: 'cancel-task',
      provider: profile.identity,
      submitted_at: new Date().toISOString(),
      status: 'pending',
    });
    expect(result?.status).toBe(
      status === 'cancelled' ? 'cancelled' : undefined,
    );
    if (reported)
      expect(onCancellationUsage).toHaveBeenCalledExactlyOnceWith(
        launch,
        expect.objectContaining({ costUsd: 0.02 }),
      );
    else expect(onCancellationUsage).not.toHaveBeenCalled();
    expect(httpClient).toHaveBeenCalledOnce();
  },
);

describe.each(['submit', 'poll', 'resume'])(
  'completed %s billing survives retrieval',
  (boundary) => {
    it.each([
      'error',
      'throw',
      'abort',
      'unpriced',
      'token-only',
      'repriced',
      'zero',
    ])(
      '%s retrieval keeps or authoritatively replaces the terminal charge',
      async (retrieval) => {
        const completed = {
          id: 'retrieval-task',
          status: 'completed',
          model: 'openai/gpt-5.6-luna',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'Completed' }],
            },
          ],
          usage: { cost: { total_cost: 0.02 } },
        };
        const receipts =
          boundary === 'submit'
            ? [completed]
            : [{ id: 'retrieval-task', status: 'queued' }, completed];
        const httpClient = vi.fn<HttpClient>(async () => {
          const data = receipts.shift();
          if (!data) throw new Error('Unexpected provider request');
          return {
            status: 200,
            statusText: 'OK',
            headers: {},
            durationMs: 1,
            data,
          };
        });
        const provider = new PerplexityDeepResearchProvider({
          apiKey: 'synthetic',
          httpClient,
        });
        const interrupted = new AbortController();
        const retrieve = vi
          .spyOn(provider, 'retrieve')
          .mockImplementation(async () => {
            if (retrieval === 'throw')
              throw new Error('Retrieval transport failed');
            if (retrieval === 'abort') {
              interrupted.abort();
              return new Promise(() => {});
            }
            return {
              ...canonicalFixtureResult(provider.id),
              ...(retrieval === 'error' && {
                error: 'Retrieval failed',
                content: '',
              }),
              ...(retrieval === 'token-only' && {
                usage: { outputTokens: 12 },
              }),
              ...(retrieval === 'repriced' && { usage: { costUsd: 0.03 } }),
              ...(retrieval === 'zero' && { usage: { costUsd: 0 } }),
            };
          });
        const profile = canonicalFixtureProfile(provider.id, 'background');
        const plan = canonicalFixturePrepared([profile], {
          mode: boundary === 'resume' ? 'async' : 'sync',
          requestedAtMs: Date.now(),
        });
        const profileKey = profileIdentityKey(profile.identity);
        plan.profile_plans_by_identity[profileKey] = {
          ...plan.profile_plans_by_identity[profileKey]!,
          binding: { adapter_id: provider.id, binding_id: profileKey },
          estimate: { estimated_cost_microusd: '1000' },
        };
        plan.policy.budgets = { max_actual_cost_microusd: '10000' };
        const root = mkdtempSync(
          join(tmpdir(), 'librarium-retrieval-billing-'),
        );
        roots.push(root);
        const runDirectory = join(root, 'run');
        mkdirSync(runDirectory);
        const wallet = new RunPaidWallet({
          request_id: plan.request.request_id,
          request_fingerprint: fingerprint(plan.request),
          config_fingerprint: fingerprint('config'),
          created_at: plan.request.requested_at,
          deadline_at: new Date(
            Date.parse(plan.request.requested_at) + 60_000,
          ).toISOString(),
          limits: plan.policy.budgets,
          stages: (
            ['refinement', 'research', 'synthesis', 'verification'] as const
          ).map((stage) => ({
            stage,
            requested: stage === 'research',
            fallback_authorized: false,
            prompt_version: 'v1',
            providers: [{ provider: provider.id, profile: profileKey }],
          })),
          on_change: (ledger) => writePaidRunLedger(root, runDirectory, ledger),
          load_latest: () => readPaidRunLedger(root, runDirectory),
          with_mutation_lock: (action) =>
            withPaidRunLedgerLock(root, runDirectory, action),
        });
        const dependencies = {
          runs_root: root,
          run_directory: runDirectory,
          coordinator: createNodeCoordinatorDependencies(),
          attempt_bridge: {
            ...createRegisteredProviderAttemptBridge(plan, () => provider),
            signal: interrupted.signal,
          },
        };
        let result = await runCanonicalPreparedExecution(plan, {
          ...dependencies,
          paid_wallet: wallet,
        });
        if (boundary === 'resume')
          result = await resumeCanonicalPreparedExecution(dependencies);
        const cost =
          retrieval === 'zero'
            ? '0'
            : retrieval === 'repriced'
              ? '30000'
              : '20000';
        const succeeded = !['error', 'throw', 'abort'].includes(retrieval);
        expect(result.manifest.coordination_state.attempts[0]).toMatchObject({
          status: succeeded
            ? 'succeeded'
            : retrieval === 'abort'
              ? 'timed_out'
              : 'failed',
          actual_cost_microusd: cost,
          durable_handle: { status: 'succeeded' },
        });
        expect(result.response?.results).toHaveLength(succeeded ? 1 : 0);
        expect(
          Object.keys(result.manifest.provider_outputs_by_attempt),
        ).toHaveLength(succeeded ? 1 : 0);
        const ledger = readPaidRunLedger(root, runDirectory)!;
        expect(ledger.attempts[0]?.reported).toEqual({
          state: 'known',
          cost_microusd: cost,
        });
        const restored = new RunPaidWallet({
          ...ledger,
          restored_ledger: ledger,
        });
        const next = () =>
          restored.begin({
            stage: 'research',
            provider: provider.id,
            profile: profileKey,
            estimated_cost_microusd: '2000',
            input_fingerprint: fingerprint('next'),
          });
        if (retrieval === 'zero') expect(next).not.toThrow();
        else expect(next).toThrow('actual_budget_exhausted');
        expect(retrieve).toHaveBeenCalledOnce();
        expect(httpClient).toHaveBeenCalledTimes(boundary === 'submit' ? 1 : 2);
      },
    );
  },
);
