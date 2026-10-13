import data from 'librarium-spec/sources.json' with { type: 'json' };
import { decimalFromUnits, decimalUnits, type Run } from './run.js';

export interface SourceVariant {
  js: string | null;
  php?: string | null;
  env: string;
  requires?: Record<string, string>;
}
export interface SourceOption {
  default?: unknown;
  values?: string[];
  type?: string;
  items?: string[];
  variants?: Record<string, SourceVariant>;
}
export interface SourceDefinition {
  id: string;
  name: string;
  kind: 'research' | 'engine';
  variants?: Partial<Record<'quick' | 'deep', SourceVariant>>;
  options?: Record<string, SourceOption>;
  collectors?: Record<string, SourceVariant>;
}
export const SOURCE_CATALOG = [
  ...data.sources,
  ...data.engines,
] as SourceDefinition[];
export interface SelectionSetup {
  sources: string[];
  engines: { collector: string; configured: boolean };
  groups: Record<string, string[]>;
  configuredEngines?: string[];
  collectors?: Record<string, string>;
}
export interface SelectionRequest {
  question: string;
  depth?: 'quick' | 'deep';
  only?: string[];
  skip?: string[];
  max_cost?: string;
}
export class SelectionError extends Error {
  constructor(
    readonly code: string,
    readonly source?: string,
  ) {
    super(`${code}${source ? `: ${source}` : ''}`);
  }
}
export function selectSources(
  setup: SelectionSetup,
  estimates: Record<string, string | null>,
  request: SelectionRequest,
  catalog = SOURCE_CATALOG,
) {
  const byId = new Map(catalog.map((source) => [source.id, source]));
  for (const name of Object.keys(setup.groups))
    if (byId.has(name)) throw new SelectionError('group_name_conflict', name);
  function expand(names: string[]): string[] {
    return names.flatMap((name) => {
      const members = setup.groups[name];
      if (members)
        return members.map((member) => {
          if (!byId.has(member))
            throw new SelectionError('unknown_name', member);
          return member;
        });
      if (!byId.has(name)) throw new SelectionError('unknown_name', name);
      return [name];
    });
  }
  const names = request.only
    ? expand(request.only)
    : setup.sources.filter((name) => byId.get(name)?.kind === 'research');
  if (!request.only && names.length === 0)
    throw new SelectionError('no_sources');
  if (request.only)
    for (const name of names) {
      if (
        byId.get(name)?.kind === 'engine'
          ? !(setup.configuredEngines
              ? setup.configuredEngines.includes(name)
              : setup.engines.configured)
          : !setup.sources.includes(name)
      )
        throw new SelectionError('not_configured', name);
    }
  const excluded = new Set(expand(request.skip ?? []));
  const selected: string[] = [];
  const skipped: Run['skipped'] = [];
  let total = 0n;
  let complete = true;
  const cap =
    request.max_cost === undefined ? null : decimalUnits(request.max_cost);
  for (const source of catalog.filter((source) => names.includes(source.id))) {
    const name = source.id;
    let reason: Run['skipped'][number]['reason'] | undefined;
    if (excluded.has(name)) reason = 'excluded';
    else if (
      request.depth === 'deep' &&
      (source.kind === 'engine' || !source.variants?.deep)
    )
      reason = 'no_deep_variant';
    else if (
      source.kind === 'engine' &&
      !source.collectors?.[setup.collectors?.[name] ?? setup.engines.collector]
    )
      reason = 'no_collector';
    else if (cap !== null && estimates[name] == null) reason = 'unpriced';
    else if (
      cap !== null &&
      total + decimalUnits(estimates[name] as string) > cap
    )
      reason = 'over_budget';
    if (reason) {
      skipped.push({ source: name, reason });
      continue;
    }
    selected.push(name);
    if (estimates[name] == null) complete = false;
    else total += decimalUnits(estimates[name]);
  }
  return {
    selected,
    skipped,
    ...(Object.keys(estimates).length > 0 && {
      estimated: complete ? decimalFromUnits(total) : null,
    }),
  };
}
export function resolveSourceVariant(
  source: SourceDefinition,
  depth: 'quick' | 'deep',
  options: Record<string, unknown>,
  collector = 'searchapi',
): SourceVariant | undefined {
  if (source.kind === 'engine')
    return depth === 'quick' ? source.collectors?.[collector] : undefined;
  let variant = source.variants?.[depth];
  for (const [name, option] of Object.entries(source.options ?? {})) {
    const value = options[name] ?? option.default;
    if (
      ((depth === 'quick' && name !== 'deep_effort') ||
        (depth === 'deep' && name === 'deep_effort')) &&
      option.variants &&
      typeof value === 'string'
    ) {
      const candidate = option.variants[value];
      if (
        candidate?.requires &&
        Object.entries(candidate.requires).some(
          ([key, expected]) =>
            (options[key] ?? source.options?.[key]?.default) !== expected,
        )
      )
        throw new TypeError(
          `Invalid option combination for ${source.id}.${name}`,
        );
      variant = candidate ?? variant;
    }
  }
  return variant;
}
export function validateSourceOptions(
  source: SourceDefinition,
  options: Record<string, unknown>,
): void {
  for (const [name, value] of Object.entries(options)) {
    const rule = source.options?.[name];
    if (!rule) throw new TypeError(`Unknown option ${source.id}.${name}`);
    if (rule.values && !rule.values.includes(String(value)))
      throw new TypeError(`Invalid option ${source.id}.${name}`);
    if (rule.type === 'string' && typeof value !== 'string')
      throw new TypeError(`Invalid option ${source.id}.${name}`);
    if (
      rule.type === 'integer' &&
      (!Number.isInteger(value) || Number(value) < 1)
    )
      throw new TypeError(`Invalid option ${source.id}.${name}`);
    if (
      rule.type === 'array' &&
      (!Array.isArray(value) ||
        (rule.items && value.some((item) => !rule.items?.includes(item))))
    )
      throw new TypeError(`Invalid option ${source.id}.${name}`);
  }
}
