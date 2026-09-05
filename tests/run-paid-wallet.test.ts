import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PaidRunLedgerSchema,
  writePaidRunLedger,
} from '../src/node-paid-attempt-ledger.js';
import {
  fingerprint,
  PaidRunAdmissionError,
  type PaidStageDeclaration,
  RunPaidWallet,
} from '../src/run-paid-wallet.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function stages(
  overrides: Partial<
    Record<PaidStageDeclaration['stage'], Partial<PaidStageDeclaration>>
  > = {},
): PaidStageDeclaration[] {
  return (['refinement', 'research', 'synthesis', 'verification'] as const).map(
    (stage) => ({
      stage,
      requested: stage === 'research' || stage === 'synthesis',
      fallback_authorized: false,
      prompt_version: `${stage}-v1`,
      providers:
        stage === 'research'
          ? [
              {
                provider: 'research-a',
                profile: 'research-a\0default',
                estimated_cost_microusd: '7000',
              },
            ]
          : stage === 'synthesis'
            ? [
                {
                  provider: 'openai',
                  model: 'model-a',
                  estimated_cost_microusd: '3000',
                },
              ]
            : [],
      ...(stage === 'synthesis' && { reserve_first_attempt: true }),
      ...overrides[stage],
    }),
  );
}

function wallet(
  options: {
    stages?: PaidStageDeclaration[];
    max?: string;
    now?: () => number;
    onChange?: Parameters<typeof RunPaidWallet>[0]['on_change'];
  } = {},
): RunPaidWallet {
  return new RunPaidWallet({
    request_id: 'request-1',
    request_fingerprint: fingerprint('request'),
    config_fingerprint: fingerprint('config'),
    created_at: '2026-09-05T12:00:00.000Z',
    deadline_at: '2026-09-05T12:01:00.000Z',
    ...(options.max && {
      limits: {
        max_estimated_cost_microusd: options.max,
        max_actual_cost_microusd: options.max,
      },
    }),
    stages: options.stages ?? stages(),
    now: options.now ?? (() => Date.parse('2026-09-05T12:00:01.000Z')),
    ...(options.onChange && { on_change: options.onChange }),
  });
}

describe('run-wide paid wallet', () => {
  it('reserves requested synthesis before research can spend the hard budget', () => {
    const subject = wallet({ max: '10000' });

    expect(() =>
      subject.begin({
        stage: 'research',
        provider: 'research-a',
        profile: 'research-a\0default',
        estimated_cost_microusd: '8000',
        input_fingerprint: fingerprint('research'),
      }),
    ).toThrowError(PaidRunAdmissionError);
    expect(subject.snapshot().attempts[0]).toMatchObject({
      status: 'blocked',
      reason_code: 'estimated_budget_exhausted',
    });

    const synthesis = subject.begin({
      stage: 'synthesis',
      provider: 'openai',
      model: 'model-a',
      estimated_cost_microusd: '3000',
      input_fingerprint: fingerprint('synthesis'),
    });
    subject.finish(synthesis, {
      status: 'succeeded',
      usage: { costUsd: 0.003 },
      output_fingerprint: fingerprint('answer'),
      output_ref: 'answer.md',
    });
    expect(subject.snapshot().attempts[1]).toMatchObject({
      status: 'succeeded',
      reported: { state: 'known', cost_microusd: '3000' },
    });
  });

  it('never treats unknown cost as free under a hard budget', () => {
    const subject = wallet({
      max: '10000',
      stages: stages({
        synthesis: {
          providers: [{ provider: 'openai', model: 'model-a' }],
        },
      }),
    });

    expect(subject.stageStatus('synthesis')).toMatchObject({
      status: 'skipped',
      reason_code: 'unknown_cost_under_hard_budget',
    });
    expect(() =>
      subject.begin({
        stage: 'synthesis',
        provider: 'openai',
        model: 'model-a',
        input_fingerprint: fingerprint('prompt'),
      }),
    ).toThrowError(PaidRunAdmissionError);
  });

  it('admits no new call after cancellation or the absolute deadline', () => {
    const cancelled = wallet();
    cancelled.cancel();
    expect(() =>
      cancelled.begin({
        stage: 'research',
        provider: 'research-a',
        profile: 'research-a\0default',
        estimated_cost_microusd: '7000',
        input_fingerprint: fingerprint('cancelled'),
      }),
    ).toThrowError(/run_cancelled/);

    const expired = wallet({
      now: () => Date.parse('2026-09-05T12:01:00.000Z'),
    });
    expect(() =>
      expired.begin({
        stage: 'research',
        provider: 'research-a',
        profile: 'research-a\0default',
        estimated_cost_microusd: '7000',
        input_fingerprint: fingerprint('expired'),
      }),
    ).toThrowError(/run_deadline_exceeded/);
  });

  it('blocks providers outside the frozen no-fallback authorization set', () => {
    const subject = wallet();
    expect(() =>
      subject.begin({
        stage: 'synthesis',
        provider: 'gemini',
        model: 'model-b',
        estimated_cost_microusd: '3000',
        input_fingerprint: fingerprint('alternate'),
      }),
    ).toThrowError(/provider_not_authorized/);
    expect(subject.snapshot().attempts).toHaveLength(1);
  });

  it('persists a versioned replay-safe ledger with all admitted and blocked attempts', () => {
    const root = join(tmpdir(), `librarium-wallet-${crypto.randomUUID()}`);
    const runDirectory = join(root, 'run-1');
    mkdirSync(runDirectory, { recursive: true });
    roots.push(root);
    const subject = wallet({
      onChange: (ledger) => writePaidRunLedger(root, runDirectory, ledger),
    });
    const attempt = subject.begin({
      stage: 'research',
      provider: 'research-a',
      profile: 'research-a\0default',
      estimated_cost_microusd: '7000',
      input_fingerprint: fingerprint('research input'),
      parent_attempt_id: 'canonical-attempt-1',
      input_ref: 'run.json#/coordination_state/attempts',
    });
    subject.finish(attempt, {
      status: 'succeeded',
      output_fingerprint: fingerprint('research output'),
      output_ref: 'run.json#/provider_outputs_by_attempt/canonical-attempt-1',
    });
    expect(() =>
      subject.begin({
        stage: 'research',
        provider: 'unauthorized',
        estimated_cost_microusd: '1',
        input_fingerprint: fingerprint('blocked input'),
      }),
    ).toThrowError(PaidRunAdmissionError);

    const parsed = PaidRunLedgerSchema.parse(
      JSON.parse(
        readFileSync(join(runDirectory, 'paid-attempt-ledger.json'), 'utf8'),
      ),
    );
    expect(parsed.attempts).toHaveLength(2);
    expect(parsed.attempts[0]).toMatchObject({
      parent_attempt_id: 'canonical-attempt-1',
      output_ref: 'run.json#/provider_outputs_by_attempt/canonical-attempt-1',
    });
    expect(JSON.stringify(parsed)).not.toContain('research input');
    expect(JSON.stringify(parsed)).not.toContain('research output');
  });
});
