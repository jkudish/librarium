import { z } from 'zod';
import { UnsafeToRetrySubmissionError } from '../core/errors.js';
import { normalizeUrl } from '../core/normalizer.js';
import type {
  AsyncPollResult,
  AsyncTaskHandle,
  AsyncTaskStatus,
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import {
  BackgroundBaseProvider,
  BaseProvider,
  type BaseProviderOptions,
} from './base.js';
import {
  ParallelChatOptionsSchema,
  ParallelResearchOptionsSchema,
  type ParallelSearchOptions,
  ParallelSearchOptionsSchema,
} from './parallel-options.js';

const API = 'https://api.parallel.ai';
const CHAT_MODELS = new Set(['speed', 'lite', 'base', 'core']);
const RESEARCH_PROCESSORS = new Set(['pro', 'pro-fast', 'ultra', 'ultra-fast']);
const STATUS: Record<string, AsyncTaskStatus> = {
  queued: 'pending',
  action_required: 'running',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelling: 'running',
  cancelled: 'cancelled',
};

interface WebResult {
  url?: unknown;
  title?: unknown;
  excerpts?: unknown;
  publish_date?: unknown;
}
interface BasisCitation {
  url?: unknown;
  excerpts?: unknown;
}
interface FieldBasis {
  field?: unknown;
  citations?: BasisCitation[];
  reasoning?: unknown;
  confidence?: unknown;
}
interface TaskRun {
  run_id?: string;
  status?: string;
  processor?: string;
  created_at?: string;
  modified_at?: string;
  error?: { message?: string };
}
interface TaskResult {
  run?: TaskRun;
  output?: { type?: unknown; content?: unknown; basis?: FieldBasis[] };
}
interface ChatResponse {
  id?: string;
  interaction_id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  basis?: FieldBasis[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

const fieldBasisSchema = z
  .object({
    field: z.unknown().optional(),
    citations: z
      .array(
        z.object({
          url: z.unknown().optional(),
          excerpts: z.unknown().optional(),
        }),
      )
      .optional(),
    reasoning: z.unknown().optional(),
    confidence: z.unknown().optional(),
  })
  .passthrough();

const searchResponseSchema = z
  .object({
    search_id: z.unknown().optional(),
    session_id: z.unknown().optional(),
    results: z.array(
      z
        .object({
          url: z
            .string()
            .trim()
            .min(1)
            .refine(isHttpUrl, 'must be a valid HTTP(S) URL'),
          title: z.unknown().optional(),
          excerpts: z.unknown().optional(),
          publish_date: z.unknown().optional(),
        })
        .passthrough(),
    ),
    warnings: z.unknown().optional(),
    usage: z.unknown().optional(),
  })
  .passthrough();

const chatResponseSchema = z
  .object({
    id: z.unknown().optional(),
    interaction_id: z.unknown().optional(),
    model: z.unknown().optional(),
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string() }).passthrough().optional(),
          })
          .passthrough(),
      )
      .min(1),
    basis: z.array(fieldBasisSchema).optional(),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const taskResultSchema = z
  .object({
    run: z
      .object({
        run_id: z.string().trim().min(1),
        status: z.string(),
        processor: z.string().optional(),
        error: z
          .object({ message: z.string().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    output: z
      .object({
        type: z.unknown().optional(),
        content: z.unknown().optional(),
        basis: z.array(fieldBasisSchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const textTaskOutputSchema = z
  .object({
    type: z.literal('text'),
    content: z.string(),
    basis: z.array(fieldBasisSchema).optional(),
  })
  .passthrough();

const taskRunSchema = z
  .object({
    run_id: z.string().trim().min(1),
    status: z.string(),
    processor: z.string().optional(),
    error: z
      .object({ message: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname.length > 0 &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function sourcePolicy(options: {
  includeDomains?: string[];
  excludeDomains?: string[];
  afterDate?: string;
}) {
  const policy = {
    ...(options.includeDomains && { include_domains: options.includeDomains }),
    ...(options.excludeDomains && { exclude_domains: options.excludeDomains }),
    ...(options.afterDate && { after_date: options.afterDate }),
  };
  return Object.keys(policy).length ? policy : undefined;
}
function citationsFromBasis(
  basis: FieldBasis[] | undefined,
  provider: string,
): Citation[] {
  const found = new Map<string, Citation>();
  for (const item of basis ?? [])
    for (const citation of item.citations ?? []) {
      const url = text(citation.url);
      if (!url) continue;
      const key = normalizeUrl(url);
      if (!found.has(key))
        found.set(key, {
          url,
          snippet: Array.isArray(citation.excerpts)
            ? text(citation.excerpts[0])?.slice(0, 500)
            : undefined,
          provider,
        });
    }
  return [...found.values()];
}
function basisMeta(basis: FieldBasis[] | undefined) {
  if (!basis?.length) return undefined;
  return basis.map((item) => ({
    field: text(item.field),
    reasoning: text(item.reasoning),
    confidence: text(item.confidence),
    citations: (item.citations ?? []).flatMap((citation) => {
      const url = text(citation.url);
      return url
        ? [
            {
              url,
              excerpts: Array.isArray(citation.excerpts)
                ? citation.excerpts
                    .filter(
                      (entry): entry is string => typeof entry === 'string',
                    )
                    .slice(0, 5)
                : [],
            },
          ]
        : [];
    }),
  }));
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Request aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
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

export class ParallelSearchProvider extends BaseProvider {
  readonly id = 'parallel-search';
  readonly tier: ProviderTier = 'raw-search';
  constructor(
    private readonly configuredOptions: unknown = {},
    base: BaseProviderOptions = {},
  ) {
    super(base);
  }
  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const parsed = ParallelSearchOptionsSchema.safeParse(
      this.configuredOptions,
    );
    if (!parsed.success) return this.errorResult(start, parsed.error.message);
    try {
      const response = await this.request<{
        search_id?: string;
        session_id?: string;
        results?: WebResult[];
        warnings?: unknown;
        usage?: unknown;
      }>(`${API}/v1/search`, {
        method: 'POST',
        headers: { 'x-api-key': this.getApiKey() },
        body: this.body(query, parsed.data),
        timeout: options.timeout * 1000,
        signal: options.signal,
      });
      const durationMs = Math.round(performance.now() - start);
      if (response.status < 200 || response.status >= 300)
        return this.resultError(
          durationMs,
          this.formatError(response.status, response.data),
        );
      const parsedResponse = searchResponseSchema.safeParse(response.data);
      if (!parsedResponse.success)
        return this.resultError(
          durationMs,
          'Parallel returned an invalid Search response',
        );
      const results = parsedResponse.data.results;
      const cited = results.flatMap((result) => {
        const url = text(result.url);
        return url
          ? [
              {
                url,
                title: text(result.title),
                snippet: Array.isArray(result.excerpts)
                  ? text(result.excerpts[0])?.slice(0, 500)
                  : undefined,
                provider: this.id,
              },
            ]
          : [];
      });
      return {
        provider: this.id,
        tier: this.tier,
        content: cited
          .map(
            (item, index) =>
              `### ${index + 1}. ${item.title ?? item.url}\n${item.url}${item.snippet ? `\n\n${item.snippet}` : ''}`,
          )
          .join('\n\n'),
        citations: cited,
        durationMs,
        providerMeta: {
          ...(text(parsedResponse.data.search_id) && {
            'parallel:search_id': text(parsedResponse.data.search_id),
          }),
          ...(text(parsedResponse.data.session_id) && {
            'parallel:session_id': text(parsedResponse.data.session_id),
          }),
          ...(parsedResponse.data.warnings !== undefined && {
            'parallel:warnings': parsedResponse.data.warnings,
          }),
          ...(parsedResponse.data.usage !== undefined && {
            'parallel:usage': parsedResponse.data.usage,
          }),
        },
      };
    } catch (error) {
      return this.resultError(
        Math.round(performance.now() - start),
        this.formatCatchError(error),
      );
    }
  }
  private body(query: string, value: ParallelSearchOptions) {
    const policy = sourcePolicy(value.sourcePolicy ?? {});
    const advanced = {
      ...(policy && { source_policy: policy }),
      ...(value.fetchPolicy && {
        fetch_policy: {
          ...(value.fetchPolicy.maxAgeSeconds !== undefined && {
            max_age_seconds: value.fetchPolicy.maxAgeSeconds,
          }),
          ...(value.fetchPolicy.timeoutSeconds !== undefined && {
            timeout_seconds: value.fetchPolicy.timeoutSeconds,
          }),
          ...(value.fetchPolicy.disableCacheFallback !== undefined && {
            disable_cache_fallback: value.fetchPolicy.disableCacheFallback,
          }),
        },
      }),
      ...(value.maxCharsPerResult !== undefined && {
        excerpt_settings: { max_chars_per_result: value.maxCharsPerResult },
      }),
      ...(value.location && { location: value.location }),
      ...(value.maxResults !== undefined && { max_results: value.maxResults }),
    };
    return {
      objective: value.objective ?? query,
      search_queries: value.searchQueries ?? [query],
      ...(value.mode && { mode: value.mode }),
      ...(value.maxCharsTotal !== undefined && {
        max_chars_total: value.maxCharsTotal,
      }),
      ...(Object.keys(advanced).length && { advanced_settings: advanced }),
    };
  }
  private resultError(durationMs: number, error: string): ProviderResult {
    return {
      provider: this.id,
      tier: this.tier,
      content: '',
      citations: [],
      durationMs,
      error,
    };
  }
  private errorResult(start: number, error: string) {
    return this.resultError(
      Math.round(performance.now() - start),
      `parallel-search options: ${error}`,
    );
  }
}

export class ParallelChatProvider extends BaseProvider {
  readonly id = 'parallel-chat';
  readonly tier: ProviderTier = 'ai-grounded';
  readonly model: string;
  constructor(
    options: BaseProviderOptions & {
      model?: string;
      configuredOptions?: unknown;
    } = {},
  ) {
    super(options);
    this.model = options.model?.trim() || 'base';
    this.options = options.configuredOptions ?? {};
  }
  private readonly options: unknown;
  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const parsed = ParallelChatOptionsSchema.safeParse(this.options);
    if (!parsed.success || !CHAT_MODELS.has(this.model))
      return {
        provider: this.id,
        tier: this.tier,
        content: '',
        citations: [],
        durationMs: Math.round(performance.now() - start),
        error: !parsed.success
          ? `parallel-chat options: ${parsed.error.message}`
          : 'parallel-chat model must be one of: speed, lite, base, core',
      };
    try {
      const response = await this.request<ChatResponse>(
        `${API}/v1beta/chat/completions`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.getApiKey()}` },
          body: {
            model: this.model,
            messages: [{ role: 'user', content: query }],
            stream: false,
            ...(parsed.data.responseFormat && {
              response_format: {
                type: 'json_schema',
                json_schema: parsed.data.responseFormat,
              },
            }),
          },
          timeout: options.timeout * 1000,
          signal: options.signal,
        },
      );
      const durationMs = Math.round(performance.now() - start);
      if (response.status < 200 || response.status >= 300)
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: this.formatError(response.status, response.data),
        };
      const parsedResponse = chatResponseSchema.safeParse(response.data);
      if (!parsedResponse.success)
        return this.resultError(
          durationMs,
          'Parallel returned an invalid Chat response',
        );
      const content = parsedResponse.data.choices
        .map((choice) => choice.message?.content)
        .find((value): value is string => typeof value === 'string');
      if (content === undefined)
        return this.resultError(
          durationMs,
          'Parallel returned a Chat response without message content',
        );
      const basis = basisMeta(parsedResponse.data.basis);
      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations: citationsFromBasis(parsedResponse.data.basis, this.id),
        durationMs,
        model: text(parsedResponse.data.model) ?? this.model,
        tokenUsage: {
          input: parsedResponse.data.usage?.prompt_tokens,
          output: parsedResponse.data.usage?.completion_tokens,
        },
        usage: usage(parsedResponse.data.usage),
        providerMeta: {
          ...(text(parsedResponse.data.interaction_id) && {
            'parallel:interaction_id': text(parsedResponse.data.interaction_id),
          }),
          ...(basis && { 'parallel:basis': basis }),
          'parallel:basis_available': parsedResponse.data.basis !== undefined,
        },
      };
    } catch (error) {
      return {
        provider: this.id,
        tier: this.tier,
        content: '',
        citations: [],
        durationMs: Math.round(performance.now() - start),
        error: this.formatCatchError(error),
      };
    }
  }
  private resultError(durationMs: number, error: string): ProviderResult {
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

export class ParallelResearchProvider extends BackgroundBaseProvider {
  readonly id = 'parallel-research';
  readonly tier: ProviderTier = 'deep-research';
  readonly processor: string;
  private readonly options: unknown;
  constructor(
    options: BaseProviderOptions & {
      model?: string;
      configuredOptions?: unknown;
    } = {},
  ) {
    super(options);
    this.processor = options.model?.trim() || 'pro';
    this.options = options.configuredOptions ?? {};
  }
  async submit(
    query: string,
    options: ProviderOptions,
  ): Promise<AsyncTaskHandle> {
    const parsed = ParallelResearchOptionsSchema.safeParse(this.options);
    if (!parsed.success)
      throw new Error(`parallel-research options: ${parsed.error.message}`);
    if (!RESEARCH_PROCESSORS.has(this.processor))
      throw new Error(
        'parallel-research processor must be one of: pro, pro-fast, ultra, ultra-fast',
      );
    let response;
    try {
      response = await this.request<TaskRun>(`${API}/v1/tasks/runs`, {
        method: 'POST',
        headers: { 'x-api-key': this.getApiKey() },
        body: {
          input: query,
          processor: this.processor,
          task_spec: {
            output_schema: {
              type: 'text',
              description:
                'A thorough cited research report that directly answers the request.',
            },
          },
          ...(sourcePolicy(parsed.data) && {
            source_policy: sourcePolicy(parsed.data),
          }),
          ...(parsed.data.location && {
            advanced_settings: { location: parsed.data.location },
          }),
        },
        timeout: 30_000,
        signal: options.signal,
      });
    } catch (error) {
      throw new UnsafeToRetrySubmissionError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (response.status !== 202 && response.status !== 200)
      throw new UnsafeToRetrySubmissionError(
        this.formatError(response.status, response.data),
      );
    const parsedResponse = taskRunSchema.safeParse(response.data);
    if (!parsedResponse.success)
      throw new UnsafeToRetrySubmissionError(
        'Parallel accepted an invalid task response',
      );
    const id = text(parsedResponse.data.run_id);
    if (!id)
      throw new UnsafeToRetrySubmissionError(
        'Parallel accepted a task response without run_id',
      );
    // Creation establishes the remote identity used for every later request.
    // The returned handle therefore derives only from the validated response.
    const status = parsedResponse.data.status ?? 'queued';
    return {
      provider: this.id,
      taskId: id,
      query,
      submittedAt: Date.now(),
      status: STATUS[status] ?? 'pending',
      providerStatus: status,
      ...(STATUS[status]
        ? {}
        : { lastPollError: `Unknown Parallel task status: ${status}` }),
    };
  }
  async poll(handle: AsyncTaskHandle): Promise<AsyncPollResult> {
    const response = await this.request<TaskRun>(
      `${API}/v1/tasks/runs/${encodeURIComponent(handle.taskId)}`,
      {
        method: 'GET',
        headers: { 'x-api-key': this.getApiKey() },
        timeout: 15_000,
      },
    );
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
    const parsedResponse = taskRunSchema.safeParse(response.data);
    if (!parsedResponse.success)
      return {
        status: 'failed',
        rawStatus: 'invalid_response',
        message: 'Parallel returned an invalid task status response',
      };
    if (parsedResponse.data.run_id !== handle.taskId)
      return {
        status: 'failed',
        rawStatus: 'identity_mismatch',
        message: 'Parallel returned task status for a different run_id',
      };
    const rawStatus = parsedResponse.data.status;
    const status = STATUS[rawStatus];
    return status
      ? { status, rawStatus, message: parsedResponse.data.error?.message }
      : {
          status: handle.status === 'pending' ? 'pending' : 'running',
          rawStatus,
          message: `Unknown Parallel task status: ${rawStatus}`,
        };
  }
  async retrieve(handle: AsyncTaskHandle): Promise<ProviderResult> {
    const start = performance.now();
    try {
      const response = await this.request<TaskResult>(
        `${API}/v1/tasks/runs/${encodeURIComponent(handle.taskId)}/result`,
        {
          method: 'GET',
          headers: { 'x-api-key': this.getApiKey() },
          timeout: 30_000,
        },
      );
      const durationMs = Math.round(performance.now() - start);
      if (response.status !== 200)
        return this.errorResult(
          durationMs,
          `Retrieve failed with HTTP ${response.status}`,
        );
      const parsedResponse = taskResultSchema.safeParse(response.data);
      if (!parsedResponse.success)
        return this.errorResult(
          durationMs,
          'Parallel returned an invalid Task result response',
        );
      if (parsedResponse.data.run.run_id !== handle.taskId)
        return this.errorResult(
          durationMs,
          'Parallel returned Task result for a different run_id',
        );
      if (parsedResponse.data.run.status !== 'completed')
        return this.errorResult(
          durationMs,
          parsedResponse.data.run.error?.message ??
            `Task is not complete: status=${parsedResponse.data.run.status}`,
        );
      // This adapter requests a fixed text schema. Do not stringify unknown or
      // structured output into a fabricated successful report.
      const output = textTaskOutputSchema.safeParse(parsedResponse.data.output);
      if (!output.success)
        return this.errorResult(
          durationMs,
          'Parallel returned a completed Task without text output',
        );
      const content = output.data.content;
      const basis = basisMeta(output.data.basis);
      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations: citationsFromBasis(output.data.basis, this.id),
        durationMs,
        model: text(parsedResponse.data.run.processor) ?? this.processor,
        providerMeta: {
          'parallel:run_id': handle.taskId,
          ...(basis && { 'parallel:basis': basis }),
        },
      };
    } catch (error) {
      return this.errorResult(
        Math.round(performance.now() - start),
        this.formatCatchError(error),
      );
    }
  }
  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    try {
      const handle = await this.submit(query, options);
      const deadline = Date.now() + options.timeout * 1000;
      let state: AsyncPollResult = { status: handle.status };
      let last: string | undefined;
      while (
        !['completed', 'failed', 'cancelled'].includes(state.status) &&
        Date.now() < deadline
      ) {
        await sleep(5_000, options.signal);
        try {
          state = await this.poll(handle);
          handle.status = state.status;
          last = state.message;
        } catch (error) {
          last = error instanceof Error ? error.message : String(error);
        }
      }
      if (state.status !== 'completed')
        return this.errorResult(
          Math.round(performance.now() - start),
          last
            ? `Task did not complete: status=${state.status} (${last})`
            : `Task did not complete: status=${state.status}`,
        );
      const result = await this.retrieve(handle);
      result.durationMs = Math.round(performance.now() - start);
      return result;
    } catch (error) {
      return this.errorResult(
        Math.round(performance.now() - start),
        this.formatCatchError(error),
      );
    }
  }
  private errorResult(durationMs: number, error: string): ProviderResult {
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

function usage(value: ChatResponse['usage']): ProviderUsage | undefined {
  return value
    ? {
        inputTokens: value.prompt_tokens,
        outputTokens: value.completion_tokens,
        totalTokens: value.total_tokens,
      }
    : undefined;
}
