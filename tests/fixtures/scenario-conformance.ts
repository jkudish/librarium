export interface ScenarioConformanceEvidence {
  readonly file: string;
  readonly assertion: string;
}

/**
 * Broad v2 behavior that must remain backed by a named executable test.
 * The inventory is intentionally small and points at the authoritative test
 * instead of copying each scenario into another suite.
 */
export const SCENARIO_CONFORMANCE_EVIDENCE: Readonly<
  Record<string, ScenarioConformanceEvidence>
> = {
  concurrent_fan_out: {
    file: 'tests/execution-runtime.test.ts',
    assertion:
      'fans out deterministic shared reserve replacements through the real runtime loop',
  },
  ordered_fallback: {
    file: 'tests/dispatcher-fallback.test.ts',
    assertion:
      'preserves an admitted compatible fallback after a primary failure',
  },
  source_deduplication: {
    file: 'tests/normalizer.test.ts',
    assertion: 'merges citations that only differ by UTM keys or fragment',
  },
  budget_cutoff: {
    file: 'tests/dispatcher-budget.test.ts',
    assertion: 'does not launch a fallback once the budget is exhausted',
  },
  durable_cancellation: {
    file: 'tests/node-canonical-run.test.ts',
    assertion:
      'attempts remote cancellation only for accepted pending/running work',
  },
  partial_terminal_response: {
    file: 'tests/node-canonical-run.test.ts',
    assertion:
      'derives partial and failed terminal shapes from exact slot outcomes',
  },
  collected_surface_provenance: {
    file: 'tests/result-provenance.test.ts',
    assertion: 'gives the six surfaces one shared collector correlation',
  },
  transport_consistency: {
    file: 'tests/run-artifact-cross-transport.test.ts',
    assertion:
      'keeps reconciliation and every presentation transport on one durable result',
  },
  unsafe_link_neutralization: {
    file: 'tests/html-report.test.ts',
    assertion:
      'escapes raw HTML and neutralizes unsafe links in the answer (untrusted)',
  },
  secret_redaction: {
    file: 'tests/node-canonical-run.test.ts',
    assertion:
      'atomically stores a safe result and immutable terminal projection',
  },
};
