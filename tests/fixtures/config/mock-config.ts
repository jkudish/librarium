import { fileURLToPath } from 'node:url';

/**
 * Committed config fixtures for the PTY smoke suite.
 *
 * librarium's script-provider config references an absolute `command`/script
 * path, which necessarily differs per machine and per worktree. Rather than
 * commit a config.json with a hard-coded path, we commit the *shape* of each
 * scenario here and let {@link buildMockConfig} stamp in the absolute path to
 * the committed mock provider script at runtime. The harness writes the result
 * to an isolated HOME so the user's real ~/.config/librarium is never touched.
 */

const MOCK_PROVIDER_SCRIPT = fileURLToPath(
  new URL('../providers/mock-provider.mjs', import.meta.url),
);

export type MockTier = 'deep-research' | 'ai-grounded' | 'raw-search';

export interface MockProviderSpec {
  id: string;
  displayName?: string;
  tier?: MockTier;
  /** Mark execute as failing so the dispatcher attempts a fallback. */
  fail?: boolean;
  error?: string;
  citations?: number;
  delayMs?: number;
  content?: string;
  /** Registered + trusted but disabled, e.g. a fallback-only provider. */
  enabled?: boolean;
  /** Configure this provider's fallback target (another mock id). */
  fallback?: string;
}

export interface MockConfigSpec {
  providers: MockProviderSpec[];
  /** Named groups → member ids; merged over librarium's defaults. */
  groups?: Record<string, string[]>;
  outputDir?: string;
  mode?: 'sync' | 'async' | 'mixed';
}

/** Build a full librarium config.json object from a scenario spec. */
export function buildMockConfig(spec: MockConfigSpec): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  const customProviders: Record<string, unknown> = {};
  const trustedProviderIds: string[] = [];

  for (const p of spec.providers) {
    trustedProviderIds.push(p.id);
    providers[p.id] = {
      enabled: p.enabled ?? true,
      // The dispatcher gates a fallback target on a resolvable credential
      // (config apiKey), independent of the provider being keyless. A literal
      // value satisfies that check so fallback-only mocks can fire.
      apiKey: 'mock-key',
      ...(p.fallback ? { fallback: p.fallback } : {}),
    };
    customProviders[p.id] = {
      type: 'script',
      command: process.execPath,
      args: [MOCK_PROVIDER_SCRIPT],
      options: {
        displayName: p.displayName ?? p.id,
        tier: p.tier ?? 'ai-grounded',
        ...(p.fail ? { fail: true } : {}),
        ...(p.error ? { error: p.error } : {}),
        ...(p.citations !== undefined ? { citations: p.citations } : {}),
        ...(p.delayMs !== undefined ? { delayMs: p.delayMs } : {}),
        ...(p.content !== undefined ? { content: p.content } : {}),
      },
    };
  }

  return {
    version: 1,
    defaults: {
      outputDir: spec.outputDir ?? './agents/librarium',
      maxParallel: 6,
      timeout: 30,
      asyncTimeout: 1800,
      asyncPollInterval: 10,
      mode: spec.mode ?? 'sync',
    },
    providers,
    customProviders,
    trustedProviderIds,
    groups: spec.groups ?? {},
  };
}

/** The three-provider happy-path scenario used by the live-table run test. */
export const HAPPY_PATH: MockConfigSpec = {
  mode: 'sync',
  providers: [
    {
      id: 'mock-grounded',
      displayName: 'Mock Grounded',
      tier: 'ai-grounded',
      citations: 3,
    },
    {
      id: 'mock-search',
      displayName: 'Mock Search',
      tier: 'raw-search',
      citations: 2,
    },
    {
      id: 'mock-second',
      displayName: 'Mock Second',
      tier: 'raw-search',
      citations: 1,
    },
  ],
  groups: { smoke: ['mock-grounded', 'mock-search', 'mock-second'] },
};

/** A failing primary with a working fallback, for the fallback run test. */
export const FALLBACK_PATH: MockConfigSpec = {
  mode: 'sync',
  providers: [
    {
      id: 'mock-flaky',
      displayName: 'Mock Flaky',
      tier: 'ai-grounded',
      fail: true,
      error: 'HTTP 401 Unauthorized',
      fallback: 'mock-backup',
    },
    {
      id: 'mock-backup',
      displayName: 'Mock Backup',
      tier: 'ai-grounded',
      // Fallback-only: not enabled as a primary, but registered + trusted.
      enabled: false,
      citations: 2,
    },
    { id: 'mock-ok', displayName: 'Mock Ok', tier: 'raw-search', citations: 1 },
  ],
  groups: { smoke: ['mock-flaky', 'mock-ok'] },
};

/** Single-provider scenario for the wizard and Ctrl+C tests. */
export const SINGLE: MockConfigSpec = {
  mode: 'sync',
  providers: [
    {
      id: 'mock-grounded',
      displayName: 'Mock Grounded',
      tier: 'ai-grounded',
      citations: 2,
    },
  ],
  groups: { smoke: ['mock-grounded'] },
};

/** A slow provider so a SIGINT can land mid-run deterministically. */
export const SLOW: MockConfigSpec = {
  mode: 'sync',
  providers: [
    {
      id: 'mock-slow',
      displayName: 'Mock Slow',
      tier: 'ai-grounded',
      delayMs: 5000,
      citations: 1,
    },
  ],
  groups: { smoke: ['mock-slow'] },
};
