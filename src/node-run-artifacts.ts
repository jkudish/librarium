/**
 * Private Node-only access to the v2 run artifact store.
 *
 * This module deliberately does not appear in a package entry point. The
 * worker-safe core owns the manifest shape and mutation primitives; this
 * service owns the filesystem boundary around those primitives.
 */
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { sanitizeId } from './constants.js';
import { safeWriteFile as defaultSafeWriteFile } from './core/fs-utils.js';
import { deduplicateSources } from './core/normalizer.js';
import {
  applyRunLifecycle,
  mutateRunManifest,
  RunManifestError,
  readRunManifest,
} from './core/run-manifest.js';
import type {
  RunArtifactDiscovery,
  RunArtifactMeta,
  RunArtifactMetaInput,
  RunArtifactPresence,
  RunArtifactProviderArtifact,
  RunArtifactRepositoryFs,
  RunArtifactSnapshot,
} from './node-run-artifact-codecs.js';
import {
  clone,
  DEFAULT_FS,
  fixedFile,
  freezeDeep,
  parseMeta,
  parseMetering,
  parseSources,
  parseUsage,
  resolveContainedPathWithFs,
  resolveRunDirectoryWithFs,
  wordCount,
} from './node-run-artifact-codecs.js';
import type {
  Citation,
  DeduplicatedSource,
  ProviderMetering,
  ProviderReport,
  ProviderUsage,
  RunManifest,
} from './types.js';

export type {
  RunArtifactAnswer,
  RunArtifactDiscovery,
  RunArtifactMeta,
  RunArtifactMetaInput,
  RunArtifactPresence,
  RunArtifactProviderArtifact,
  RunArtifactRepositoryFs,
  RunArtifactSnapshot,
} from './node-run-artifact-codecs.js';

export type RunArtifactView = 'authoritative' | 'recovery';

export interface CommitRetrievedInput {
  readonly runDir: string;
  readonly providerId: string;
  readonly taskId: string;
  readonly report: ProviderReport;
  readonly content: string;
  readonly meta: RunArtifactMetaInput;
  readonly now?: number;
}

interface ValidatedReportFields {
  readonly tier: ProviderReport['tier'];
  readonly durationMs: number;
  readonly wordCount: number;
  readonly citationCount: number;
  readonly usage?: ProviderUsage;
  readonly metering?: ProviderMetering;
  readonly error?: string;
  readonly fallbackFor?: string;
  readonly preventFallback?: true;
}

const RETRIEVED_SENTINEL = Symbol('run-artifact-already-retrieved');

const RESERVED_ARTIFACT_NAMES = new Set([
  'run.json',
  'run.json.lock',
  'prompt.md',
  'summary.md',
  'sources.json',
  'answer.md',
  'report.html',
  'results.jsonl',
]);

