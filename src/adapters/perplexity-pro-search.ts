import type {
  Citation,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
  ProviderUsage,
} from '../types.js';
import { BaseProvider } from './base.js';

const PERPLEXITY_PRO_SEARCH_URL = 'https://api.perplexity.ai/v1/sonar';
const SONAR_PRO_MODEL = 'sonar-pro';

type JsonRecord = Record<string, unknown>;

interface PerplexitySearchResult {
  title?: string;
  url: string;
  snippet?: string;
}

interface PerplexityUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: {
    total_cost?: number;
  };
}

interface ParsedProSearchStream {
  content: string;
  citations: Citation[];
  model: string;
  usage: ProviderUsage;
}

/**
 * Forced Perplexity Pro Search provider.
 *
 * Pro Search is a distinct capability from ordinary Sonar Pro: it requires a
 * streaming request, explicit search_type=pro, and the Pro reasoning/completion
 * lifecycle. This adapter fails closed when those invariants are not visible.
 */
export class PerplexityProSearchProvider extends BaseProvider {
  readonly id = 'perplexity-pro-search';
  readonly tier: ProviderTier = 'ai-grounded';

  override get displayName(): string {
    return 'Perplexity Pro Search';
  }

  override get envVar(): string {
    return 'PERPLEXITY_API_KEY';
  }

  async execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult> {
    const start = performance.now();
    let apiKey: string | undefined;

    try {
      apiKey = this.getApiKey();
      const response = await this.streamRequest(PERPLEXITY_PRO_SEARCH_URL, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model: SONAR_PRO_MODEL,
          messages: [{ role: 'user', content: query }],
          stream: true,
          stream_mode: 'concise',
          web_search_options: { search_type: 'pro' },
        },
        timeout: options.timeout * 1000,
        signal: options.signal,
        retry: { mode: 'never' },
      });

      if (response.status !== 200) {
        const errorBody = await this.readBody(response.body);
        return this.errorResult(
          start,
          this.formatProviderError(
            response.status,
            this.parseBody(errorBody),
            apiKey,
          ),
        );
      }

      const contentType = this.header(response.headers, 'content-type');
      if (!contentType?.toLowerCase().includes('text/event-stream')) {
        await response.body.cancel().catch(() => {});
        return this.errorResult(
          start,
          'Perplexity Pro Search returned a non-streaming response',
        );
      }

