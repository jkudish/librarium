/**
 * Internal Node-only reconciliation for persisted background runs.
 *
 * This module deliberately knows only the provider lifecycle contract from
 * src/types.ts.  Filesystem writes and manifest locking stay behind
 * RunArtifactRepository so polling and retrieval cannot accidentally create a
 * second persistence boundary.
 */

import { buildProviderMetering } from './core/metering.js';
import { RunManifestError } from './core/run-manifest.js';
import { freezeDeep, wordCount } from './node-run-artifact-codecs.js';
import {
  providerArtifactFileNames,
  type RunArtifactMetaInput,
  type RunArtifactRepository,
  type RunArtifactSnapshot,
  type RunArtifactTaskUpdate,
} from './node-run-artifacts.js';
import {
  isRecord,
  normalizeSuccess,
  type ReconciliationTaskResult,
  TASK_STATUSES,
  taskResultFromReport,
  validTimestamp,
} from './node-run-reconciliation-codecs.js';
import type {
  AsyncPollResult,
  AsyncTaskHandle,
  AsyncTaskStatus,
  ProviderConfig,
  ProviderResult,
} from './types.js';

/** Exact provider lifecycle surface needed by reconciliation. */
export interface ReconciliationBackgroundProvider {
  readonly execution: 'background';
  readonly poll: (handle: AsyncTaskHandle) => Promise<AsyncPollResult>;
  readonly retrieve: (handle: AsyncTaskHandle) => Promise<ProviderResult>;
}

export type BackgroundProviderResolver = (
  providerId: string,
) => ReconciliationBackgroundProvider | undefined;

export type ProviderConfigLookup = (
  providerId: string,
) => ProviderConfig | undefined;

export interface DerivedArtifactRegeneratorInput {
  readonly runDir: string;
  readonly snapshot: RunArtifactSnapshot;
  readonly refreshSummary: boolean;
  readonly refreshHtml: boolean;
  readonly refreshJsonl: boolean;
}

export type DerivedArtifactRegenerator = (
  input: DerivedArtifactRegeneratorInput,
) => void | Promise<void>;

export interface RunReconciliationServiceDependencies {
  readonly repository: RunArtifactRepository;
  readonly resolveBackgroundProvider: BackgroundProviderResolver;
  readonly getProviderConfig: ProviderConfigLookup;
  readonly now?: () => number;
  readonly regenerateDerivedArtifacts?: DerivedArtifactRegenerator;
}

export interface ReconcileOnceOptions {
  readonly retrieve?: boolean;
}

export type {
  ReconciliationTaskOutcome,
  ReconciliationTaskResult,
} from './node-run-reconciliation-codecs.js';

export interface ReconciliationResult {
  readonly runDir: string;
  readonly tasks: readonly ReconciliationTaskResult[];
  readonly polled: number;
  readonly retrieved: number;
  readonly regenerated: boolean;
  readonly regenerationError?: string;
}

const DIAGNOSTIC = {
  pollFailed: 'provider.poll_failed',
  pollInvalid: 'provider.poll_invalid',
  retrieveFailed: 'provider.retrieve_failed',
  resultError: 'provider.result_error',
  resultInvalid: 'provider.result_invalid',
  configInvalid: 'provider.config_invalid',
  unavailable: 'provider.unavailable',
  persistFailed: 'artifact.persist_failed',
  regenerationFailed: 'artifact.regeneration_failed',
} as const;

function taskKey(provider: string, taskId: string): string {
  return `${provider}\u0000${taskId}`;
}

function asReadonlyResult(result: ReconciliationResult): ReconciliationResult {
  return freezeDeep(result);
}

function isBackgroundProvider(
  provider: ReconciliationBackgroundProvider | undefined,
): provider is ReconciliationBackgroundProvider {
  try {
    return provider?.execution === 'background';
  } catch {
    return false;
  }
}

export class RunReconciliationService {
  private readonly repository: RunArtifactRepository;
  private readonly resolveBackgroundProvider: BackgroundProviderResolver;
  private readonly getProviderConfig: ProviderConfigLookup;
  private readonly clock: () => number;
  private readonly regenerateDerivedArtifacts?: DerivedArtifactRegenerator;

  constructor(dependencies: RunReconciliationServiceDependencies) {
    this.repository = dependencies.repository;
    this.resolveBackgroundProvider = dependencies.resolveBackgroundProvider;
    this.getProviderConfig = dependencies.getProviderConfig;
    this.clock = dependencies.now ?? Date.now;
    this.regenerateDerivedArtifacts = dependencies.regenerateDerivedArtifacts;
  }

