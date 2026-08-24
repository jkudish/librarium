import { cpSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { canonicalUrl, readJson } from './io.mjs';

function readOptional(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function isContained(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) &&
      pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${sep}`))
  );
}

export function resolveArtifactReference(root, reference, label) {
  if (typeof reference !== 'string' || reference.trim() === '') {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (isAbsolute(reference)) {
    throw new Error(`${label} must be relative to its artifact root`);
  }
  return resolveWithinArtifactRoot(root, resolve(root, reference), label);
}

function resolveWithinArtifactRoot(root, candidate, label) {
  const resolvedRoot = resolve(root);
  const lexicalCandidate = resolve(candidate);
  if (!isContained(resolvedRoot, lexicalCandidate)) {
    throw new Error(`${label} must stay within its artifact root`);
  }
  let realRoot;
  let realCandidate;
  try {
    realRoot = realpathSync(resolvedRoot);
    realCandidate = realpathSync(lexicalCandidate);
  } catch {
    throw new Error(`${label} does not reference an existing artifact`);
  }
  if (!isContained(realRoot, realCandidate)) {
    throw new Error(`${label} escapes its artifact root through a symlink`);
  }
  return realCandidate;
}

export function parseLibrariumRun(runDirectory) {
  const runDir = resolve(runDirectory);
  const manifest = readJson(
    resolveArtifactReference(runDir, 'run.json', 'run manifest'),
  );
  if (manifest.schemaVersion === 3) {
    if (
      manifest.artifact_name !== 'run_manifest' ||
      manifest.artifact_version !== '3.0.0' ||
      manifest.terminal_response?.status !== 'succeeded' ||
      !Array.isArray(manifest.terminal_response.results)
    ) {
      throw new Error(`${runDir} is not a successful canonical Librarium run`);
    }
    const providerOutputs = manifest.terminal_response.results.map((result) => {
      if (result.fallback_reason) {
        throw new Error(
          `Benchmark artifacts must not contain provider fallbacks: ${result.provider}`,
        );
      }
      const resultKind = result.provenance?.result_kind;
      const tier =
        resultKind === 'research_report'
          ? 'deep-research'
          : resultKind === 'search_results'
            ? 'raw-search'
            : resultKind === 'model_answer'
              ? 'llm'
              : 'ai-grounded';
      const durationMs = result.provider_meta?.['librarium:duration_ms'];
      return {
        provider: result.provider,
        tier,
        status: 'success',
        durationMs:
          typeof durationMs === 'number' && Number.isFinite(durationMs)
            ? durationMs
            : 0,
        error: undefined,
        model: result.model ?? null,
        content:
          typeof result.content === 'string'
            ? result.content
            : JSON.stringify(result.content),
        citations: Array.isArray(result.citations)
          ? result.citations.flatMap((citation) =>
              citation?.source?.url
                ? [
                    {
                      url: citation.source.url,
                      ...(citation.source.title && {
                        title: citation.source.title,
                      }),
                      ...(citation.excerpt && { snippet: citation.excerpt }),
                      provider: result.provider,
                    },
                  ]
                : [],
            )
          : [],
        usage: result.usage ?? null,
        metering: null,
        rawFiles: { output: null, meta: null },
      };
    });
    return {
      runDir,
      manifest,
      providerOutputs,
      sources: [],
    };
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.providers)) {
    throw new Error(`${runDir} is not a Librarium v1 run artifact`);
  }
  const pending = manifest.providers.filter(
    (provider) => provider.status === 'async-pending',
  );
  if (pending.length > 0 || (manifest.asyncTasks?.length ?? 0) > 0) {
    throw new Error(
      `Deep-research output is not comparable until completed and retrieved: ${pending.map((item) => item.id).join(', ')}`,
    );
  }
  const fallbacks = manifest.providers.filter(
    (provider) => provider.fallbackFor,
  );
  if (fallbacks.length > 0) {
    throw new Error(
      `Benchmark artifacts must not contain provider fallbacks: ${fallbacks.map((item) => `${item.id} for ${item.fallbackFor}`).join(', ')}`,
    );
  }

  const providerOutputs = manifest.providers.map((report) => {
    const metaPath = report.metaFile
      ? resolveArtifactReference(
          runDir,
          report.metaFile,
          `provider ${report.id} metaFile`,
        )
      : null;
    const outputPath = report.outputFile
      ? resolveArtifactReference(
          runDir,
          report.outputFile,
          `provider ${report.id} outputFile`,
        )
      : null;
    const meta = metaPath ? readJson(metaPath) : {};
    return {
      provider: report.id,
      tier: report.tier,
      status: report.status,
      durationMs: report.durationMs,
      error: report.error,
      model: meta.model ?? null,
      content: outputPath ? readOptional(outputPath) : '',
      citations: Array.isArray(meta.citations) ? meta.citations : [],
      usage: report.usage ?? meta.usage ?? null,
      metering: report.metering ?? meta.metering ?? null,
      rawFiles: {
        output: report.outputFile || null,
        meta: report.metaFile || null,
      },
    };
  });
  const sourcesPath = resolveArtifactReference(
    runDir,
    manifest.sources?.file ?? 'sources.json',
    'sources file',
  );
  const sources = existsSync(sourcesPath) ? readJson(sourcesPath) : [];
  for (const source of sources) {
    source.validUrl = canonicalUrl(source.url) !== null;
  }
  return {
    runDir,
    manifest,
    providerOutputs,
    sources,
  };
}

export function loadFixturePack(path) {
  const manifestPath = resolve(path);
  const fixture = readJson(manifestPath);
  if (fixture.schemaVersion !== 1 || !Array.isArray(fixture.cases)) {
    throw new Error(`${manifestPath} is not a benchmark fixture pack`);
  }
  const root = dirname(manifestPath);
  const cases = new Map();
  for (const item of fixture.cases) {
    const key = `${item.questionId}::${item.targetId}`;
    if (cases.has(key)) throw new Error(`Duplicate fixture case ${key}`);
    const runDir = resolveArtifactReference(
      root,
      item.runDirectory,
      `fixture ${key} runDirectory`,
    );
    const judgmentPath = resolveArtifactReference(
      root,
      item.judgmentFile,
      `fixture ${key} judgmentFile`,
    );
    const answerPath = resolveArtifactReference(
      root,
      item.answerFile,
      `fixture ${key} answerFile`,
    );
    const synthesisPath = resolveArtifactReference(
      root,
      item.synthesisFile,
      `fixture ${key} synthesisFile`,
    );
    cases.set(key, {
      ...item,
      parsedRun: parseLibrariumRun(runDir),
      answer: readFileSync(answerPath, 'utf8'),
      synthesis: readJson(synthesisPath),
      judgment: readJson(judgmentPath),
    });
  }
  return { manifestPath, root, fixture, cases };
}

export function copyFixtureRun(caseFixture, destination) {
  cpSync(caseFixture.parsedRun.runDir, destination, {
    recursive: true,
    errorOnExist: false,
  });
  return parseLibrariumRun(destination);
}

export function findRunDirectory(outputBase, manifest) {
  if (manifest?.outputDir) {
    const candidate = resolveWithinArtifactRoot(
      outputBase,
      isAbsolute(manifest.outputDir)
        ? manifest.outputDir
        : resolve(outputBase, manifest.outputDir),
      'Librarium manifest outputDir',
    );
    if (existsSync(resolve(candidate, 'run.json'))) return candidate;
  }
  if (manifest?.slug) {
    const candidate = resolveArtifactReference(
      outputBase,
      manifest.slug,
      'Librarium manifest slug',
    );
    if (existsSync(resolve(candidate, 'run.json'))) return candidate;
  }
  throw new Error(
    `Librarium did not produce a readable run directory under ${basename(outputBase)}`,
  );
}
