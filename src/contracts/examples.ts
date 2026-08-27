import type { z } from 'zod/v4';
import type {
  HistoricalArtifactReaderSchema,
  RunManifestArtifactSchema,
} from './artifacts/index.js';
import type { ExecutionProfile, StructuredError } from './domain/index.js';
import type {
  AttemptSchema,
  InterchangeRequestSchema,
  InterchangeResponseSchema,
  InterchangeResultSchema,
  LifecycleTraceSchema,
} from './interchange/internal.js';

export const SNAPSHOT_GENERATED_AT = '2026-08-08T00:00:00Z';

export const groundedPrimaryProfile: ExecutionProfile = {
  identity: {
    provider_id: 'perplexity-sonar-pro',
    profile_id: 'grounded-web',
    target: {
      primary: {
        model_selection: 'fixed',
        kind: 'preset',
        target_id: 'low',
      },
    },
  },
  result_kind: 'grounded_answer',
  grounding_policy: 'required',
  observation_mode: 'api_output',
  corpora: ['web'],
  retrieval_method: 'model_search_tool',
  access_mode: 'direct',
  operator_id: 'perplexity',
  invocation: 'inline',
  resumability: 'none',
};

export const groundedFallbackProfile: ExecutionProfile = {
  identity: {
    provider_id: 'brave-answers',
    profile_id: 'grounded-web',
    target: {
      primary: {
        model_selection: 'fixed',
        kind: 'model',
        target_id: 'brave',
      },
    },
  },
  result_kind: 'grounded_answer',
  grounding_policy: 'required',
  observation_mode: 'api_output',
  corpora: ['web'],
  retrieval_method: 'search_endpoint',
  access_mode: 'direct',
  operator_id: 'brave',
  invocation: 'inline',
  resumability: 'none',
};

export const durableResearchProfile: ExecutionProfile = {
  identity: {
    provider_id: 'openai-research',
    profile_id: 'deep-web-news',
    target: {
      primary: {
        model_selection: 'configurable',
        kind: 'model',
        target_id: 'o4-deep-research',
      },
    },
  },
  result_kind: 'research_report',
  grounding_policy: 'required',
  observation_mode: 'api_output',
  corpora: ['web', 'news'],
  retrieval_method: 'research_agent',
  access_mode: 'direct',
  operator_id: 'openai',
  invocation: 'background',
  resumability: 'durable',
};

/**
 * A real preset-backed profile: Librarium fixes the Agent API preset while the
 * provider owns the underlying model until a supported model is configured.
 */
export const perplexityPresetResearchProfile: ExecutionProfile = {
  identity: {
    provider_id: 'perplexity-deep-research',
    profile_id: 'research',
    target: {
      primary: {
        model_selection: 'fixed',
        kind: 'preset',
        target_id: 'medium',
      },
      underlying: {
        model_selection: 'provider_managed',
        kind: 'model',
      },
    },
  },
  result_kind: 'research_report',
  grounding_policy: 'required',
  observation_mode: 'api_output',
  corpora: ['web'],
  retrieval_method: 'research_agent',
  access_mode: 'direct',
  operator_id: 'perplexity',
  invocation: 'background',
  resumability: 'process_local',
};

export const searchResultsProfile: ExecutionProfile = {
  identity: {
    provider_id: 'brave-search',
    profile_id: 'web-results',
    target: {
      primary: {
        model_selection: 'not_applicable',
      },
    },
  },
  result_kind: 'search_results',
  observation_mode: 'api_output',
  corpora: ['web'],
  retrieval_method: 'search_endpoint',
  access_mode: 'direct',
  operator_id: 'brave',
  invocation: 'inline',
  resumability: 'none',
};

export const surfaceObservationPrimaryProfile: ExecutionProfile = {
  identity: {
    provider_id: 'searchapi-google-ai-mode',
    profile_id: 'google-ai-mode-en-ca',
    target: {
      primary: {
        model_selection: 'provider_managed',
        kind: 'model',
      },
    },
  },
  result_kind: 'surface_observation',
  grounding_policy: 'optional',
  observation_mode: 'surface_snapshot',
  corpora: ['web'],
  retrieval_method: 'surface_collector',
  access_mode: 'collected',
  operator_id: 'google',
  collector_id: 'searchapi',
  surface_id: 'google_ai_mode',
  surface_context: {
    account_context: 'unknown',
    locale: 'en-CA',
    country: 'CA',
    personalization: 'unknown',
  },
  invocation: 'inline',
  resumability: 'none',
};

