import { join } from 'node:path';
import { benchmarkRoot } from './corpus.mjs';
import { readJson, round } from './io.mjs';

export function loadTargetCatalog() {
  const catalog = readJson(join(benchmarkRoot, 'targets.json'));
  const errors = validateTargetCatalog(catalog);
  if (errors.length > 0) {
    throw new Error(
      `Invalid benchmark target catalog:\n- ${errors.join('\n- ')}`,
    );
  }
  return catalog;
}

export function validateTargetCatalog(catalog) {
  const errors = [];
  if (catalog?.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!Array.isArray(catalog?.providers) || catalog.providers.length === 0) {
    errors.push('providers must not be empty');
    return errors;
  }
  const providerIds = new Set();
  for (const provider of catalog.providers) {
    if (!provider?.id || providerIds.has(provider.id)) {
      errors.push(`invalid or duplicate provider ${provider?.id}`);
    }
    providerIds.add(provider.id);
    if (
      !['deep-research', 'ai-grounded', 'raw-search', 'llm'].includes(
        provider.tier,
      )
    ) {
      errors.push(`${provider.id} has invalid tier`);
    }
    if (!provider.envVar) errors.push(`${provider.id} is missing envVar`);
    if (
      !['unknown', 'estimated', 'configured'].includes(provider.costConfidence)
    ) {
      errors.push(`${provider.id} has invalid costConfidence`);
    }
    if (
      provider.estimatedCostUsd !== null &&
      (typeof provider.estimatedCostUsd !== 'number' ||
        provider.estimatedCostUsd <= 0)
    ) {
      errors.push(`${provider.id} has an invalid cost estimate`);
    }
    if (
      provider.estimatedCostUsd === 0 &&
      provider.costConfidence === 'unknown'
    ) {
      errors.push(`${provider.id} treats unknown cost as zero`);
    }
  }
  for (const [kind, groups] of [
    ['built-in', catalog.builtInGroups],
    ['candidate', catalog.candidateGroups],
  ]) {
    if (!groups || Object.keys(groups).length === 0) {
      errors.push(`${kind} groups must not be empty`);
      continue;
    }
    for (const [name, members] of Object.entries(groups)) {
      if (!Array.isArray(members) || members.length === 0) {
        errors.push(`${kind} group ${name} is empty`);
        continue;
      }
      for (const member of members) {
        if (!providerIds.has(member)) {
          errors.push(`${kind} group ${name} references unknown ${member}`);
        }
      }
      if (new Set(members).size !== members.length) {
        errors.push(`${kind} group ${name} repeats a provider`);
      }
    }
  }
  if (Object.keys(catalog.candidateGroups ?? {}).length > 5) {
    errors.push('candidate group set must remain small (at most 5)');
  }
  const signatures = new Map();
  for (const [kind, groups] of [
    ['built-in', catalog.builtInGroups],
    ['candidate', catalog.candidateGroups],
  ]) {
    for (const [name, members] of Object.entries(groups ?? {})) {
      const signature = [...members].sort().join(',');
      const existing = signatures.get(signature);
      if (existing) {
        errors.push(`${kind} group ${name} duplicates ${existing}`);
      } else {
        signatures.set(signature, `${kind} group ${name}`);
      }
    }
  }
  return errors;
}

function groupTier(members, providersById) {
  const tiers = new Set(members.map((id) => providersById.get(id).tier));
  return tiers.size === 1 ? [...tiers][0] : 'mixed';
}

export function allTargets(catalog) {
  const providersById = new Map(
    catalog.providers.map((provider) => [provider.id, provider]),
  );
  const individual = catalog.providers.map((provider) => ({
    id: `provider:${provider.id}`,
    name: provider.id,
    type: 'individual-provider',
    tier: provider.tier,
    members: [provider.id],
  }));
  const builtIn = Object.entries(catalog.builtInGroups).map(
    ([name, members]) => ({
      id: `group:${name}`,
      name,
      type: 'built-in-group',
      tier: groupTier(members, providersById),
      members,
    }),
  );
  const candidates = Object.entries(catalog.candidateGroups).map(
    ([name, members]) => ({
      id: `candidate:${name}`,
      name,
      type: 'candidate-group',
      tier: groupTier(members, providersById),
      members,
    }),
  );
  return [...individual, ...builtIn, ...candidates];
}

