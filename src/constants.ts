import { homedir } from 'node:os';
import { join } from 'node:path';

declare const __VERSION__: string;

export const VERSION =
  typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.1.0';

export const APP_NAME = 'librarium';

// Config paths
export const CONFIG_DIR = join(homedir(), '.config', APP_NAME);
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
export const CONFIG_FILE_MODE = 0o600;
export const PROJECT_CONFIG_FILE = `.${APP_NAME}.json`;

// Output
export const MAX_SLUG_LENGTH = 40;
export const DEFAULT_OUTPUT_DIR = `./agents/${APP_NAME}`;

// Timeouts (seconds)
export const DEFAULT_TIMEOUT = 30;
export const DEFAULT_ASYNC_TIMEOUT = 1800;
export const DEFAULT_ASYNC_POLL_INTERVAL = 10;
export const DEFAULT_MAX_PARALLEL = 6;

// HTTP
export const MAX_RETRIES = 3;
export const INITIAL_RETRY_DELAY_MS = 1000;
export const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB

// Provider environment variable names
export const PROVIDER_ENV_VARS: Record<string, string> = {
  'perplexity-sonar-deep': 'PERPLEXITY_API_KEY',
  'perplexity-deep-research': 'PERPLEXITY_API_KEY',
  'perplexity-advanced-deep': 'PERPLEXITY_API_KEY',
  'perplexity-sonar-pro': 'PERPLEXITY_API_KEY',
  'openai-deep': 'OPENAI_API_KEY',
  'gemini-deep': 'GEMINI_API_KEY',
  'brave-answers': 'BRAVE_API_KEY',
  'brave-search': 'BRAVE_API_KEY',
  exa: 'EXA_API_KEY',
  searchapi: 'SEARCHAPI_API_KEY',
  serpapi: 'SERPAPI_API_KEY',
  tavily: 'TAVILY_API_KEY',
};

// Provider display names
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  'perplexity-sonar-deep': 'Perplexity Sonar Deep Research',
  'perplexity-deep-research': 'Perplexity Deep Research',
  'perplexity-advanced-deep': 'Perplexity Advanced Deep Research',
  'perplexity-sonar-pro': 'Perplexity Sonar Pro',
  'openai-deep': 'OpenAI Deep Research',
  'gemini-deep': 'Gemini Deep Research',
  'brave-answers': 'Brave AI Answers',
  'brave-search': 'Brave Web Search',
  exa: 'Exa Search',
  searchapi: 'SearchAPI',
  serpapi: 'SerpAPI',
  tavily: 'Tavily Search',
};

// Default groups
export const DEFAULT_GROUPS: Record<string, string[]> = {
  deep: [
    'perplexity-sonar-deep',
    'perplexity-deep-research',
    'perplexity-advanced-deep',
    'openai-deep',
    'gemini-deep',
  ],
  quick: ['perplexity-sonar-pro', 'brave-answers', 'exa'],
  raw: ['brave-search', 'searchapi', 'serpapi', 'tavily'],
  fast: ['perplexity-sonar-pro', 'brave-answers', 'exa', 'brave-search', 'tavily'],
  comprehensive: [
    'perplexity-sonar-deep',
    'perplexity-deep-research',
    'perplexity-advanced-deep',
    'openai-deep',
    'gemini-deep',
    'perplexity-sonar-pro',
    'brave-answers',
    'exa',
  ],
  all: [
    'perplexity-sonar-deep',
    'perplexity-deep-research',
    'perplexity-advanced-deep',
    'openai-deep',
    'gemini-deep',
    'perplexity-sonar-pro',
    'brave-answers',
    'exa',
    'brave-search',
    'searchapi',
    'serpapi',
    'tavily',
  ],
};

// Sanitize ID for filesystem
export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}