export const surfaceObservationFallbackProfile: ExecutionProfile = {
  identity: {
    provider_id: 'serpapi-google-ai-mode',
    profile_id: 'google-ai-mode-en-ca',
    target: {
      primary: {
        model_selection: 'provider_managed',
        kind: 'model',
      },
    },
  },
  result_kind: 'surface_observation',
  grounding_policy: 'optional',
  observation_mode: 'surface_snapshot',
  corpora: ['web'],
  retrieval_method: 'surface_collector',
  access_mode: 'collected',
  operator_id: 'google',
  collector_id: 'serpapi',
  surface_id: 'google_ai_mode',
  surface_context: {
    account_context: 'unknown',
    locale: 'en-CA',
    country: 'CA',
    personalization: 'unknown',
  },
  invocation: 'inline',
  resumability: 'none',
};

export const representativeRequest = {
  interchange_version: '1.0.0',
  message_type: 'request',
  request_id: 'req-contract-001',
  requested_at: '2026-08-08T00:00:00Z',
  mode: 'sync',
  query: 'What changed in the example market this week?',
  slots: [
    {
      slot_id: 'slot-grounded',
      position: 0,
      requirements: {
        result_kind: 'grounded_answer',
        grounding_policy: 'required',
        observation_mode: 'api_output',
        corpora: ['web'],
        retrieval_methods: ['model_search_tool', 'search_endpoint'],
      },
      primary: groundedPrimaryProfile,
    },
    {
      slot_id: 'slot-research',
      position: 1,
      requirements: {
        result_kind: 'research_report',
        grounding_policy: 'required',
        observation_mode: 'api_output',
        corpora: ['web', 'news'],
        retrieval_methods: ['research_agent'],
      },
      primary: durableResearchProfile,
    },
    {
      slot_id: 'slot-perplexity-preset',
      position: 2,
      requirements: {
        result_kind: 'research_report',
        grounding_policy: 'required',
        observation_mode: 'api_output',
        corpora: ['web'],
        retrieval_methods: ['research_agent'],
      },
      primary: perplexityPresetResearchProfile,
    },
  ],
  fallback_reserve: [
    {
      candidate_id: 'fallback-grounded-001',
      position: 0,
      profile: groundedFallbackProfile,
      eligible_slot_ids: ['slot-grounded'],
    },
  ],
  extensions: {
    'com.example:traceId': 'trace-public-001',
  },
} satisfies z.input<typeof InterchangeRequestSchema>;

export const representativeSearchRequest = {
  interchange_version: '1.0.0',
  message_type: 'request',
  request_id: 'req-search-results-001',
  requested_at: '2026-08-08T00:00:00Z',
  mode: 'sync',
  query: 'Find recent example market sources.',
  slots: [
    {
      slot_id: 'slot-search-results',
      position: 0,
      requirements: {
        result_kind: 'search_results',
        observation_mode: 'api_output',
        corpora: ['web'],
        retrieval_methods: ['search_endpoint'],
      },
      primary: searchResultsProfile,
    },
  ],
  fallback_reserve: [],
} satisfies z.input<typeof InterchangeRequestSchema>;

export const representativeSurfaceContextRequest = {
  interchange_version: '1.0.0',
  message_type: 'request',
  request_id: 'req-surface-context-001',
  requested_at: '2026-08-08T00:00:00Z',
  mode: 'sync',
  query: 'Observe the Google AI Mode consumer surface for this prompt.',
  slots: [
    {
      slot_id: 'slot-surface-observation',
      position: 0,
      requirements: {
        result_kind: 'surface_observation',
        grounding_policy: 'optional',
        observation_mode: 'surface_snapshot',
        corpora: ['web'],
        retrieval_methods: ['surface_collector'],
        surface_id: 'google_ai_mode',
        surface_context_constraint: {
          locale: 'en-CA',
        },
      },
      primary: surfaceObservationPrimaryProfile,
    },
  ],
  fallback_reserve: [
    {
      candidate_id: 'fallback-surface-observation-001',
      position: 0,
      profile: surfaceObservationFallbackProfile,
      eligible_slot_ids: ['slot-surface-observation'],
    },
  ],
} satisfies z.input<typeof InterchangeRequestSchema>;

