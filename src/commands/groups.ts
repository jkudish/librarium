import type { Command } from 'commander';
import { OpaqueIdSchema } from '../contracts/common.js';
import {
  BUILTIN_WORKFLOW_IDS,
  CUSTOM_WORKFLOW_PREFIX,
  RESERVED_WORKFLOW_IDS,
} from '../core/builtin-workflows.js';
import {
  configGroupProvenance,
  loadConfig,
  saveConfig,
} from '../core/config.js';
import { mapConfiguration } from '../core/configuration-mapping.js';
import type { Config } from '../types.js';

interface GroupsCommandDependencies {
  readonly loadConfig: typeof loadConfig;
  readonly saveConfig: typeof saveConfig;
}

export interface ProviderGroupListing {
  readonly name: string;
  readonly members: readonly string[];
}

function profileKey(identity: {
  readonly provider_id: string;
  readonly profile_id: string;
}): string {
  return `${identity.provider_id}/${identity.profile_id}`;
}

/** Return exactly the groups accepted by canonical workflow selection. */
export function canonicalProviderGroups(
  config: Config,
): ProviderGroupListing[] {
  const mapped = mapConfiguration(config, {
    authoredGroups: configGroupProvenance(config),
    assumeCredentialAvailability: true,
  });
  const builtins = BUILTIN_WORKFLOW_IDS.map((name) => ({
    name,
    members: mapped.catalog.workflow(name).members.map(profileKey),
  }));
  const custom = mapped.catalog.custom_group_ids.map((name) => ({
    name,
    members: (mapped.catalog.resolveGroup(name) ?? []).map(profileKey),
  }));
  return [...builtins, ...custom];
}

function customGroupNameIssue(name: string): string | null {
  if (RESERVED_WORKFLOW_IDS.has(name)) {
    return `Group name "${name}" is reserved. Custom groups must use "${CUSTOM_WORKFLOW_PREFIX}${name}".`;
  }
  if (!name.startsWith(CUSTOM_WORKFLOW_PREFIX)) {
    return `Custom groups must use a canonical "${CUSTOM_WORKFLOW_PREFIX}<name>" id (for example, "${CUSTOM_WORKFLOW_PREFIX}${name}").`;
  }
  const suffix = name.slice(CUSTOM_WORKFLOW_PREFIX.length);
  if (
    !OpaqueIdSchema.safeParse(name).success ||
    !OpaqueIdSchema.safeParse(suffix).success
  ) {
    return `Invalid custom group id "${name}". Use "${CUSTOM_WORKFLOW_PREFIX}<name>" with a non-empty name and no surrounding whitespace or control characters.`;
  }
  return null;
}

function authoredGlobalGroups(config: Config): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(configGroupProvenance(config).global).map(
      ([name, members]) => [name, [...members]],
    ),
  );
}

export function registerGroupsCommand(
  program: Command,
  dependencies: Partial<GroupsCommandDependencies> = {},
): void {
  const load = dependencies.loadConfig ?? loadConfig;
  const save = dependencies.saveConfig ?? saveConfig;
  const groupsCmd = program
    .command('groups')
    .description('List and manage provider groups');

  // Default action: list groups
  groupsCmd.option('--json', 'Output JSON').action((opts) => {
    try {
      const config = load();
      const groups = canonicalProviderGroups(config);

      if (opts.json) {
        console.log(
          JSON.stringify(
            Object.fromEntries(
              groups.map(({ name, members }) => [name, members]),
            ),
            null,
            2,
          ),
        );
        return;
      }

      console.log('\nProvider Groups:\n');
      for (const { name, members } of groups) {
        console.log(`  ${name}`);
        console.log(`    ${members.join(', ')}`);
        console.log('');
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

  // Sub-command: add group
  groupsCmd
    .command('add')
    .description('Add or update a custom provider group')
    .argument('<name>', 'Group name')
    .argument('<providers...>', 'Provider IDs to include')
    .action((name: string, providers: string[]) => {
      try {
        const nameIssue = customGroupNameIssue(name);
        if (nameIssue) {
          console.error(nameIssue);
          process.exitCode = 1;
          return;
        }
        const config = load();
        const groups = authoredGlobalGroups(config);
        groups[name] = [...providers];
        save({ ...config, groups });
        console.log(
          `Group "${name}" saved with providers: ${providers.join(', ')}`,
        );
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });

  // Sub-command: remove group
  groupsCmd
    .command('remove')
    .description('Remove a custom group')
    .argument('<name>', 'Group name')
    .action((name: string) => {
      try {
        const nameIssue = customGroupNameIssue(name);
        if (nameIssue) {
          console.error(nameIssue);
          process.exitCode = 1;
          return;
        }
        const config = load();
        const groups = authoredGlobalGroups(config);
        if (!Object.hasOwn(groups, name)) {
          console.error(`Group "${name}" not found.`);
          process.exitCode = 1;
          return;
        }
        delete groups[name];
        save({ ...config, groups });
        console.log(`Group "${name}" removed.`);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}
