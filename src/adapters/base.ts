import { PROVIDER_DISPLAY_NAMES, PROVIDER_ENV_VARS } from '../constants.js';
import {
  type CredentialContext,
  resolveCredential,
} from '../core/credentials.js';
import {
  type HttpClient,
  type HttpRequestOptions,
  type HttpResponse,
  httpRequest,
} from '../core/http-client.js';
import type {
  AsyncPollResult,
  AsyncTaskHandle,
  BackgroundProvider,
  InlineProvider,
  Provider,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';

export interface BaseProviderOptions {
  apiKey?: string;
  credentials?: CredentialContext;
  httpClient?: HttpClient;
}

/**
 * Base class for all provider adapters.
 * Handles common concerns: API key resolution, HTTP client, display info.
 *
 * Inline is the default execution contract, so the synchronous adapters need
 * no per-class boilerplate. Background adapters extend BackgroundBaseProvider.
 */
export abstract class ProviderBase {
  abstract readonly id: string;
  abstract readonly tier: ProviderTier;
  source?: Provider['source'];
  requiresApiKey?: Provider['requiresApiKey'];

  private apiKeyRef?: string;
  private credentials: CredentialContext;
  private httpClient: HttpClient;

  constructor(options: BaseProviderOptions = {}) {
    this.apiKeyRef = options.apiKey;
    this.credentials = options.credentials ?? {};
    this.httpClient = options.httpClient ?? httpRequest;
  }

  get displayName(): string {
    return PROVIDER_DISPLAY_NAMES[this.id] ?? this.id;
  }

  get envVar(): string {
    return PROVIDER_ENV_VARS[this.id] ?? '';
  }

  configure(options: BaseProviderOptions): void {
    this.apiKeyRef = options.apiKey;
    this.credentials = options.credentials ?? {};
    this.httpClient = options.httpClient ?? httpRequest;
  }

  /** Override only the transport, preserving credentials and provider config. */
  setHttpClient(httpClient: HttpClient = httpRequest): void {
    this.httpClient = httpClient;
  }

  /**
   * Resolve the API key from config ($ENV_VAR pattern)
   */
  protected getApiKey(apiKeyRef?: string): string {
    const ref = apiKeyRef ?? this.apiKeyRef ?? `$${this.envVar}`;
    const resolved = resolveCredential(ref, this.credentials);
    if (!resolved) {
      throw new Error(
        `API key not found for ${this.id}. Set ${this.envVar} environment variable.`,
      );
    }
    return resolved;
  }

  /**
   * Make an HTTP request with provider defaults
   */
  protected async request<T = unknown>(
    url: string,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse<T>> {
    return this.httpClient<T>(url, options);
  }

  /**
   * Format an HTTP error response with helpful hints
   */
  protected formatError(status: number, data: unknown): string {
    let body: string;
    try {
      body = JSON.stringify(data).slice(0, 200);
    } catch {
      body = String(data);
    }
    const base = `API returned ${status}: ${body}`;
    if (status === 401) {
      return `${base} — check that ${this.envVar} is set and valid`;
    }
    if (status === 403) {
      return `${base} — API key may lack required permissions`;
    }
    return base;
  }

  /**
   * Format a catch-block error with user-friendly messages
   */
  protected formatCatchError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      err instanceof TypeError ||
      /fetch failed|failed to fetch|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(
        msg,
      )
    ) {
      return `Network error connecting to ${this.displayName} — check your internet connection`;
    }
    return msg;
  }

  abstract execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult>;
}

export abstract class BaseProvider
  extends ProviderBase
  implements InlineProvider
{
  readonly execution = 'inline' as const;
}

/** Base for adapters that implement the complete persisted-task lifecycle. */
export abstract class BackgroundBaseProvider
  extends ProviderBase
  implements BackgroundProvider
{
  readonly execution = 'background' as const;

  abstract submit(
    query: string,
    options: ProviderOptions,
  ): Promise<AsyncTaskHandle>;

  abstract poll(handle: AsyncTaskHandle): Promise<AsyncPollResult>;

  abstract retrieve(handle: AsyncTaskHandle): Promise<ProviderResult>;
}
