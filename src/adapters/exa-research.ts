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

interface ExaCitation {
  url: string;
  title?: string;
  text?: string;
}
interface ExaRun {
  id: string;
  status: string;
  createdAt?: string;
  completedAt?: string | null;
  output?: {
    text?: string;
    structured?: unknown;
    grounding?: Array<{ citations?: ExaCitation[] }>;
  };
  usage?: Record<string, unknown>;
  costDollars?: { total?: number };
  error?: { message?: string };
}

const URL = 'https://api.exa.ai/agent';
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
    if (response.status !== 200 && response.status !== 201) {
      throw new UnsafeToRetrySubmissionError(
        this.formatError(response.status, response.data),
      );
    }
    const status = statuses[response.data.status];
    return {
      provider: this.id,
      taskId: response.data.id,
      query,
      submittedAt: Date.parse(response.data.createdAt ?? '') || Date.now(),
      status: status ?? 'pending',
      providerStatus: response.data.status,
      ...(status
        ? {}
        : {
            lastPollError: `Unknown Exa Agent status: ${response.data.status}`,
          }),
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
    const status = statuses[response.data.status];
    return status
      ? {
          status,
          rawStatus: response.data.status,
          message: response.data.error?.message,
        }
      : {
          status: handle.status === 'pending' ? 'pending' : 'running',
          rawStatus: response.data.status,
          message: `Unknown Exa Agent status: ${response.data.status}`,
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
      const run = response.data;
      if (statuses[run.status] !== 'completed')
        return this.error(
          start,
          run.error?.message ?? `Task is not complete: status=${run.status}`,
        );
      const structured = run.output?.structured;
      return {
        provider: this.id,
        tier: this.tier,
        content:
          run.output?.text ??
          (structured === undefined ? '' : JSON.stringify(structured, null, 2)),
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
      `${URL}/runs/${encodeURIComponent(handle.taskId)}/cancel`,
      {
        method: 'POST',
        headers: { 'x-api-key': this.getApiKey() },
        timeout: 15_000,
      },
    );
    if (response.status !== 200)
      throw new Error(`Cancel returned HTTP ${response.status}`);
    return {
      status: statuses[response.data.status] ?? handle.status,
      rawStatus: response.data.status,
      message: response.data.error?.message,
    };
  }

  private run(taskId: string, timeout: number) {
    return this.request<ExaRun>(`${URL}/runs/${encodeURIComponent(taskId)}`, {
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