const REPORT_TIERS = new Set([
  'deep-research',
  'ai-grounded',
  'raw-search',
  'llm',
]);
const TASK_STATUSES = new Set([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isSafeString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 512 &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  );
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unknown ${label} field: ${key}`);
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface ProviderArtifactFileNames {
  readonly outputFile: string;
  readonly metaFile: string;
}

/** Collision-resistant names for all newly written provider artifacts. */
export function providerArtifactFileNames(
  providerId: string,
): ProviderArtifactFileNames {
  const stem = sanitizeId(providerId).slice(0, 64) || 'provider';
  const digest = createHash('sha256').update(providerId, 'utf8').digest('hex');
  return {
    outputFile: `provider-${stem}--${digest}.md`,
    metaFile: `provider-${stem}--${digest}.meta.json`,
  };
}

function legacyStemKey(providerId: string): string {
  return sanitizeId(providerId).replace(/[A-Z]/g, (character) =>
    character.toLowerCase(),
  );
}

export interface RunArtifactRepositoryOptions {
  readonly fs?: Partial<RunArtifactRepositoryFs>;
  readonly writeFile?: (path: string, content: string) => void;
  readonly readManifest?: typeof readRunManifest;
  readonly mutateManifest?: typeof mutateRunManifest;
  readonly now?: () => number;
}

export function resolveRunDirectory(
  baseDir: string,
  requested?: string,
): string | null {
  return resolveRunDirectoryWithFs(DEFAULT_FS, baseDir, requested);
}

export function resolveContainedPath(runDir: string, fileName: string): string {
  return resolveContainedPathWithFs(DEFAULT_FS, runDir, fileName);
}
/** Private Node-only v2 run artifact repository. */
export class RunArtifactRepository {
  private readonly fs: RunArtifactRepositoryFs;
  private readonly writeFile: (path: string, content: string) => void;
  private readonly readManifestImpl: typeof readRunManifest;
  private readonly mutateManifestImpl: typeof mutateRunManifest;
  private readonly now: () => number;

  constructor(options: RunArtifactRepositoryOptions = {}) {
    this.fs = { ...DEFAULT_FS, ...(options.fs ?? {}) };
    this.writeFile = options.writeFile ?? defaultSafeWriteFile;
    this.readManifestImpl = options.readManifest ?? readRunManifest;
    this.mutateManifestImpl = options.mutateManifest ?? mutateRunManifest;
    this.now = options.now ?? Date.now;
  }

  resolveRunDirectory(baseDir: string, requested?: string): string | null {
    return resolveRunDirectoryWithFs(this.fs, baseDir, requested);
  }

  resolveContainedPath(runDir: string, fileName: string): string {
    return resolveContainedPathWithFs(this.fs, runDir, fileName);
  }

  readManifest(runDir: string): RunManifest {
    const safeRunDir = this.assertRunDirectory(runDir);
    // Validate the manifest path through the same containment gate as every
    // declared artifact before delegating strict parsing/error semantics.
    this.resolveContainedPath(safeRunDir, fixedFile('manifest'));
    return this.readManifestImpl(safeRunDir);
  }

  tryReadManifest(runDir: string): RunManifest | null {
    try {
      return this.readManifest(runDir);
    } catch {
      return null;
    }
  }

  discoverRuns(baseDir: string, limit = 20): readonly RunArtifactDiscovery[] {
    const base = this.resolveRunDirectory(baseDir);
    if (!base) return [];
    let names: string[];
    try {
      names = this.fs.readdirSync(base);
    } catch {
      return [];
    }
    const entries: RunArtifactDiscovery[] = [];
    for (const name of names) {
      const runDir = this.resolveRunDirectory(base, name);
      if (!runDir || runDir === base) continue;
      try {
        const manifest = this.readManifest(runDir);
        entries.push({ runDir, manifest: freezeDeep(clone(manifest)) });
      } catch {
        // Discovery is intentionally best-effort. Strict consumers call
        // readManifest/readSnapshot directly and retain RunManifestError.
      }
    }
    entries.sort((a, b) => b.manifest.timestamp - a.manifest.timestamp);
    return entries.slice(0, Math.max(0, limit));
  }

  readSnapshot(
    runDir: string,
    options: { readonly view?: RunArtifactView } | RunArtifactView = {},
  ): RunArtifactSnapshot {
    const view =
      typeof options === 'string' ? options : (options.view ?? 'authoritative');
    const canonicalRunDir = this.assertRunDirectory(runDir);
    const manifest = this.readManifest(runDir);
    const reports = manifest.providers.map((report) => clone(report));
    const artifactEntries: Array<[string, RunArtifactProviderArtifact]> = [];

    for (const report of reports) {
      const artifact = this.readDeclaredProviderArtifact(
        canonicalRunDir,
        report,
      );
      artifactEntries.push([report.id, artifact]);
    }

    if (view === 'recovery') {
      const legacyStemCounts = new Map<string, number>();
      for (const report of reports) {
        const stem = legacyStemKey(report.id);
        legacyStemCounts.set(stem, (legacyStemCounts.get(stem) ?? 0) + 1);
      }
      for (let index = 0; index < reports.length; index++) {
        const report = reports[index];
        if (!report || !this.isRecoveryCandidate(report)) continue;
        const recovered = this.readRecoveryArtifact(
          canonicalRunDir,
          report,
          legacyStemCounts.get(legacyStemKey(report.id)) === 1,
        );
        if (!recovered) continue;
        reports[index] = recovered.report;
        const artifactIndex = artifactEntries.findLastIndex(
          ([providerId]) => providerId === report.id,
        );
        if (artifactIndex >= 0) {
          artifactEntries[artifactIndex] = [report.id, recovered.artifact];
        }
      }
    }

    const providerArtifacts = Object.fromEntries(artifactEntries);

    const prompt = this.readTextArtifact(canonicalRunDir, fixedFile('prompt'));
    const summary = this.readTextArtifact(
      canonicalRunDir,
      fixedFile('summary'),
    );
    const answerContent = this.readTextArtifact(
      canonicalRunDir,
      fixedFile('answer'),
    );
    const answer =
      answerContent === undefined
        ? undefined
        : {
            content: answerContent,
            ...(manifest.answer?.provider
              ? { provider: manifest.answer.provider }
              : {}),
            ...(manifest.answer?.model ? { model: manifest.answer.model } : {}),
          };
    const persistedSources = this.readSourcesFile(canonicalRunDir, manifest);
    const sources = persistedSources;
    const artifactPresence: RunArtifactPresence = {
      manifest: true,
      prompt: this.hasArtifactResolved(canonicalRunDir, fixedFile('prompt')),
      summary: this.hasArtifactResolved(canonicalRunDir, fixedFile('summary')),
      sources: this.hasArtifactResolved(
        canonicalRunDir,
        this.sourceFile(manifest),
      ),
      answer: this.hasArtifactResolved(canonicalRunDir, fixedFile('answer')),
    };
    return freezeDeep({
      runDir: canonicalRunDir,
      manifest: clone(manifest),
      reports,
      providerArtifacts,
      sources,
      ...(answer !== undefined ? { answer } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(summary !== undefined ? { summary } : {}),
      artifactPresence,
    });
  }

  tryReadSnapshot(
    runDir: string,
    options: { readonly view?: RunArtifactView } | RunArtifactView = {},
  ): RunArtifactSnapshot | null {
    try {
      return this.readSnapshot(runDir, options);
    } catch {
      return null;
    }
  }

  readPrompt(runDir: string): string | null {
    return (
      this.readTextArtifact(
        this.assertRunDirectory(runDir),
        fixedFile('prompt'),
      ) ?? null
    );
  }

  writePrompt(runDir: string, content: string): void {
    this.writeTextArtifact(runDir, fixedFile('prompt'), content);
  }

  readSummary(runDir: string): string | null {
    return (
      this.readTextArtifact(
        this.assertRunDirectory(runDir),
        fixedFile('summary'),
      ) ?? null
    );
  }

  writeSummary(runDir: string, content: string): void {
    this.writeTextArtifact(runDir, fixedFile('summary'), content);
  }

  readAnswer(runDir: string): string | null {
    return (
      this.readTextArtifact(
        this.assertRunDirectory(runDir),
        fixedFile('answer'),
      ) ?? null
    );
  }

  writeAnswer(runDir: string, content: string): void {
    this.writeTextArtifact(runDir, fixedFile('answer'), content);
  }

  readProviderContent(
    runDir: string,
    provider: string | Pick<ProviderReport, 'id' | 'outputFile'>,
  ): string | null {
    const fileName =
      typeof provider === 'string'
        ? providerArtifactFileNames(provider).outputFile
        : provider.outputFile;
    if (!fileName) return null;
    return (
      this.readTextArtifact(this.assertRunDirectory(runDir), fileName) ?? null
    );
  }

  writeProviderContent(
    runDir: string,
    providerId: string,
    content: string,
  ): void {
    this.writeTextArtifact(
      runDir,
      providerArtifactFileNames(providerId).outputFile,
      content,
    );
  }

  readProviderMeta(
    runDir: string,
    provider: string | Pick<ProviderReport, 'id' | 'metaFile'>,
  ): RunArtifactMeta | null {
    const providerId = typeof provider === 'string' ? provider : provider.id;
    const fileName =
      typeof provider === 'string'
        ? providerArtifactFileNames(provider).metaFile
        : provider.metaFile;
    if (!fileName) return null;
    const raw = this.readJsonArtifact(
      this.assertRunDirectory(runDir),
      fileName,
    );
    return raw === undefined ? null : parseMeta(raw, providerId);
  }

  writeProviderMeta(
    runDir: string,
    providerId: string,
    meta: RunArtifactMetaInput,
  ): void {
    if (meta.provider !== undefined && meta.provider !== providerId) {
      throw new Error(`Provider metadata does not match ${providerId}`);
    }
    const candidate = { provider: providerId, ...meta };
    const validated = parseMeta(candidate, providerId);
    if (!validated)
      throw new Error(`Invalid metadata for provider ${providerId}`);
    this.writeJsonArtifact(
      runDir,
      providerArtifactFileNames(providerId).metaFile,
      validated,
    );
  }

  readSources(runDir: string): readonly DeduplicatedSource[] {
    const manifest = this.readManifest(runDir);
    return this.readSourcesFile(this.assertRunDirectory(runDir), manifest);
  }

  writeSources(runDir: string, sources: readonly DeduplicatedSource[]): void {
    const parsed = parseSources(sources);
    if (!parsed) throw new Error('Invalid canonical sources');
    this.writeJsonArtifact(runDir, fixedFile('sources'), parsed);
  }

  hasArtifact(runDir: string, fileName: string): boolean {
    return this.hasArtifactResolved(this.assertRunDirectory(runDir), fileName);
  }

  /**
   * Write one completed provider result and fold it into run.json under the
   * existing manifest lock.  The write-ahead order is deliberate: output and
   * metadata can survive a retry, but a task is never marked retrieved until
   * the source rebuild and manifest commit both succeed.
   */
  commitRetrieved(input: CommitRetrievedInput): RunArtifactSnapshot {
    const runDir = this.assertRunDirectory(input.runDir);
    const commitNow = input.now ?? this.now();
    if (!Number.isSafeInteger(commitNow) || commitNow < 0) {
      throw new Error(
        'Retrieved commit timestamp must be a finite nonnegative safe integer',
      );
    }
    if (input.report.id !== input.providerId) {
      throw new Error('Retrieved report provider does not match providerId');
    }
    if (input.report.status !== 'success') {
      throw new Error('Retrieved report must have success status');
    }
    // A successful retrieval is idempotent.  Avoid rewriting artifacts when a
    // caller retries after the task has already been folded into run.json.
    const beforeWrite = this.readManifest(runDir);
    const beforeTarget = beforeWrite.providers.find(
      (candidate) =>
        candidate.id === input.providerId &&
        candidate.task?.taskId === input.taskId,
    );
    if (!beforeTarget) {
      throw new Error(
        `Task ${input.providerId}/${input.taskId} is not recorded in run.json`,
      );
    }
    if (beforeTarget.task?.retrievedAt !== undefined) {
      return this.readSnapshot(runDir, { view: 'authoritative' });
    }
    if (beforeTarget.task?.status !== 'completed') {
      throw new Error(
        `Task ${input.providerId}/${input.taskId} is not completed`,
      );
    }
    const generatedNames = providerArtifactFileNames(input.providerId);
    const { outputFile, metaFile } = generatedNames;
    this.validateGeneratedName(input.providerId, outputFile, metaFile);
    if (
      input.report.outputFile !== outputFile ||
      input.report.metaFile !== metaFile
    ) {
      throw new Error(
        `Retrieved report must use generated artifact names ${outputFile} and ${metaFile}`,
      );
    }
    this.assertNoArtifactCollision(
      beforeWrite,
      input.providerId,
      input.taskId,
      outputFile,
      metaFile,
    );
    // Validate every write target and the metadata before any write-ahead file
    // is created. This makes malformed input fail without leaving artifacts.
    this.resolveContainedPath(runDir, outputFile);
    this.resolveContainedPath(runDir, metaFile);
    if (beforeWrite.sources.file !== fixedFile('sources')) {
      throw new Error(
        'Retrieved commits require sources.json as the source file',
      );
    }
    this.resolveContainedPath(runDir, fixedFile('sources'));
    const validatedMeta = parseMeta(
      { provider: input.providerId, ...input.meta },
      input.providerId,
    );
    if (!validatedMeta) {
      throw new Error(`Invalid metadata for provider ${input.providerId}`);
    }
    const validatedReport = this.validateCommittedReport(input, validatedMeta);
    try {
      this.mutateManifestImpl(runDir, (manifest) => {
        const index = manifest.providers.findIndex(
          (candidate) =>
            candidate.id === input.providerId &&
            candidate.task?.taskId === input.taskId,
        );
        if (index < 0) {
          throw new Error(
            `Task ${input.providerId}/${input.taskId} is not recorded in run.json`,
          );
        }
        const current = manifest.providers[index];
        const task = current?.task;
        if (!task) {
          throw new Error(
            `Task ${input.providerId}/${input.taskId} has no durable task state`,
          );
        }
        if (task.retrievedAt !== undefined) throw RETRIEVED_SENTINEL;
        if (task.status !== 'completed') {
          throw new Error(
            `Task ${input.providerId}/${input.taskId} is not completed`,
          );
        }
        const report = this.buildCommittedReport(
          input,
          validatedReport,
          task,
          generatedNames,
          commitNow,
        );
        this.assertNoArtifactCollision(
          manifest,
          input.providerId,
          input.taskId,
          outputFile,
          metaFile,
        );
        if (manifest.sources.file !== fixedFile('sources')) {
          throw new Error(
            'Retrieved commits require sources.json as the source file',
          );
        }
        this.resolveContainedPath(runDir, fixedFile('sources'));

        // Keep output and metadata writes inside the same manifest lock as the
        // source rebuild. A loser racing an already retrieved task throws the
        // sentinel before writing and therefore does not bump the revision.
        this.writeProviderContent(runDir, input.providerId, input.content);
        this.writeProviderMeta(runDir, input.providerId, validatedMeta);
        manifest.providers[index] = report;

        const allCitations = this.collectDeclaredCitations(
          runDir,
          manifest.providers,
        );
        const sources = deduplicateSources(allCitations);
        const sourceFile = fixedFile('sources');
        // A process crash between this atomic sources write and run.json's
        // atomic rename can leave sources.json ahead of the manifest. The task
        // remains completed/unretrieved in that window; a retry rebuilds the
        // source file from the declared metadata and commits both state lanes.
        this.writeJsonArtifact(runDir, sourceFile, sources);
        manifest.sources = {
          total: allCitations.length,
          unique: sources.length,
          file: sourceFile,
        };
        applyRunLifecycle(manifest, commitNow);
      });
    } catch (error) {
      if (error === RETRIEVED_SENTINEL) {
        return this.readSnapshot(runDir, { view: 'authoritative' });
      }
      throw error;
    }
    return this.readSnapshot(runDir, { view: 'authoritative' });
  }

  private validateCommittedReport(
    input: CommitRetrievedInput,
    metadata: RunArtifactMeta,
  ): ValidatedReportFields {
    const report = input.report as unknown as Record<string, unknown>;
    assertKnownKeys(
      report,
      new Set([
        'id',
        'tier',
        'status',
        'durationMs',
        'wordCount',
        'citationCount',
        'outputFile',
        'metaFile',
        'usage',
        'metering',
        'error',
        'fallbackFor',
        'preventFallback',
        'task',
      ]),
      'report',
    );
    if (report.id !== input.providerId) {
      throw new Error('Retrieved report provider does not match providerId');
    }
    if (report.status !== 'success') {
      throw new Error('Retrieved report must have success status');
    }
    if (typeof report.tier !== 'string' || !REPORT_TIERS.has(report.tier)) {
      throw new Error('Retrieved report has an unknown tier');
    }
    if (!isFiniteNonnegative(report.durationMs)) {
      throw new Error(
        'Retrieved report duration must be finite and nonnegative',
      );
    }
    if (
      !Number.isSafeInteger(report.wordCount) ||
      !isFiniteNonnegative(report.wordCount) ||
      report.wordCount !== wordCount(input.content)
    ) {
      throw new Error('Retrieved report word count does not match content');
    }
    const citationCount = metadata.citations.length;
    if (
      !Number.isSafeInteger(report.citationCount) ||
      !isFiniteNonnegative(report.citationCount) ||
      report.citationCount !== citationCount ||
      (metadata.citationCount !== undefined &&
        metadata.citationCount !== citationCount)
    ) {
      throw new Error(
        'Retrieved report citation count does not match metadata',
      );
    }
    if (metadata.tier !== undefined && metadata.tier !== report.tier) {
      throw new Error('Retrieved report tier does not match metadata');
    }
    if (
      metadata.durationMs !== undefined &&
      metadata.durationMs !== report.durationMs
    ) {
      throw new Error('Retrieved report duration does not match metadata');
    }
    if (report.error !== undefined && !isSafeString(report.error)) {
      throw new Error('Retrieved report error is unsafe');
    }
    if (report.fallbackFor !== undefined && !isSafeString(report.fallbackFor)) {
      throw new Error('Retrieved report fallbackFor is unsafe');
    }
    if (
      report.preventFallback !== undefined &&
      report.preventFallback !== true
    ) {
      throw new Error('Retrieved report preventFallback must be true');
    }
    this.validateInputTask(report.task);

    const usage =
      report.usage === undefined ? undefined : parseUsage(report.usage);
    if (report.usage !== undefined) {
      if (!usage) throw new Error('Retrieved report usage is invalid');
      if (isRecord(report.usage)) {
        assertKnownKeys(
          report.usage,
          new Set([
            'inputTokens',
            'outputTokens',
            'totalTokens',
            'costUsd',
            'billableUnits',
            'unit',
          ]),
          'report usage',
        );
      }
    }
    if (
      usage !== undefined &&
      metadata.usage !== undefined &&
      !sameValue(usage, metadata.usage)
    ) {
      throw new Error('Retrieved report usage does not match metadata');
    }

    const metering =
      report.metering === undefined
        ? undefined
        : parseMetering(report.metering);
    if (report.metering !== undefined && !metering) {
      throw new Error('Retrieved report metering is invalid');
    }
    if (
      metering !== undefined &&
      metadata.metering !== undefined &&
      !sameValue(metering, metadata.metering)
    ) {
      throw new Error('Retrieved report metering does not match metadata');
    }
    return {
      tier: report.tier as ProviderReport['tier'],
      durationMs: report.durationMs,
      wordCount: report.wordCount,
      citationCount,
      ...((metadata.usage ?? usage) ? { usage: metadata.usage ?? usage } : {}),
      ...((metadata.metering ?? metering)
        ? { metering: metadata.metering ?? metering }
        : {}),
      ...(report.error !== undefined ? { error: report.error } : {}),
      ...(report.fallbackFor !== undefined
        ? { fallbackFor: report.fallbackFor }
        : {}),
      ...(report.preventFallback === true ? { preventFallback: true } : {}),
    };
  }

  private validateInputTask(value: unknown): void {
    if (value === undefined) return;
    if (!isRecord(value)) throw new Error('Retrieved report task is invalid');
    assertKnownKeys(
      value,
      new Set([
        'taskId',
        'submittedAt',
        'status',
        'lastPolledAt',
        'completedAt',
        'retrievedAt',
        'providerStatus',
        'lastPollError',
      ]),
      'report task',
    );
    if (!isSafeString(value.taskId) || value.taskId.length === 0) {
      throw new Error('Retrieved report task ID is invalid');
    }
    if (!isFiniteNonnegative(value.submittedAt)) {
      throw new Error('Retrieved report task submittedAt is invalid');
    }
    if (typeof value.status !== 'string' || !TASK_STATUSES.has(value.status)) {
      throw new Error('Retrieved report task status is invalid');
    }
    for (const key of ['lastPolledAt', 'completedAt', 'retrievedAt'] as const) {
      if (value[key] !== undefined && !isFiniteNonnegative(value[key])) {
        throw new Error(`Retrieved report task ${key} is invalid`);
      }
    }
    for (const key of ['providerStatus', 'lastPollError'] as const) {
      if (value[key] !== undefined && !isSafeString(value[key])) {
        throw new Error(`Retrieved report task ${key} is unsafe`);
      }
    }
  }

  private buildCommittedReport(
    input: CommitRetrievedInput,
    fields: ValidatedReportFields,
    task: NonNullable<ProviderReport['task']>,
    names: ProviderArtifactFileNames,
    commitNow: number,
  ): ProviderReport {
    return {
      id: input.providerId,
      tier: fields.tier,
      status: 'success',
      durationMs: fields.durationMs,
      wordCount: fields.wordCount,
      citationCount: fields.citationCount,
      outputFile: names.outputFile,
      metaFile: names.metaFile,
      ...(fields.usage !== undefined ? { usage: fields.usage } : {}),
      ...(fields.metering !== undefined ? { metering: fields.metering } : {}),
      ...(fields.error !== undefined ? { error: fields.error } : {}),
      ...(fields.fallbackFor !== undefined
        ? { fallbackFor: fields.fallbackFor }
        : {}),
      ...(fields.preventFallback === true ? { preventFallback: true } : {}),
      task: {
        ...task,
        status: 'completed',
        completedAt: task.completedAt ?? commitNow,
        retrievedAt: commitNow,
        lastPollError: undefined,
      },
    };
  }

  private validateGeneratedName(
    providerId: string,
    outputFile: string,
    metaFile: string,
  ): void {
    if (
      !providerId ||
      [...providerId].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 0x20 || code === 0x7f;
      }) ||
      RESERVED_ARTIFACT_NAMES.has(outputFile) ||
      RESERVED_ARTIFACT_NAMES.has(metaFile) ||
      outputFile.endsWith('.lock') ||
      metaFile.endsWith('.lock')
    ) {
      throw new Error(`Provider ${providerId} has a reserved artifact name`);
    }
  }

  private assertNoArtifactCollision(
    manifest: RunManifest,
    providerId: string,
    taskId: string,
    outputFile: string,
    metaFile: string,
  ): void {
    for (const candidate of manifest.providers) {
      if (candidate.id === providerId && candidate.task?.taskId === taskId) {
        continue;
      }
      if (
        candidate.outputFile === outputFile ||
        candidate.outputFile === metaFile ||
        candidate.metaFile === outputFile ||
        candidate.metaFile === metaFile
      ) {
        throw new Error(
          `Retrieved artifact names collide with provider ${candidate.id}`,
        );
      }
    }
  }

  private assertRunDirectory(runDir: string): string {
    if (runDir.split(/[\\/]+/).some((part) => part === '..')) {
      throw new RunManifestError('Run directory path is not contained', runDir);
    }
    const resolved = this.resolveRunDirectory(
      dirname(resolve(runDir)),
      resolve(runDir),
    );
    if (!resolved) {
      throw new RunManifestError(
        'Run directory is not safe or does not exist',
        runDir,
      );
    }
    return resolved;
  }

  private readTextArtifact(
    runDir: string,
    fileName: string,
  ): string | undefined {
    const path = this.resolveContainedPath(runDir, fileName);
    try {
      if (!this.fs.existsSync(path) || !this.fs.statSync(path).isFile())
        return undefined;
      return this.fs.readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  }

  private readJsonArtifact(
    runDir: string,
    fileName: string,
  ): unknown | undefined {
    const path = this.resolveContainedPath(runDir, fileName);
    try {
      if (!this.fs.existsSync(path) || !this.fs.statSync(path).isFile())
        return undefined;
      return JSON.parse(this.fs.readFileSync(path, 'utf8')) as unknown;
    } catch {
      return undefined;
    }
  }

  private writeTextArtifact(
    runDir: string,
    fileName: string,
    content: string,
  ): void {
    const path = this.resolveContainedPath(
      this.assertRunDirectory(runDir),
      fileName,
    );
    this.writeFile(path, content);
  }

  private writeJsonArtifact(
    runDir: string,
    fileName: string,
    value: unknown,
  ): void {
    const path = this.resolveContainedPath(
      this.assertRunDirectory(runDir),
      fileName,
    );
    this.writeFile(path, JSON.stringify(value, null, 2));
  }

  private hasArtifactResolved(runDir: string, fileName: string): boolean {
    try {
      const path = this.resolveContainedPath(runDir, fileName);
      return this.fs.existsSync(path) && this.fs.statSync(path).isFile();
    } catch {
      return false;
    }
  }

  private sourceFile(manifest: RunManifest): string {
    // A source declaration is data, not an output directory.  Validate it at
    // the point of use; the normal writer always persists sources.json.
    return manifest.sources.file || fixedFile('sources');
  }

  private readSourcesFile(
    runDir: string,
    manifest: RunManifest,
  ): DeduplicatedSource[] {
    const raw = this.readJsonArtifact(runDir, this.sourceFile(manifest));
    const parsed = parseSources(raw);
    return parsed ?? [];
  }

  private collectDeclaredCitations(
    runDir: string,
    reports: readonly ProviderReport[],
  ): Citation[] {
    const citations: Citation[] = [];
    for (const report of reports) {
      if (!report.metaFile) continue;
      const path = this.resolveContainedPath(runDir, report.metaFile);
      if (!this.fs.existsSync(path) || !this.fs.statSync(path).isFile()) {
        throw new Error(
          `Declared provider metadata is missing for ${report.id}: ${report.metaFile}`,
        );
      }
      let raw: unknown;
      try {
        raw = JSON.parse(this.fs.readFileSync(path, 'utf8')) as unknown;
      } catch (error) {
        throw new Error(
          `Declared provider metadata is unreadable for ${report.id}: ${report.metaFile}`,
          { cause: error },
        );
      }
      const meta = parseMeta(raw, report.id);
      if (!meta) {
        throw new Error(
          `Declared provider metadata is malformed or mismatched for ${report.id}: ${report.metaFile}`,
        );
      }
      citations.push(...meta.citations);
    }
    return citations;
  }

  private readDeclaredProviderArtifact(
    runDir: string,
    report: ProviderReport,
  ): RunArtifactProviderArtifact {
    const content = report.outputFile
      ? this.readTextArtifact(runDir, report.outputFile)
      : undefined;
    const meta = report.metaFile
      ? parseMeta(this.readJsonArtifact(runDir, report.metaFile), report.id)
      : null;
    return {
      ...(content !== undefined ? { content } : {}),
      ...(meta !== null ? { meta } : {}),
      recovered: false,
    };
  }

  private isRecoveryCandidate(report: ProviderReport): boolean {
    return (
      report.status === 'async-pending' &&
      report.outputFile === '' &&
      report.task !== undefined &&
      report.task.retrievedAt === undefined
    );
  }

  private readRecoveryArtifact(
    runDir: string,
    report: ProviderReport,
    legacyStemIsUnique: boolean,
  ): {
    readonly report: ProviderReport;
    readonly artifact: RunArtifactProviderArtifact;
  } | null {
    if (!legacyStemIsUnique) return null;
    const safeId = sanitizeId(report.id);
    const outputFile = `${safeId}.md`;
    const content = this.readTextArtifact(runDir, outputFile);
    if (content === undefined) return null;
    const metaFile = `${safeId}.meta.json`;
    const meta = parseMeta(this.readJsonArtifact(runDir, metaFile), report.id);
    const recoveredReport: ProviderReport = {
      ...report,
      status: 'success',
      outputFile,
      metaFile: meta ? metaFile : '',
      wordCount: wordCount(content),
      ...(meta?.durationMs !== undefined
        ? { durationMs: meta.durationMs }
        : {}),
      ...(meta?.citationCount !== undefined
        ? { citationCount: meta.citationCount }
        : meta
          ? { citationCount: meta.citations.length }
          : {}),
      ...(meta?.usage !== undefined ? { usage: meta.usage } : {}),
      ...(meta?.metering !== undefined ? { metering: meta.metering } : {}),
    };
    return {
      report: recoveredReport,
      artifact: {
        content,
        ...(meta ? { meta } : {}),
        recovered: true,
      },
    };
  }
}
