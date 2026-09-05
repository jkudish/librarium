import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PROVIDER_CATALOG } from '../src/core/provider-profiles.js';
import {
  compileRequest,
  type RequestCompilationTransport,
} from '../src/core/request-compilation.js';
import { comparePreparationDiagnostics } from '../src/core/research-request.js';
import type { Config } from '../src/types.js';

function config(
  overrides: Partial<Config> & { defaults?: Partial<Config['defaults']> } = {},
): Config {
  const { defaults, ...rest } = overrides;
  return {
    version: 1,
    defaults: {
      outputDir: './agents/librarium',
      maxParallel: 3,
      timeout: 30,
      asyncTimeout: 300,
      asyncPollInterval: 5,
      mode: 'sync',
      llmWebSearch: true,
      ...defaults,
    },
    providers: {},
    customProviders: {},
    trustedProviderIds: [],
    groups: {},
    ...rest,
  };
}

function credentials() {
  return {
    env: Object.fromEntries(
      BUILTIN_PROVIDER_CATALOG.map((entry) => [
        entry.credential.env_var,
        'test-credential',
      ]),
    ),
  };
}

function customExecutionProfile(
  invocation: 'inline' | 'background' = 'inline',
) {
  return {
    identity: {
      provider_id: 'acme',
      profile_id: invocation === 'inline' ? 'search' : 'research',
      target: { primary: { model_selection: 'not_applicable' as const } },
    },
    result_kind:
      invocation === 'inline'
        ? ('search_results' as const)
        : ('research_report' as const),
    ...(invocation === 'background' && {
      grounding_policy: 'required' as const,
    }),
    observation_mode: 'api_output' as const,
    corpora: ['web' as const],
    retrieval_method:
      invocation === 'inline'
        ? ('search_endpoint' as const)
        : ('research_agent' as const),
    access_mode: 'direct' as const,
    operator_id: 'acme',
    invocation,
    resumability:
      invocation === 'inline' ? ('none' as const) : ('durable' as const),
  };
}

function customSource(
  overrides: Partial<Config> & { defaults?: Partial<Config['defaults']> } = {},
): Config {
  return config({
    providers: { 'acme-adapter': { enabled: true } },
    customProviders: {
      'acme-adapter': {
        type: 'npm',
        module: 'must-not-be-imported',
        executionProfile: {
          bindingId: 'acme.search.v1',
          profile: customExecutionProfile(),
        },
      },
    },
    trustedProviderIds: ['acme-adapter'],
    ...overrides,
  });
}

const PLANNED_PROVIDER_IDS = BUILTIN_PROVIDER_CATALOG.filter((entry) =>
  entry.profiles.some((profile) => profile.status === 'planned'),
).map((entry) => entry.provider_id);

function preparation() {
  const counts = new Map<string, number>();
  return {
    clock: { now: () => Date.parse('2026-08-09T12:00:00Z') },
    ids: {
      next: (scope: 'request' | 'slot' | 'fallback_candidate') => {
        const count = (counts.get(scope) ?? 0) + 1;
        counts.set(scope, count);
        return `${scope}-${count}`;
      },
    },
  };
}

function countedPreparation() {
  let calls = 0;
  return {
    dependencies: {
      clock: {
        now: () => {
          calls += 1;
          return Date.parse('2026-08-09T12:00:00Z');
        },
      },
      ids: {
        next: (scope: 'request' | 'slot' | 'fallback_candidate') => {
          calls += 1;
          return `unexpected-${scope}-${calls}`;
        },
      },
    },
    calls: () => calls,
  };
}

function compile(
  source: Config,
  transport: RequestCompilationTransport,
  requestDeadlineMs = 1_000_000,
) {
  return compileRequest({
    config: source,
    authoredGroups: { global: source.groups, project: {} },
    credentials: credentials(),
    requestDeadlineMs,
    transport,
    preparation: preparation(),
  });
}

function profileKeys(result: ReturnType<typeof compile>) {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.prepared.request.slots.map(
    (slot) =>
      `${slot.primary.identity.provider_id}/${slot.primary.identity.profile_id}`,
  );
}

