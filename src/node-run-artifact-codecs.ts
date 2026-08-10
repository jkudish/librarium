import {
  existsSync as fsExistsSync,
  lstatSync as fsLstatSync,
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
  realpathSync as fsRealpathSync,
  statSync as fsStatSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  ActualCostSource,
  Citation,
  CostConfidence,
  DeduplicatedSource,
  ProviderMetering,
  ProviderReport,
  ProviderTier,
  ProviderUsage,
  RunManifest,
} from './types.js';

export interface RunArtifactMeta {
  readonly provider: string;
  readonly tier?: ProviderTier | string;
  readonly model?: string;
  readonly durationMs?: number;
  readonly citationCount?: number;
  readonly tokenUsage?: { readonly input?: number; readonly output?: number };
  readonly usage?: Readonly<
    Pick<
      ProviderUsage,
      | 'inputTokens'
      | 'outputTokens'
      | 'totalTokens'
      | 'costUsd'
      | 'billableUnits'
      | 'unit'
    >
  >;
  readonly metering?: ProviderMetering;
  readonly citations: readonly Citation[];
}

export type RunArtifactMetaInput = Omit<RunArtifactMeta, 'provider'> & {
  readonly provider?: string;
};

export interface RunArtifactProviderArtifact {
  readonly content?: string;
  readonly meta?: RunArtifactMeta;
  readonly recovered: boolean;
}

export interface RunArtifactAnswer {
  readonly content: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface RunArtifactPresence {
  readonly manifest: boolean;
  readonly prompt: boolean;
  readonly summary: boolean;
  readonly sources: boolean;
  readonly answer: boolean;
}

export interface RunArtifactSnapshot {
  readonly runDir: string;
  readonly manifest: Readonly<RunManifest>;
  readonly reports: readonly Readonly<ProviderReport>[];
  readonly providerArtifacts: Readonly<
    Record<string, Readonly<RunArtifactProviderArtifact>>
  >;
  readonly sources: readonly Readonly<DeduplicatedSource>[];
  readonly answer?: Readonly<RunArtifactAnswer>;
  readonly prompt?: string;
  readonly summary?: string;
  readonly artifactPresence: Readonly<RunArtifactPresence>;
}

export interface RunArtifactDiscovery {
  readonly runDir: string;
  readonly manifest: Readonly<RunManifest>;
}

export interface RunArtifactRepositoryFs {
  readonly existsSync: (path: string) => boolean;
  readonly lstatSync: (path: string) => Stats;
  readonly statSync: (path: string) => Stats;
  readonly realpathSync: (path: string) => string;
  readonly readdirSync: (path: string) => string[];
  readonly readFileSync: (path: string, encoding: 'utf8') => string;
}

export const DEFAULT_FS: RunArtifactRepositoryFs = {
  existsSync: fsExistsSync,
  lstatSync: fsLstatSync,
  statSync: fsStatSync,
  realpathSync: fsRealpathSync,
  readdirSync: (path) => fsReaddirSync(path, { encoding: 'utf8' }),
  readFileSync: (path, encoding) => fsReadFileSync(path, encoding),
};

export const FIXED_ARTIFACTS = {
  manifest: 'run.json',
  prompt: 'prompt.md',
  summary: 'summary.md',
  sources: 'sources.json',
  answer: 'answer.md',
} as const;

export function fixedFile(name: keyof typeof FIXED_ARTIFACTS): string {
  return FIXED_ARTIFACTS[name];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseCitation(
  value: unknown,
  expectedProvider?: string,
): Citation | null {
  if (
    !isRecord(value) ||
    typeof value.url !== 'string' ||
    typeof value.provider !== 'string' ||
    (expectedProvider !== undefined && value.provider !== expectedProvider) ||
    (value.title !== undefined && typeof value.title !== 'string') ||
    (value.snippet !== undefined && typeof value.snippet !== 'string')
  ) {
    return null;
  }
  return {
    url: value.url,
    provider: value.provider,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.snippet === undefined ? {} : { snippet: value.snippet }),
  };
}

const METERING_KINDS = new Set([
  'native_cost',
  'native_tokens',
  'request_priced',
  'credit_priced',
  'api_unit_priced',
  'manual_unmetered',
]);
const COST_CONFIDENCE = new Set([
  'reported',
  'configured',
  'estimated',
  'unknown',
]);
const ACTUAL_SOURCES = new Set([
  'provider_reported',
  'computed_from_tokens',
  'computed_from_request',
  'computed_from_credits',
  'account_usage_delta',
  'unknown',
]);

export function parseUsage(
  value: unknown,
): RunArtifactMeta['usage'] | undefined {
  if (!isRecord(value)) return undefined;
  const result: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
    billableUnits?: number;
    unit?: string;
  } = {};
  for (const key of [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'costUsd',
    'billableUnits',
  ] as const) {
    if (value[key] !== undefined && (!finite(value[key]) || value[key] < 0)) {
      return undefined;
    }
    if (value[key] !== undefined) result[key] = value[key];
  }
  if (value.unit !== undefined) {
    if (typeof value.unit !== 'string') return undefined;
    result.unit = value.unit;
  }
  return result;
}

