/** One-way derived artifacts for a canonical v3 run. */
import { buildPrompt } from './core/prompt-builder.js';
import { generateSummary } from './core/synthesis.js';
import {
  type CanonicalRunPresentation,
  projectCanonicalRunPresentation,
} from './node-canonical-presentation.js';
import type { CanonicalRunManifestV3 } from './node-canonical-run.js';
import {
  type CanonicalDerivedArtifactWriter,
  NodeCanonicalDerivedArtifactWriter,
} from './node-derived-artifacts.js';

export function writeCanonicalPresentationArtifacts(
  manifest: CanonicalRunManifestV3,
  outputDir: string,
  slug: string,
  repository: CanonicalDerivedArtifactWriter = new NodeCanonicalDerivedArtifactWriter(),
): CanonicalRunPresentation {
  const presentation = projectCanonicalRunPresentation(
    manifest,
    outputDir,
    slug,
  );
  repository.writePrompt(outputDir, buildPrompt(manifest.request.query));
  for (const report of presentation.reports) {
    const result = presentation.results.find(
      (candidate) => candidate.provider === report.id,
    );
    repository.writeProviderContent(
      outputDir,
      report.id,
      presentation.providerContents[report.outputFile] ?? '',
    );
    repository.writeProviderMeta(outputDir, report.id, {
      tier: report.tier,
      durationMs: report.durationMs,
      citationCount: report.citationCount,
      citations: result?.citations ?? [],
      ...(result?.model && { model: result.model }),
      ...(report.usage && { usage: report.usage }),
      ...(presentation.providerMetadata[report.id] && {
        providerMeta: structuredClone(
          presentation.providerMetadata[report.id] as Record<string, unknown>,
        ),
      }),
    });
  }
  repository.writeSources(outputDir, presentation.sources);
  repository.writeSummary(
    outputDir,
    generateSummary({
      query: manifest.request.query,
      reports: presentation.reports,
      sources: presentation.sources,
      asyncTasks: [],
      timestamp: Math.floor(Date.parse(manifest.generated_at) / 1_000),
    }),
  );
  return presentation;
}
