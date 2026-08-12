/**
 * One-way presentation of a private v3 run. Nothing in this module may drive
 * lifecycle, resume, provider selection, or run.json mutation.
 */
import { providerIdentityKey } from './contracts/domain/index.js';
import type { ResearchResult } from './contracts/interchange/research-result.js';
import { deduplicateSources } from './core/normalizer.js';
import type { CanonicalRunManifestV3 } from './node-canonical-run.js';
import { providerArtifactFileNames } from './node-provider-artifact-names.js';
import type {
  Citation,
  DeduplicatedSource,
  ProviderDispatchResult,
  ProviderReport,
  ProviderTier,
  ProviderUsage,
  RunManifest,
} from './types.js';

function tierFor(resultKind: string): ProviderTier {
  switch (resultKind) {
    case 'research_report':
      return 'deep-research';
    case 'search_results':
      return 'raw-search';
    case 'model_answer':
      return 'llm';
    default:
      return 'ai-grounded';
  }
}

function numberMetadata(
  result: ResearchResult,
  key: string,
): number | undefined {
  const value = result.provider_meta?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function legacyUsage(
  usage: ResearchResult['usage'],
): ProviderUsage | undefined {
  if (!usage) return undefined;
  const cost =
    usage.actual_cost === undefined ? undefined : Number(usage.actual_cost);
  const projected: ProviderUsage = {
    ...(usage.prompt_tokens !== undefined && {
      inputTokens: usage.prompt_tokens,
    }),
    ...(usage.completion_tokens !== undefined && {
      outputTokens: usage.completion_tokens,
    }),
    ...(Number.isFinite(cost) && cost !== undefined && { costUsd: cost }),
  };
  return Object.keys(projected).length === 0 ? undefined : projected;
}

function markdown(result: ResearchResult): string {
  return typeof result.content === 'string'
    ? result.content
    : `\`\`\`json\n${JSON.stringify(result.content, null, 2)}\n\`\`\``;
}

function legacyCitations(result: ResearchResult, provider: string): Citation[] {
  return result.citations.flatMap((citation) =>
    citation.source.url
      ? [
          {
            url: citation.source.url,
            ...(citation.source.title && { title: citation.source.title }),
            ...(citation.excerpt && { snippet: citation.excerpt }),
            provider,
          },
        ]
      : [],
  );
}

function uniqueReportId(
  adapterId: string,
  slotId: string,
  used: Set<string>,
): string {
  if (!used.has(adapterId)) {
    used.add(adapterId);
    return adapterId;
  }
  const id = `${adapterId}:${slotId}`;
  used.add(id);
  return id;
}

export interface CanonicalRunPresentation {
  readonly reports: ProviderReport[];
  readonly results: ProviderDispatchResult[];
  readonly sources: DeduplicatedSource[];
  readonly providerContents: Readonly<Record<string, string>>;
  readonly totalCitations: number;
  readonly totalDurationMs: number;
  /** In-memory v2-shaped view for existing HTML/JSONL generators only. */
  readonly generatorManifest: RunManifest;
}

export function projectCanonicalRunPresentation(
  manifest: CanonicalRunManifestV3,
  outputDir: string,
  slug: string,
): CanonicalRunPresentation {
  const responseResults = manifest.terminal_response?.results ?? [];
  const resultById = new Map(
    responseResults.map((result) => [result.id, result]),
  );
  const usedReportIds = new Set<string>();
  const reports: ProviderReport[] = [];
  const results: ProviderDispatchResult[] = [];
  const providerContents: Record<string, string> = {};

  for (const slot of [...manifest.coordination_state.slots].sort(
    (left, right) => left.position - right.position,
  )) {
    const attempt = slot.latest_attempt_id
      ? manifest.coordination_state.attempts.find(
          (candidate) => candidate.attempt_id === slot.latest_attempt_id,
        )
      : undefined;
    const earlierAttempts = manifest.coordination_state.attempts
      .filter(
        (candidate) =>
          candidate.slot_id === slot.slot_id &&
          candidate.attempt_id !== attempt?.attempt_id,
      )
      .sort((left, right) => left.attempt_number - right.attempt_number);
    for (const earlier of earlierAttempts) {
      const earlierPlan =
        manifest.coordination_state.profile_plans_by_identity[
          providerIdentityKey(earlier.profile.identity)
        ];
      const earlierAdapter =
        earlierPlan?.binding.adapter_id ?? earlier.profile.identity.provider_id;
      const earlierId = uniqueReportId(
        earlierAdapter,
        slot.slot_id,
        usedReportIds,
      );
      const earlierFiles = providerArtifactFileNames(earlierId);
      const earlierStatus: ProviderReport['status'] =
        earlier.status === 'timed_out' ? 'timeout' : 'error';
      const earlierError =
        earlier.error?.message ?? 'The provider attempt did not succeed.';
      reports.push({
        id: earlierId,
        tier: tierFor(earlier.profile.result_kind),
        status: earlierStatus,
        durationMs: 0,
        wordCount: 0,
        citationCount: 0,
        outputFile: earlierFiles.outputFile,
        metaFile: earlierFiles.metaFile,
        error: earlierError,
      });
      providerContents[earlierFiles.outputFile] = '';
      results.push({
        provider: earlierId,
        tier: tierFor(earlier.profile.result_kind),
        status: earlierStatus,
        text: '',
        sourceUrls: [],
        citations: [],
        durationMs: 0,
        error: earlierError,
      });
    }
    const profile = attempt?.profile ?? slot.primary;
    const plan =
      manifest.coordination_state.profile_plans_by_identity[
        providerIdentityKey(profile.identity)
      ];
    const adapterId = plan?.binding.adapter_id ?? profile.identity.provider_id;
    const id = uniqueReportId(adapterId, slot.slot_id, usedReportIds);
    const projected = slot.result_id
      ? resultById.get(slot.result_id)
      : undefined;
    const tier = projected
      ? tierFor(projected.provenance.result_kind)
      : tierFor(profile.result_kind);
    const durationMs = projected
      ? (numberMetadata(projected, 'librarium:duration_ms') ?? 0)
      : 0;
    const citations = projected ? legacyCitations(projected, adapterId) : [];
    const content = projected ? markdown(projected) : '';
    const status: ProviderReport['status'] = projected
      ? 'success'
      : manifest.coordination_state.status === 'running' &&
          (!attempt ||
            ['dispatch_pending', 'submitting', 'submitted', 'running'].includes(
              attempt.status,
            ))
        ? 'async-pending'
        : attempt?.status === 'timed_out'
          ? 'timeout'
          : 'error';
    const files = providerArtifactFileNames(id);
    const error = attempt?.error?.message ?? slot.error?.message;
    const replaced = attempt?.replaces_attempt_id
      ? manifest.coordination_state.attempts.find(
          (candidate) => candidate.attempt_id === attempt.replaces_attempt_id,
        )
      : undefined;
    const fallbackFor = replaced
      ? (manifest.coordination_state.profile_plans_by_identity[
          providerIdentityKey(replaced.profile.identity)
        ]?.binding.adapter_id ?? replaced.profile.identity.provider_id)
      : undefined;
    const report: ProviderReport = {
      id,
      tier,
      status,
      durationMs,
      wordCount: content.trim() ? content.trim().split(/\s+/).length : 0,
      citationCount: citations.length,
      outputFile: files.outputFile,
      metaFile: files.metaFile,
      ...(projected?.usage && { usage: legacyUsage(projected.usage) }),
      ...(error && { error }),
      ...(fallbackFor && { fallbackFor }),
    };
    reports.push(report);
    providerContents[files.outputFile] = content;
    results.push({
      provider: id,
      tier,
      status,
      text: content,
      sourceUrls: citations.map((citation) => citation.url),
      citations,
      durationMs,
      ...(projected?.model && { model: projected.model }),
      ...(report.usage && { usage: report.usage }),
      ...(error && { error }),
      ...(fallbackFor && { fallbackFor }),
    });
  }

  const sources = deduplicateSources(
    results.flatMap((result) => result.citations),
  );
  const totalCitations = responseResults.reduce(
    (total, result) => total + result.citations.length,
    0,
  );
  const totalDurationMs = reports.reduce(
    (total, report) => total + report.durationMs,
    0,
  );
  const terminal = manifest.coordination_state.status !== 'running';
  const exitCode = terminal
    ? manifest.coordination_state.status === 'cancelled'
      ? 130
      : manifest.terminal_response?.status === 'succeeded'
        ? 0
        : manifest.terminal_response?.status === 'partial'
          ? 1
          : 2
    : undefined;
  const generatorManifest: RunManifest = {
    schemaVersion: 2,
    revision: manifest.revision,
    status:
      manifest.coordination_state.status === 'succeeded'
        ? 'completed'
        : manifest.coordination_state.status === 'unsuccessful'
          ? 'failed'
          : manifest.coordination_state.status,
    timestamp: Math.floor(Date.parse(manifest.generated_at) / 1_000),
    query: manifest.request.query,
    slug,
    mode: manifest.request.mode,
    outputDir,
    providers: reports,
    sources: {
      total: totalCitations,
      unique: sources.length,
      file: 'sources.json',
    },
    exitCode: exitCode ?? null,
    ...(terminal && {
      completedAt: Date.parse(
        manifest.terminal_response?.completed_at ?? manifest.generated_at,
      ),
    }),
  };
  return {
    reports,
    results,
    sources,
    providerContents,
    totalCitations,
    totalDurationMs,
    generatorManifest,
  };
}
