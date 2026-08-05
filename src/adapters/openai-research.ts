import { UnsafeToRetrySubmissionError } from '../core/errors.js';
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
import { BackgroundBaseProvider, type BaseProviderOptions } from './base.js';

interface OpenAIAnnotation {
  type: string;
  url?: string;
  title?: string;
}

interface OpenAIContentPart {
  type: string;
  text?: string;
  annotations?: OpenAIAnnotation[];
}

interface OpenAIOutputItem {
  type: string;
  content?: OpenAIContentPart[];
}

interface OpenAIUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface OpenAIResponseBody {
  id: string;
  status: string;
  output?: OpenAIOutputItem[];
  model?: string;
  usage?: OpenAIUsage;
  error?: { message?: string; code?: string };
}

export interface OpenAIResearchProviderOptions extends BaseProviderOptions {
  model?: string;
  maxToolCalls?: unknown;
  reasoningEffort?: unknown;
  returnTokenBudget?: unknown;
}

const DEFAULT_MODEL = 'gpt-5.6-sol';
const REASONING_EFFORTS = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
const RETURN_TOKEN_BUDGETS = ['default', 'unlimited'] as const;
type ReturnTokenBudget = (typeof RETURN_TOKEN_BUDGETS)[number];

const STATUS_MAP: Record<string, AsyncTaskStatus> = {
  queued: 'pending',
  in_progress: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  incomplete: 'failed',
};

function parseMaxToolCalls(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  throw new Error(
    'openai-research options.maxToolCalls must be a positive integer',
  );
}

function parseReasoningEffort(value: unknown): ReasoningEffort {
  if (value === undefined) return 'xhigh';
  if (
    typeof value === 'string' &&
    REASONING_EFFORTS.includes(value as ReasoningEffort)
  ) {
    return value as ReasoningEffort;
  }
  throw new Error(
    `openai-research options.reasoningEffort must be one of: ${REASONING_EFFORTS.join(', ')}`,
  );
}

function parseReturnTokenBudget(value: unknown): ReturnTokenBudget {
  if (value === undefined) return 'default';
  if (
    typeof value === 'string' &&
    RETURN_TOKEN_BUDGETS.includes(value as ReturnTokenBudget)
  ) {
    return value as ReturnTokenBudget;
  }
  throw new Error(
    `openai-research options.returnTokenBudget must be one of: ${RETURN_TOKEN_BUDGETS.join(', ')}`,
  );
}

/**
 * OpenAI async research through the Responses API. This deliberately accepts
 * exactly the configured model: a rejected model is an actionable API error,
 * never an opportunity to silently substitute a retired research model.
 */
export class OpenAIResearchProvider extends BackgroundBaseProvider {
  readonly id = 'openai-research';
  readonly tier: ProviderTier = 'deep-research';
  readonly model: string;
  private readonly configuredMaxToolCalls?: unknown;
  private readonly configuredReasoningEffort?: unknown;
  private readonly configuredReturnTokenBudget?: unknown;

  constructor(options: OpenAIResearchProviderOptions = {}) {
    super(options);
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.configuredMaxToolCalls = options.maxToolCalls;
    this.configuredReasoningEffort = options.reasoningEffort;
    this.configuredReturnTokenBudget = options.returnTokenBudget;
  }

  get maxToolCalls(): number | undefined {
    return parseMaxToolCalls(this.configuredMaxToolCalls);
  }

  get reasoningEffort(): ReasoningEffort {
    return parseReasoningEffort(this.configuredReasoningEffort);
  }