  async reconcileOnce(
    runDir: string,
    options: ReconcileOnceOptions = {},
  ): Promise<ReconciliationResult> {
    // The strict read is intentionally the first operation.  In particular,
    // do not call the provider resolver, config lookup, clock, or an artifact
    // writer before the manifest and declared paths have been validated.
    const initial = this.repository.readSnapshot(runDir, {
      view: 'authoritative',
    });
    const refreshSummary = this.repository.hasArtifact(runDir, 'summary.md');
    const refreshHtml = this.repository.hasArtifact(runDir, 'report.html');
    const refreshJsonl = this.repository.hasArtifact(runDir, 'results.jsonl');
    const retrieve = options.retrieve === true;
    const outcomes = new Map<string, ReconciliationTaskResult>();
    let polled = 0;

    for (const report of initial.manifest.providers) {
      const task = report.task;
      if (!task || task.retrievedAt !== undefined) continue;
      if (task.status !== 'pending' && task.status !== 'running') continue;
      const key = taskKey(report.id, task.taskId);
      let provider: ReconciliationBackgroundProvider | undefined;
      let resolverFailed = false;
      try {
        provider = this.resolveBackgroundProvider(report.id);
      } catch {
        resolverFailed = true;
      }
      if (resolverFailed) {
        const updated = this.persistPollDiagnostic(
          runDir,
          report.id,
          task.taskId,
          DIAGNOSTIC.pollFailed,
        );
        polled++;
        const taskResult = taskResultFromReport(
          report.id,
          updated?.manifest.providers.find(
            (candidate) =>
              candidate.id === report.id &&
              candidate.task?.taskId === task.taskId,
          ) ?? report,
          true,
          false,
          undefined,
          DIAGNOSTIC.pollFailed,
        );
        if (taskResult) outcomes.set(key, taskResult);
        continue;
      }
      if (!isBackgroundProvider(provider)) {
        const unsupported = this.persistUnsupported(
          runDir,
          report.id,
          task.taskId,
        );
        polled++;
        const unsupportedResult = taskResultFromReport(
          report.id,
          unsupported?.manifest.providers.find(
            (candidate) =>
              candidate.id === report.id &&
              candidate.task?.taskId === task.taskId,
          ) ?? report,
          true,
          false,
          'unsupported',
          DIAGNOSTIC.unavailable,
        );
        if (unsupportedResult) outcomes.set(key, unsupportedResult);
        continue;
      }
      const handle = this.toHandle(initial, report.id, task.taskId);
      let normalizedPoll: AsyncPollResult | null;
      try {
        const poll = await provider.poll(handle);
        normalizedPoll = this.normalizePoll(poll);
      } catch {
        const updated = this.persistPollDiagnostic(
          runDir,
          report.id,
          task.taskId,
          DIAGNOSTIC.pollFailed,
        );
        polled++;
        const taskResult = taskResultFromReport(
          report.id,
          updated?.manifest.providers.find(
            (candidate) =>
              candidate.id === report.id &&
              candidate.task?.taskId === task.taskId,
          ) ?? report,
          true,
          false,
          undefined,
          DIAGNOSTIC.pollFailed,
        );
        if (taskResult) outcomes.set(key, taskResult);
        continue;
      }
      if (!normalizedPoll) {
        const updated = this.persistPollDiagnostic(
          runDir,
          report.id,
          task.taskId,
          DIAGNOSTIC.pollInvalid,
        );
        polled++;
        const taskResult = taskResultFromReport(
          report.id,
          updated?.manifest.providers.find(
            (candidate) =>
              candidate.id === report.id &&
              candidate.task?.taskId === task.taskId,
          ) ?? report,
          true,
          false,
          undefined,
          DIAGNOSTIC.pollInvalid,
        );
        if (taskResult) outcomes.set(key, taskResult);
        continue;
      }
      const at = this.readClockOrNull();
      if (at === null) {
        const taskResult = taskResultFromReport(
          report.id,
          report,
          true,
          false,
          undefined,
          DIAGNOSTIC.pollFailed,
        );
        if (taskResult) outcomes.set(key, taskResult);
        polled++;
        continue;
      }
      const updates: RunArtifactTaskUpdate = {
        status: normalizedPoll.status,
        lastPolledAt: at,
        ...(normalizedPoll.rawStatus === undefined
          ? {}
          : { providerStatus: normalizedPoll.rawStatus }),
        lastPollError:
          normalizedPoll.status === 'failed' ||
          normalizedPoll.status === 'cancelled'
            ? DIAGNOSTIC.pollFailed
            : undefined,
        ...(normalizedPoll.status === 'completed' ||
        normalizedPoll.status === 'failed' ||
        normalizedPoll.status === 'cancelled'
          ? { completedAt: at }
          : {}),
      };
      const updated = this.repository.updateTask(
        runDir,
        report.id,
        task.taskId,
        updates,
        at,
      );
      polled++;
      const taskResult = taskResultFromReport(
        report.id,
        updated.manifest.providers.find(
          (candidate) =>
            candidate.id === report.id &&
            candidate.task?.taskId === task.taskId,
        ) ?? report,
        true,
        false,
      );
      if (taskResult) outcomes.set(key, taskResult);
    }

    // Re-read after every poll mutation.  This is what lets a task that became
    // completed in this pass join pre-existing completed/unretrieved work.
    const afterPoll = this.repository.readSnapshot(runDir, {
      view: 'authoritative',
    });
    let retrieved = 0;
    if (retrieve) {
      for (const report of afterPoll.manifest.providers) {
        const task = report.task;
        if (
          !task ||
          task.retrievedAt !== undefined ||
          task.status !== 'completed'
        ) {
          continue;
        }
        const key = taskKey(report.id, task.taskId);
        let provider: ReconciliationBackgroundProvider | undefined;
        let resolverFailed = false;
        try {
          provider = this.resolveBackgroundProvider(report.id);
        } catch {
          resolverFailed = true;
        }
        if (resolverFailed) {
          const failed = taskResultFromReport(
            report.id,
            report,
            false,
            false,
            'error',
            DIAGNOSTIC.retrieveFailed,
          );
          if (failed) outcomes.set(key, failed);
          continue;
        }
        if (!isBackgroundProvider(provider)) {
          const unsupported = this.persistUnsupported(
            runDir,
            report.id,
            task.taskId,
          );
          const unsupportedResult = taskResultFromReport(
            report.id,
            unsupported?.manifest.providers.find(
              (candidate) =>
                candidate.id === report.id &&
                candidate.task?.taskId === task.taskId,
            ) ?? report,
            false,
            false,
            'unsupported',
            DIAGNOSTIC.unavailable,
          );
          if (unsupportedResult) outcomes.set(key, unsupportedResult);
          continue;
        }
        const handle = this.toHandle(afterPoll, report.id, task.taskId);
        let providerResult: ProviderResult;
        try {
          providerResult = await provider.retrieve(handle);
        } catch {
          const failed = taskResultFromReport(
            report.id,
            report,
            false,
            false,
            'error',
            DIAGNOSTIC.retrieveFailed,
          );
          if (failed) outcomes.set(key, failed);
          continue;
        }
        if (isRecord(providerResult) && providerResult.error !== undefined) {
          const failed = taskResultFromReport(
            report.id,
            report,
            false,
            false,
            'error',
            DIAGNOSTIC.resultError,
          );
          if (failed) outcomes.set(key, failed);
          continue;
        }
        const normalized = normalizeSuccess(providerResult, report.id);
        if ('error' in normalized) {
          const failed = taskResultFromReport(
            report.id,
            report,
            false,
            false,
            'error',
            normalized.error,
          );
          if (failed) outcomes.set(key, failed);
          continue;
        }
        const usage = normalized.usage;
        let metering: ReturnType<typeof buildProviderMetering>;
        try {
          const config = this.getProviderConfig(report.id);
          if (
            config !== undefined &&
            (!isRecord(config) ||
              (config.options !== undefined && !isRecord(config.options)))
          ) {
            throw new Error('invalid provider config');
          }
          metering = buildProviderMetering(report.id, config, usage);
        } catch {
          const failed = taskResultFromReport(
            report.id,
            report,
            false,
            false,
            'error',
            DIAGNOSTIC.configInvalid,
          );
          if (failed) outcomes.set(key, failed);
          continue;
        }
        const names = providerArtifactFileNames(report.id);
        const meta: RunArtifactMetaInput = {
          tier: normalized.tier,
          ...(normalized.model === undefined
            ? {}
            : { model: normalized.model }),
          durationMs: normalized.durationMs,
          citationCount: normalized.citations.length,
          ...(normalized.tokenUsage === undefined
            ? {}
            : { tokenUsage: normalized.tokenUsage }),
          ...(usage === undefined ? {} : { usage }),
          metering,
          citations: normalized.citations,
        };
        const commitNow = this.readClockOrNull();
        if (commitNow === null) {
          const failed = taskResultFromReport(
            report.id,
            report,
            false,
            false,
            'error',
            DIAGNOSTIC.persistFailed,
          );
          if (failed) outcomes.set(key, failed);
          continue;
        }
        const committedReport = {
          id: report.id,
          tier: normalized.tier,
          status: 'success' as const,
          durationMs: normalized.durationMs,
          wordCount: wordCount(normalized.content),
          citationCount: normalized.citations.length,
          outputFile: names.outputFile,
          metaFile: names.metaFile,
          ...(usage === undefined ? {} : { usage }),
          metering,
          ...(normalized.preventFallback === true
            ? { preventFallback: true as const }
            : {}),
        };
        try {
          const committed = this.repository.commitRetrieved({
            runDir,
            providerId: report.id,
            taskId: task.taskId,
            report: committedReport,
            content: normalized.content,
            meta,
            now: commitNow,
          });
          retrieved++;
          const committedProvider = committed.manifest.providers.find(
            (candidate) =>
              candidate.id === report.id &&
              candidate.task?.taskId === task.taskId,
          );
          const successResult = committedProvider
            ? taskResultFromReport(
                report.id,
                committedProvider,
                false,
                true,
                'retrieved',
              )
            : null;
          if (successResult) outcomes.set(key, successResult);
        } catch (error) {
          if (error instanceof RunManifestError) throw error;
          const failed = taskResultFromReport(
            report.id,
            report,
            false,
            false,
            'error',
            DIAGNOSTIC.persistFailed,
          );
          if (failed) outcomes.set(key, failed);
        }
      }
    }

    let regenerated = false;
    let regenerationError: string | undefined;
    if (retrieved > 0 && this.regenerateDerivedArtifacts) {
      const snapshot = this.repository.readSnapshot(runDir, {
        view: 'authoritative',
      });
      try {
        await this.regenerateDerivedArtifacts({
          runDir: snapshot.runDir,
          snapshot,
          refreshSummary,
          refreshHtml,
          refreshJsonl,
        });
        regenerated = true;
      } catch {
        regenerationError = DIAGNOSTIC.regenerationFailed;
      }
    }

    const orderedTasks: ReconciliationTaskResult[] = [];
    const final = this.repository.readSnapshot(runDir, {
      view: 'authoritative',
    });
    for (const report of final.manifest.providers) {
      const task = report.task;
      if (!task) continue;
      const key = taskKey(report.id, task.taskId);
      const existing = outcomes.get(key);
      if (existing) {
        orderedTasks.push(existing);
        continue;
      }
      const result = taskResultFromReport(report.id, report, false, false);
      if (result) orderedTasks.push(result);
    }
    return asReadonlyResult({
      runDir: final.runDir,
      tasks: orderedTasks,
      polled,
      retrieved,
      regenerated,
      ...(regenerationError === undefined ? {} : { regenerationError }),
    });
  }

