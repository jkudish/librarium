import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalUrl, readJson } from './io.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const benchmarkRoot = join(here, '..');

const allowedCategories = new Set([
  'factual-lookup',
  'technical-versioned',
  'comparison',
  'multi-hop',
  'freshness-sensitive',
]);
const allowedDifficulties = new Set(['easy', 'medium', 'hard']);

function requiredString(value, label, errors) {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${label} must be a non-empty string`);
  }
}

function validateQuestion(question, track, errors) {
  const prefix = question?.id ?? '<missing-id>';
  requiredString(question?.id, `${prefix}.id`, errors);
  requiredString(question?.question, `${prefix}.question`, errors);
  if (!String(question?.id ?? '').startsWith(`${track}-`)) {
    errors.push(`${prefix}.id must start with ${track}-`);
  }
  if (!allowedCategories.has(question?.category)) {
    errors.push(`${prefix}.category is invalid`);
  }
  if (!allowedDifficulties.has(question?.difficulty)) {
    errors.push(`${prefix}.difficulty is invalid`);
  }

  const expected = question?.expected;
  if (!Array.isArray(expected?.answers) || expected.answers.length === 0) {
    errors.push(`${prefix}.expected.answers must not be empty`);
  } else {
    for (const answer of expected.answers) {
      requiredString(answer, `${prefix}.expected.answers[]`, errors);
    }
  }
  if (!Array.isArray(expected?.aliases)) {
    errors.push(`${prefix}.expected.aliases must be an array`);
  }
  if (
    !Array.isArray(expected?.requiredFacts) ||
    expected.requiredFacts.length === 0
  ) {
    errors.push(`${prefix}.expected.requiredFacts must not be empty`);
  } else {
    const factIds = new Set();
    for (const fact of expected.requiredFacts) {
      requiredString(fact?.id, `${prefix}.requiredFacts[].id`, errors);
      requiredString(fact?.text, `${prefix}.requiredFacts[].text`, errors);
      if (!Array.isArray(fact?.aliases)) {
        errors.push(`${prefix}.${fact?.id}.aliases must be an array`);
      }
      if (factIds.has(fact?.id))
        errors.push(`${prefix} repeats fact ${fact.id}`);
      factIds.add(fact?.id);
    }
  }
  if (
    !Array.isArray(expected?.requiredSources) ||
    expected.requiredSources.length === 0
  ) {
    errors.push(`${prefix}.expected.requiredSources must not be empty`);
  } else {
    for (const source of expected.requiredSources) {
      requiredString(source?.title, `${prefix}.source.title`, errors);
      requiredString(source?.publisher, `${prefix}.source.publisher`, errors);
      requiredString(source?.evidence, `${prefix}.source.evidence`, errors);
      if (!canonicalUrl(source?.url)) {
        errors.push(`${prefix}.source.url must be an HTTP(S) URL`);
      }
    }
  }
  if (
    typeof question?.budgets?.maxLatencyMs !== 'number' ||
    question.budgets.maxLatencyMs <= 0
  ) {
    errors.push(`${prefix}.budgets.maxLatencyMs must be positive`);
  }
  if (
    typeof question?.budgets?.maxCostUsd !== 'number' ||
    question.budgets.maxCostUsd <= 0
  ) {
    errors.push(`${prefix}.budgets.maxCostUsd must be positive`);
  }

  if (track === 'live') {
    if (question.category !== 'freshness-sensitive') {
      errors.push(`${prefix}.category must be freshness-sensitive`);
    }
    const revalidation = question?.revalidation;
    if (revalidation?.requiredBeforePublishedRun !== true) {
      errors.push(`${prefix} must require revalidation before publication`);
    }
    if (
      !Number.isInteger(revalidation?.cadenceDays) ||
      revalidation.cadenceDays <= 0
    ) {
      errors.push(`${prefix}.revalidation.cadenceDays must be positive`);
    }
    for (const key of [
      'lastValidatedAt',
      'validUntil',
      'validator',
      'instructions',
    ]) {
      requiredString(
        revalidation?.[key],
        `${prefix}.revalidation.${key}`,
        errors,
      );
    }
    if (
      Number.isNaN(Date.parse(revalidation?.lastValidatedAt)) ||
      Number.isNaN(Date.parse(revalidation?.validUntil))
    ) {
      errors.push(`${prefix}.revalidation dates must be ISO-compatible`);
    } else if (revalidation.validUntil < revalidation.lastValidatedAt) {
      errors.push(`${prefix}.revalidation.validUntil precedes validation`);
    }
  }
}

export function validateCorpus(stable, live) {
  const errors = [];
  if (stable?.schemaVersion !== 1 || stable?.track !== 'stable') {
    errors.push('stable dataset must use schemaVersion 1 and track stable');
  }
  if (live?.schemaVersion !== 1 || live?.track !== 'live') {
    errors.push('live dataset must use schemaVersion 1 and track live');
  }
  for (const [name, dataset] of [
    ['stable', stable],
    ['live', live],
  ]) {
    requiredString(dataset?.version, `${name}.version`, errors);
    requiredString(
      dataset?.maintainerValidatedAt,
      `${name}.maintainerValidatedAt`,
      errors,
    );
  }
  requiredString(stable?.frozenAt, 'stable.frozenAt', errors);
  if (
    !Array.isArray(stable?.questions) ||
    stable.questions.length < 25 ||
    stable.questions.length > 30
  ) {
    errors.push('stable dataset must contain 25-30 questions');
  }
  if (
    !Array.isArray(live?.questions) ||
    live.questions.length < 10 ||
    live.questions.length > 15
  ) {
    errors.push('live dataset must contain 10-15 questions');
  }

  const ids = new Set();
  for (const [track, dataset] of [
    ['stable', stable],
    ['live', live],
  ]) {
    for (const question of dataset?.questions ?? []) {
      validateQuestion(question, track, errors);
      if (ids.has(question.id))
        errors.push(`duplicate question id ${question.id}`);
      ids.add(question.id);
    }
  }

  const stableCategories = new Set(
    (stable?.questions ?? []).map((question) => question.category),
  );
  for (const required of [
    'factual-lookup',
    'technical-versioned',
    'comparison',
    'multi-hop',
  ]) {
    if (!stableCategories.has(required)) {
      errors.push(`stable dataset must cover ${required}`);
    }
  }
  return errors;
}

export function loadCorpus() {
  const stable = readJson(join(benchmarkRoot, 'datasets', 'stable.json'));
  const live = readJson(join(benchmarkRoot, 'datasets', 'live.json'));
  const errors = validateCorpus(stable, live);
  if (errors.length > 0) {
    throw new Error(`Invalid benchmark corpus:\n- ${errors.join('\n- ')}`);
  }
  return { stable, live };
}

export function selectQuestions(corpus, track, questionIds = []) {
  const available = [
    ...(track === 'stable' || track === 'all' ? corpus.stable.questions : []),
    ...(track === 'live' || track === 'all' ? corpus.live.questions : []),
  ];
  if (questionIds.length === 0) return available;
  const requested = new Set(questionIds);
  const selected = available.filter((question) => requested.has(question.id));
  const missing = questionIds.filter(
    (id) => !selected.some((question) => question.id === id),
  );
  if (missing.length > 0) {
    throw new Error(
      `Unknown question id(s) for track ${track}: ${missing.join(', ')}`,
    );
  }
  return selected;
}

export function assertLiveQuestionsFresh(questions, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const stale = questions.filter(
    (question) =>
      question.category === 'freshness-sensitive' &&
      question.revalidation.validUntil < today,
  );
  if (stale.length > 0) {
    throw new Error(
      `Live corpus revalidation expired for: ${stale.map((q) => q.id).join(', ')}. Update expected facts/evidence before a live run.`,
    );
  }
}