const providerError: StructuredError = {
  code: 'provider_unavailable',
  message: 'The provider did not return a usable response.',
  category: 'provider',
  retryable: true,
  fallback_allowed: true,
  provider_code: 'upstream_unavailable',
};

const researchError: StructuredError = {
  code: 'research_timed_out',
  message: 'The research task exceeded the allowed completion window.',
  category: 'timeout',
  retryable: true,
  fallback_allowed: false,
};

const failedAttempt = {
  attempt_id: 'attempt-grounded-primary',
  slot_id: 'slot-grounded',
  attempt_number: 1,
  profile: groundedPrimaryProfile,
  started_at: '2026-08-08T00:00:01Z',
  attempt_status: 'failed',
  finished_at: '2026-08-08T00:00:02Z',
  error: providerError,
} as const;

const successfulFallbackAttempt = {
  attempt_id: 'attempt-grounded-fallback',
  slot_id: 'slot-grounded',
  attempt_number: 2,
  profile: groundedFallbackProfile,
  started_at: '2026-08-08T00:00:03Z',
  replaces_attempt_id: 'attempt-grounded-primary',
  candidate_id: 'fallback-grounded-001',
  attempt_status: 'succeeded',
  finished_at: '2026-08-08T00:00:05Z',
  result_id: 'result-grounded-fallback',
} as const;

const durableHandle = {
  handle_id: 'handle-research-001',
  provider_task_id: 'provider-task-public-001',
  provider: durableResearchProfile.identity,
  submitted_at: '2026-08-08T00:00:06Z',
  last_observed_at: '2026-08-08T00:00:10Z',
  status: 'failed',
} as const;

const failedResearchAttempt = {
  attempt_id: 'attempt-research-primary',
  slot_id: 'slot-research',
  attempt_number: 1,
  profile: durableResearchProfile,
  started_at: '2026-08-08T00:00:06Z',
  attempt_status: 'timed_out',
  finished_at: '2026-08-08T00:00:10Z',
  error: researchError,
  durable_handle: durableHandle,
  usage: {
    billable_units: [
      {
        unit: 'research_request',
        quantity_decimal: '1',
        source: 'provider_reported',
      },
    ],
    actual_cost: {
      amount: { amount_decimal: '0.250000', currency: 'USD' },
      source: 'provider_reported',
    },
    completeness: 'partial',
  },
} satisfies z.input<typeof AttemptSchema>;

const successfulResult = {
  result_id: 'result-grounded-fallback',
  slot_id: 'slot-grounded',
  attempt_id: 'attempt-grounded-fallback',
  content_format: 'markdown',
  content: 'The example market announced a revised weekly outlook. [Source 1]',
  semantic_facts: {
    result_kinds: ['grounded_answer'],
    grounding_outcome: 'used',
    observation_mode: 'api_output',
    corpora: ['web'],
    retrieval_methods: ['search_endpoint'],
    observed_at: '2026-08-08T00:00:05Z',
  },
  citations: [
    {
      citation_id: 'citation-001',
      source_kind: 'news_article',
      derivation: 'provider_reported',
      url: 'https://example.com/market/outlook',
      title: 'Example Market Outlook',
      retrieved_at: '2026-08-08T00:00:04Z',
      provenance: {
        provider: groundedFallbackProfile.identity,
        access_mode: 'direct',
        operator_id: 'brave',
        origin_key: 'origin-example-newsroom',
        correlation_keys: {
          'com.example:publisherGroup': 'example-newsroom',
        },
      },
    },
  ],
  provenance: {
    request_id: 'req-contract-001',
    slot_id: 'slot-grounded',
    attempt_id: 'attempt-grounded-fallback',
    requested_profile: groundedPrimaryProfile,
    effective_profile: groundedFallbackProfile,
    collection: {
      provider: groundedFallbackProfile.identity,
      access_mode: 'direct',
      operator_id: 'brave',
      origin_key: 'origin-brave-api',
      correlation_keys: {
        'com.brave:requestId': 'brave-request-public-001',
      },
    },
    replaced_attempt_id: 'attempt-grounded-primary',
  },
  usage: {
    input_tokens: 42,
    output_tokens: 81,
    total_tokens: 123,
    billable_units: [
      {
        unit: 'request',
        quantity_decimal: '1',
        source: 'provider_reported',
      },
    ],
    actual_cost: {
      amount: { amount_decimal: '0.010000', currency: 'USD' },
      source: 'provider_reported',
    },
    estimated_cost: {
      amount: { amount_decimal: '0.009500', currency: 'USD' },
      source: 'pricing_snapshot',
      pricing_version: '2026.8.0',
    },
    completeness: 'complete',
  },
  completed_at: '2026-08-08T00:00:05Z',
} satisfies z.input<typeof InterchangeResultSchema>;

