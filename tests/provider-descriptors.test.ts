import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAllProviders,
  getProvider,
  initializeProviders,
} from '../src/adapters/index.js';
import { BUILTIN_PROVIDER_DESCRIPTORS } from '../src/adapters/provider-descriptors.js';
import {
  DEFAULT_GROUPS,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_ENV_VARS,
  PROVIDER_ID_ALIASES,
  validateDefaultGroups,
} from '../src/constants.js';
import { getMeteringKind } from '../src/core/metering.js';
import { PROVIDER_CATALOG } from '../src/core/provider-catalog.js';

describe('built-in provider descriptors', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('drives registry, catalog, credentials, aliases, and metering', async () => {
    await initializeProviders();
    expect(BUILTIN_PROVIDER_DESCRIPTORS).toHaveLength(24);
    expect(getAllProviders()).toHaveLength(BUILTIN_PROVIDER_DESCRIPTORS.length);

    for (const descriptor of BUILTIN_PROVIDER_DESCRIPTORS) {
      const provider = getProvider(descriptor.id);
      expect(provider).toMatchObject({
        id: descriptor.id,
        displayName: descriptor.display.name,
        envVar: descriptor.credential.envVar,
        tier: descriptor.tier,
        execution: descriptor.capabilities.execution,
      });
      expect(PROVIDER_DISPLAY_NAMES[descriptor.id]).toBe(
        descriptor.display.name,
      );
      expect(PROVIDER_ENV_VARS[descriptor.id]).toBe(
        descriptor.credential.envVar,
      );
      expect(PROVIDER_CATALOG[descriptor.id]).toMatchObject({
        displayName: descriptor.display.name,
        envVar: descriptor.credential.envVar,
        tier: descriptor.tier,
        defaultModel: descriptor.defaultModel,
      });
      expect(getMeteringKind(descriptor.id)).toBe(descriptor.metering.kind);
      for (const alias of descriptor.aliases) {
        expect(PROVIDER_ID_ALIASES[alias]).toBe(descriptor.id);
      }
      if (descriptor.defaultModel && provider && 'model' in provider) {
        expect(provider.model).toBe(descriptor.defaultModel);
      }
    }
  });

  it('preserves the established registry order independently of catalog order', async () => {
    await initializeProviders();
    expect(getAllProviders().map(({ id }) => id)).toEqual([
      'perplexity-sonar-deep',
      'perplexity-deep-research',
      'perplexity-advanced-deep',
      'openai-research',
      'gemini-deep',
      'perplexity-sonar-pro',
      'gemini-grounded',
      'grok',
      'openrouter-online',
      'brave-answers',
      'exa',
      'you-research',
      'kagi-fastgpt',
      'perplexity-search',
      'brave-search',
      'jina-search',
      'firecrawl-search',
      'searchapi',
      'serpapi',
      'tavily',
      'claude',
      'openai-chat',
      'gemini-chat',
      'openrouter-chat',
    ]);
  });

  it('isolates an invalid provider option schema from other adapters', async () => {
    const result = await initializeProviders({
      providers: {
        'openai-research': {
          options: { returnTokenBudget: 'bottomless' },
        },
      },
    });

    expect(getProvider('openai-research')).toBeDefined();
    expect(getProvider('gemini-deep')).toBeDefined();
    expect(result.warnings).toEqual([
      expect.stringContaining('Invalid options for openai-research'),
    ]);
  });

  it('distinguishes remote tasks from process-local lifecycle wrappers', () => {
    const persistence = Object.fromEntries(
      BUILTIN_PROVIDER_DESCRIPTORS.filter(
        (descriptor) => descriptor.capabilities.execution === 'background',
      ).map((descriptor) => [
        descriptor.id,
        descriptor.capabilities.execution === 'background'
          ? descriptor.capabilities.taskPersistence
          : undefined,
      ]),
    );

    expect(persistence).toEqual({
      'openai-research': 'remote',
      'gemini-deep': 'remote',
      'perplexity-sonar-deep': 'remote',
      'perplexity-deep-research': 'process-local',
      'perplexity-advanced-deep': 'process-local',
    });
  });

  it('validates explicit default-group policy against descriptors', () => {
    expect(() => validateDefaultGroups()).not.toThrow();
    expect(() =>
      validateDefaultGroups({
        ...DEFAULT_GROUPS,
        quick: [...DEFAULT_GROUPS.quick, 'not-a-provider'],
      }),
    ).toThrow('unknown provider');
    expect(() =>
      validateDefaultGroups({
        ...DEFAULT_GROUPS,
        raw: [...DEFAULT_GROUPS.raw, DEFAULT_GROUPS.raw[0]],
      }),
    ).toThrow('repeats provider');
    expect(() =>
      validateDefaultGroups({
        ...DEFAULT_GROUPS,
        all: DEFAULT_GROUPS.all.slice(1),
      }),
    ).toThrow('must contain every non-LLM built-in provider');
  });
});
