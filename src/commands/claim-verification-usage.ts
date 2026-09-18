import type {
  VerificationFollowUp,
  VerificationLlmCall,
  VerificationMetadata,
  VerificationUsageSummary,
} from '../types.js';

interface UsageRecord {
  usage?: VerificationLlmCall['usage'];
  metering?: VerificationLlmCall['metering'];
}
function finiteUsageNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
export function usageSummary(records: UsageRecord[]): VerificationUsageSummary {
  const sum = (key: 'inputTokens' | 'outputTokens' | 'totalTokens') => {
    const values = records
      .map((record) => record.usage?.[key])
      .filter(finiteUsageNumber);
    return values.length > 0
      ? values.reduce((total, value) => total + value, 0)
      : undefined;
  };
  const reportedCostUsd = records.reduce(
    (total, record) =>
      total +
      (finiteUsageNumber(record.usage?.costUsd) ? record.usage.costUsd : 0),
    0,
  );
  const estimatedCostUsd = records.reduce(
    (total, record) =>
      total +
      (finiteUsageNumber(record.metering?.estimate?.estimatedCostUsd)
        ? record.metering.estimate.estimatedCostUsd
        : 0),
    0,
  );
  const inputTokens = sum('inputTokens');
  const outputTokens = sum('outputTokens');
  const totalTokens = sum('totalTokens');
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    tokenCountsAreLowerBound:
      records.length > 0 &&
      records.some(
        (record) =>
          !finiteUsageNumber(record.usage?.inputTokens) ||
          !finiteUsageNumber(record.usage?.outputTokens) ||
          !finiteUsageNumber(record.usage?.totalTokens),
      ),
    reportedCostUsd,
    reportedCostIsLowerBound:
      records.length > 0 &&
      records.some((record) => !finiteUsageNumber(record.usage?.costUsd)),
    estimatedCostUsd,
    estimatedCostIsLowerBound:
      records.length > 0 &&
      records.some(
        (record) =>
          !finiteUsageNumber(record.metering?.estimate?.estimatedCostUsd),
      ),
  };
}
export function verificationUsage(
  followUps: VerificationFollowUp[],
  llm: VerificationLlmCall[],
): VerificationMetadata['usage'] {
  const attempts = followUps.flatMap((followUp) => followUp.attempts);
  const providerRecords = attempts.filter(
    (attempt) => attempt.status !== 'skipped',
  );
  const llmRecords = llm.filter((call) => call.status !== undefined);
  const provider = usageSummary(providerRecords);
  const llmUsage = usageSummary(llmRecords);
  return {
    providerAttempts: providerRecords.length,
    successfulProviderAttempts: attempts.filter(
      (attempt) => attempt.status === 'success',
    ).length,
    reportedCostUsd: provider.reportedCostUsd + llmUsage.reportedCostUsd,
    reportedCostIsLowerBound:
      provider.reportedCostIsLowerBound || llmUsage.reportedCostIsLowerBound,
    estimatedCostUsd: provider.estimatedCostUsd + llmUsage.estimatedCostUsd,
    estimatedCostIsLowerBound:
      provider.estimatedCostIsLowerBound || llmUsage.estimatedCostIsLowerBound,
    llmCalls: llmRecords.length,
    successfulLlmCalls: llmRecords.filter((call) => call.status === 'success')
      .length,
    provider,
    llm: llmUsage,
  };
}
