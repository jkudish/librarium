import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GROUPS } from '../src/constants.js';
import { loadConfig } from '../src/core/config.js';
import { validateConfigV2 } from '../src/core/config-v2.js';
import { resolveConfigurationProfileToken } from '../src/core/configuration-mapping.js';
import { retiredProviderSelectionIssues } from '../src/core/provider-selection.js';
import { RESERVED_BUILTIN_PROVIDER_IDS } from '../src/core/reserved-provider-ids.js';
import {
  isRetiredProviderToken,
  migrateRetiredProviderId,
  retiredProviderGuidance,
  retiredProviderTokenReplacement,
} from '../src/core/retired-provider-ids.js';
import {
  preflightProductionRequest,
  preflightProductionRequestStructure,
  RequestPreflightError,
} from '../src/node-request-preflight.js';
import type { Config } from '../src/types.js';

const RETIRED = 'searchapi-perplexity';
const GUIDANCE =
  /^Provider "searchapi-perplexity" was retired upstream: SearchAPI deprecated its Perplexity engine .*It is not replaced automatically; "perplexity-sonar-pro" is the nearest alternative, but it returns a Perplexity API answer, not an observation of the Perplexity consumer surface\.$/;

let dir: string;
let warnings: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'librarium-retired-'));
  warnings = [];
  vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function loadV1(content: Record<string, unknown>): Config {
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      defaults: { outputDir: join(dir, 'runs') },
      ...content,
    }),
  );
  return loadConfig(path);
}

describe('searchapi-perplexity retired upstream (#4769)', () => {
  it('guides callers to the alternative without ever mapping to it', () => {
    expect(retiredProviderGuidance(RETIRED)).toMatch(GUIDANCE);
    expect(retiredProviderGuidance(`${RETIRED}/surface`)).toMatch(GUIDANCE);
    expect(isRetiredProviderToken(RETIRED)).toBe(true);
    expect(isRetiredProviderToken(`${RETIRED}/surface`)).toBe(true);
    expect(retiredProviderTokenReplacement(RETIRED)).toBeUndefined();
    expect(migrateRetiredProviderId(RETIRED)).toBe(RETIRED);
    expect(
      resolveConfigurationProfileToken(RETIRED, [], { migrateRetired: true }),
    ).toEqual({
      kind: 'retired',
      token: RETIRED,
      message: expect.stringMatching(GUIDANCE),
    });
  });

  it('keeps the id reserved so custom code cannot claim it', () => {
    expect(RESERVED_BUILTIN_PROVIDER_IDS.has(RETIRED)).toBe(true);
  });

  it('rejects an explicit CLI or MCP selection with the retirement guidance', () => {
    expect(retiredProviderSelectionIssues([RETIRED])).toEqual([
      {
        code: 'provider_token_retired',
        path: '/providers/0',
        message: expect.stringMatching(GUIDANCE),
      },
    ]);

    const config = loadV1({ providers: { exa: { enabled: true } } });
    let thrown: unknown;
    try {
      preflightProductionRequest(
        {
          config,
          transport: {
            kind: 'cli',
            input: { query: 'q', providers: [`${RETIRED}/surface`] },
          },
        },
        { createCredentials: () => ({ env: {} }) },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RequestPreflightError);
    expect((thrown as RequestPreflightError).issues).toEqual([
      expect.objectContaining({
        code: 'request_provider_token_retired',
        message: expect.stringMatching(GUIDANCE),
      }),
    ]);
  });

  it('loads a v1 config by dropping the retired provider, fallback, and group member with warnings', () => {
    const config = loadV1({
      providers: {
        [RETIRED]: { enabled: true },
        'gemini-grounded': { enabled: true, fallback: RETIRED },
      },
      groups: { mine: ['grok', RETIRED], visibility: [RETIRED] },
    });

    expect(config.providers[RETIRED]).toBeUndefined();
    expect(config.providers['gemini-grounded']?.fallback).toBeUndefined();
    expect(config.groups.mine).toEqual(['grok']);
    expect(config.groups.visibility).toEqual([]);
    for (const members of Object.values(config.groups)) {
      expect(members).not.toContain('perplexity-sonar-pro/grounded');
      expect(members).not.toContain(RETIRED);
    }
    expect(warnings).toHaveLength(4);
    for (const warning of warnings) {
      expect(warning).toContain('was retired upstream');
      expect(warning).toContain('"perplexity-sonar-pro" is the nearest');
    }
  });

  it.each(['comprehensive', 'all'] as const)(
    'upgrades a stored exact pre-retirement %s roster to the current default',
    (group) => {
      const previous = [...DEFAULT_GROUPS[group]];
      previous.splice(previous.indexOf('searchapi-gemini') + 1, 0, RETIRED);
      const config = loadV1({ groups: { [group]: previous } });
      expect(config.groups[group]).toEqual(DEFAULT_GROUPS[group]);
    },
  );

  it('rejects the retired id in native v2 providers and groups with guidance', () => {
    const result = validateConfigV2({
      version: 2,
      execution_defaults: {
        mode: 'sync',
        max_concurrency: 4,
        inline_attempt_deadline_ms: 30_000,
        background_attempt_deadline_ms: 1_800_000,
        poll_interval_ms: 10_000,
      },
      providers: { [RETIRED]: { enabled: true } },
      custom_providers: {},
      trusted_provider_ids: [],
      groups: { 'custom:mine': [`${RETIRED}/surface`] },
      runtime: { output_dir: join(dir, 'runs'), llm_web_search: true },
    });
    expect(result.ok).toBe(false);
    const issues = result.ok ? [] : result.issues;
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'config_provider_alias_removed',
          message: expect.stringContaining('was retired upstream'),
        }),
        expect.objectContaining({
          code: 'config_group_member_alias_removed',
          message: expect.stringContaining('was retired upstream'),
        }),
      ]),
    );
  });

  it('maps a hand-built v1 group with a notice, not an issue', () => {
    const config: Config = {
      ...loadV1({ providers: { exa: { enabled: true } } }),
      groups: { mine: [RETIRED, 'exa'] },
    };
    const result = preflightProductionRequestStructure({
      config,
      transport: {
        kind: 'cli',
        input: { query: 'q', group: 'custom:mine' },
      },
    });
    expect(
      result.prepared.request.slots.map(
        (slot) => slot.primary.identity.provider_id,
      ),
    ).toEqual(['exa']);
    expect(result.notices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'configuration_group_member_retired',
          message: expect.stringMatching(GUIDANCE),
        }),
      ]),
    );
  });
});
