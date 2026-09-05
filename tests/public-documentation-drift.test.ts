import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as parallelAdapters from '../src/adapters/parallel.js';
import { createCliProgram } from '../src/cli-program.js';
import { ARTIFACTS_VERSION } from '../src/contracts/artifacts/versions.js';
import {
  BUILTIN_WORKFLOW_IDS,
  QUICK_WORKFLOW_ROSTER,
  VISIBILITY_WORKFLOW_ROSTER,
} from '../src/core/builtin-workflows.js';
import { BUILTIN_PRICING_SNAPSHOT } from '../src/core/pricing-snapshot.js';
import { BUILTIN_PROFILE_BINDING_SPECS } from '../src/core/profile-bindings.js';
import { BUILTIN_PROVIDER_DEFINITIONS } from '../src/core/provider-descriptor.js';
import { BUILTIN_PROVIDER_CATALOG } from '../src/core/provider-profiles.js';
import { SCRIPT_CUSTOM_PROVIDER_PROTOCOL_VERSION } from '../src/node-entry.js';

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const README = read('README.md');
const SKILL = read('SKILL.md');
const PROVIDER_GUIDE = read('docs/provider-development.md');
const CONTRACTS_GUIDE = read('contracts/README.md');
const PACKAGE = JSON.parse(read('package.json')) as {
  engines: { node: string };
  exports: Record<string, unknown>;
};
const MCP_SOURCE = read('src/mcp/server.ts');

const profileKeys = BUILTIN_PROVIDER_CATALOG.flatMap((provider) =>
  provider.profiles.map(
    (profile) => `${provider.provider_id}/${profile.profile_id}`,
  ),
);
const durableProfileKeys = BUILTIN_PROVIDER_CATALOG.flatMap((provider) =>
  provider.profiles
    .filter(
      (profile) =>
        profile.invocation === 'background' &&
        profile.resumability === 'durable',
    )
    .map((profile) => `${provider.provider_id}/${profile.profile_id}`),
);
const mcpTools = [
  ...MCP_SOURCE.matchAll(/server\.registerTool\(\s*'([^']+)'/g),
].map((match) => match[1]);

