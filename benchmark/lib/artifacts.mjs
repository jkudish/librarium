import { cpSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalUrl, readJson } from './io.mjs';

function readOptional(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

export function parseLibrariumRun(runDirectory) {
  const runDir = resolve(runDirectory);
  const manifest = readJson(join(runDir, 'run.json'));
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

  const providerOutputs = manifest.providers.map((report) => {
    const meta = report.metaFile ? readJson(join(runDir, report.metaFile)) : {};
    return {
      provider: report.id,
      tier: report.tier,
      status: report.status,
      durationMs: report.durationMs,
      error: report.error,
      model: meta.model ?? null,
      content: report.outputFile
        ? readOptional(join(runDir, report.outputFile))
        : '',
      citations: Array.isArray(meta.citations) ? meta.citations : [],
      usage: report.usage ?? meta.usage ?? null,
      metering: report.metering ?? meta.metering ?? null,
      rawFiles: {
        output: report.outputFile || null,
        meta: report.metaFile || null,
      },
    };
  });
  const sourcesPath = join(runDir, manifest.sources?.file ?? 'sources.json');
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
    const runDir = join(root, item.runDirectory);
    const judgmentPath = join(root, item.judgmentFile);
    const answerPath = join(root, item.answerFile);
    const synthesisPath = join(root, item.synthesisFile);
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
  if (manifest?.outputDir && existsSync(join(manifest.outputDir, 'run.json'))) {
    return manifest.outputDir;
  }
  if (manifest?.slug) {
    const candidate = join(outputBase, manifest.slug);
    if (existsSync(join(candidate, 'run.json'))) return candidate;
  }
  throw new Error(
    `Librarium did not produce a readable run directory under ${basename(outputBase)}`,
  );
}