function tokenUsage(value: unknown): RunArtifactMeta['tokenUsage'] | undefined {
  if (!isRecord(value)) return undefined;
  if (value.input !== undefined && (!finite(value.input) || value.input < 0)) {
    return undefined;
  }
  if (
    value.output !== undefined &&
    (!finite(value.output) || value.output < 0)
  ) {
    return undefined;
  }
  if (value.input === undefined && value.output === undefined) return undefined;
  return {
    ...(value.input === undefined ? {} : { input: value.input }),
    ...(value.output === undefined ? {} : { output: value.output }),
  };
}

export function parseMetering(value: unknown): ProviderMetering | undefined {
  if (
    !isRecord(value) ||
    typeof value.kind !== 'string' ||
    !METERING_KINDS.has(value.kind) ||
    (value.pricingVersion !== undefined &&
      typeof value.pricingVersion !== 'string')
  ) {
    return undefined;
  }
  const result: ProviderMetering = {
    kind: value.kind as ProviderMetering['kind'],
    ...(typeof value.pricingVersion === 'string'
      ? { pricingVersion: value.pricingVersion }
      : {}),
  };
  if (value.estimate !== undefined) {
    if (!isRecord(value.estimate)) return undefined;
    const estimate = value.estimate;
    if (
      typeof estimate.costConfidence !== 'string' ||
      !COST_CONFIDENCE.has(estimate.costConfidence) ||
      (estimate.estimatedCostUsd !== undefined &&
        (!finite(estimate.estimatedCostUsd) ||
          estimate.estimatedCostUsd < 0)) ||
      (estimate.billableUnits !== undefined &&
        (!finite(estimate.billableUnits) || estimate.billableUnits < 0)) ||
      (estimate.unit !== undefined && typeof estimate.unit !== 'string') ||
      (estimate.pricingVersion !== undefined &&
        typeof estimate.pricingVersion !== 'string')
    ) {
      return undefined;
    }
    result.estimate = {
      costConfidence: estimate.costConfidence as CostConfidence,
      ...(estimate.estimatedCostUsd === undefined
        ? {}
        : { estimatedCostUsd: estimate.estimatedCostUsd }),
      ...(estimate.billableUnits === undefined
        ? {}
        : { billableUnits: estimate.billableUnits }),
      ...(typeof estimate.unit === 'string' ? { unit: estimate.unit } : {}),
      ...(typeof estimate.pricingVersion === 'string'
        ? { pricingVersion: estimate.pricingVersion }
        : {}),
    };
  }
  if (value.actual !== undefined) {
    if (
      !isRecord(value.actual) ||
      typeof value.actual.source !== 'string' ||
      !ACTUAL_SOURCES.has(value.actual.source) ||
      (value.actual.costUsd !== undefined &&
        (!finite(value.actual.costUsd) || value.actual.costUsd < 0)) ||
      (value.actual.billableUnits !== undefined &&
        (!finite(value.actual.billableUnits) || value.actual.billableUnits < 0))
    ) {
      return undefined;
    }
    result.actual = {
      source: value.actual.source as ActualCostSource,
      ...(value.actual.costUsd === undefined
        ? {}
        : { costUsd: value.actual.costUsd }),
      ...(value.actual.billableUnits === undefined
        ? {}
        : { billableUnits: value.actual.billableUnits }),
    };
  }
  return result;
}

