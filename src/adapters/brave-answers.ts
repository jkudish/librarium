import { MAX_RESPONSE_SIZE } from '../constants.js';
import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BaseProvider } from './base.js';

const MAX_ERROR_BODY_SIZE = 256 * 1024;

const BRAVE_ANSWERS_URL =
  'https://api.search.brave.com/res/v1/chat/completions';
const BRAVE_ANSWERS_MODEL = 'brave';

interface BraveStreamPayload {
  model?: string;
  choices?: Array<{
    delta?: { content?: string };
  }>;
}

type JsonRecord = Record<string, unknown>;

/**
 * Brave AI Answers provider.
 * Uses Brave's OpenAI-compatible Answers API with streaming enabled because
 * citations are emitted as inline metadata in the streamed response.
 * Tier: ai-grounded (sync)
 */
export class BraveAnswersProvider extends BaseProvider {
  readonly id = 'brave-answers';
  readonly tier: ProviderTier = 'ai-grounded';

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      options.timeout * 1000,
    );
    const abortFromCaller = () => controller.abort();

    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else {
        options.signal.addEventListener('abort', abortFromCaller, {
          once: true,
        });
      }
    }

    try {
      const apiKey = this.getApiKey();
      const response = await fetch(BRAVE_ANSWERS_URL, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          'X-Subscription-Token': apiKey,
        },
        body: JSON.stringify({
          model: BRAVE_ANSWERS_MODEL,
          messages: [{ role: 'user', content: query }],
          stream: true,
          web_search_options: {
            enable_citations: true,
          },
        }),
        signal: controller.signal,
      });

      const durationMs = Math.round(performance.now() - start);

      if (!response.ok) {
        return this.errorResult(
          durationMs,
          response.status,
          await this.readErrorBody(response),
        );
      }

      const streamed = await this.readStream(response, controller.signal);
      const parsed = this.extractInlineMetadata(streamed.content);
      const usage = this.extractUsage(response.headers);

      return {
        provider: this.id,
        tier: this.tier,
        content: parsed.content,
        citations: parsed.citations,
        durationMs: Math.round(performance.now() - start),
        model: streamed.model ?? BRAVE_ANSWERS_MODEL,
        tokenUsage:
          usage?.inputTokens !== undefined || usage?.outputTokens !== undefined
            ? {
                input: usage.inputTokens,
                output: usage.outputTokens,
              }
            : undefined,
        usage,
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
    } finally {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    // Streaming is required for Answers citations, so this inexpensive short
    // request validates the exact capability execute() depends on.
    const result = await this.execute('ping', { timeout: 10 });
    if (!result.error) return { ok: true };
    return { ok: false, error: result.error };
  }

  private errorResult(
    durationMs: number,
    status: number,
    body: unknown,
  ): ProviderResult {
    return {
      provider: this.id,
      tier: this.tier,
      content: '',
      citations: [],
      durationMs,
      error: this.formatBraveError(status, body),
    };
  }

  private async readErrorBody(response: Response): Promise<unknown> {
    const text = await this.readBounded(response, MAX_ERROR_BODY_SIZE);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private async readBounded(response: Response, limit: number): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (text.length <= limit) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    return text.slice(0, limit);
  }

  private async readStream(
    response: Response,
    signal: AbortSignal,
  ): Promise<{ content: string; model?: string }> {
    if (!response.body) return { content: '' };

    const reader = response.body.getReader();
    // Race every read against the abort signal so a hung stream that never
    // yields (or a body that ignores fetch's abort wiring) still terminates.
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(new Error('The operation was aborted'));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });
    aborted.catch(() => {});
    const read = () => Promise.race([reader.read(), aborted]);
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let model: string | undefined;

    const consumeEvent = (event: string): void => {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');

      if (!data || data === '[DONE]') return;

      let payload: BraveStreamPayload;
      try {
        payload = JSON.parse(data) as BraveStreamPayload;
      } catch {
        // A single malformed frame must not discard an otherwise-complete
        // answer; skip it and keep consuming the stream.
        return;
      }

      if (typeof payload.model === 'string') model = payload.model;
      const delta = payload.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') content += delta;
    };

    while (true) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await read());
      } catch (err) {
        await reader.cancel().catch(() => {});
        throw err;
      }
      if (done) break;
      if (!value) continue;

      buffer += decoder.decode(value, { stream: true });
      if (content.length + buffer.length > MAX_RESPONSE_SIZE) {
        await reader.cancel();
        throw new Error(`Response exceeds ${MAX_RESPONSE_SIZE} bytes`);
      }
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const separatorLength = buffer.startsWith('\r\n', boundary) ? 4 : 2;
        consumeEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + separatorLength);
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) consumeEvent(buffer);

    return { content, model };
  }

  private extractInlineMetadata(content: string): {
    content: string;
    citations: Citation[];
  } {
    const citations: Citation[] = [];
    const seenUrls = new Set<string>();
    const output: string[] = [];
    const openTagPattern = /<(citation|enum_item)>/g;
    let cursor = 0;

    let open = openTagPattern.exec(content);
    while (open) {
      output.push(content.slice(cursor, open.index));
      const payload = this.parseTagPayload(
        content,
        open.index + open[0].length,
        `</${open[1]}>`,
      );

      if (payload.end === -1) {
        // Unclosed tag: everything after it is truncated metadata, not answer
        // text — drop it rather than leaking raw payload into the content.
        cursor = content.length;
        break;
      }

      if (
        open[1] === 'citation' &&
        this.isRecord(payload.value) &&
        typeof payload.value.url === 'string'
      ) {
        const metadata = payload.value;
        const url = metadata.url as string;
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          citations.push({
            url,
            title: this.firstString(
              metadata.title,
              metadata.source,
              metadata.name,
            ),
            snippet: this.firstString(metadata.snippet, metadata.description),
            provider: this.id,
          });
        }
      }

      cursor = payload.end;
      openTagPattern.lastIndex = cursor;
      open = openTagPattern.exec(content);
    }

    output.push(content.slice(cursor));
    return { content: output.join('').trim(), citations };
  }

  /**
   * Finds the real closing tag for an inline metadata payload. A literal
   * closing tag can appear INSIDE the payload's JSON strings (titles and
   * snippets are web-derived), so the first close-tag occurrence is only
   * accepted once the enclosed span parses as JSON; otherwise scanning
   * continues to the next occurrence. Payloads that never parse fall back to
   * the first occurrence so malformed tags are still stripped from content.
   */
  private parseTagPayload(
    content: string,
    innerStart: number,
    closeTag: string,
  ): { value: unknown; end: number } {
    let searchFrom = innerStart;
    let fallbackEnd = -1;
    for (let attempts = 0; attempts < 32; attempts++) {
      const candidate = content.indexOf(closeTag, searchFrom);
      if (candidate === -1) break;
      if (fallbackEnd === -1) fallbackEnd = candidate + closeTag.length;
      try {
        return {
          value: JSON.parse(content.slice(innerStart, candidate).trim()),
          end: candidate + closeTag.length,
        };
      } catch {
        searchFrom = candidate + closeTag.length;
      }
    }
    return { value: undefined, end: fallbackEnd };
  }

  private extractUsage(headers: Headers): ProviderUsage | undefined {
    const requestQueries = this.headerNumber(headers, 'x-request-queries');
    const requestRequests = this.headerNumber(headers, 'x-request-requests');
    const inputTokens = this.headerNumber(headers, 'x-request-tokens-in');
    const outputTokens = this.headerNumber(headers, 'x-request-tokens-out');
    const costBreakdown = headers.get('x-request-cost-breakdown');
    const reportedCostUsd = this.extractReportedCostUsd(headers, costBreakdown);
    const raw: JsonRecord = {};

    if (requestQueries !== undefined) raw.requestQueries = requestQueries;
    if (requestRequests !== undefined) raw.requestRequests = requestRequests;
    if (inputTokens !== undefined) raw.requestTokensIn = inputTokens;
    if (outputTokens !== undefined) raw.requestTokensOut = outputTokens;
    if (costBreakdown !== null) raw.requestCostBreakdown = costBreakdown;

    if (Object.keys(raw).length === 0 && reportedCostUsd === undefined) {
      return undefined;
    }

    return {
      inputTokens,
      outputTokens,
      totalTokens:
        inputTokens !== undefined && outputTokens !== undefined
          ? inputTokens + outputTokens
          : undefined,
      costUsd: reportedCostUsd,
      raw,
    };
  }

  private extractReportedCostUsd(
    headers: Headers,
    costBreakdown: string | null,
  ): number | undefined {
    for (const header of ['x-request-cost-usd', 'x-request-total-cost-usd']) {
      const value = this.headerNumber(headers, header);
      if (value !== undefined) return value;
    }

    if (costBreakdown === null) return undefined;
    try {
      return this.findExplicitUsd(JSON.parse(costBreakdown) as unknown);
    } catch {
      return undefined;
    }
  }

  private findExplicitUsd(value: unknown): number | undefined {
    if (!this.isRecord(value)) return undefined;
    for (const key of ['cost_usd', 'costUsd', 'total_usd', 'totalUsd', 'usd']) {
      const candidate = value[key];
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return candidate;
      }
    }
    for (const nested of Object.values(value)) {
      const found = this.findExplicitUsd(nested);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private headerNumber(headers: Headers, name: string): number | undefined {
    const value = headers.get(name);
    if (value === null || value.trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }

  private formatBraveError(status: number, body: unknown): string {
    const detail = this.braveErrorDetail(body);
    const base = `Brave Answers API returned ${status}: ${detail}`;

    if (status === 401) {
      return `${base} — check that ${this.envVar} is valid and enabled for the Brave Answers plan`;
    }
    if (status === 402) {
      return `${base} — Payment Required; check your Brave billing and Answers plan`;
    }
    if (status === 403) {
      return `${base} — API key may lack permission for the Answers API`;
    }
    if (status === 404) {
      return `${base} — confirm the Brave Answers API endpoint is available for your plan`;
    }
    if (status === 422) {
      return `${base} — request validation failed; review the request and try a shorter query`;
    }
    if (status === 429) {
      return `${base} — rate limit reached; reduce request rate and retry`;
    }
    if (status === 400) {
      return `${base} — check the request parameters`;
    }
    return base;
  }

  private braveErrorDetail(body: unknown): string {
    if (this.isRecord(body)) {
      const error = body.error;
      if (this.isRecord(error)) {
        const detail = this.firstString(error.detail);
        if (detail) return detail;
        const code = this.firstString(error.code);
        if (code) return code;
      }
      const type = this.firstString(body.type);
      if (type) return type;
      if (typeof error === 'string' && error.trim()) return error;
    }
    return this.truncateBody(body);
  }

  private truncateBody(body: unknown): string {
    let serialized: string;
    try {
      serialized = typeof body === 'string' ? body : JSON.stringify(body);
    } catch {
      serialized = String(body);
    }
    return (serialized || 'unknown error response').slice(0, 200);
  }

  private isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private firstString(...values: unknown[]): string | undefined {
    return values.find(
      (value): value is string =>
        typeof value === 'string' && value.trim() !== '',
    );
  }
}