  get returnTokenBudget(): ReturnTokenBudget {
    return parseReturnTokenBudget(this.configuredReturnTokenBudget);
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    try {
      const handle = await this.submit(query, options);
      const deadline = Date.now() + options.timeout * 1000;
      let poll: AsyncPollResult = { status: handle.status };
      let lastPollError: string | undefined;

      while (!isTerminal(poll.status) && Date.now() < deadline) {
        await sleep(5000, options.signal);
        try {
          poll = await this.poll(handle);
          handle.status = poll.status;
          lastPollError = poll.message;
        } catch (error) {
          lastPollError =
            error instanceof Error ? error.message : String(error);
        }
      }

      if (poll.status !== 'completed') {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs: Math.round(performance.now() - start),
          error: lastPollError
            ? `Task did not complete: status=${poll.status} (${lastPollError})`
            : `Task did not complete: status=${poll.status}`,
        };
      }

      const result = await this.retrieve(handle);
      result.durationMs = Math.round(performance.now() - start);
      return result;
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

  async submit(
    query: string,
    options: ProviderOptions,
  ): Promise<AsyncTaskHandle> {
    const apiKey = this.getApiKey();
    let response;
    try {
      response = await this.request<OpenAIResponseBody>(
        'https://api.openai.com/v1/responses',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: {
            model: this.model,
            input: [{ role: 'user', content: query }],
            tools: [
              {
                type: 'web_search',
                return_token_budget: this.returnTokenBudget,
              },
            ],
            reasoning: { effort: this.reasoningEffort },
            ...(this.maxToolCalls ? { max_tool_calls: this.maxToolCalls } : {}),
            background: true,
          },
          timeout: 30000,
          signal: options.signal,
        },
      );
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

    const status = mapStatus(response.data.status);
    return {
      provider: this.id,
      taskId: response.data.id,
      query,
      submittedAt: Date.now(),
      status: status ?? 'pending',
      providerStatus: response.data.status,
      ...(status
        ? {}
        : {
            lastPollError: `Unknown OpenAI response status: ${response.data.status}`,
          }),
    };
  }

  async poll(handle: AsyncTaskHandle): Promise<AsyncPollResult> {
    const apiKey = this.getApiKey();
    const response = await this.request<OpenAIResponseBody>(
      `https://api.openai.com/v1/responses/${handle.taskId}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15000,
      },
    );

    if (response.status !== 200) {
      if (
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        throw new Error(`Poll returned HTTP ${response.status}`);
      }
      return {
        status: 'failed',
        rawStatus: `http_${response.status}`,
        message: `Poll returned HTTP ${response.status}`,
      };
    }

    const data = response.data;
    const mapped = mapStatus(data.status);
    if (!mapped) {
      return {
        // Preserve the active state while making the unexpected remote value
        // visible and retryable rather than silently treating it as running.
        status: handle.status === 'pending' ? 'pending' : 'running',
        rawStatus: data.status,
        message: `Unknown OpenAI response status: ${data.status}`,
      };
    }
    return {
      status: mapped,
      rawStatus: data.status,
      message: data.error?.message,
    };
  }

  async retrieve(handle: AsyncTaskHandle): Promise<ProviderResult> {
    const start = performance.now();
    try {
      const apiKey = this.getApiKey();
      const response = await this.request<OpenAIResponseBody>(
        `https://api.openai.com/v1/responses/${handle.taskId}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 30000,
        },
      );
      const durationMs = Math.round(performance.now() - start);
      if (response.status !== 200) {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: `Retrieve failed with HTTP ${response.status}`,
        };
      }
      const data = response.data;
      const status = mapStatus(data.status);
      if (status !== 'completed') {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error:
            data.error?.message ??
            `Task is not complete: status=${data.status}`,
        };
      }
      const { content, citations } = extractOutput(data, this.id);
      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations,
        durationMs,
        model: data.model ?? this.model,
        tokenUsage: {
          input: data.usage?.input_tokens,
          output: data.usage?.output_tokens,
        },
        usage: extractUsage(data.usage),
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

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const apiKey = this.getApiKey();
      const response = await this.request(
        `https://api.openai.com/v1/models/${encodeURIComponent(this.model)}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 10000,
        },
      );
      return response.status === 200
        ? { ok: true }
        : { ok: false, error: `Model ${this.model}: HTTP ${response.status}` };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function mapStatus(status: string): AsyncTaskStatus | undefined {
  return STATUS_MAP[status];
}

function isTerminal(status: AsyncTaskStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Request aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error('Request aborted'));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function extractOutput(
  data: OpenAIResponseBody,
  provider: string,
): { content: string; citations: Citation[] } {
  const contentParts: string[] = [];
  const citations: Citation[] = [];
  for (const item of data.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part.text) contentParts.push(part.text);
      for (const annotation of part.annotations ?? []) {
        if (annotation.type === 'url_citation' && annotation.url) {
          citations.push({
            url: annotation.url,
            title: annotation.title,
            provider,
          });
        }
      }
    }
  }
  return { content: contentParts.join('\n'), citations };
}

function extractUsage(usage?: OpenAIUsage): ProviderUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    raw: usage,
  };
}
