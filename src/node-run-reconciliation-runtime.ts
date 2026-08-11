/** Node runtime wiring for the internal reconciliation service. */
import { getExactProvider } from './adapters/node-registry.js';
import { writeHtmlReportFromSnapshot } from './commands/html-report.js';
import { writeJsonlReportFromSnapshot } from './commands/jsonl-report.js';
import { generateSummary } from './core/synthesis.js';
import {
  RunArtifactRepository,
  type RunArtifactSnapshot,
} from './node-run-artifacts.js';
import { RunReconciliationService } from './node-run-reconciliation.js';
import type { AsyncTaskHandle, Config, ProviderReport } from './types.js';

export interface NodeRunReconciliationRuntime {
  readonly repository: RunArtifactRepository;
  readonly service: RunReconciliationService;
}

function snapshotReports(snapshot: RunArtifactSnapshot): ProviderReport[] {
  return snapshot.reports.map((report) => structuredClone(report));
}

function snapshotTasks(snapshot: RunArtifactSnapshot): AsyncTaskHandle[] {
  return snapshot.manifest.providers.flatMap((report) => {
    const task = report.task;
    if (!task || task.retrievedAt !== undefined) return [];
    return [
      {
        provider: report.id,
        taskId: task.taskId,
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
      },
    ];
  });
}

function createRegenerator(
  repository: RunArtifactRepository,
): NonNullable<
  ConstructorParameters<typeof RunReconciliationService>[0]
>['regenerateDerivedArtifacts'] {
  return ({ runDir, snapshot, refreshSummary, refreshHtml, refreshJsonl }) => {
    let failed = false;
    if (refreshSummary) {
      try {
        repository.writeSummary(
          runDir,
          generateSummary({
            query: snapshot.manifest.query,
            reports: snapshotReports(snapshot),
            sources: snapshot.sources.map((source) => structuredClone(source)),
            asyncTasks: snapshotTasks(snapshot),
            timestamp: snapshot.manifest.timestamp,
          }),
        );
      } catch {
        failed = true;
      }
    }
    let presentationSnapshot: RunArtifactSnapshot | undefined;
    if (refreshHtml || refreshJsonl) {
      try {
        presentationSnapshot = repository.readSnapshot(runDir, {
          view: 'recovery',
        });
      } catch {
        failed = true;
      }
    }
    if (refreshHtml && presentationSnapshot) {
      try {
        writeHtmlReportFromSnapshot(presentationSnapshot, repository);
      } catch {
        failed = true;
      }
    }
    if (refreshJsonl && presentationSnapshot) {
      try {
        writeJsonlReportFromSnapshot(presentationSnapshot, repository);
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error('derived artifact regeneration failed');
  };
}

/** Construct the one production Node reconciliation runtime. */
export function createNodeRunReconciliationRuntime(
  config: Config,
  repository = new RunArtifactRepository(),
): NodeRunReconciliationRuntime {
  const service = new RunReconciliationService({
    repository,
    resolveBackgroundProvider: (providerId) => {
      const provider = getExactProvider(providerId);
      return provider?.execution === 'background' ? provider : undefined;
    },
    getProviderConfig: (providerId) => config.providers[providerId],
    regenerateDerivedArtifacts: createRegenerator(repository),
  });
  return { repository, service };
}

export type { ReconciliationResult } from './node-run-reconciliation.js';