      const streamed = await this.parseStream(response.body, apiKey);
      return {
        provider: this.id,
        tier: this.tier,
        content: streamed.content,
        citations: streamed.citations,
        durationMs: Math.round(performance.now() - start),
        model: streamed.model,
        tokenUsage: {
          input: streamed.usage.inputTokens,
          output: streamed.usage.outputTokens,
        },
        usage: streamed.usage,
      };
    } catch (error) {
      return this.errorResult(
        start,
        redactPerplexityError(this.formatCatchError(error), apiKey),
      );
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    const result = await this.execute('ping', { timeout: 10 });
    return result.error ? { ok: false, error: result.error } : { ok: true };
  }

  private async parseStream(
    body: ReadableStream<Uint8Array>,
    apiKey: string,
  ): Promise<ParsedProSearchStream> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let model: string | undefined;
    let reasoningDone = false;
    let completionChunkSeen = false;
    let terminalSeen = false;
    let doneMarkerSeen = false;
    let usage: ProviderUsage | undefined;
    let terminalContent: string | undefined;
    let terminalSearchResults: PerplexitySearchResult[] = [];
    let terminalCitationUrls: string[] = [];

    const consumeEvent = (eventBlock: string): void => {
      const event = this.decodeSseEvent(eventBlock);
      if (!event.data) return;
      if (doneMarkerSeen) {
        throw new Error('Perplexity Pro Search emitted data after stream end');
      }
      if (event.data === '[DONE]') {
        doneMarkerSeen = true;
        return;
      }

      let payload: JsonRecord;
      try {
        const decoded = JSON.parse(event.data) as unknown;
        if (!this.isRecord(decoded)) throw new Error();
        payload = decoded;
      } catch {
        throw new Error('Perplexity Pro Search emitted malformed stream data');
      }
      if (event.type === 'error' || payload.error !== undefined) {
        throw new Error(
          `Perplexity Pro Search stream error: ${this.errorDetail(payload, apiKey)}`,
        );
      }
      if (terminalSeen) {
        throw new Error(
          'Perplexity Pro Search emitted data after its terminal event',
        );
      }

      this.validateSearchType(payload);
      model = this.observeModel(payload, model);
      const object = payload.object;
      if (typeof object !== 'string') {
        throw new Error('Perplexity Pro Search event omitted its object type');
      }

      if (object === 'chat.reasoning') return;
      if (object === 'chat.reasoning.done') {
        if (reasoningDone) {
          throw new Error(
            'Perplexity Pro Search emitted duplicate reasoning terminals',
          );
        }
        reasoningDone = true;
        return;
      }
      if (object === 'chat.completion.chunk') {
        if (!reasoningDone) {
          throw new Error(
            'Perplexity Pro Search response did not prove Pro reasoning',
          );
        }
        completionChunkSeen = true;
        const delta = this.firstChoice(payload)?.delta;
        if (delta !== undefined && !this.isRecord(delta)) {
          throw new Error('Perplexity Pro Search emitted a malformed delta');
        }
        const part = this.isRecord(delta) ? delta.content : undefined;
        if (part !== undefined && part !== null && typeof part !== 'string') {
          throw new Error('Perplexity Pro Search emitted non-text content');
        }
        if (typeof part === 'string') content += part;
        return;
      }
      if (object !== 'chat.completion.done') {
        throw new Error(
          `Perplexity Pro Search emitted unknown event type: ${object.slice(0, 80)}`,
        );
      }
      if (!reasoningDone || !completionChunkSeen) {
        throw new Error(
          'Perplexity Pro Search response did not prove a streamed Pro result',
        );
      }

      const choice = this.firstChoice(payload);
      if (choice?.finish_reason !== 'stop') {
        throw new Error('Perplexity Pro Search completion was incomplete');
      }
      if (!this.isRecord(choice.message)) {
        throw new Error('Perplexity Pro Search terminal message was malformed');
      }
      if (typeof choice.message.content !== 'string') {
        throw new Error('Perplexity Pro Search terminal content was malformed');
      }

      terminalContent = choice.message.content;
      usage = this.extractUsage(payload.usage);
      terminalSearchResults = this.extractSearchResults(payload.search_results);
      terminalCitationUrls = this.extractCitationUrls(payload.citations);
      terminalSeen = true;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
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
    } catch (error) {
      void reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }

    if (!terminalSeen || !usage || !model || terminalContent === undefined) {
      throw new Error('Perplexity Pro Search stream ended before completion');
    }
    if (model !== SONAR_PRO_MODEL) {
      throw new Error(
        `Perplexity Pro Search returned unexpected model: ${model}`,
      );
    }
    if (!content.trim()) {
      throw new Error('Perplexity Pro Search returned no streamed content');
    }
    if (terminalContent !== content) {
      throw new Error(
        'Perplexity Pro Search terminal content did not match streamed content',
      );
    }

    return {
      content,
      citations: this.extractCitations(
        terminalSearchResults,
        terminalCitationUrls,
      ),
      model,
      usage,
    };
  }

  private decodeSseEvent(block: string): { type?: string; data: string } {
    let type: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const raw = colon === -1 ? '' : line.slice(colon + 1);
      const value = raw.startsWith(' ') ? raw.slice(1) : raw;
      if (field === 'event') type = value;
      if (field === 'data') data.push(value);
    }
    return { type, data: data.join('\n') };
  }

  private observeModel(
    payload: JsonRecord,
    current: string | undefined,
  ): string | undefined {
    if (payload.model === undefined) return current;
    if (typeof payload.model !== 'string' || !payload.model.trim()) {
      throw new Error('Perplexity Pro Search emitted malformed model metadata');
    }
    if (current && current !== payload.model) {
      throw new Error('Perplexity Pro Search changed models during the stream');
    }
    return payload.model;
  }

  /**
   * Forced-Pro responses do not consistently echo their requested search
   * type. Treat metadata as a downgrade guard when present; the required
   * reasoning lifecycle, streamed terminal, model, and usage prove execution.
   */
  private validateSearchType(payload: JsonRecord): void {
    const metadata = this.isRecord(payload.metadata) ? payload.metadata : {};
    const searchMetadata = this.isRecord(payload.search_metadata)
      ? payload.search_metadata
      : {};
    const candidates = [
      payload.search_type,
      payload.searchType,
      metadata.search_type,
      metadata.searchType,
      searchMetadata.search_type_used,
      searchMetadata.searchTypeUsed,
    ].filter((value) => value !== undefined && value !== null);
    for (const value of candidates) {
      if (typeof value !== 'string') {
        throw new Error(
          'Perplexity Pro Search emitted malformed search-type metadata',
        );
      }
      if (value.toLowerCase() !== 'pro') {
        throw new Error(
          `Perplexity Pro Search was downgraded to ${value.slice(0, 40)}`,
        );
      }
    }
  }

  private firstChoice(payload: JsonRecord): JsonRecord {
    if (!Array.isArray(payload.choices) || !this.isRecord(payload.choices[0])) {
      throw new Error('Perplexity Pro Search event omitted its first choice');
    }
    return payload.choices[0];
  }

  private extractUsage(value: unknown): ProviderUsage {
    if (!this.isRecord(value)) {
      throw new Error('Perplexity Pro Search terminal usage was missing');
    }
    const usage = value as PerplexityUsage;
    const inputTokens = this.optionalCount(
      usage.prompt_tokens,
      'prompt tokens',
    );
    const outputTokens = this.optionalCount(
      usage.completion_tokens,
      'completion tokens',
    );
    const totalTokens = this.optionalCount(usage.total_tokens, 'total tokens');
    if (totalTokens === undefined) {
      throw new Error('Perplexity Pro Search terminal usage was incomplete');
    }

    let costUsd: number | undefined;
    if (usage.cost !== undefined) {
      if (!this.isRecord(usage.cost)) {
        throw new Error('Perplexity Pro Search terminal cost was malformed');
      }
      costUsd = this.optionalAmount(usage.cost.total_cost, 'reported cost');
    }

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd,
      raw: value,
    };
  }

  private extractSearchResults(value: unknown): PerplexitySearchResult[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      throw new Error('Perplexity Pro Search search results were malformed');
    }
    return value.flatMap((candidate) => {
      if (!this.isRecord(candidate) || typeof candidate.url !== 'string') {
        return [];
      }
      const result: PerplexitySearchResult = { url: candidate.url };
      if (typeof candidate.title === 'string') result.title = candidate.title;
      if (typeof candidate.snippet === 'string') {
        result.snippet = candidate.snippet;
      }
      return [result];
    });
  }

  private extractCitationUrls(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      throw new Error('Perplexity Pro Search citations were malformed');
    }
    return value.filter((candidate): candidate is string =>
      this.isExternalUrl(candidate),
    );
  }

  private extractCitations(
    searchResults: PerplexitySearchResult[],
    citationUrls: string[],
  ): Citation[] {
    const citations: Citation[] = [];
    const seen = new Set<string>();
    for (const result of searchResults) {
      if (!this.isExternalUrl(result.url) || seen.has(result.url)) continue;
      seen.add(result.url);
      citations.push({
        url: result.url,
        title: result.title,
        snippet: result.snippet,
        provider: this.id,
      });
    }
    for (const url of citationUrls) {
      if (seen.has(url)) continue;
      seen.add(url);
      citations.push({ url, provider: this.id });
    }
    return citations;
  }

  private optionalCount(value: unknown, label: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new Error(`Perplexity Pro Search ${label} were malformed`);
    }
    return value as number;
  }

  private optionalAmount(value: unknown, label: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`Perplexity Pro Search ${label} was malformed`);
    }
    return value;
  }

  private isExternalUrl(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }

  private header(
    headers: Record<string, string>,
    name: string,
  ): string | undefined {
    const normalized = name.toLowerCase();
    return Object.entries(headers).find(
      ([candidate]) => candidate.toLowerCase() === normalized,
    )?.[1];
  }

  private async readBody(body: ReadableStream<Uint8Array>): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return text + decoder.decode();
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
  }

  private parseBody(value: string): unknown {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }

  private errorDetail(payload: JsonRecord, apiKey: string): string {
    const error = this.isRecord(payload.error) ? payload.error : payload;
    for (const candidate of [error.message, error.detail, error.type]) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return redactPerplexityError(candidate, apiKey).slice(0, 200);
      }
    }
    return 'provider-reported error';
  }

  private formatProviderError(
    status: number,
    data: unknown,
    apiKey: string,
  ): string {
    let body: string;
    try {
      body = JSON.stringify(data);
    } catch {
      body = String(data);
    }
    const base = `API returned ${status}: ${redactPerplexityError(
      body,
      apiKey,
    ).slice(0, 200)}`;
    if (status === 401) {
      return `${base} — check that ${this.envVar} is set and valid`;
    }
    if (status === 403) {
      return `${base} — API key may lack required permissions`;
    }
    return base;
  }

  private errorResult(start: number, error: string): ProviderResult {
    return {
      provider: this.id,
      tier: this.tier,
      content: '',
      citations: [],
      durationMs: Math.round(performance.now() - start),
      error,
    };
  }

  private isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

function redactPerplexityError(text: string, apiKey?: string): string {
  let redacted = text
    .replace(/(Bearer\s+)[^\s"'\\]+/gi, '$1[REDACTED]')
    .replace(
      /("(?:api[_-]?key|token|authorization)"\s*:\s*")[^"]*"/gi,
      '$1[REDACTED]"',
    );
  if (apiKey) redacted = redacted.split(apiKey).join('[REDACTED]');
  return redacted;
}
