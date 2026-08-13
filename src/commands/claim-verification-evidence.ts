import type {
  ClaimSupport,
  ClaimSupportStatus,
  ProviderDispatchResult,
} from '../types.js';
import { untrusted } from './claim-verification-normalization.js';

interface RawAssessment {
  id?: unknown;
  status?: unknown;
  sourceUrls?: unknown;
  reason?: unknown;
}

export function evidencePrompt(
  claims: ClaimSupport[],
  evidence: Array<{ provider: string; text: string; sourceUrls: string[] }>,
): string {
  return `Assess each claim strictly against the independent source evidence below. Provider agreement is never evidence by itself. Mark a claim supported or conflicting ONLY when sourceUrls contains one or more URLs from the evidence; otherwise mark it insufficient. Return JSON only: {"assessments":[{"id":"claim-1","status":"supported|conflicting|insufficient","sourceUrls":["https://..."],"reason":"short evidence-based reason"}]}.

Claims:
${JSON.stringify(claims.map(({ id, claim, category }) => ({ id, claim, category })))}

Untrusted evidence:
<<<EVIDENCE>>>
${JSON.stringify(evidence.map((item) => ({ provider: item.provider, sourceUrls: item.sourceUrls, text: untrusted(item.text).slice(0, 6000) })))}
<<<END-EVIDENCE>>>`;
}

/** Map an LLM assessment back to known claim IDs and known source URLs. */
export function normalizeAssessment(
  claims: ClaimSupport[],
  raw: unknown,
  allowedUrls: Set<string>,
): ClaimSupport[] {
  const entries =
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as { assessments?: unknown }).assessments)
      ? (raw as { assessments: unknown[] }).assessments
      : [];
  const byId = new Map<string, RawAssessment>();
  for (const item of entries) {
    if (item && typeof item === 'object') {
      const assessment = item as RawAssessment;
      if (typeof assessment.id === 'string')
        byId.set(assessment.id, assessment);
    }
  }
  return claims.map((claim) => {
    const assessment = byId.get(claim.id);
    const status = assessment?.status;
    const validStatus: ClaimSupportStatus =
      status === 'supported' ||
      status === 'conflicting' ||
      status === 'insufficient'
        ? status
        : 'insufficient';
    const sourceUrls = Array.isArray(assessment?.sourceUrls)
      ? Array.from(
          new Set(
            assessment.sourceUrls.filter(
              (url): url is string =>
                typeof url === 'string' && allowedUrls.has(url),
            ),
          ),
        )
      : [];
    const verifiedStatus =
      validStatus === 'insufficient' || sourceUrls.length > 0
        ? validStatus
        : 'insufficient';
    return {
      ...claim,
      status: verifiedStatus,
      sourceUrls,
      ...(typeof assessment?.reason === 'string' && assessment.reason.trim()
        ? { reason: assessment.reason.trim() }
        : {}),
    };
  });
}

export function initialEvidence(
  results: ProviderDispatchResult[],
): Array<{ provider: string; text: string; sourceUrls: string[] }> {
  return results
    .filter((result) => result.status === 'success' && result.text.trim())
    .map((result) => ({
      provider: result.provider,
      text: result.text,
      sourceUrls: result.sourceUrls,
    }));
}