export const representativePartialResponse = {
  interchange_version: '1.0.0',
  message_type: 'response',
  request_id: 'req-contract-001',
  response_status: 'partial',
  emitted_at: '2026-08-08T00:00:11Z',
  slots: [
    {
      slot_id: 'slot-grounded',
      slot_status: 'succeeded',
      selected_attempt_id: 'attempt-grounded-fallback',
      result_id: 'result-grounded-fallback',
    },
    {
      slot_id: 'slot-research',
      slot_status: 'failed',
      selected_attempt_id: 'attempt-research-primary',
      error: researchError,
    },
  ],
  attempts: [failedAttempt, successfulFallbackAttempt, failedResearchAttempt],
  results: [successfulResult],
  errors: [researchError],
} satisfies z.input<typeof InterchangeResponseSchema>;

export const representativeUnsuccessfulResponse = {
  interchange_version: '1.0.0',
  message_type: 'response',
  request_id: 'req-contract-001',
  response_status: 'unsuccessful',
  emitted_at: '2026-08-08T00:00:11Z',
  slots: [
    {
      slot_id: 'slot-grounded',
      slot_status: 'failed',
      selected_attempt_id: 'attempt-grounded-primary',
      error: providerError,
    },
    {
      slot_id: 'slot-research',
      slot_status: 'cancelled',
      selected_attempt_id: 'attempt-research-cancelled',
      error: researchError,
    },
  ],
  attempts: [
    failedAttempt,
    {
      attempt_id: 'attempt-research-cancelled',
      slot_id: 'slot-research',
      attempt_number: 1,
      profile: durableResearchProfile,
      started_at: '2026-08-08T00:00:06Z',
      attempt_status: 'cancelled',
      finished_at: '2026-08-08T00:00:10Z',
      error: researchError,
    },
  ],
  results: [],
  errors: [providerError, researchError],
} satisfies z.input<typeof InterchangeResponseSchema>;