describe('public v2 documentation drift', () => {
  it('keeps the generated catalog facts in README aligned with source', () => {
    expect(BUILTIN_PROVIDER_CATALOG).toHaveLength(33);
    expect(profileKeys).toHaveLength(39);
    expect(README).toMatch(
      /\*\*33 built-in providers\*\* and \*\*39 implemented public\s+profiles\*\*/,
    );
    expect(SKILL).toContain(
      '33 built-in providers and 39 implemented profiles',
    );

    for (const provider of BUILTIN_PROVIDER_CATALOG) {
      expect(README).toContain(`${provider.provider_id}/`);
    }
    for (const key of profileKeys) expect(README).toContain(`\`${key}\``);
  });

  it('excludes beta Parallel Chat from every shipping authority and public claim', () => {
    const retained = ['parallel/research', 'parallel/search', 'parallel/turbo'];
    expect(
      profileKeys.filter((key) => key.startsWith('parallel/')).sort(),
    ).toEqual(retained);
    for (const definitions of [
      BUILTIN_PROFILE_BINDING_SPECS,
      BUILTIN_PRICING_SNAPSHOT.definitions,
    ]) {
      expect(
        definitions
          .filter(({ provider_id }) => provider_id === 'parallel')
          .map(({ provider_id, profile_id }) => `${provider_id}/${profile_id}`)
          .sort(),
      ).toEqual(retained);
    }
    expect(
      BUILTIN_PROVIDER_DEFINITIONS.filter(({ id }) =>
        id.startsWith('parallel-'),
      )
        .map(({ id }) => id)
        .sort(),
    ).toEqual(retained.map((key) => key.replace('/', '-')));
    expect(Object.keys(parallelAdapters).sort()).toEqual([
      'ParallelResearchProvider',
      'ParallelSearchProvider',
      'ParallelTurboProvider',
    ]);
    for (const document of [
      README,
      SKILL,
      PROVIDER_GUIDE,
      CONTRACTS_GUIDE,
      read('benchmark/targets.json'),
    ]) {
      expect(document).not.toMatch(/parallel[\s/-]+chat|ParallelChatProvider/i);
    }
  });

  it('keeps workflow names and curated rosters aligned with source', () => {
    expect(BUILTIN_WORKFLOW_IDS).toEqual([
      'quick',
      'deep',
      'visibility',
      'all',
    ]);
    for (const workflow of BUILTIN_WORKFLOW_IDS) {
      expect(README).toContain(`| \`${workflow}\` |`);
      expect(SKILL).toContain(`\`${workflow}\``);
    }
    for (const member of [
      ...QUICK_WORKFLOW_ROSTER,
      ...VISIBILITY_WORKFLOW_ROSTER,
    ]) {
      expect(README).toContain(
        `\`${member.provider_id}/${member.profile_id}\``,
      );
    }
    expect(README).toContain(
      'Custom groups must be stored and selected as `custom:<name>`',
    );
    expect(README).toContain(
      '| `deep` | Derived from implemented research-report profiles |',
    );
    expect(SKILL).toContain('`deep` for research-report profiles');
  });

  it('keeps the skill durable-profile roster aligned with source', () => {
    const row = SKILL.split('\n').find((line) =>
      line.startsWith('| background/durable |'),
    );
    expect(row).toBeDefined();
    expect(
      [...(row ?? '').matchAll(/`([^`]+\/[^`]+)`/g)].map((match) => match[1]),
    ).toEqual(durableProfileKeys);
  });

  it('documents every registered public command and long option', () => {
    const program = createCliProgram();
    for (const command of program.commands) {
      expect(README).toContain(`\`${command.name()}\``);
      for (const option of command.options) {
        if (option.long && option.long !== '--help') {
          expect(README).toContain(option.long);
        }
      }
    }

    const config = program.commands.find(
      (command) => command.name() === 'config',
    );
    const migrate = config?.commands.find(
      (command) => command.name() === 'migrate',
    );
    expect(migrate).toBeDefined();
    expect(README).toContain('`config migrate`');
    for (const option of migrate?.options ?? []) {
      if (option.long) expect(README).toContain(option.long);
    }
  });

  it('documents the source-derived MCP tool roster', () => {
    expect(mcpTools).toEqual([
      'research',
      'get_results',
      'check_async',
      'list_providers',
      'list_groups',
    ]);
    for (const tool of mcpTools) expect(README).toContain(`\`${tool}\``);
  });

  it('keeps package boundaries and Node support aligned with package metadata', () => {
    expect(Object.keys(PACKAGE.exports)).toEqual(['.', './core', './node']);
    expect(PACKAGE.engines.node).toBe('>=22.12.0');
    expect(README).toContain('`librarium`');
    expect(README).toContain('`librarium/core`');
    expect(README).toContain('`librarium/node`');
    expect(README).toContain('Node.js **22.12 or newer**');
  });

  it('keeps contract and script-provider versions documented', () => {
    expect(ARTIFACTS_VERSION).toBe('1.0.0');
    expect(SCRIPT_CUSTOM_PROVIDER_PROTOCOL_VERSION).toBe(1);
    expect(CONTRACTS_GUIDE).toContain(
      `ARTIFACTS_VERSION\` contract (currently \`${ARTIFACTS_VERSION}\`)`,
    );
    expect(PROVIDER_GUIDE).toContain(
      `\`protocolVersion: ${SCRIPT_CUSTOM_PROVIDER_PROTOCOL_VERSION}\``,
    );
    expect(PROVIDER_GUIDE).toContain('There is no separate `1.0.0`');
  });

  it('keeps shipped durable-profile rosters aligned with the catalog', () => {
    const durableProfiles = BUILTIN_PROVIDER_CATALOG.flatMap((provider) =>
      provider.profiles
        .filter(
          (profile) =>
            profile.invocation === 'background' &&
            profile.resumability === 'durable',
        )
        .map((profile) => `${provider.provider_id}/${profile.profile_id}`),
    ).sort();
    const documentedRoster = (document: string) => {
      const row = document.match(/\| background\/durable \| ([^|]+) \|/);
      expect(row).not.toBeNull();
      return [...(row?.[1] ?? '').matchAll(/`([^`]+)`/g)]
        .map((match) => match[1])
        .sort();
    };

    expect(documentedRoster(SKILL)).toEqual(durableProfiles);
  });

  it('keeps the execution, provenance, privacy, and paid-validation boundaries explicit', () => {
    for (const text of [README, SKILL, PROVIDER_GUIDE]) {
      expect(text).toContain('background/durable');
    }
    expect(README).toContain('process-local');
    expect(PROVIDER_GUIDE).toContain('process-local');
    expect(README).toContain(
      'correlated visibility evidence, not six independent confirmations',
    );
    expect(README).toContain(
      'not official OpenAI, Google, Microsoft, or Perplexity',
    );
    expect(README).toContain('fails closed if the account rejects it');
    expect(README).toContain(
      'missing estimate, missing reported cost, API unit, or token price is unknown',
    );
    expect(README).toContain('separate live-validation approval protocol');
    expect(PROVIDER_GUIDE).toContain(
      'exact-profile remote cancellation only for\n`valyu/research`',
    );
    expect(SKILL).not.toContain('higher citation count = higher confidence');
  });
});
