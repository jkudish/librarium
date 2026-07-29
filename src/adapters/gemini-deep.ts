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
import { BaseProvider } from './base.js';

/**
 * Citation annotation attached to a TextContent block.
 * The Interactions API embeds grounding sources as annotations on text spans
 * (url_citation / file_citation / place_citation), each carrying a real URL.
 */
interface InteractionAnnotation {
  type: string;
  url?: string;
  title?: string;
  // file_citation
  document_uri?: string;
  file_name?: string;
  // place_citation
  place_id?: string;
  name?: string;
  start_index?: number;
  end_index?: number;
}

interface InteractionContentBlock {
  type: string;
  text?: string;
  annotations?: InteractionAnnotation[];
}

interface InteractionStep {
  type: string;
  content?: InteractionContentBlock[];
}

interface InteractionUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_tokens?: number;
}

interface InteractionResponse {
  id: string;
  status: string;
  agent?: string;
  model?: string;
  output_text?: string;
  steps?: InteractionStep[];
  usage?: InteractionUsage;
  created?: string;
  updated?: string;
  error?: { code?: string; message?: string };
}

interface GeminiDeepProviderOptions {
  model?: string;
}

const INTERACTIONS_URL =
  'https://generativelanguage.googleapis.com/v1beta/interactions';

/**
 * API revision pin for the Interactions endpoint family. Sent on every request
 * so the response shape stays stable as the preview evolves.
 */
const API_REVISION = '2026-05-20';

/**
 * Default Deep Research agent. The `model` config override accepts the heavier
 * `deep-research-max-preview-04-2026` variant (documented in the README).
 */
const DEFAULT_GEMINI_DEEP_AGENT = 'deep-research-preview-04-2026';

const STATUS_MAP: Record<string, AsyncTaskStatus> = {
  in_progress: 'running',
  requires_action: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  incomplete: 'failed',
  budget_exceeded: 'failed',
};

/**
 * Gemini Deep Research provider.
 * Uses Google's real Deep Research agent via the Interactions API
 * (POST /v1beta/interactions with background: true). A single request triggers
 * an autonomous loop of planning, searching, reading, and reasoning that runs
 * server-side for minutes; results are polled and retrieved by interaction id.
 * Tier: deep-research (true async).
 */
export class GeminiDeepProvider extends BaseProvider {
  readonly id = 'gemini-deep';
  readonly tier: ProviderTier = 'deep-research';
  readonly model: string;

  constructor(options: GeminiDeepProviderOptions = {}) {
    super();
    this.model = options.model?.trim() || DEFAULT_GEMINI_DEEP_AGENT;
  }

  private authHeaders(apiKey: string): Record<string, string> {
    return {
      'x-goog-api-key': apiKey,
      'Api-Revision': API_REVISION,
    };
  }

  /**
   * Sync entry point: submit then poll inline until completion or asyncTimeout.
   * Mirrors other async deep-research adapters so `--mode sync` works the same way.
   */
  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();

    try {
      const handle = await this.submit(query, options);

      const deadline = Date.now() + options.timeout * 1000;
      let pollResult: AsyncPollResult = { status: handle.status };
      let lastPollError: string | undefined;

      while (
        pollResult.status !== 'completed' &&
        pollResult.status !== 'failed' &&
        pollResult.status !== 'cancelled' &&
        Date.now() < deadline
      ) {
        await this.sleep(5000);
        try {
          pollResult = await this.poll(handle);
          handle.status = pollResult.status;
          lastPollError = undefined;
        } catch (pollErr) {
          // Retryable poll failure: the interaction may still be running.
          // Keep polling until the deadline instead of abandoning a paid
          // background task over a transport blip.
          lastPollError =
            pollErr instanceof Error ? pollErr.message : String(pollErr);
        }

        if (options.signal?.aborted) {
          throw new Error('Request aborted');
        }
      }

      if (pollResult.status !== 'completed') {
        const durationMs = Math.round(performance.now() - start);
        const detail = pollResult.message ?? lastPollError;
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs,
          error: detail
            ? `Task did not complete: status=${pollResult.status} (${detail})`
            : `Task did not complete: status=${pollResult.status}`,
        };
      }

