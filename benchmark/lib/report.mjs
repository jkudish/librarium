import { mean, round } from './io.mjs';

function qualityIncludingFailedCases(cases, expectedCaseCount, selector) {
  if (expectedCaseCount === 0) return null;
  return (
    cases.reduce((total, score) => total + (selector(score) ?? 0), 0) /
    expectedCaseCount
  );
}

function aggregateTarget(target, scores, expectedCaseCount) {
  const cases = scores.filter((score) => score.target.id === target.id);
  const completedCaseCount = cases.length;
  const failedCaseCount = Math.max(0, expectedCaseCount - completedCaseCount);
  const complete = failedCaseCount === 0;
  const costKnown =
    complete &&
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
    caseCount: completedCaseCount,
    expectedCaseCount,
    completedCaseCount,
    failedCaseCount,
    complete,
    retrievalQuality: round(
      qualityIncludingFailedCases(
        cases,
        expectedCaseCount,
        (score) => score.retrieval.qualityScore,
      ),
    ),
    answerQuality: round(
      qualityIncludingFailedCases(
        cases,
        expectedCaseCount,
        (score) => score.answer.qualityScore,
      ),
    ),
    endToEndQuality: round(
      qualityIncludingFailedCases(
        cases,
        expectedCaseCount,
        (score) => score.endToEndQuality,
      ),
    ),
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
    unknownCostCases:
      failedCaseCount +
      cases.filter(
        (score) => score.performance.cost.providerComparableUsd === null,
      ).length,
    failureRate: round(
      expectedCaseCount === 0
        ? null
        : (cases.reduce(
            (total, score) => total + score.performance.failureRate,
            0,
          ) +
            failedCaseCount) /
            expectedCaseCount,
    ),
  };
}

function paretoFlags(rows) {
  return rows.map((row) => {
    if (!row.complete) {
      return { ...row, pareto: null, paretoEligibility: 'incomplete' };
    }
    if (
      row.costUsd === null ||
      row.endToEndQuality === null ||
      row.latencyMs === null
    ) {
      return { ...row, pareto: null, paretoEligibility: 'insufficient-data' };
    }
    const dominated = rows.some((other) => {
      if (
        other.id === row.id ||
        !other.complete ||
        other.costUsd === null ||
        other.endToEndQuality === null ||
        other.latencyMs === null
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
    return { ...row, pareto: !dominated, paretoEligibility: 'eligible' };
  });
}

export function buildSummary({ run, targets, scores }) {
  const expectedCaseCount =
    run.questions?.length ??
    Math.max(
      0,
      ...targets.map(
        (target) =>
          scores.filter((score) => score.target.id === target.id).length,
      ),
    );
  const aggregates = targets.map((target) =>
    aggregateTarget(target, scores, expectedCaseCount),
  );
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
      incompleteTargetsExcludedFromPareto: true,
      failedCasesScoreAsZeroInQualityAggregates: true,
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
    '| Target | Cases | Failed | Retrieval | Answer | End-to-end | Provider cost USD | Latency ms | Failure rate | Pareto |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|:---:|';
  const body = rows.map(
    (row) =>
      `| ${row.name} | ${row.completedCaseCount}/${row.expectedCaseCount} | ${row.failedCaseCount} | ${formatNumber(row.retrievalQuality)} | ${formatNumber(row.answerQuality)} | ${formatNumber(row.endToEndQuality)} | ${formatNumber(row.costUsd, 6)} | ${formatNumber(row.latencyMs, 1)} | ${formatNumber(row.failureRate)} | ${row.paretoEligibility === 'incomplete' ? 'incomplete' : row.pareto === null ? 'insufficient data' : row.pareto ? 'yes' : 'no'} |`,
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
    'Retrieval and answer quality are independent metrics. End-to-end quality is a summary only. Failed cases count as zero in quality aggregates, and incomplete targets are excluded from Pareto comparison. Providers are compared within tier; this report intentionally does not name a cross-tier winner. Provider cost marked `unknown` is not treated as zero or free. Synthesis and judge costs remain preserved separately in case artifacts and total-cost fields.',
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