export function selectTargets(catalog, selection = {}) {
  const targets = allTargets(catalog);
  const requested = new Set();
  for (const id of selection.providers ?? []) requested.add(`provider:${id}`);
  for (const id of selection.groups ?? []) requested.add(`group:${id}`);
  for (const id of selection.candidates ?? []) requested.add(`candidate:${id}`);
  if (requested.size === 0) return targets;
  const selected = targets.filter((target) => requested.has(target.id));
  const missing = [...requested].filter(
    (id) => !selected.some((target) => target.id === id),
  );
  if (missing.length > 0) {
    throw new Error(`Unknown benchmark target(s): ${missing.join(', ')}`);
  }
  return selected;
}

export function buildPreflight({
  questions,
  targets,
  catalog,
  config,
  env,
  cases,
  providerConfiguration = [],
}) {
  const providerById = new Map(
    catalog.providers.map((provider) => [provider.id, provider]),
  );
  const plannedCases =
    cases ??
    questions.flatMap((question) =>
      targets.map((target) => ({ question, target, stage: 'full' })),
    );
  const resolvedProviderById = new Map(
    providerConfiguration.map((provider) => [provider.id, provider]),
  );
  let knownEstimateUsd = 0;
  const knownOperations = new Map();
  const unknownOperations = new Map();
  const credentialRefs = new Map();

  for (const plannedCase of plannedCases) {
    if (plannedCase.stage !== 'full') continue;
    for (const member of plannedCase.target.members) {
      const provider = providerById.get(member);
      const credentialEnvironmentVariable =
        resolvedProviderById.get(member)?.credentialEnvironmentVariable ??
        provider.envVar;
      if (credentialEnvironmentVariable) {
        credentialRefs.set(
          credentialEnvironmentVariable,
          Boolean(env[credentialEnvironmentVariable]),
        );
      }
      if (typeof provider.estimatedCostUsd === 'number') {
        knownEstimateUsd += provider.estimatedCostUsd;
        const operation = `provider:${member}`;
        const existing = knownOperations.get(operation) ?? {
          operation,
          count: 0,
          perCallEstimateUsd: provider.estimatedCostUsd,
          costConfidence: provider.costConfidence,
          pricingVersion: provider.pricingVersion ?? null,
        };
        existing.count += 1;
        knownOperations.set(operation, existing);
      } else {
        unknownOperations.set(
          `provider:${member}`,
          (unknownOperations.get(`provider:${member}`) ?? 0) + 1,
        );
      }
    }
  }

  for (const lane of ['synthesis', 'judge']) {
    const llm = config[lane];
    const count = plannedCases.filter(
      (plannedCase) => lane === 'judge' || plannedCase.stage === 'full',
    ).length;
    if (count === 0) continue;
    credentialRefs.set(llm.envVar, Boolean(env[llm.envVar]));
    unknownOperations.set(`${lane}:${llm.provider}/${llm.model}`, count);
  }

  const remainingQuestionIds = new Set(
    plannedCases.map((plannedCase) => plannedCase.question.id),
  );
  const remainingTargetIds = new Set(
    plannedCases.map((plannedCase) => plannedCase.target.id),
  );

  return {
    schemaVersion: 1,
    paidCalls: true,
    questionCount: remainingQuestionIds.size,
    targetCount: remainingTargetIds.size,
    caseCount: plannedCases.length,
    fullCaseCount: plannedCases.filter(
      (plannedCase) => plannedCase.stage === 'full',
    ).length,
    judgeOnlyCaseCount: plannedCases.filter(
      (plannedCase) => plannedCase.stage === 'judge',
    ).length,
    providerDispatchCount: plannedCases
      .filter((plannedCase) => plannedCase.stage === 'full')
      .reduce(
        (total, plannedCase) => total + plannedCase.target.members.length,
        0,
      ),
    knownEstimateUsd: round(knownEstimateUsd, 6),
    knownEstimateIsPartial: unknownOperations.size > 0,
    knownCostOperations: [...knownOperations.values()].map((operation) => ({
      ...operation,
      subtotalEstimateUsd: round(
        operation.count * operation.perCallEstimateUsd,
        6,
      ),
    })),
    unknownCostOperations: [...unknownOperations].map(([operation, count]) => ({
      operation,
      count,
    })),
    credentials: [...credentialRefs].map(([envVar, available]) => ({
      envVar,
      available,
    })),
    synthesis: {
      ...config.synthesis,
      credentialAvailable: Boolean(env[config.synthesis.envVar]),
    },
    judge: {
      ...config.judge,
      credentialAvailable: Boolean(env[config.judge.envVar]),
    },
    note: 'Unknown costs are not included in knownEstimateUsd and are never treated as free.',
  };
}
