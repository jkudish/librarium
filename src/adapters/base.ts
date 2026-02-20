import { PROVIDER_DISPLAY_NAMES, PROVIDER_ENV_VARS } from '../constants.js';
import { resolveEnvVar } from '../core/config.js';
import {
  type HttpRequestOptions,
  type HttpResponse,
  httpRequest,
} from '../core/http-client.js';
import type {
  Provider,
  ProviderOptions,
  ProviderResult,
  ProviderTier,
} from '../types.js';

/**
 * Base class for all provider adapters.
 * Handles common concerns: API key resolution, HTTP client, display info.
 *
 * Note: submit/poll/retrieve are NOT declared here. Only deep-research
 * subclasses that need async capabilities implement them directly,
 * satisfying the Provider interface's optional methods.
 */
export abstract class BaseProvider implements Provider {
  abstract readonly id: string;
  abstract readonly tier: ProviderTier;

  get displayName(): string {
    return PROVIDER_DISPLAY_NAMES[this.id] ?? this.id;
  }

  get envVar(): string {
    return PROVIDER_ENV_VARS[this.id] ?? '';
  }

  /**
   * Resolve the API key from config ($ENV_VAR pattern)
   */
  protected getApiKey(apiKeyRef?: string): string {
    const ref = apiKeyRef ?? `$${this.envVar}`;
    const resolved = resolveEnvVar(ref);
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
    return httpRequest<T>(url, options);
  }

  abstract execute(
    query: string,
    options: ProviderOptions,
  ): Promise<ProviderResult>;
}