export function parseMeta(
  value: unknown,
  expectedProvider?: string,
): RunArtifactMeta | null {
  if (
    !isRecord(value) ||
    typeof value.provider !== 'string' ||
    (expectedProvider !== undefined && value.provider !== expectedProvider) ||
    !Array.isArray(value.citations)
  ) {
    return null;
  }
  const citations: Citation[] = [];
  for (const entry of value.citations) {
    const parsed = parseCitation(entry, expectedProvider);
    if (!parsed) return null;
    citations.push(parsed);
  }
  if (
    value.tier !== undefined &&
    (typeof value.tier !== 'string' ||
      !new Set(['deep-research', 'ai-grounded', 'raw-search', 'llm']).has(
        value.tier,
      ))
  ) {
    return null;
  }
  if (value.model !== undefined && typeof value.model !== 'string') return null;
  if (
    value.durationMs !== undefined &&
    (!finite(value.durationMs) || value.durationMs < 0)
  ) {
    return null;
  }
  if (
    value.citationCount !== undefined &&
    (!finite(value.citationCount) || value.citationCount < 0)
  ) {
    return null;
  }
  const token =
    value.tokenUsage === undefined ? undefined : tokenUsage(value.tokenUsage);
  const normalizedUsage =
    value.usage === undefined ? undefined : parseUsage(value.usage);
  const normalizedMetering =
    value.metering === undefined ? undefined : parseMetering(value.metering);
  if (
    (value.tokenUsage !== undefined && token === undefined) ||
    (value.usage !== undefined && normalizedUsage === undefined) ||
    (value.metering !== undefined && normalizedMetering === undefined)
  ) {
    return null;
  }
  return {
    provider: value.provider,
    ...(value.tier === undefined ? {} : { tier: value.tier }),
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
    ...(value.citationCount === undefined
      ? {}
      : { citationCount: value.citationCount }),
    ...(token === undefined ? {} : { tokenUsage: token }),
    ...(normalizedUsage === undefined ? {} : { usage: normalizedUsage }),
    ...(normalizedMetering === undefined
      ? {}
      : { metering: normalizedMetering }),
    citations,
  };
}

export function parseSources(value: unknown): DeduplicatedSource[] | null {
  if (!Array.isArray(value)) return null;
  const result: DeduplicatedSource[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.url !== 'string' ||
      typeof entry.normalizedUrl !== 'string' ||
      !Array.isArray(entry.providers) ||
      !entry.providers.every((provider) => typeof provider === 'string') ||
      !finite(entry.citationCount) ||
      entry.citationCount < 0 ||
      (entry.title !== undefined && typeof entry.title !== 'string')
    ) {
      return null;
    }
    result.push({
      url: entry.url,
      normalizedUrl: entry.normalizedUrl,
      providers: [...entry.providers],
      citationCount: entry.citationCount,
      ...(entry.title === undefined ? {} : { title: entry.title }),
    });
  }
  return result;
}

export function wordCount(content: string): number {
  return content.split(/\s+/).filter(Boolean).length;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeDeep(child);
  }
  return Object.freeze(value);
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  );
}

export function rejectUnsafeRelativeName(name: string): void {
  if (
    !name ||
    name.split(/[\\/]+/).some((part) => part === '.') ||
    /[\\/]$/.test(name) ||
    name.includes('\0') ||
    isAbsolute(name) ||
    /^[A-Za-z]:[\\/]/.test(name) ||
    name.split(/[\\/]+/).some((part) => part === '..')
  ) {
    throw new Error(`Unsafe run artifact path: ${name}`);
  }
}

export function resolveRunDirectoryWithFs(
  fs: RunArtifactRepositoryFs,
  baseDir: string,
  requested?: string,
): string | null {
  try {
    if (requested?.split(/[\\/]+/).some((part) => part === '..')) {
      return null;
    }
    const base = resolve(baseDir);
    if (
      !fs.existsSync(base) ||
      !fs.statSync(base).isDirectory() ||
      fs.lstatSync(base).isSymbolicLink()
    ) {
      return null;
    }
    const candidate =
      requested === undefined
        ? base
        : isAbsolute(requested)
          ? resolve(requested)
          : resolve(base, requested);
    if (
      !isPathInside(base, candidate) ||
      !fs.existsSync(candidate) ||
      !fs.statSync(candidate).isDirectory() ||
      fs.lstatSync(candidate).isSymbolicLink()
    ) {
      return null;
    }
    const realBase = fs.realpathSync(base);
    const realCandidate = fs.realpathSync(candidate);
    return isPathInside(realBase, realCandidate) ? realCandidate : null;
  } catch {
    return null;
  }
}

export function resolveContainedPathWithFs(
  fs: RunArtifactRepositoryFs,
  runDir: string,
  fileName: string,
): string {
  rejectUnsafeRelativeName(fileName);
  const root = resolve(runDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Run directory does not exist: ${runDir}`);
  }
  if (fs.lstatSync(root).isSymbolicLink()) {
    throw new Error(`Run directory must not be a symlink: ${runDir}`);
  }
  const realRoot = fs.realpathSync(root);
  const candidate = resolve(root, fileName);
  if (!isPathInside(root, candidate)) {
    throw new Error(`Unsafe run artifact path: ${fileName}`);
  }
  const rel = relative(root, candidate);
  let cursor = root;
  for (const component of rel.split(sep)) {
    if (!component) continue;
    cursor = join(cursor, component);
    if (!fs.existsSync(cursor)) break;
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(
        `Symlinked run artifact path is not allowed: ${fileName}`,
      );
    }
  }
  if (
    fs.existsSync(candidate) &&
    !isPathInside(realRoot, fs.realpathSync(candidate))
  ) {
    throw new Error(`Run artifact path escapes its run directory: ${fileName}`);
  }
  return candidate;
}
