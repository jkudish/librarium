import { z } from 'zod';
import { UnsafeToRetrySubmissionError } from '../core/errors.js';
import type {
  AsyncPollResult,
  AsyncTaskHandle,
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BackgroundBaseProvider, type BaseProviderOptions } from './base.js';

type ExaEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'auto'
  | 'max';

export interface ExaResearchProviderOptions extends BaseProviderOptions {
  effort?: ExaEffort;
  systemPrompt?: string;
  outputSchema?: Record<string, unknown>;
  maxCostDollars?: number;
}

const ExaId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const ExaStatus = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
type ExaCitation = z.infer<typeof ExaCitation>;
const ExaCitation = z.object({
  url: z.string().url(),
  title: z.string().min(1).optional(),
  text: z.string().optional(),
});
const ExaStructuredOutput = z.record(z.string(), z.unknown());
const ExaRun = z.object({
  id: ExaId,
  object: z.literal('agent_run').optional(),
  status: ExaStatus,
  createdAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable().optional(),
  output: z
    .object({
      text: z.string().optional(),
      structured: ExaStructuredOutput.nullable().optional(),
      grounding: z
        .array(z.object({ citations: z.array(ExaCitation).optional() }))
        .optional(),
    })
    .optional(),
  usage: z.record(z.string(), z.number().nonnegative()).optional(),
  costDollars: z
    .object({ total: z.number().nonnegative() })
    .passthrough()
    .optional(),
  error: z.object({ message: z.string().min(1).optional() }).optional(),
});
type ExaRun = z.infer<typeof ExaRun>;

