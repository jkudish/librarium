import { UnsafeToRetrySubmissionError } from '../core/errors.js';
import type {
  AsyncPollResult,
  AsyncTaskHandle,
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';
import { BackgroundBaseProvider } from './base.js';
import type { ValyuResearchOptions } from './valyu-options.js';

interface ValyuResearchSource {
  title?: string;
  url?: string;
  snippet?: string;
  description?: string;
  source?: string;
  price?: number;
  doi?: string;
  word_count?: number;
  fragment?: string;
}

interface ValyuResearchImage {
  image_id?: string;
  image_type?: string;
  title?: string;
  image_url?: string;
  created_at?: string | number;
}

interface ValyuResearchDeliverable {
  id?: string;
  type?: string;
  status?: string;
  title?: string;
  url?: string;
  row_count?: number;
  column_count?: number;
  created_at?: string | number;
  error?: string;
  s3_key?: string;
}

interface ValyuResearchStatus {
  deepresearch_id?: string;
  status?: string;
  mode?: string;
  created_at?: string;
  completed_at?: string;
  output_type?: string;
  output?: string | Record<string, unknown>;
  sources?: ValyuResearchSource[];
  cost?: number;
  cost_breakdown?: Record<string, number>;
  progress?: { current_step?: number; total_steps?: number };
  pdf_url?: string;
  images?: ValyuResearchImage[];
  deliverables?: ValyuResearchDeliverable[];
  error?: string;
  message?: string;
}

interface ValyuCancelResponse {
  success?: boolean;
  message?: string;
  deepresearch_id?: string;
}

const TASKS_URL = 'https://api.valyu.ai/v1/deepresearch/tasks';
const STATUS_MAP: Record<string, AsyncTaskHandle['status']> = {
  queued: 'pending',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};
const HELD_BACK_HITL_STATUSES = new Set(['awaiting_input', 'paused']);

function timestamp(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      !parsed.username &&
      !parsed.password
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function safeArtifactUrl(value: string | undefined): string | undefined {
  const safe = safeHttpUrl(value);
  if (!safe) return undefined;
  const parsed = new URL(safe);
  // Signed and fragment-bearing locations are not demonstrably public. Keep
  // the artifact identity, but do not persist the credential-bearing URL.
  return parsed.search || parsed.hash ? undefined : parsed.toString();
}

function safeArtifacts(data: ValyuResearchStatus): Record<string, unknown>[] {
  const artifacts: Record<string, unknown>[] = [];
  const pdfUrl = safeArtifactUrl(data.pdf_url);
  if (data.pdf_url) {
    artifacts.push({ kind: 'pdf', ...(pdfUrl && { url: pdfUrl }) });
  }
  for (const image of data.images ?? []) {
    const imageUrl = safeArtifactUrl(image.image_url);
    artifacts.push({
      kind: image.image_type || 'image',
      ...(image.image_id && { provider_asset_id: image.image_id }),
      ...(image.title && { title: image.title }),
      ...(imageUrl && { url: imageUrl }),
      ...(timestamp(image.created_at) && {
        created_at: timestamp(image.created_at),
      }),
    });
  }
  for (const deliverable of data.deliverables ?? []) {
    // Deliberately omit s3_key, provider filenames, and binary content.
    const deliverableUrl = safeArtifactUrl(deliverable.url);
    artifacts.push({
      kind: deliverable.type || 'deliverable',
      ...(deliverable.id && { provider_asset_id: deliverable.id }),
      ...(deliverable.status && { status: deliverable.status }),
      ...(deliverable.title && { title: deliverable.title }),
      ...(deliverableUrl && { url: deliverableUrl }),
      ...(typeof deliverable.row_count === 'number' && {
        row_count: deliverable.row_count,
      }),
      ...(typeof deliverable.column_count === 'number' && {
        column_count: deliverable.column_count,
      }),
      ...(timestamp(deliverable.created_at) && {
        created_at: timestamp(deliverable.created_at),
      }),
    });
  }
  return artifacts;
}

export class ValyuResearchProvider extends BackgroundBaseProvider {
  readonly id = 'valyu-research';
  readonly tier: ProviderTier = 'deep-research';
  readonly options: ValyuResearchOptions;

  constructor(options: ValyuResearchOptions = {}) {
    super();
    this.options = options;
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    try {
      const handle = await this.submit(query, options);
      let observed: AsyncPollResult = { status: handle.status };
      const deadline = Date.now() + options.timeout * 1_000;
      while (
        !['completed', 'failed', 'cancelled'].includes(observed.status) &&
        Date.now() < deadline
      ) {
        if (options.signal?.aborted) throw new Error('Request aborted');
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        observed = await this.poll(handle);
      }
      if (observed.status === 'completed') return this.retrieve(handle);
      return this.failure(
        Math.round(performance.now() - start),
        observed.status === 'cancelled'
          ? 'Valyu research task was cancelled.'
          : observed.status === 'failed'
            ? observed.message || 'Valyu research task failed.'
            : 'Valyu research task exceeded the local timeout and may still be running remotely.',
      );
    } catch (error) {
      return this.failure(
        Math.round(performance.now() - start),
        this.formatCatchError(error),
      );
    }
  }

  async submit(
    query: string,
    options: ProviderOptions,
  ): Promise<AsyncTaskHandle> {
    if (query.length > 25_000) {
      throw new UnsafeToRetrySubmissionError(
        'Valyu research queries cannot exceed 25000 characters.',
      );
    }
    let response;
    try {
      response = await this.request<ValyuResearchStatus>(TASKS_URL, {
        method: 'POST',
        headers: { 'X-API-Key': this.getApiKey() },
        body: this.requestBody(query),
        timeout: options.timeout * 1_000,
        signal: options.signal,
      });
    } catch (error) {
      throw new UnsafeToRetrySubmissionError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (response.status !== 202) {
      throw new UnsafeToRetrySubmissionError(
        this.formatError(response.status, response.data),
      );
    }
    const data = response.data;
    if (!data.deepresearch_id || !data.status) {
      throw new UnsafeToRetrySubmissionError(
        'Valyu returned an invalid research task handle.',
      );
    }
    const heldBackHitl = HELD_BACK_HITL_STATUSES.has(data.status);
    const status = heldBackHitl ? 'failed' : STATUS_MAP[data.status];
    if (!status) {
      throw new UnsafeToRetrySubmissionError(
        'Valyu returned an invalid research task handle.',
      );
    }
    const submittedAt = data.created_at
      ? Date.parse(data.created_at)
      : Number.NaN;
    return {
      provider: this.id,
      taskId: data.deepresearch_id,
      query,
      submittedAt: Number.isFinite(submittedAt) ? submittedAt : Date.now(),
      status,
      providerStatus: data.status,
      ...(heldBackHitl
        ? {
            lastPollError:
              'Valyu requested unsupported human-in-the-loop interaction.',
          }
        : data.message
          ? { lastPollError: data.message }
          : {}),
    };
  }

  async poll(handle: AsyncTaskHandle): Promise<AsyncPollResult> {
    const response = await this.status(handle.taskId);
    if (response.status && HELD_BACK_HITL_STATUSES.has(response.status)) {
      return {
        status: 'failed',
        rawStatus: response.status,
        message: 'Valyu requested unsupported human-in-the-loop interaction.',
      };
    }
    const status = response.status ? STATUS_MAP[response.status] : undefined;
    if (!status) {
      return {
        status: 'failed',
        rawStatus: response.status || 'unknown',
        message: 'Valyu returned an unknown task status.',
      };
    }
    const current = response.progress?.current_step;
    const total = response.progress?.total_steps;
    const progress =
      typeof current === 'number' && typeof total === 'number' && total > 0
        ? Math.max(0, Math.min(100, Math.round((current / total) * 100)))
        : undefined;
    return {
      status,
      rawStatus: response.status,
      ...(progress !== undefined && { progress }),
      ...(response.error || response.message
        ? { message: response.error || response.message }
        : {}),
    };
  }

  async retrieve(handle: AsyncTaskHandle): Promise<ProviderResult> {
    const start = performance.now();
    try {
      const data = await this.status(handle.taskId);
      if (data.status !== 'completed') {
        return this.failure(
          Math.round(performance.now() - start),
          `Valyu research task is not completed (status: ${data.status || 'unknown'}).`,
        );
      }
      if (data.output_type !== 'markdown' || typeof data.output !== 'string') {
        return this.failure(
          Math.round(performance.now() - start),
          'Valyu returned an unsupported research output type.',
        );
      }
      const sources = (data.sources ?? []).filter(
        (source): source is ValyuResearchSource & { url: string } =>
          safeHttpUrl(source.url) !== undefined,
      );
      const artifacts = safeArtifacts(data);
      return {
        provider: this.id,
        tier: this.tier,
        content: data.output,
        citations: sources.map((source) => this.citation(source)),
        durationMs: this.duration(data, start),
        ...(typeof data.cost === 'number' && { usage: { costUsd: data.cost } }),
        providerMeta: {
          'valyu:deepresearch_id': handle.taskId,
          'valyu:mode': data.mode || this.options.mode || 'standard',
          ...(data.output_type && { 'valyu:output_type': data.output_type }),
          ...(data.cost_breakdown && {
            'valyu:cost_breakdown': data.cost_breakdown,
          }),
          ...(artifacts.length > 0 && { 'valyu:artifacts': artifacts }),
          'valyu:sources': sources.map((source) => ({
            ...(source.source && { source: source.source }),
            ...(source.doi && { doi: source.doi }),
            ...(typeof source.price === 'number' && { price: source.price }),
            ...(typeof source.word_count === 'number' && {
              word_count: source.word_count,
            }),
          })),
        },
      };
    } catch (error) {
      return this.failure(
        Math.round(performance.now() - start),
        this.formatCatchError(error),
      );
    }
  }

  async cancel(handle: AsyncTaskHandle): Promise<AsyncPollResult> {
    const response = await this.request<ValyuCancelResponse>(
      `${TASKS_URL}/${encodeURIComponent(handle.taskId)}/cancel`,
      {
        method: 'POST',
        headers: { 'X-API-Key': this.getApiKey() },
        timeout: 15_000,
      },
    );
    if (
      response.status !== 200 ||
      response.data.success !== true ||
      response.data.deepresearch_id !== handle.taskId
    ) {
      throw new Error(`Cancel returned HTTP ${response.status}`);
    }
    return {
      status: 'cancelled',
      rawStatus: 'cancelled',
      ...(response.data.message && { message: response.data.message }),
    };
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    // A task creation is paid. Validate only credential presence without a call.
    try {
      this.getApiKey();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: this.formatCatchError(error),
      };
    }
  }

  private async status(taskId: string): Promise<ValyuResearchStatus> {
    const response = await this.request<ValyuResearchStatus>(
      `${TASKS_URL}/${encodeURIComponent(taskId)}/status`,
      {
        method: 'GET',
        headers: { 'X-API-Key': this.getApiKey() },
        timeout: 30_000,
      },
    );
    if (response.status !== 200) {
      throw new Error(`Status returned HTTP ${response.status}`);
    }
    if (response.data.deepresearch_id !== taskId) {
      throw new Error('Valyu research task identity changed during polling.');
    }
    return response.data;
  }

  private requestBody(query: string): Record<string, unknown> {
    const value = this.options;
    const search = value.search;
    return {
      query,
      mode: value.mode || 'standard',
      ...(value.researchStrategy && {
        research_strategy: value.researchStrategy,
      }),
      ...(value.reportFormat && { report_format: value.reportFormat }),
      ...(search && {
        search: {
          ...(search.searchType && { search_type: search.searchType }),
          ...(search.includedSources && {
            included_sources: search.includedSources,
          }),
          ...(search.excludedSources && {
            excluded_sources: search.excludedSources,
          }),
          ...(search.sourceBiases && { source_biases: search.sourceBiases }),
          ...(search.startDate && { start_date: search.startDate }),
          ...(search.endDate && { end_date: search.endDate }),
          ...(search.countryCode && { country_code: search.countryCode }),
        },
      }),
      ...(value.urls && { urls: value.urls }),
      output_formats: value.outputFormats || ['markdown'],
    };
  }

  private citation(source: ValyuResearchSource & { url: string }): Citation {
    return {
      url: source.url,
      ...(source.title && { title: source.title }),
      ...((source.snippet || source.description) && {
        snippet: source.snippet || source.description,
      }),
      provider: this.id,
      ...(source.source && { providerReference: source.source }),
      sourceKind: 'web_page',
      ...(source.source && { publisher: source.source }),
      ...(source.fragment && { locator: source.fragment }),
    };
  }

  private duration(data: ValyuResearchStatus, start: number): number {
    const created = data.created_at ? Date.parse(data.created_at) : undefined;
    const completed = data.completed_at
      ? Date.parse(data.completed_at)
      : undefined;
    return created !== undefined &&
      completed !== undefined &&
      completed >= created
      ? completed - created
      : Math.round(performance.now() - start);
  }

  private failure(durationMs: number, error: string): ProviderResult {
    return {
      provider: this.id,
      tier: this.tier,
      content: '',
      citations: [],
      durationMs,
      error,
    };
  }
}