  private readClock(): number {
    const value = this.clock();
    if (!validTimestamp(value)) {
      throw new Error(
        'Reconciliation clock must return a finite nonnegative safe integer',
      );
    }
    return value;
  }

  private readClockOrNull(): number | null {
    try {
      return this.readClock();
    } catch {
      return null;
    }
  }

  private normalizePoll(poll: unknown): AsyncPollResult | null {
    if (!isRecord(poll) || !TASK_STATUSES.has(poll.status as AsyncTaskStatus)) {
      return null;
    }
    const rawStatus =
      typeof poll.rawStatus === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(poll.rawStatus)
        ? poll.rawStatus
        : undefined;
    return {
      status: poll.status as AsyncTaskStatus,
      ...(rawStatus === undefined ? {} : { rawStatus: rawStatus }),
    };
  }

  private toHandle(
    snapshot: RunArtifactSnapshot,
    providerId: string,
    taskId: string,
  ): AsyncTaskHandle {
    const report = snapshot.manifest.providers.find(
      (candidate) =>
        candidate.id === providerId && candidate.task?.taskId === taskId,
    );
    const task = report?.task;
    if (!report || !task) {
      throw new Error(
        `Task ${providerId}/${taskId} is not recorded in run.json`,
      );
    }
    return {
      provider: providerId,
      taskId,
      query: snapshot.manifest.query,
      submittedAt: task.submittedAt,
      status: task.status,
      outputDir: snapshot.runDir,
      ...(task.lastPolledAt === undefined
        ? {}
        : { lastPolledAt: task.lastPolledAt }),
      ...(task.completedAt === undefined
        ? {}
        : { completedAt: task.completedAt }),
      ...(task.providerStatus === undefined
        ? {}
        : { providerStatus: task.providerStatus }),
      ...(task.lastPollError === undefined
        ? {}
        : { lastPollError: task.lastPollError }),
    };
  }

  private persistPollDiagnostic(
    runDir: string,
    providerId: string,
    taskId: string,
    diagnostic: string,
  ): RunArtifactSnapshot | null {
    const at = this.readClockOrNull();
    if (at === null) return null;
    return this.repository.updateTask(
      runDir,
      providerId,
      taskId,
      { lastPolledAt: at, lastPollError: diagnostic },
      at,
    );
  }

  private persistUnsupported(
    runDir: string,
    providerId: string,
    taskId: string,
  ): RunArtifactSnapshot | null {
    const at = this.readClockOrNull();
    if (at === null) return null;
    return this.repository.failUnretrievedTask(runDir, providerId, taskId, at);
  }
}