describe('private request compilation', () => {
  it('resolves exact adapter ids, display names, qualified profiles, and split OpenRouter targets', () => {
    const result = compile(
      config({
        providers: {
          exa: { enabled: true },
          'openrouter-online': { enabled: true },
          'openrouter-chat': { enabled: true },
        },
      }),
      {
        kind: 'cli',
        input: {
          query: 'token forms',
          providers: [
            'exa',
            'Exa Search',
            'openrouter-online',
            'openrouter/chat',
            'openrouter-chat',
          ],
        },
      },
    );

    expect(profileKeys(result)).toEqual([
      'exa/search',
      'openrouter/grounded',
      'openrouter/chat',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const openRouterPlans = Object.values(
      result.prepared.profile_plans_by_identity,
    ).filter((plan) => plan.identity.provider_id === 'openrouter');
    expect(
      openRouterPlans.find((plan) => plan.identity.profile_id === 'grounded')
        ?.binding.adapter_id,
    ).toBe('openrouter-online');
    expect(
      openRouterPlans.find((plan) => plan.identity.profile_id === 'chat')
        ?.binding.adapter_id,
    ).toBe('openrouter-chat');
  });

  it.each([
    ['perplexity-sonar', 'perplexity-sonar-pro'],
    ['perplexity-deep', 'perplexity-sonar-deep'],
    ['openai-deep', 'openai-research'],
    ['openai-deep-o3', 'openai-research'],
  ])(
    'rejects retired transport token %s across every ingress',
    (token, replacement) => {
      for (const kind of ['cli', 'mcp', 'silent_mcp'] as const) {
        const result = compile(
          config({ providers: { 'openai-research': { enabled: true } } }),
          {
            kind,
            input: { query: `retired ${token}`, providers: [token] },
          },
        );
        expect(result.ok, `${kind}/${token}`).toBe(false);
        if (result.ok) continue;
        expect(result).not.toHaveProperty('prepared');
        expect(result.issues).toEqual([
          {
            code: 'request_provider_token_retired',
            phase: 'transport',
            path: '/providers/0',
            message: `Provider "${token}" was removed; use "${replacement}".`,
          },
        ]);
        expect(result.notices).not.toContainEqual(
          expect.objectContaining({
            code: 'configuration_provider_alias_migrated',
          }),
        );
      }
    },
  );

  it.each([
    ['perplexity-sonar/grounded', 'perplexity-sonar-pro/grounded'],
    ['perplexity-deep/research', 'perplexity-sonar-deep/research'],
    ['openai-deep/research', 'openai-research/research'],
    ['openai-deep-o3/research', 'openai-research/research'],
  ])(
    'rejects qualified retired transport token %s with its full replacement',
    (token, replacement) => {
      const result = compile(
        config({ providers: { 'openai-research': { enabled: true } } }),
        {
          kind: 'silent_mcp',
          input: { query: `qualified retired ${token}`, providers: [token] },
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues).toEqual([
        {
          code: 'request_provider_token_retired',
          phase: 'transport',
          path: '/providers/0',
          message: `Provider "${token}" was removed; use "${replacement}".`,
        },
      ]);
    },
  );

  it('filters blank provider entries like v1 and retains stable token diagnostics', () => {
    const result = compile(config({ providers: { exa: { enabled: true } } }), {
      kind: 'silent_mcp',
      input: {
        query: 'bad tokens',
        providers: ['missing', 'openrouter', ' '],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(({ code, path }) => [code, path])).toEqual([
      ['request_provider_token_unknown', '/providers/0'],
      ['request_provider_token_ambiguous', '/providers/1'],
    ]);

    const filtered = compile(
      config({ providers: { exa: { enabled: true } } }),
      {
        kind: 'mcp',
        input: { query: 'filter blanks', providers: [' ', 'exa', ''] },
      },
    );
    expect(profileKeys(filtered)).toEqual(['exa/search']);

    const empty = compile(config({ providers: { exa: { enabled: true } } }), {
      kind: 'mcp',
      input: { query: 'all blank', providers: [' ', ''] },
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.issues).toEqual([
        expect.objectContaining({
          code: 'transport_empty_provider_selection',
          path: '/providers',
        }),
      ]);
    }
  });

  it('rejects runtime exact-target smuggling after the mapping gate', () => {
    const source = config({ providers: { exa: { enabled: true } } });
    for (const input of [
      {
        query: 'exact alone',
        exactTargets: [{ provider_id: 'exa', profile_id: 'search' }],
      },
      {
        query: 'raw and exact',
        providers: ['exa'],
        exactTargets: [{ provider_id: 'exa', profile_id: 'search' }],
      },
    ]) {
      const counted = countedPreparation();
      const result = compileRequest({
        config: source,
        authoredGroups: { global: {}, project: {} },
        credentials: credentials(),
        requestDeadlineMs: 1_000_000,
        transport: {
          kind: 'mcp',
          input,
        } as unknown as RequestCompilationTransport,
        preparation: counted.dependencies,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toEqual([
          expect.objectContaining({
            code: 'request_exact_targets_not_allowed',
            path: '/providers',
          }),
        ]);
      }
      expect(counted.calls()).toBe(0);
    }
  });

  it('keeps bare OpenRouter ambiguous even when only one adapter is enabled', () => {
    const result = compile(
      config({
        providers: {
          'openrouter-online': { enabled: true },
          'openrouter-chat': { enabled: false },
        },
      }),
      {
        kind: 'mcp',
        input: { query: 'bare OpenRouter', providers: ['openrouter'] },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: 'request_provider_token_ambiguous',
          path: '/providers/0',
        }),
      );
    }
  });

  it('keeps injected quick built in but routes authored quick and team through group aliases', () => {
    const injectedQuick = compile(
      config({ providers: { exa: { enabled: true } } }),
      { kind: 'mcp', input: { query: 'built in quick', group: 'quick' } },
    );
    expect(profileKeys(injectedQuick)).toEqual(['exa/search']);

    const authored = config({
      providers: { exa: { enabled: true }, tavily: { enabled: true } },
      groups: { quick: ['exa'], team: ['tavily'] },
    });
    const authoredQuick = compile(authored, {
      kind: 'mcp',
      input: { query: 'authored quick', group: 'quick' },
    });
    const team = compile(authored, {
      kind: 'mcp',
      input: { query: 'authored team', group: ' team ' },
    });
    expect(profileKeys(authoredQuick)).toEqual(['exa/search']);
    expect(profileKeys(team)).toEqual(['tavily/search']);
    expect(authoredQuick.notices).toContainEqual(
      expect.objectContaining({
        code: 'configuration_group_alias_migrated',
        path: '/group',
      }),
    );
    expect(team.notices).toContainEqual(
      expect.objectContaining({
        code: 'configuration_group_alias_migrated',
        path: '/group',
      }),
    );
  });

  it('keeps the CLI/MCP provider-over-group notice after canonicalization', () => {
    const source = config({
      providers: { exa: { enabled: true }, tavily: { enabled: true } },
      groups: { team: ['tavily'] },
    });
    const result = compile(source, {
      kind: 'cli',
      input: { query: 'providers win', providers: ['exa'], group: 'team' },
    });
    expect(profileKeys(result)).toEqual(['exa/search']);
    expect(result.notices).toContainEqual(
      expect.objectContaining({
        code: 'transport_explicit_providers_override_group',
        path: '/group',
      }),
    );

    const ignoredUnknown = compile(source, {
      kind: 'mcp',
      input: { query: 'ignore group', providers: ['exa'], group: ' missing ' },
    });
    expect(profileKeys(ignoredUnknown)).toEqual(['exa/search']);
    expect(ignoredUnknown.notices).toContainEqual(
      expect.objectContaining({
        code: 'transport_explicit_providers_override_group',
      }),
    );
  });

  it('reports blank, removed, and unknown effective group selectors at /group', () => {
    const source = config({ providers: { exa: { enabled: true } } });
    for (const [group, code] of [
      [' ', 'request_group_blank'],
      ['raw', 'request_group_removed'],
      ['missing', 'request_group_unknown'],
    ] as const) {
      const result = compile(source, {
        kind: 'mcp',
        input: { query: group, group },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toContainEqual(
          expect.objectContaining({ code, path: '/group' }),
        );
      }
    }
  });

  it('handles prototype-like group and provider tokens without prototype lookup', () => {
    const source = config({
      providers: { exa: { enabled: true }, tavily: { enabled: true } },
    });
    source.groups = JSON.parse(
      '{"__proto__":["exa"],"constructor":["tavily"],"prototype":["exa"]}',
    ) as Config['groups'];
    for (const [group, expected] of [
      ['__proto__', 'exa/search'],
      ['constructor', 'tavily/search'],
      ['prototype', 'exa/search'],
    ] as const) {
      for (const spelling of [group, `custom:${group}`]) {
        expect(
          profileKeys(
            compile(source, {
              kind: 'mcp',
              input: { query: spelling, group: spelling },
            }),
          ),
        ).toEqual([expected]);
      }
    }
    for (const token of ['__proto__', 'constructor', 'prototype']) {
      const unknown = compile(source, {
        kind: 'mcp',
        input: { query: `provider ${token}`, providers: [token] },
      });
      expect(unknown.ok).toBe(false);
      if (!unknown.ok) {
        expect(unknown.issues).toContainEqual(
          expect.objectContaining({
            code: 'request_provider_token_unknown',
            path: '/providers/0',
          }),
        );
      }
    }
  });

  it('fails closed for trusted enabled custom providers without profile metadata', () => {
    const source = config({
      providers: {
        exa: { enabled: true },
        'custom-search': { enabled: true },
      },
      customProviders: {
        'custom-search': { type: 'npm', module: 'custom-search' },
      },
      trustedProviderIds: ['custom-search'],
    });
    const defaultResult = compile(source, {
      kind: 'mcp',
      input: { query: 'custom default' },
    });
    const explicitResult = compile(source, {
      kind: 'mcp',
      input: { query: 'custom explicit', providers: ['custom-search'] },
    });
    const groupSource = config({
      ...source,
      groups: { team: ['custom-search'] },
    });
    const groupResult = compile(groupSource, {
      kind: 'mcp',
      input: { query: 'custom group', group: 'team' },
    });
    for (const result of [defaultResult, explicitResult]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toContainEqual(
          expect.objectContaining({ code: 'custom_provider_profile_missing' }),
        );
      }
    }
    expect(explicitResult.ok).toBe(false);
    if (!explicitResult.ok) {
      expect(explicitResult.issues).not.toContainEqual(
        expect.objectContaining({ code: 'request_provider_token_unknown' }),
      );
    }
    expect(groupResult.ok).toBe(false);
    if (!groupResult.ok) {
      expect(groupResult.issues).toContainEqual(
        expect.objectContaining({ code: 'configuration_group_member_unknown' }),
      );
    }
  });

  it('plans trusted custom profiles by adapter, qualified identity, group, and default without loading code', () => {
    const source = customSource({ groups: { team: ['acme-adapter'] } });
    for (const transport of [
      {
        kind: 'mcp' as const,
        input: { query: 'adapter', providers: ['acme-adapter'] },
      },
      {
        kind: 'mcp' as const,
        input: { query: 'qualified', providers: ['acme/search'] },
      },
      {
        kind: 'mcp' as const,
        input: { query: 'group', group: 'team' },
      },
      { kind: 'mcp' as const, input: { query: 'default' } },
    ]) {
      const result = compile(source, transport);
      expect(profileKeys(result)).toEqual(['acme/search']);
      if (!result.ok) continue;
      expect(result.prepared.profile_plans_by_identity).toEqual(
        expect.objectContaining({
          [JSON.stringify([
            'acme',
            'search',
            'not_applicable',
            null,
            null,
            null,
            null,
            null,
          ])]: expect.objectContaining({
            binding: {
              adapter_id: 'acme-adapter',
              binding_id: 'acme.search.v1',
            },
          }),
        }),
      );
    }
  });

  it('plans a compatible custom fallback and durable async profile', () => {
    const fallbackSource = customSource({
      providers: {
        exa: { enabled: true, fallback: 'acme-adapter' },
        'acme-adapter': { enabled: true },
      },
    });
    const fallback = compile(fallbackSource, {
      kind: 'mcp',
      input: { query: 'fallback', providers: ['exa'] },
    });
    expect(fallback.ok).toBe(true);
    if (fallback.ok) {
      expect(
        fallback.prepared.request.fallback_reserve.map(
          (candidate) =>
            `${candidate.profile.identity.provider_id}/${candidate.profile.identity.profile_id}`,
        ),
      ).toEqual(['acme/search']);
    }

    const durable = customSource({
      defaults: { mode: 'async' },
      customProviders: {
        'acme-adapter': {
          type: 'script',
          command: 'must-not-run',
          executionProfile: {
            bindingId: 'acme.research.v1',
            profile: customExecutionProfile('background'),
          },
        },
      },
    });
    const asyncResult = compile(durable, {
      kind: 'mcp',
      input: {
        query: 'durable',
        mode: 'async',
        providers: ['acme-adapter'],
      },
    });
    expect(profileKeys(asyncResult)).toEqual(['acme/research']);
  });

  it('keeps untrusted and disabled custom declarations out and rejects process-local planning', () => {
    const untrusted = customSource({ trustedProviderIds: [] });
    const disabled = customSource({
      providers: { 'acme-adapter': { enabled: false } },
    });
    for (const source of [untrusted, disabled]) {
      const result = compile(source, {
        kind: 'mcp',
        input: { query: 'not eligible', providers: ['acme-adapter'] },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toContainEqual(
          expect.objectContaining({ code: 'request_provider_token_unknown' }),
        );
      }
    }

    const processLocal = customSource({
      customProviders: {
        'acme-adapter': {
          type: 'npm',
          module: 'must-not-import',
          executionProfile: {
            bindingId: 'acme.local.v1',
            profile: {
              ...customExecutionProfile('background'),
              resumability: 'process_local',
            },
          },
        },
      },
    });
    const result = compile(processLocal, {
      kind: 'mcp',
      input: { query: 'local', providers: ['acme-adapter'] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: 'custom_provider_process_local_unsupported',
        }),
      );
    }
  });

  it.each(PLANNED_PROVIDER_IDS)(
    'keeps planned built-in adapter id %s reserved in request compilation',
    (providerId) => {
      const result = compile(
        config({
          providers: { [providerId]: { enabled: true } },
          customProviders: {
            [providerId]: {
              type: 'npm',
              module: 'must-not-import',
              executionProfile: {
                bindingId: 'malicious.v1',
                profile: customExecutionProfile(),
              },
            },
          },
          trustedProviderIds: [providerId],
        }),
        {
          kind: 'mcp',
          input: { query: providerId, providers: [providerId] },
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toContainEqual(
          expect.objectContaining({ code: 'request_provider_token_unknown' }),
        );
        expect(result.issues).not.toContainEqual(
          expect.objectContaining({ code: 'custom_provider_profile_missing' }),
        );
      }
    },
  );

  it('returns structured reserved-provider and slash diagnostics without throwing', () => {
    const cases = [
      {
        source: customSource({
          customProviders: {
            'acme-adapter': {
              type: 'npm',
              module: 'must-not-import',
              executionProfile: {
                bindingId: 'acme.v1',
                profile: {
                  ...customExecutionProfile(),
                  identity: {
                    ...customExecutionProfile().identity,
                    provider_id: 'parallel',
                  },
                },
              },
            },
          },
        }),
        code: 'custom_provider_profile_provider_id_reserved',
      },
      {
        source: config({
          providers: { 'acme/adapter': { enabled: true } },
          customProviders: {
            'acme/adapter': {
              type: 'npm',
              module: 'must-not-import',
              executionProfile: {
                bindingId: 'acme.v1',
                profile: customExecutionProfile(),
              },
            },
          },
          trustedProviderIds: ['acme/adapter'],
        }),
        code: 'custom_provider_adapter_id_unaddressable',
      },
      {
        source: customSource({
          customProviders: {
            'acme-adapter': {
              type: 'npm',
              module: 'must-not-import',
              executionProfile: {
                bindingId: 'acme.v1',
                profile: {
                  ...customExecutionProfile(),
                  identity: {
                    ...customExecutionProfile().identity,
                    provider_id: 'acme/provider',
                  },
                },
              },
            },
          },
        }),
        code: 'custom_provider_profile_id_unaddressable',
      },
      {
        source: customSource({
          customProviders: {
            'acme-adapter': {
              type: 'npm',
              module: 'must-not-import',
              executionProfile: {
                bindingId: 'acme.v1',
                profile: {
                  ...customExecutionProfile(),
                  identity: {
                    ...customExecutionProfile().identity,
                    profile_id: 'search/v2',
                  },
                },
              },
            },
          },
        }),
        code: 'custom_provider_profile_id_unaddressable',
      },
    ];
    for (const { source, code } of cases) {
      expect(() =>
        compile(source, {
          kind: 'mcp',
          input: {
            query: code,
            providers: [Object.keys(source.providers)[0]!],
          },
        }),
      ).not.toThrow();
      const result = compile(source, {
        kind: 'mcp',
        input: { query: code, providers: [Object.keys(source.providers)[0]!] },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toContainEqual(expect.objectContaining({ code }));
      }
    }
  });

  it('never treats built-in ids or aliases as missing custom profiles', () => {
    const canonical = compile(
      config({
        providers: { exa: { enabled: true } },
        customProviders: {
          exa: {
            type: 'npm',
            module: 'malicious-exa',
            executionProfile: {
              bindingId: 'malicious.v1',
              profile: customExecutionProfile(),
            },
          },
        },
        trustedProviderIds: ['exa'],
      }),
      {
        kind: 'mcp',
        input: { query: 'canonical collision', providers: ['exa'] },
      },
    );
    expect(profileKeys(canonical)).toEqual(['exa/search']);
    expect(canonical.notices).not.toContainEqual(
      expect.objectContaining({ code: 'custom_provider_profile_missing' }),
    );

    const alias = compile(
      config({
        providers: { 'openai-deep': { enabled: true } },
        customProviders: {
          'openai-deep': {
            type: 'npm',
            module: 'malicious-openai',
            executionProfile: {
              bindingId: 'malicious.v1',
              profile: customExecutionProfile(),
            },
          },
        },
        trustedProviderIds: ['openai-deep'],
        defaults: { mode: 'async' },
      }),
      {
        kind: 'mcp',
        input: {
          query: 'alias collision',
          providers: ['openai-research'],
          mode: 'async',
        },
      },
    );
    expect(profileKeys(alias)).toEqual(['openai-research/research']);
    expect(alias.notices).not.toContainEqual(
      expect.objectContaining({ code: 'custom_provider_profile_missing' }),
    );
  });

  it('does not traverse prototype keys during custom-provider group analysis', () => {
    const source = config({
      providers: {
        exa: { enabled: true },
        'custom-search': { enabled: true },
      },
      customProviders: {
        'custom-search': { type: 'npm', module: 'custom-search' },
      },
      trustedProviderIds: ['custom-search'],
    });
    for (const group of ['__proto__', 'constructor', 'prototype']) {
      const result = compile(source, {
        kind: 'mcp',
        input: { query: group, group },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toContainEqual(
          expect.objectContaining({
            code: 'request_group_unknown',
            path: '/group',
          }),
        );
      }
    }
  });

  it('returns mapping gates before any clock or id calls', () => {
    const source = config({
      providers: { exa: { enabled: true } },
      groups: { quick: ['exa'], 'custom:quick': ['exa'] },
    });
    const collisionDependencies = countedPreparation();
    const collision = compileRequest({
      config: source,
      authoredGroups: { global: source.groups, project: {} },
      credentials: credentials(),
      requestDeadlineMs: 1_000_000,
      transport: { kind: 'mcp', input: { query: 'collision', group: 'quick' } },
      preparation: collisionDependencies.dependencies,
    });
    expect(collision.ok).toBe(false);
    if (!collision.ok) {
      expect(collision.issues).toEqual([
        expect.objectContaining({ code: 'request_group_collision' }),
        expect.objectContaining({ code: 'reserved_workflow_name_collision' }),
      ]);
    }
    expect(collisionDependencies.calls()).toBe(0);

    const inexactSource = config({
      providers: { exa: { enabled: true } },
      defaults: { maxEstimatedCostUsd: 0.0000001 },
    });
    const inexactDependencies = countedPreparation();
    const inexact = compileRequest({
      config: inexactSource,
      authoredGroups: { global: inexactSource.groups, project: {} },
      credentials: credentials(),
      requestDeadlineMs: 1_000_000,
      transport: { kind: 'mcp', input: { query: 'inexact' } },
      preparation: inexactDependencies.dependencies,
    });
    expect(inexact.ok).toBe(false);
    if (!inexact.ok) {
      expect(inexact.issues).toContainEqual(
        expect.objectContaining({ code: 'transport_budget_not_exact' }),
      );
    }
    expect(inexactDependencies.calls()).toBe(0);
  });

  it('derives a bounded request deadline before materialization effects', () => {
    const source = config({ providers: { exa: { enabled: true } } });
    const dependencies = countedPreparation();
    const result = compileRequest({
      config: source,
      authoredGroups: { global: source.groups, project: {} },
      credentials: credentials(),
      transport: {
        kind: 'mcp',
        input: { query: 'deadline', providers: ['exa'] },
      },
      preparation: dependencies.dependencies,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.policy.limits).toMatchObject({
        request_deadline_ms: 300_000,
        background_attempt_deadline_ms: 300_000,
      });
    }
    expect(dependencies.calls()).toBe(3);
  });

  it('carries a configured request deadline identically through CLI and MCP preparation', () => {
    const source = config({
      providers: { exa: { enabled: true } },
      defaults: { requestDeadlineMs: 450_000 },
    });
    const prepared = (['cli', 'mcp', 'silent_mcp'] as const).map((kind) => {
      const result = compileRequest({
        config: source,
        authoredGroups: { global: source.groups, project: {} },
        credentials: credentials(),
        transport: {
          kind,
          input: { query: 'configured deadline', providers: ['exa'] },
        },
        preparation: preparation(),
      });
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      expect(result.prepared.policy.limits.request_deadline_ms).toBe(450_000);
      return JSON.stringify(result.prepared);
    });

    expect(new Set(prepared).size).toBe(1);
  });

  it('sorts merged diagnostics globally and prepares CLI, MCP, and silent MCP identically', () => {
    const source = config({ providers: { exa: { enabled: true } } });
    const invalid = compile(source, {
      kind: 'cli',
      input: { query: 'sorted', providers: ['missing', ' '] },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect([...invalid.issues].sort(comparePreparationDiagnostics)).toEqual(
        invalid.issues,
      );
    }

    const openRouterSource = config({
      providers: {
        'openrouter-online': { enabled: true },
        'openrouter-chat': { enabled: true },
      },
    });
    const transports: RequestCompilationTransport[] = [
      {
        kind: 'cli',
        input: {
          query: '  parity  ',
          providers: ['OpenRouter Online Search', 'openrouter-chat'],
        },
      },
      {
        kind: 'mcp',
        input: {
          query: '  parity  ',
          providers: ['openrouter-online', 'openrouter/chat'],
        },
      },
      {
        kind: 'silent_mcp',
        input: {
          query: '  parity  ',
          providers: ['openrouter/grounded', 'openrouter-chat'],
        },
      },
    ];
    const prepared = transports.map((transport) => {
      const result = compile(openRouterSource, transport);
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      return JSON.stringify(result.prepared);
    });
    expect(new Set(prepared).size).toBe(1);

    const budgetSource = config({
      providers: { 'brave-search': { enabled: true } },
      defaults: { maxCostUsd: 0.25, maxEstimatedCostUsd: 0.1 },
    });
    const budgetPrepared = (['cli', 'mcp', 'silent_mcp'] as const).map(
      (kind) => {
        const result = compile(budgetSource, {
          kind,
          input: { query: 'budget parity', providers: ['brave-search'] },
        });
        if (!result.ok) throw new Error(JSON.stringify(result.issues));
        expect(result.prepared.policy.budgets).toEqual({
          max_estimated_cost_microusd: '100000',
          max_actual_cost_microusd: '250000',
        });
        return JSON.stringify(result.prepared);
      },
    );
    expect(new Set(budgetPrepared).size).toBe(1);
  });

  it('keeps authored group aliases and mixed-mode migration byte-identical across transports', () => {
    const groupSource = config({
      providers: { exa: { enabled: true } },
      groups: { team: ['exa'] },
    });
    const groupPrepared = (['cli', 'mcp', 'silent_mcp'] as const).map(
      (kind) => {
        const result = compile(groupSource, {
          kind,
          input: { query: 'group parity', group: 'team' },
        });
        if (!result.ok) throw new Error(JSON.stringify(result.issues));
        expect(result.notices).toContainEqual(
          expect.objectContaining({
            code: 'configuration_group_alias_migrated',
          }),
        );
        return JSON.stringify(result.prepared);
      },
    );
    expect(new Set(groupPrepared).size).toBe(1);

    const mixedSource = config({
      providers: { 'openai-research': { enabled: true } },
      defaults: { mode: 'mixed' },
    });
    const mixedPrepared = [
      {
        kind: 'cli' as const,
        input: { query: 'mixed parity', providers: ['openai-research'] },
      },
      {
        kind: 'mcp' as const,
        input: { query: 'mixed parity', providers: ['openai-research'] },
      },
      {
        kind: 'silent_mcp' as const,
        input: { query: 'mixed parity', providers: ['openai-research'] },
      },
    ].map((transport) => {
      const result = compile(mixedSource, transport);
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      expect(result.notices).toContainEqual(
        expect.objectContaining({ code: 'legacy_mixed_mode_migrated' }),
      );
      return JSON.stringify(result.prepared);
    });
    expect(new Set(mixedPrepared).size).toBe(1);
  });

  it('merges compatible mapper, group, and planner notices in global order', () => {
    const source = config({
      providers: { 'openai-deep': { enabled: true } },
      groups: { team: ['openai-deep'] },
      defaults: { mode: 'mixed' },
    });
    const result = compile(source, {
      kind: 'mcp',
      input: { query: 'merged notices', group: 'team' },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect([...result.notices].sort(comparePreparationDiagnostics)).toEqual(
      result.notices,
    );
    for (const code of [
      'configuration_provider_id_migrated',
      'configuration_provider_alias_migrated',
      'configuration_group_alias_migrated',
      'legacy_mixed_mode_migrated',
    ]) {
      expect(result.notices).toContainEqual(expect.objectContaining({ code }));
    }
  });

  it('sorts provider-alias, override, and mixed-mode notices together', () => {
    const source = config({
      providers: { 'openai-research': { enabled: true } },
      defaults: { mode: 'mixed' },
    });
    const result = compile(source, {
      kind: 'cli',
      input: {
        query: 'provider precedence notices',
        providers: ['openai-research'],
        group: 'ignored-group',
      },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect([...result.notices].sort(comparePreparationDiagnostics)).toEqual(
      result.notices,
    );
    for (const code of [
      'transport_explicit_providers_override_group',
      'legacy_mixed_mode_migrated',
    ]) {
      expect(result.notices).toContainEqual(expect.objectContaining({ code }));
    }
  });

  it('stays private and has an edge-safe esbuild dependency graph', async () => {
    const result = await build({
      entryPoints: [
        fileURLToPath(
          new URL('../src/core/request-compilation.ts', import.meta.url),
        ),
      ],
      bundle: true,
      format: 'esm',
      metafile: true,
      packages: 'external',
      platform: 'neutral',
      write: false,
      logLevel: 'silent',
    });
    const graph = [
      ...Object.keys(result.metafile.inputs),
      ...Object.values(result.metafile.inputs).flatMap((input) =>
        input.imports.map(({ path }) => path),
      ),
    ].join('\n');
    expect(graph).not.toMatch(
      /(?:node:|execution-runtime|coordinator(?:-store)?|bridge|dispatcher|research-run|node-registry|(?:^|\/)commands(?:\/|$)|(?:^|\/)mcp(?:\/|$))/,
    );
    const productionEntryPoints = [
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
      fileURLToPath(new URL('../src/core-entry.ts', import.meta.url)),
      fileURLToPath(new URL('../src/node-entry.ts', import.meta.url)),
      ...readdirSync(fileURLToPath(new URL('../src/mcp/', import.meta.url)))
        .filter((name) => name.endsWith('.ts'))
        .map((name) =>
          fileURLToPath(new URL(`../src/mcp/${name}`, import.meta.url)),
        ),
    ];
    const production = await build({
      entryPoints: productionEntryPoints,
      bundle: true,
      format: 'esm',
      metafile: true,
      outdir: 'metafile-only',
      packages: 'external',
      platform: 'node',
      write: false,
      logLevel: 'silent',
    });
    const diagnosticImporters = Object.entries(production.metafile.inputs)
      .filter(([, input]) =>
        input.imports.some(({ path }) =>
          path.includes('node-request-preflight'),
        ),
      )
      .map(([path]) => path)
      .sort();
    expect(diagnosticImporters).toEqual([
      'src/commands/run.ts',
      'src/commands/wizard.ts',
      'src/mcp/research.ts',
      'src/node-live-validation-production.ts',
    ]);
    const compilationImporters = Object.entries(production.metafile.inputs)
      .filter(([, input]) =>
        input.imports.some(({ path }) => path.includes('request-compilation')),
      )
      .map(([path]) => path)
      .sort();
    expect(compilationImporters).toEqual(['src/node-request-preflight.ts']);
  });
});
