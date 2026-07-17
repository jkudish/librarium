import { mean, round } from './io.mjs';

function aggregateTarget(target, scores) {
  const cases = scores.filter((score) => score.target.id === target.id);
  const costKnown =
    cases.length > 0 &&
    cases.every(
      (score) => score.performance.cost.providerComparableUsd !== null,
    );
  return {
    id: target.id,
    name: target.name,
    type: target.type,
    tier: target.tier,
    members: target.members,
    caseCount: cases.length,
    retrievalQuality: round(
      mean(cases.map((score) => score.retrieval.qualityScore)),
    ),
    answerQuality: round(mean(cases.map((score) => score.answer.qualityScore))),
    endToEndQuality: round(mean(cases.map((score) => score.endToEndQuality))),
    latencyMs: round(
      mean(cases.map((score) => score.performance.latencyMs)),
      1,
    ),
    costUsd: costKnown
      ? round(
          cases.reduce(
            (total, score) =>
              total + score.performance.cost.providerComparableUsd,
            0,
          ),
          8,
        )
      : null,
    unknownCostCases: cases.filter(
      (score) => score.performance.cost.providerComparableUsd === null,
    ).length,
    failureRate: round(
      mean(cases.map((score) => score.performance.failureRate)),
    ),
  };
}

function paretoFlags(rows) {
  return rows.map((row) => {
    if (row.costUsd === null || row.endToEndQuality === null) {
      return { ...row, pareto: null };
    }
    const dominated = rows.some((other) => {
      if (
        other.id === row.id ||
        other.costUsd === null ||
        other.endToEndQuality === null
      ) {
        return false;
      }
      const noWorse =
        other.endToEndQuality >= row.endToEndQuality &&
        other.costUsd <= row.costUsd &&
        other.latencyMs <= row.latencyMs;
      const strictlyBetter =
        other.endToEndQuality > row.endToEndQuality ||
        other.costUsd < row.costUsd ||
        other.latencyMs < row.latencyMs;
      return noWorse && strictlyBetter;
    });
    return { ...row, pareto: !dominated };
  });
}

export function buildSummary({ run, targets, scores }) {
  const aggregates = targets.map((target) => aggregateTarget(target, scores));
  const individualByTier = {};
  for (const tier of ['deep-research', 'ai-grounded', 'raw-search', 'llm']) {
    individualByTier[tier] = paretoFlags(
      aggregates.filter(
        (row) => row.type === 'individual-provider' && row.tier === tier,
      ),
    );
  }
  return {
    schemaVersion: 1,
    runId: run.runId,
    generatedAt: new Date().toISOString(),
    methodology: {
      retrievalAndAnswerScoredSeparately: true,
      crossTierWinner: false,
      paretoDimensions: ['endToEndQuality', 'costUsd', 'latencyMs'],
      costDimension: 'providerComparableUsd',
      unknownCostsExcludedFromPareto: true,
    },
    individualProvidersByTier: individualByTier,
    builtInGroups: paretoFlags(
      aggregates.filter((row) => row.type === 'built-in-group'),
    ),
    candidateGroups: paretoFlags(
      aggregates.filter((row) => row.type === 'candidate-group'),
    ),
  };
}

function formatNumber(value, digits = 3) {
  return value === null ? 'unknown' : Number(value).toFixed(digits);
}

function table(rows) {
  if (rows.length === 0) return '_No results in this run._\n';
  const header =
    '| Target | Retrieval | Answer | End-to-end | Provider cost USD | Latency ms | Failure rate | Pareto |\n|---|---:|---:|---:|---:|---:|---:|:---:|';
  const body = rows.map(
    (row) =>
      `| ${row.name} | ${formatNumber(row.retrievalQuality)} | ${formatNumber(row.answerQuality)} | ${formatNumber(row.endToEndQuality)} | ${formatNumber(row.costUsd, 6)} | ${formatNumber(row.latencyMs, 1)} | ${formatNumber(row.failureRate)} | ${row.pareto === null ? 'unknown cost' : row.pareto ? 'yes' : 'no'} |`,
  );
  return `${header}\n${body.join('\n')}\n`;
}

export function renderMarkdownReport(summary) {
  const sections = [
    '# Librarium provider benchmark',
    '',
    `Run: \`${summary.runId}\`  `,
    `Generated: ${summary.generatedAt}`,
    '',
    'Retrieval and answer quality are independent metrics. End-to-end quality is a summary only. Providers are compared within tier; this report intentionally does not name a cross-tier winner. Provider cost marked `unknown` is not treated as zero or free. Synthesis and judge costs remain preserved separately in case artifacts and total-cost fields.',
    '',
  ];
  for (const [tier, rows] of Object.entries(
    summary.individualProvidersByTier,
  )) {
    sections.push(`## Individual providers — ${tier}`, '', table(rows));
  }
  sections.push('## Built-in groups', '', table(summary.builtInGroups));
  sections.push(
    '## Curated candidate groups',
    '',
    table(summary.candidateGroups),
    'Candidate groups are a small reviewed set. The benchmark does not search all provider combinations and never changes Librarium defaults automatically.',
    '',
  );
  return sections.join('\n');
}