const URL = 'https://api.exa.ai/agent/runs';
const statuses: Record<string, AsyncTaskHandle['status']> = {
  queued: 'pending',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** Durable Exa Agent adapter bound only to `exa/research`. */
export class ExaResearchProvider extends BackgroundBaseProvider {
  readonly id = 'exa-research';
  get envVar(): string {
    return 'EXA_API_KEY';
  }
  get displayName(): string {
    return 'Exa Research Adapter';
  }
  readonly tier: ProviderTier = 'deep-research';
  private readonly configured: ExaResearchProviderOptions;

  constructor(options: ExaResearchProviderOptions = {}) {
    super(options);
    this.configured = options;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    try {
      const handle = await this.submit(query, options);
      const deadline = Date.now() + options.timeout * 1000;
      while (handle.status === 'pending' || handle.status === 'running') {
        if (Date.now() >= deadline)
          return this.error(start, 'Exa research task timed out');
        await wait(Math.min(1_000, deadline - Date.now()), options.signal);
        const next = await this.poll(handle);
        handle.status = next.status;
        if (next.status === 'failed' || next.status === 'cancelled') {
          return this.error(
            start,
            next.message ?? `Exa research task ${next.status}`,
          );
        }
      }
      const result = await this.retrieve(handle);
      return { ...result, durationMs: Math.round(performance.now() - start) };
    } catch (error) {
      return this.error(start, this.formatCatchError(error));
    }
  }

  async submit(
    query: string,
    options: ProviderOptions,
  ): Promise<AsyncTaskHandle> {
    let response;
    try {
      response = await this.request<ExaRun>(URL, {
        method: 'POST',
        headers: { 'x-api-key': this.getApiKey() },
        body: {
          query,
          ...(this.configured.effort && { effort: this.configured.effort }),
          ...(this.configured.systemPrompt && {
            systemPrompt: this.configured.systemPrompt,
          }),
          ...(this.configured.outputSchema && {
            outputSchema: this.configured.outputSchema,
          }),
          ...(this.configured.maxCostDollars && {
            budget: { maxCostDollars: this.configured.maxCostDollars },
          }),
        },
        timeout: Math.min(options.timeout * 1000, 30_000),
        signal: options.signal,
      });
    } catch (error) {
      throw new UnsafeToRetrySubmissionError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (response.status !== 200) {
      throw new UnsafeToRetrySubmissionError(
        this.formatError(response.status, response.data),
      );
    }
    const parsed = ExaRun.safeParse(response.data);
    if (!parsed.success) {
      const id = ExaId.safeParse((response.data as { id?: unknown })?.id);
      if (!id.success)
        throw new UnsafeToRetrySubmissionError(
          'Exa Agent returned an invalid run handle',
        );
      return {
        provider: this.id,
        taskId: id.data,
        query,
        submittedAt: Date.now(),
        status: 'failed',
        providerStatus: 'invalid_response',
        lastPollError: 'Exa Agent returned a malformed create response',
      };
    }
    const data = parsed.data;
    const status = statuses[data.status];
    return {
      provider: this.id,
      taskId: data.id,
      query,
      submittedAt: Date.parse(data.createdAt),
      status,
      providerStatus: data.status,
    };
  }

  async poll(handle: AsyncTaskHandle): Promise<AsyncPollResult> {
    const response = await this.run(handle.taskId, 15_000);
    if (response.status !== 200) {
      if (
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500
      )
        throw new Error(`Poll returned HTTP ${response.status}`);
      return {
        status: 'failed',
        rawStatus: `http_${response.status}`,
        message: `Poll returned HTTP ${response.status}`,
      };
    }
    const parsed = ExaRun.safeParse(response.data);
    if (!parsed.success)
      return {
        status: 'failed',
        rawStatus: 'invalid_response',
        message: 'Exa Agent returned a malformed status response',
      };
    const status = statuses[parsed.data.status];
    return status
      ? {
          status,
          rawStatus: parsed.data.status,
          message: parsed.data.error?.message,
        }
      : {
          status: 'failed',
          rawStatus: 'invalid_status',
          message: 'Unknown Exa Agent status',
        };
  }

  async retrieve(handle: AsyncTaskHandle): Promise<ProviderResult> {
    const start = performance.now();
    try {
      const response = await this.run(handle.taskId, 30_000);
      if (response.status !== 200)
        return this.error(
          start,
          `Retrieve failed with HTTP ${response.status}`,
        );
      const parsed = ExaRun.safeParse(response.data);
      if (!parsed.success)
        return this.error(
          start,
          'Exa Agent returned a malformed completed response',
        );
      const run = parsed.data;
      if (statuses[run.status] !== 'completed')
        return this.error(
          start,
          run.error?.message ?? `Task is not complete: status=${run.status}`,
        );
      const structured = run.output?.structured;
      const hasStructured = structured && Object.keys(structured).length > 0;
      const text = run.output?.text?.trim();
      if (!text && !hasStructured)
        return this.error(
          start,
          'Exa Agent completed without non-empty output',
        );
      return {
        provider: this.id,
        tier: this.tier,
        content: text ?? JSON.stringify(structured, null, 2),
        citations: citations(run.output?.grounding, this.id),
        durationMs: Math.round(performance.now() - start),
        usage: usage(run.usage, run.costDollars),
      };
    } catch (error) {
      return this.error(start, this.formatCatchError(error));
    }
  }

  /** Exa documents remote cancellation. The canonical bridge does not expose cancellation. */
  async cancel(handle: AsyncTaskHandle): Promise<AsyncPollResult> {
    const response = await this.request<ExaRun>(
      `${URL}/${encodeURIComponent(handle.taskId)}/cancel`,
      {
        method: 'POST',
        headers: { 'x-api-key': this.getApiKey() },
        timeout: 15_000,
      },
    );
    if (response.status !== 200)
      throw new Error(`Cancel returned HTTP ${response.status}`);
    const parsed = ExaRun.safeParse(response.data);
    if (!parsed.success)
      throw new Error('Cancel returned a malformed response');
    return {
      status: statuses[parsed.data.status],
      rawStatus: parsed.data.status,
      message: parsed.data.error?.message,
    };
  }

  private run(taskId: string, timeout: number) {
    return this.request<ExaRun>(`${URL}/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: { 'x-api-key': this.getApiKey() },
      timeout,
    });
  }
  private error(start: number, error: string): ProviderResult {
    return {
      provider: this.id,
      tier: this.tier,
      content: '',
      citations: [],
      durationMs: Math.round(performance.now() - start),
      error,
    };
  }
}

function citations(
  grounding: Array<{ citations?: ExaCitation[] }> | undefined,
  provider: string,
): Citation[] {
  const seen = new Set<string>();
  return (grounding ?? [])
    .flatMap(({ citations = [] }) => citations)
    .filter(
      ({ url }) => Boolean(url) && !seen.has(url) && Boolean(seen.add(url)),
    )
    .map(({ url, title, text }) => ({
      url,
      title,
      snippet: text?.slice(0, 200),
      provider,
    }));
}
function usage(
  value: Record<string, unknown> | undefined,
  cost: ExaRun['costDollars'],
): ProviderUsage | undefined {
  if (!value && cost?.total === undefined) return undefined;
  return {
    ...(cost?.total !== undefined && { costUsd: cost.total }),
    raw: { ...(value && { usage: value }), ...(cost && { costDollars: cost }) },
  };
}
function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Request aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(1, milliseconds));
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Request aborted'));
      },
      { once: true },
    );
  });
}
