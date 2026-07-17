import { canonicalUrl, mean, normalizeText, round } from './io.mjs';

function containsAlternative(text, alternatives) {
  const haystack = ` ${normalizeText(text)} `;
  return alternatives.some((value) => {
    const needle = normalizeText(value);
    return needle !== '' && haystack.includes(` ${needle} `);
  });
}

function factChecks(text, facts) {
  return facts.map((fact) => ({
    id: fact.id,
    matched: containsAlternative(text, [fact.text, ...(fact.aliases ?? [])]),
    alternatives: [fact.text, ...(fact.aliases ?? [])],
  }));
}

function sourceChecks(citations, requiredSources) {
  const cited = new Set(
    citations.map((citation) => canonicalUrl(citation.url)).filter(Boolean),
  );
  return requiredSources.map((source) => ({
    url: source.url,
    matched: cited.has(canonicalUrl(source.url)),
  }));
}

function citationValidity(citations) {
  if (citations.length === 0) return { valid: 0, total: 0, score: 0 };
  const valid = citations.filter(
    (citation) => canonicalUrl(citation.url) !== null,
  ).length;
  return { valid, total: citations.length, score: valid / citations.length };
}

function answerCitationValidity(answer, sourceCount) {
  const indices = [...answer.matchAll(/\[(\d+)\]/g)].map((match) =>
    Number.parseInt(match[1], 10),
  );
  if (sourceCount === 0) {
    return {
      cited: indices.length,
      valid: 0,
      score: indices.length === 0 ? 1 : 0,
    };
  }
  if (indices.length === 0) return { cited: 0, valid: 0, score: 0 };
  const valid = indices.filter(
    (index) => index >= 1 && index <= sourceCount,
  ).length;
  return { cited: indices.length, valid, score: valid / indices.length };
}

function costMetrics(outputs, answer, judge) {
  let knownUsd = 0;
  let knownCount = 0;
  let unknownCount = 0;
  let providerKnownUsd = 0;
  let providerKnownCount = 0;
  let providerUnknownCount = 0;
  const evidence = [];
  for (const output of outputs) {
    const reported = output.usage?.costUsd;
    const actual = output.metering?.actual?.costUsd;
    const value =
      typeof reported === 'number'
        ? reported
        : typeof actual === 'number'
          ? actual
          : null;
    if (value === null) {
      unknownCount++;
      providerUnknownCount++;
      evidence.push({
        provider: output.provider,
        costUsd: null,
        source: 'unknown',
      });
    } else {
      knownUsd += value;
      knownCount++;
      providerKnownUsd += value;
      providerKnownCount++;
      evidence.push({
        provider: output.provider,
        costUsd: value,
        source:
          typeof reported === 'number'
            ? 'provider-reported'
            : output.metering.actual.source,
      });
    }
  }
  for (const [lane, value, confidence] of [
    [
      'synthesis',
      answer.synthesis?.costUsd,
      answer.synthesis?.costConfidence ?? 'unknown',
    ],
    ['judge', judge.costUsd, judge.costConfidence ?? 'unknown'],
  ]) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      knownUsd += value;
      knownCount++;
      evidence.push({ lane, costUsd: value, source: confidence });
    } else {
      unknownCount++;
      evidence.push({ lane, costUsd: null, source: 'unknown' });
    }
  }
  return {
    knownUsd: round(knownUsd, 8),
    knownCount,
    unknownCount,
    fullyKnown: unknownCount === 0,
    comparableUsd: unknownCount === 0 ? round(knownUsd, 8) : null,
    providerKnownUsd: round(providerKnownUsd, 8),
    providerKnownCount,
    providerUnknownCount,
    providerFullyKnown: providerUnknownCount === 0,
    providerComparableUsd:
      providerUnknownCount === 0 ? round(providerKnownUsd, 8) : null,
    evidence,
  };
}

export function scoreCase({ question, target, run, answer, judge }) {
  const successful = run.providerOutputs.filter(
    (output) => output.status === 'success',
  );
  const retrievalText = successful.map((output) => output.content).join('\n\n');
  const citations = successful.flatMap((output) => output.citations);
  const retrievalFacts = factChecks(
    retrievalText,
    question.expected.requiredFacts,
  );
  const requiredSources = sourceChecks(
    citations,
    question.expected.requiredSources,
  );
  const retrievalCitationValidity = citationValidity(citations);
  const expectedAnswerFound = containsAlternative(retrievalText, [
    ...question.expected.answers,
    ...question.expected.aliases,
  ]);
  const successRate =
    run.providerOutputs.length === 0
      ? 0
      : successful.length / run.providerOutputs.length;
  const retrievalQuality = mean([
    expectedAnswerFound ? 1 : 0,
    mean(retrievalFacts.map((fact) => (fact.matched ? 1 : 0))),
    mean(requiredSources.map((source) => (source.matched ? 1 : 0))),
    retrievalCitationValidity.score,
    successRate,
  ]);

  const answerFacts = factChecks(
    answer.content,
    question.expected.requiredFacts,
  );
  const expectedAnswerMatch = containsAlternative(answer.content, [
    ...question.expected.answers,
    ...question.expected.aliases,
  ]);
  const answerCitations = answerCitationValidity(
    answer.content,
    run.sources.length,
  );
  const deterministicAnswerQuality = mean([
    expectedAnswerMatch ? 1 : 0,
    mean(answerFacts.map((fact) => (fact.matched ? 1 : 0))),
    answerCitations.score,
  ]);
  const semanticQuality = mean([
    judge.judgment.correctness,
    judge.judgment.completeness,
    judge.judgment.evidenceSupport,
  ]);
  const answerQuality = mean([deterministicAnswerQuality, semanticQuality]);
  const latencyMs =
    successful.length === 0
      ? 0
      : Math.max(...successful.map((output) => output.durationMs ?? 0));
  const cost = costMetrics(run.providerOutputs, answer, judge);
  const costWithinBudget =
    cost.comparableUsd === null
      ? null
      : cost.comparableUsd <= question.budgets.maxCostUsd;

  return {
    schemaVersion: 1,
    questionId: question.id,
    target: {
      id: target.id,
      type: target.type,
      tier: target.tier,
      members: target.members,
    },
    retrieval: {
      qualityScore: round(retrievalQuality),
      expectedAnswerFound,
      requiredFactRecall: round(
        mean(retrievalFacts.map((fact) => (fact.matched ? 1 : 0))),
      ),
      requiredSourceRecall: round(
        mean(requiredSources.map((source) => (source.matched ? 1 : 0))),
      ),
      citationValidity: round(retrievalCitationValidity.score),
      factChecks: retrievalFacts,
      sourceChecks: requiredSources,
    },
    answer: {
      qualityScore: round(answerQuality),
      deterministicScore: round(deterministicAnswerQuality),
      semanticScore: round(semanticQuality),
      expectedAnswerMatch,
      requiredFactCoverage: round(
        mean(answerFacts.map((fact) => (fact.matched ? 1 : 0))),
      ),
      citationValidity: round(answerCitations.score),
      factChecks: answerFacts,
      semantic: judge.judgment,
    },
    endToEndQuality: round(mean([retrievalQuality, answerQuality])),
    performance: {
      latencyMs,
      latencyWithinBudget: latencyMs <= question.budgets.maxLatencyMs,
      cost,
      costWithinBudget,
      failureCount: run.providerOutputs.length - successful.length,
      failureRate: round(1 - successRate),
    },
    evidence: {
      sourceCount: run.sources.length,
      citationCount: citations.length,
      judgePromptSha256: judge.promptSha256,
    },
  };
}
