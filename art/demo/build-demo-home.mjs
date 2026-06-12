#!/usr/bin/env node
/**
 * Build an isolated, deterministic librarium HOME for the README demo GIF.
 *
 * Honesty note: this enables the REAL built-in provider adapters (the exact ids
 * and tiers a real run uses). The demo runner (demo-run.mjs) then stubs ONLY
 * `globalThis.fetch`, so every adapter, the dispatcher, the live fan-out table,
 * dedupe, and the summary run through the real code path -- only the network
 * responses are canned. The output format is real; the API calls are mocked, so
 * the recording is deterministic and free.
 *
 * Usage: node build-demo-home.mjs <home-dir>
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.argv[2];
if (!home) {
  process.stderr.write('usage: build-demo-home.mjs <home-dir>\n');
  process.exit(1);
}

// Real provider ids/tiers. tavily fails -> falls back to jina-search.
const enabled = {
  'perplexity-sonar-pro': { apiKey: '$PERPLEXITY_API_KEY', enabled: true },
  'gemini-grounded': { apiKey: '$GEMINI_API_KEY', enabled: true },
  exa: { apiKey: '$EXA_API_KEY', enabled: true },
  'brave-search': { apiKey: '$BRAVE_API_KEY', enabled: true },
  tavily: {
    apiKey: '$TAVILY_API_KEY',
    enabled: true,
    fallback: 'jina-search',
  },
  // Fallback-only: configured + keyed, but not dispatched as a primary.
  'jina-search': { apiKey: '$JINA_AI_API_KEY', enabled: false },
};

const config = {
  version: 1,
  defaults: {
    outputDir: join(home, 'research'),
    maxParallel: 6,
    timeout: 30,
    asyncTimeout: 1800,
    asyncPollInterval: 10,
    mode: 'sync',
  },
  providers: enabled,
  customProviders: {},
  trustedProviderIds: [],
  groups: {
    demo: ['perplexity-sonar-pro', 'gemini-grounded', 'exa', 'brave-search', 'tavily'],
  },
};

const configDir = join(home, '.config', 'librarium');
mkdirSync(configDir, { recursive: true });
writeFileSync(
  join(configDir, 'config.json'),
  `${JSON.stringify(config, null, 2)}\n`,
);
process.stdout.write(`demo home ready: ${home}\n`);
