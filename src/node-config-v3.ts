import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { resolveProviderId } from './constants.js';
import { decimalUsdFromNumber } from './core/budget.js';
import { type ConfigV3, ConfigV3Schema } from './core/config-v3.js';
import { safeWriteFile } from './core/fs-utils.js';
import { executionAdapterProfileBindings } from './core/profile-bindings.js';
import { decimalUnits } from './core/run.js';
import { SOURCE_CATALOG } from './core/source-catalog.js';

export function configV3Path() {
  return resolve(homedir(), '.config/librarium/config.json');
}
export function saveConfigV3(config: ConfigV3, path = configV3Path()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  safeWriteFile(path, JSON.stringify(ConfigV3Schema.parse(config), null, 2), {
    mode: 0o600,
  });
}
export function migrateConfigV1(value: Record<string, unknown>): {
  config: ConfigV3;
  notices: string[];
} {
  if (value.version !== undefined && value.version !== 1)
    throw new Error('Unsupported config version; use setup for config v3');
  const providers = (value.providers ?? {}) as Record<
    string,
    {
      apiKey?: string;
      enabled?: boolean;
      model?: string;
      options?: Record<string, unknown>;
      fallback?: string;
    }
  >;
  const defaults = (value.defaults ?? {}) as Record<string, unknown>;
  const sources: ConfigV3['sources'] = {};
  const engines: ConfigV3['engines'] = { collector: 'searchapi' };
  const names = new Map<string, string>();
  const bindings = executionAdapterProfileBindings();
  for (const definition of SOURCE_CATALOG) {
    if (definition.kind === 'engine') {
      for (const variant of Object.values(definition.collectors ?? {}))
        if (variant.js) {
          names.set(variant.js, definition.id);
          names.set(variant.js.split('/')[0], definition.id);
          for (const binding of bindings.values())
            if (`${binding.provider_id}/${binding.profile_id}` === variant.js)
              names.set(binding.adapter_id, definition.id);
        }
      continue;
    }
    for (const variant of Object.values(definition.variants ?? {}))
      if (variant?.js) {
        const [providerId, profileId] = variant.js.split('/');
        names.set(variant.js, definition.id);
        names.set(providerId, definition.id);
        for (const binding of bindings.values())
          if (
            binding.provider_id === providerId &&
            binding.profile_id === profileId
          )
            names.set(binding.adapter_id, definition.id);
      }
    for (const rule of Object.values(definition.options ?? {}))
      for (const variant of Object.values(rule.variants ?? {}))
        if (variant.js) {
          names.set(variant.js, definition.id);
          names.set(variant.js.split('/')[0], definition.id);
          for (const binding of bindings.values())
            if (`${binding.provider_id}/${binding.profile_id}` === variant.js)
              names.set(binding.adapter_id, definition.id);
        }
  }
  const notices: string[] = [];
  for (const [originalId, provider] of Object.entries(providers)) {
    const id = resolveProviderId(originalId);
    const name = names.get(id);
    if (!name) {
      notices.push(`Unmapped provider ${id}; register it as a custom source`);
      continue;
    }
    const definition = SOURCE_CATALOG.find((source) => source.id === name);
    const key = provider.apiKey?.startsWith('$')
      ? `env:${provider.apiKey.slice(1)}`
      : provider.apiKey;
    if (definition?.kind === 'engine') {
      engines[name] = {
        ...(key && { key }),
        ...(provider.enabled !== undefined && { enabled: provider.enabled }),
      };
      continue;
    }
    const options = Object.fromEntries(
      Object.entries(provider.options ?? {}).filter(
        ([option]) => definition?.options?.[option],
      ),
    );
    if (name === 'valyu' && provider.options?.outputFormats !== undefined)
      options.output = provider.options.outputFormats;
    if (name === 'parallel' && provider.model)
      options.processor = provider.model;
    if (name === 'valyu' && provider.model) options.mode = provider.model;
    for (const [option, rule] of Object.entries(definition?.options ?? {}))
      for (const [choice, variant] of Object.entries(rule.variants ?? {}))
        if (
          variant.js &&
          (variant.js === id ||
            [...bindings.values()].some(
              (binding) =>
                `${binding.provider_id}/${binding.profile_id}` === variant.js &&
                binding.adapter_id === id,
            ) ||
            (!id.includes('/') &&
              variant.js.split('/')[0] === id &&
              !Object.values(definition?.variants ?? {}).some(
                (base) => base?.js?.split('/')[0] === id,
              )))
        )
          options[option] = choice;
    if (sources[name] && key && sources[name].key && sources[name].key !== key)
      notices.push(
        `Multiple credentials for ${name}; kept the last configured variant. Review setup.`,
      );
    const model =
      provider.model && definition?.options?.model ? provider.model : undefined;
    sources[name] = {
      ...sources[name],
      ...(key && { key }),
      ...(provider.enabled !== undefined && { enabled: provider.enabled }),
      ...(model && { model }),
      ...options,
    };
    if (provider.fallback)
      notices.push(`Dropped fallback for ${name}; use only/skip`);
  }
  if (defaults.mode !== undefined)
    notices.push('Dropped mode; depth determines execution');
  if (
    defaults.fallbacks !== undefined ||
    defaults.fallbackOrder !== undefined ||
    value.fallbacks !== undefined
  )
    notices.push('Dropped fallback reserves; use only/skip');
  const groups: Record<string, string[]> = {};
  for (const [name, members] of Object.entries(
    (value.groups ?? {}) as Record<string, string[]>,
  )) {
    const group = name.startsWith('custom:') ? name.slice(7) : name;
    groups[group] =
      group === 'visibility' && members.length === 0
        ? SOURCE_CATALOG.filter((source) => source.kind === 'engine').map(
            (source) => source.id,
          )
        : [
            ...new Set(
              members.map(
                (member) =>
                  names.get(resolveProviderId(member)) ?? member.split('/')[0],
              ),
            ),
          ];
  }
  if (defaults.group === 'visibility' && !groups.visibility)
    groups.visibility = SOURCE_CATALOG.filter(
      (source) => source.kind === 'engine',
    ).map((source) => source.id);
  const caps = [
    defaults.maxCostUsd,
    defaults.maxEstimatedCostUsd,
    defaults.maxEstimatedCost,
    defaults.maxCost,
  ]
    .filter((value) => value != null)
    .map((value) =>
      typeof value === 'number' ? decimalUsdFromNumber(value) : String(value),
    );
  const cap = caps.sort((a, b) =>
    decimalUnits(a) < decimalUnits(b) ? -1 : 1,
  )[0];
  return {
    config: ConfigV3Schema.parse({
      version: 3,
      sources,
      engines,
      groups,
      ...(cap !== undefined && {
        max_cost: typeof cap === 'number' ? decimalUsdFromNumber(cap) : cap,
      }),
      runs: { path: defaults.outputDir ?? './agents/librarium' },
    }),
    notices,
  };
}
export function loadConfigV3(
  path = configV3Path(),
  onNotice: (notice: string) => void = (notice) => {
    process.stderr.write(`${notice}\n`);
  },
) {
  if (!existsSync(path)) return ConfigV3Schema.parse({ version: 3 });
  const text = readFileSync(path, 'utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid config JSON; file contents omitted');
  }
  if (value.version === 3) {
    const parsed = ConfigV3Schema.safeParse(value);
    if (
      !parsed.success &&
      parsed.error.issues.some((issue) =>
        issue.message.startsWith('group_name_conflict:'),
      )
    )
      throw new Error(
        'group_name_conflict: rename the saved group with setup/config',
      );
    if (!parsed.success)
      throw new Error(
        'Invalid v3 config; check sources, groups, budget and storage with setup',
      );
    return parsed.data;
  }
  if (value.version === 2)
    throw new Error('Config v2 never shipped; use setup to write a v3 config');
  const { config, notices } = migrateConfigV1(value);
  const backup = `${path}.v1.backup`;
  // Never overwrite the original backup, and never migrate without one.
  if (!existsSync(backup))
    writeFileSync(backup, text, { flag: 'wx', mode: 0o600 });
  else if (readFileSync(backup, 'utf8') !== text)
    throw new Error(
      'Existing v1 backup differs; preserve the current config before migrating',
    );
  saveConfigV3(config, path);
  for (const notice of notices) onNotice(notice);
  return config;
}
