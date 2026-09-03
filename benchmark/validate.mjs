#!/usr/bin/env node
import { loadCorpus } from './lib/corpus.mjs';
import { readJson } from './lib/io.mjs';
import { allTargets, loadTargetCatalog } from './lib/targets.mjs';
import { validateCorpus as validateSurfaceCorpus } from './surface-calibration/lib.mjs';

const corpus = loadCorpus();
const catalog = loadTargetCatalog();
const targets = allTargets(catalog);
const surfaceCorpus = readJson(
  new URL('./surface-calibration/corpus.v1.json', import.meta.url),
);
const surfaceErrors = validateSurfaceCorpus(surfaceCorpus);
if (surfaceErrors.length > 0) {
  throw new Error(
    `Invalid consumer-surface corpus:\n- ${surfaceErrors.join('\n- ')}`,
  );
}
process.stdout.write(
  `Benchmark corpus valid: ${corpus.stable.questions.length} stable, ${corpus.live.questions.length} live, ${surfaceCorpus.cases.length} consumer-surface calibration; ${catalog.providers.length} providers, ${Object.keys(catalog.builtInGroups).length} built-in groups, ${Object.keys(catalog.candidateGroups).length} candidate groups (${targets.length} targets total).\n`,
);