      const result = await this.retrieve(handle);
      result.durationMs = Math.round(performance.now() - start);
      return result;
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      return {
        provider: this.id,
        tier: this.tier,
        content: '',
        citations: [],
        durationMs,
        error: this.formatCatchError(err),
      };
    }
  }

  /**
   * Submit a background interaction. Returns a real pending handle (the
   * interaction id); the dispatcher queues it and `librarium status` polls and
   * retrieves it. Throws on submission failure so the dispatcher falls back to
   * sync execution (mirrors the other async deep-research adapters).
   */
  async submit(
    query: string,
    _options: ProviderOptions,
  ): Promise<AsyncTaskHandle> {
    const apiKey = this.getApiKey();

    const response = await this.request<InteractionResponse>(INTERACTIONS_URL, {
      method: 'POST',
      headers: this.authHeaders(apiKey),
      body: {
        input: query,
        agent: this.model,
        // Background is MANDATORY for the deep-research agent.
        background: true,
        agent_config: {
          type: 'deep-research',
          thinking_summaries: 'auto',
        },
        tools: [{ type: 'google_search' }],
      },
      timeout: 30000,
    });

    if (response.status !== 200 && response.status !== 201) {
      throw new Error(this.formatError(response.status, response.data));
    }

    const data = response.data;
    return {
      provider: this.id,
      taskId: data.id,
      query,
      submittedAt: Date.now(),
      status: STATUS_MAP[data.status] ?? 'pending',
      providerStatus: data.status,
      ...(STATUS_MAP[data.status]
        ? {}
        : {
            lastPollError: `Unknown Gemini interaction status: ${data.status}`,
          }),
    };
  }

  async poll(handle: AsyncTaskHandle): Promise<AsyncPollResult> {
    const apiKey = this.getApiKey();

    const response = await this.request<InteractionResponse>(
      `${INTERACTIONS_URL}/${handle.taskId}`,
      {
        method: 'GET',
        headers: this.authHeaders(apiKey),
        timeout: 15000,
      },
    );

    if (response.status !== 200) {
      // Retryable transport failures (timeouts, rate limits, 5xx, gateway
      // blips): the interaction may still be running server-side. Throw so
      // the caller retries on the next poll.
      if (
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        throw new Error(`Poll returned HTTP ${response.status}`);
      }
      // Non-retryable client errors (400/401/403/404...): retrying forever
      // cannot help; surface a terminal failure with the status.
      return {
        status: 'failed',
        message: `Poll returned HTTP ${response.status}`,
      };
    }

    const data = response.data;
    const status = STATUS_MAP[data.status];
    if (!status) {
      return {
        status: handle.status === 'pending' ? 'pending' : 'running',
        rawStatus: data.status,
        message: `Unknown Gemini interaction status: ${data.status}`,
      };
    }
    return {
      status,
      rawStatus: data.status,
      message: data.error?.message ?? undefined,
    };
  }

  async retrieve(handle: AsyncTaskHandle): Promise<ProviderResult> {
    const apiKey = this.getApiKey();
    const start = performance.now();

    try {
      const response = await this.request<InteractionResponse>(
        `${INTERACTIONS_URL}/${handle.taskId}`,
        {
          method: 'GET',
          headers: this.authHeaders(apiKey),
          timeout: 30000,
        },
      );

      if (response.status !== 200) {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs: Math.round(performance.now() - start),
          error: `Retrieve failed with HTTP ${response.status}`,
        };
      }

      const data = response.data;
      const status = STATUS_MAP[data.status] ?? 'running';

      if (status === 'failed') {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs: this.taskDurationMs(data, start),
          error: data.error?.message ?? `Interaction failed (${data.status})`,
        };
      }

      if (status !== 'completed') {
        return {
          provider: this.id,
          tier: this.tier,
          content: '',
          citations: [],
          durationMs: Math.round(performance.now() - start),
          error: `Task ${handle.taskId} is not completed yet (status: ${data.status})`,
        };
      }

      const { content, citations } = this.extractOutput(data);

      return {
        provider: this.id,
        tier: this.tier,
        content,
        citations,
        durationMs: this.taskDurationMs(data, start),
        model: data.agent ?? data.model ?? this.model,
        tokenUsage: {
          input: data.usage?.total_input_tokens,
          output: data.usage?.total_output_tokens,
        },
        usage: this.extractUsage(data.usage),
      };
    } catch (err) {
      return {
        provider: this.id,
        tier: this.tier,
        content: '',
        citations: [],
        durationMs: Math.round(performance.now() - start),
        error: this.formatCatchError(err),
      };
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const apiKey = this.getApiKey();
      // Creating an interaction is a billable deep-research run, so verify the
      // key cheaply against the models list endpoint instead (same pattern as
      // async research models, whose model availability cannot be pinged directly).
      const response = await this.request(
        'https://generativelanguage.googleapis.com/v1beta/models',
        {
          method: 'GET',
          headers: { 'x-goog-api-key': apiKey },
          timeout: 10000,
        },
      );

      if (response.status === 200) return { ok: true };
      return { ok: false, error: `HTTP ${response.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Final report text plus citations. Prefer the SDK-style `output_text`
   * convenience field; fall back to concatenating text blocks from the
   * model_output steps. Citations come from url_citation / file_citation /
   * place_citation annotations attached to those text blocks.
   */
  private extractOutput(data: InteractionResponse): {
    content: string;
    citations: Citation[];
  } {
    const citations: Citation[] = [];
    const seen = new Set<string>();
    const textParts: string[] = [];

    for (const step of data.steps ?? []) {
      if (step.type !== 'model_output' || !step.content) continue;
      for (const block of step.content) {
        if (typeof block.text === 'string' && block.text.length > 0) {
          textParts.push(block.text);
        }
        for (const ann of block.annotations ?? []) {
          const citation = this.annotationToCitation(ann);
          if (citation && !seen.has(citation.url)) {
            seen.add(citation.url);
            citations.push(citation);
          }
        }
      }
    }

    const content =
      typeof data.output_text === 'string' && data.output_text.length > 0
        ? data.output_text
        : textParts.join('\n');

    return { content, citations };
  }

  /** Map an annotation to a librarium Citation, extracting a real URL. */
  private annotationToCitation(
    ann: InteractionAnnotation,
  ): Citation | undefined {
    if (ann.type === 'url_citation' && ann.url) {
      return { url: ann.url, title: ann.title, provider: this.id };
    }
    if (ann.type === 'place_citation' && ann.url) {
      return { url: ann.url, title: ann.name ?? ann.title, provider: this.id };
    }
    if (ann.type === 'file_citation' && ann.document_uri) {
      return {
        url: ann.document_uri,
        title: ann.file_name ?? ann.title,
        provider: this.id,
      };
    }
    return undefined;
  }

  /**
   * Server-side task duration from ISO timestamps when present, else local
   * elapsed. The API does not always advance `updated` to the completion time
   * (observed equal to `created` on completed interactions), so a non-advancing
   * pair falls back to local elapsed rather than reporting a misleading 0.
   */
  private taskDurationMs(
    data: InteractionResponse,
    localStart: number,
  ): number {
    const begin = data.created ? Date.parse(data.created) : Number.NaN;
    const end = data.updated ? Date.parse(data.updated) : Number.NaN;
    if (!Number.isNaN(begin) && !Number.isNaN(end) && end > begin) {
      return end - begin;
    }
    return Math.round(performance.now() - localStart);
  }

  private extractUsage(usage?: InteractionUsage): ProviderUsage | undefined {
    if (!usage) return undefined;
    return {
      inputTokens: usage.total_input_tokens,
      outputTokens: usage.total_output_tokens,
      totalTokens: usage.total_tokens,
      raw: usage,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
