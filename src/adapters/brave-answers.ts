import { MAX_RESPONSE_SIZE } from '../constants.js';
import { getBuiltinProviderDefaultModel } from '../core/provider-descriptor.js';
import type {
  Citation,
  ProviderFailureDiagnostic,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BaseProvider } from './base.js';

const MAX_ERROR_BODY_SIZE = 256 * 1024;

const BRAVE_ANSWERS_URL =
  'https://api.search.brave.com/res/v1/chat/completions';
const BRAVE_ANSWERS_MODEL = getBuiltinProviderDefaultModel('brave-answers');

interface BraveStreamPayload {
  model?: string;
  choices?: Array<{
    delta?: { content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
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
    let requestStarted = false;

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
      requestStarted = true;
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
          // Live-verified: enable_citations is a top-level body parameter (the
          // OpenAI SDK passes it via extra_body); nesting it under
          // web_search_options silently disables citations.
          enable_citations: true,
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
      const usage = this.mergeUsage(
        this.usageFromInlineTag(parsed.usageTag),
        this.extractUsage(response.headers),
        streamed.tokenUsage,
      );

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
        error: 'Brave Answers request failed.',
        failureDiagnostic: this.catchDiagnostic(
          err,
          controller.signal.aborted,
          requestStarted,
        ),
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
      error: 'Brave Answers request failed.',
      failureDiagnostic: {
        kind: this.classifyBraveFailure(status, body),
        ...(this.validHttpStatus(status) !== undefined && {
          httpStatus: status,
        }),
      },
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

  private async readBounded(
    response: Response,
    limit: number,
  ): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let receivedBytes = 0;
    let text = '';
    while (receivedBytes < limit) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      if (!value) continue;
      receivedBytes += value.byteLength;
      const allowed = value.byteLength - Math.max(0, receivedBytes - limit);
      text += decoder.decode(value.subarray(0, allowed), { stream: true });
    }
    void reader.cancel().catch(() => {});
    return text + decoder.decode();
  }

  private async readStream(
    response: Response,
    signal: AbortSignal,
  ): Promise<{
    content: string;
    model?: string;
    tokenUsage?: { input?: number; output?: number };
  }> {
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
    let tokenUsage: { input?: number; output?: number } | undefined;

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

      // Live-verified: usage is null on every chunk except the final one,
      // which carries OpenAI-style token counts.
      if (this.isRecord(payload.usage)) {
        const input = this.finiteCount(payload.usage.prompt_tokens);
        const output = this.finiteCount(payload.usage.completion_tokens);
        if (input !== undefined || output !== undefined) {
          tokenUsage = { input, output };
        }
      }
    };