export const representativeLifecycleTrace = [
  {
    interchange_version: '1.0.0',
    message_type: 'lifecycle_event',
    event_id: 'event-001',
    request_id: 'req-contract-001',
    sequence: 0,
    occurred_at: '2026-08-08T00:00:00Z',
    event_kind: 'request_started',
    data: { mode: 'sync' },
  },
  {
    interchange_version: '1.0.0',
    message_type: 'lifecycle_event',
    event_id: 'event-002',
    request_id: 'req-contract-001',
    sequence: 1,
    occurred_at: '2026-08-08T00:00:01Z',
    slot_id: 'slot-grounded',
    attempt_id: 'attempt-grounded-primary',
    event_kind: 'attempt_started',
    data: { provider: groundedPrimaryProfile.identity, attempt_number: 1 },
  },
  {
    interchange_version: '1.0.0',
    message_type: 'lifecycle_event',
    event_id: 'event-003',
    request_id: 'req-contract-001',
    sequence: 2,
    occurred_at: '2026-08-08T00:00:02Z',
    slot_id: 'slot-grounded',
    attempt_id: 'attempt-grounded-primary',
    event_kind: 'attempt_finished',
    data: { outcome: 'failed', error: providerError },
  },
  {
    interchange_version: '1.0.0',
    message_type: 'lifecycle_event',
    event_id: 'event-004',
    request_id: 'req-contract-001',
    sequence: 3,
    occurred_at: '2026-08-08T00:00:03Z',
    slot_id: 'slot-grounded',
    attempt_id: 'attempt-grounded-fallback',
    event_kind: 'fallback_selected',
    data: {
      failed_attempt_id: 'attempt-grounded-primary',
      replacement_attempt_id: 'attempt-grounded-fallback',
      candidate_id: 'fallback-grounded-001',
    },
  },
  {
    interchange_version: '1.0.0',
    message_type: 'lifecycle_event',
    event_id: 'event-005',
    request_id: 'req-contract-001',
    sequence: 4,
    occurred_at: '2026-08-08T00:00:03Z',
    slot_id: 'slot-grounded',
    attempt_id: 'attempt-grounded-fallback',
    event_kind: 'attempt_started',
    data: { provider: groundedFallbackProfile.identity, attempt_number: 2 },
  },
  {
    interchange_version: '1.0.0',
    message_type: 'lifecycle_event',
    event_id: 'event-006',
    request_id: 'req-contract-001',
    sequence: 5,
    occurred_at: '2026-08-08T00:00:05Z',
    slot_id: 'slot-grounded',
    attempt_id: 'attempt-grounded-fallback',
    event_kind: 'attempt_finished',
    data: { outcome: 'succeeded' },
  },
  {
    interchange_version: '1.0.0',
    message_type: 'lifecycle_event',
    event_id: 'event-007',
    request_id: 'req-contract-001',
    sequence: 6,
    occurred_at: '2026-08-08T00:00:06Z',
    slot_id: 'slot-research',
    attempt_id: 'attempt-research-primary',
    event_kind: 'attempt_started',
    data: { provider: durableResearchProfile.identity, attempt_number: 1 },
  },
  {
    interchange_version: '1.0.0',
    message_type: 'lifecycle_event',
    event_id: 'event-008',
    request_id: 'req-contract-001',
    sequence: 7,
    occurred_at: '2026-08-08T00:00:06Z',
    slot_id: 'slot-research',
    attempt_id: 'attempt-research-primary',
    event_kind: 'durable_task_submitted',
    data: { handle: durableHandle },
  },
  {
    interchange_version: '1.0.0',
    message_type: 'lifecycle_event',
    event_id: 'event-009',
    request_id: 'req-contract-001',
    sequence: 8,
    occurred_at: '2026-08-08T00:00:07Z',
    slot_id: 'slot-research',
    attempt_id: 'attempt-research-primary',
    event_kind: 'attempt_progress',
    data: { progress_percent: 40, message: 'Research task is processing.' },
  },
  {
    interchange_version: '1.0.0',
    message_type: 'lifecycle_event',
    event_id: 'event-010',
    request_id: 'req-contract-001',
    sequence: 9,
    occurred_at: '2026-08-08T00:00:10Z',
    slot_id: 'slot-research',
    attempt_id: 'attempt-research-primary',
    event_kind: 'attempt_finished',
    data: { outcome: 'timed_out', error: researchError },
  },
  {
    interchange_version: '1.0.0',
    message_type: 'lifecycle_event',
    event_id: 'event-011',
    request_id: 'req-contract-001',
    sequence: 10,
    occurred_at: '2026-08-08T00:00:11Z',
    event_kind: 'request_completed',
    data: { outcome: 'partial' },
  },
] satisfies z.input<typeof LifecycleTraceSchema>;

export const representativeRunManifest = {
  artifact_name: 'run_manifest',
  artifact_version: '1.0.0',
  generated_at: '2026-08-08T00:00:11Z',
  producer: {
    id: 'librarium',
    version: '1.4.1',
  },
  request: representativeRequest,
  response: representativePartialResponse,
} satisfies z.input<typeof RunManifestArtifactSchema>;

export const representativeArtifactReader = {
  artifact_name: 'run_manifest',
  current_version: '1.0.0',
  readable_versions: ['1.0.0'],
  unknown_version_policy: 'reject',
  migration_policy: 'lossless_explicit',
} satisfies z.input<typeof HistoricalArtifactReaderSchema>;
