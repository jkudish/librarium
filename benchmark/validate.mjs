#!/usr/bin/env node
import { loadCorpus } from './lib/corpus.mjs';
import { allTargets, loadTargetCatalog } from './lib/targets.mjs';

const corpus = loadCorpus();
const catalog = loadTargetCatalog();
const targets = allTargets(catalog);
process.stdout.write(
  `Benchmark corpus valid: ${corpus.stable.questions.length} stable, ${corpus.live.questions.length} live; ${catalog.providers.length} providers, ${Object.keys(catalog.builtInGroups).length} built-in groups, ${Object.keys(catalog.candidateGroups).length} candidate groups (${targets.length} targets total).\n`,
);