    let receivedBytes = 0;
    while (true) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await read());
      } catch (err) {
        // Best-effort cancel: never await it on a terminal error path — a
        // hung underlying source would otherwise swallow the primary error.
        void reader.cancel().catch(() => {});
        throw err;
      }
      if (done) break;
      if (!value) continue;

      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_RESPONSE_SIZE) {
        void reader.cancel().catch(() => {});
        throw new Error(`Response exceeds ${MAX_RESPONSE_SIZE} bytes`);
      }
      buffer += decoder.decode(value, { stream: true });
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

    return { content, model, tokenUsage };
  }

  private extractInlineMetadata(content: string): {
    content: string;
    citations: Citation[];
    usageTag?: JsonRecord;
  } {
    const citations: Citation[] = [];
    const seenUrls = new Set<string>();
    const output: string[] = [];
    const openTagPattern = /<(citation|enum_item|usage)>/g;
    let cursor = 0;
    let usageTag: JsonRecord | undefined;

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

      if (open[1] === 'usage' && this.isRecord(payload.value)) {
        // Live-verified: the stream's cost accounting (real dollars) arrives
        // as a trailing inline <usage> tag, not as response headers.
        usageTag = payload.value;
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
    return { content: output.join('').trim(), citations, usageTag };
  }

  /**
   * Finds the real closing tag for an inline metadata payload. A literal
   * closing tag can appear INSIDE the payload's JSON strings (titles and
   * snippets are web-derived), so the boundary is located with a linear
   * quote-and-escape-aware scan that ignores occurrences inside JSON strings.
   * Payloads that still fail to parse fall back to the first occurrence so
   * malformed tags are stripped from content rather than leaked.
   */
  private parseTagPayload(
    content: string,
    innerStart: number,
    closeTag: string,
  ): { value: unknown; end: number } {
    const boundary = this.findCloseTagOutsideStrings(
      content,
      innerStart,
      closeTag,
    );
    if (boundary !== -1) {
      try {
        return {
          value: JSON.parse(content.slice(innerStart, boundary).trim()),
          end: boundary + closeTag.length,
        };
      } catch {
        // Fall through to the malformed-payload fallback below.
      }
    }

    const first = content.indexOf(closeTag, innerStart);
    return {
      value: undefined,
      end: first === -1 ? -1 : first + closeTag.length,
    };
  }

  private findCloseTagOutsideStrings(
    content: string,
    from: number,
    closeTag: string,
  ): number {
    let inString = false;
    let escaped = false;
    for (let i = from; i < content.length; i++) {
      const char = content[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '<' && content.startsWith(closeTag, i)) return i;
    }
    return -1;
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

  /**
   * Live-verified stream accounting: Brave emits a trailing inline tag like
   * <usage>{"X-Request-Queries": 1, "X-Request-Tokens-In": 10631,
   * "X-Request-Total-Cost": 0.058585, ...}</usage>. The "-Cost" fields are
   * API-reported dollars, so they qualify for usage.costUsd under the
   * honest-data contract.
   */
  private usageFromInlineTag(tag: JsonRecord | undefined): {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    raw?: JsonRecord;
  } {
    if (!tag) return {};
    const lookup = new Map<string, unknown>();
    for (const [key, value] of Object.entries(tag)) {
      lookup.set(key.toLowerCase(), value);
    }
    const num = (key: string): number | undefined =>
      this.finiteCount(lookup.get(key));

    return {
      inputTokens: num('x-request-tokens-in'),
      outputTokens: num('x-request-tokens-out'),
      costUsd: num('x-request-total-cost'),
      raw: { streamUsage: tag },
    };
  }

  private mergeUsage(
    inline: {
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      raw?: JsonRecord;
    },
    headerUsage: ProviderUsage | undefined,
    streamTokens: { input?: number; output?: number } | undefined,
  ): ProviderUsage | undefined {
    const inputTokens =
      inline.inputTokens ?? streamTokens?.input ?? headerUsage?.inputTokens;
    const outputTokens =
      inline.outputTokens ?? streamTokens?.output ?? headerUsage?.outputTokens;
    const costUsd = inline.costUsd ?? headerUsage?.costUsd;
    const headerRaw = this.isRecord(headerUsage?.raw) ? headerUsage.raw : {};
    const raw: JsonRecord = { ...headerRaw, ...inline.raw };

    if (
      inputTokens === undefined &&
      outputTokens === undefined &&
      costUsd === undefined &&
      Object.keys(raw).length === 0
    ) {
      return undefined;
    }

    return {
      inputTokens,
      outputTokens,
      totalTokens:
        inputTokens !== undefined && outputTokens !== undefined
          ? inputTokens + outputTokens
          : undefined,
      costUsd,
      raw,
    };
  }

  private finiteCount(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
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

  private classifyBraveFailure(
    status: number,
    body: unknown,
  ): ProviderFailureDiagnostic['kind'] {
    // Live-verified: Brave reports an invalid key as 422 and a key whose plan
    // lacks the Answers option as 400, so classify by code first. The code is
    // inspected in memory but is never returned or persisted.
    const code = this.braveErrorCode(body);
    if (code === 'SUBSCRIPTION_TOKEN_INVALID') {
      return 'authentication';
    }
    if (code === 'OPTION_NOT_IN_PLAN') {
      return 'plan_required';
    }
    if (status === 401 || status === 403) return 'authentication';
    if (status === 402) return 'billing';
    if (status === 408 || status === 504) return 'timeout';
    if (status === 429) return 'rate_limit';
    if (status >= 400 && status < 500) return 'invalid_request';
    return 'provider';
  }

  private catchDiagnostic(
    err: unknown,
    aborted: boolean,
    requestStarted: boolean,
  ): ProviderFailureDiagnostic {
    if (!requestStarted) return { kind: 'authentication' };
    if (aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      return { kind: 'timeout' };
    }
    if (err instanceof TypeError) return { kind: 'network' };
    return { kind: 'provider' };
  }

  private validHttpStatus(status: number): number | undefined {
    return Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : undefined;
  }

  private braveErrorCode(body: unknown): string | undefined {
    if (!this.isRecord(body)) return undefined;
    const error = body.error;
    if (!this.isRecord(error)) return undefined;
    return this.firstString(error.code);
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
