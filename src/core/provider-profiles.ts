import type {
  Corpus,
  ExecutionProfile,
  ProfileTarget,
  ProviderIdentity,
} from '../contracts/domain/index.js';
import type { DeclarableWorkflowId } from './builtin-workflows.js';

/**
 * The audited v2 provider catalog: orthogonal semantic, retrieval, access,
 * target-selection, and execution facts for every built-in provider profile.
 *
 * These declarations describe what a profile *can* do. They never contain
 * resolved credentials, provider handles, runtime targets, grounding outcomes,
 * citation claims, usage, cost, verification, or result timestamps -- those are
 * result provenance (see `result-provenance.ts`) and only ever describe what
 * actually happened.
 *
 * `ProviderTier` deliberately does not appear here. It survives in `types.ts`
 * for v1 read-compatibility during migration only.
 */

/**
 * Optional capabilities. A feature may be advertised only when an implemented
 * public adapter proves it; unknown is always valid and always means omitted.
 */
export interface ProfileFeatures {
  readonly web_search?: 'always' | 'configurable_default_on';
  readonly json_schema_output?: true;
  readonly remote_cancellation?: true;
}

export interface ExecutableProfileDeclaration
  extends Omit<ExecutionProfile, 'identity' | 'extensions'> {
  readonly profile_id: string;
  readonly target: ProfileTarget;
  readonly selection_order: number;
  readonly status: 'implemented' | 'planned';
  readonly workflows: readonly DeclarableWorkflowId[];
  readonly features?: ProfileFeatures;
}

export interface ProviderCatalogEntry {
  readonly provider_id: string;
  readonly order: number;
  readonly aliases: readonly string[];
  readonly display: {
    readonly family: string;
    readonly name: string;
    readonly description: string;
    readonly best_for: string;
    readonly setup_url: string;
    readonly recommended?: true;
  };
  readonly credential: {
    readonly env_var: string;
    readonly required: boolean;
    readonly auto_enable: boolean;
  };
  readonly profiles: readonly ExecutableProfileDeclaration[];
}

const NOT_APPLICABLE_TARGET: ProfileTarget = {
  primary: { model_selection: 'not_applicable' },
};

/** A target Librarium selects and can name today. */
function fixedTarget(
  kind: 'model' | 'preset',
  targetId: string,
): ProfileTarget {
  return { primary: { model_selection: 'fixed', kind, target_id: targetId } };
}

/** A target the user may override; the declared id is today's default. */
function configurableTarget(
  kind: 'model' | 'agent' | 'preset',
  targetId: string,
): ProfileTarget {
  return {
    primary: { model_selection: 'configurable', kind, target_id: targetId },
  };
}

/**
 * The provider owns the target. `target_id` stays absent until the provider
 * reports one at runtime, and `kind` stays absent when even the kind is
 * unaudited. This is also the only honest shape for a planned, unbound profile:
 * inventing a `fixed`/`configurable` default would guess a runtime fact.
 */
function providerManagedTarget(
  kind?: 'model' | 'agent' | 'preset',
): ProfileTarget {
  return {
    primary: {
      model_selection: 'provider_managed',
      ...(kind !== undefined && { kind }),
    },
  };
}

/** A fixed provider preset may expose a separately selected underlying model. */
function fixedPresetWithUnderlyingModel(preset: string): ProfileTarget {
  return {
    primary: { model_selection: 'fixed', kind: 'preset', target_id: preset },
    underlying: { model_selection: 'provider_managed', kind: 'model' },
  };
}

interface ProfileInput {
  readonly profile_id: string;
  readonly selection_order: number;
  readonly target: ProfileTarget;
  readonly result_kind: ExecutionProfile['result_kind'];
  readonly grounding_policy?: ExecutionProfile['grounding_policy'];
  readonly observation_mode?: ExecutionProfile['observation_mode'];
  readonly corpora: readonly Corpus[];
  readonly retrieval_method: ExecutionProfile['retrieval_method'];
  readonly access_mode?: ExecutionProfile['access_mode'];
  readonly operator_id: string;
  readonly collector_id?: string;
  readonly surface_id?: string;
  readonly surface_context?: ExecutionProfile['surface_context'];
  readonly invocation?: ExecutionProfile['invocation'];
  readonly resumability?: ExecutionProfile['resumability'];
  readonly status?: 'implemented' | 'planned';
  readonly workflows?: readonly DeclarableWorkflowId[];
  readonly features?: ProfileFeatures;
}

function declare(input: ProfileInput): ExecutableProfileDeclaration {
  const invocation = input.invocation ?? 'inline';
  return {
    profile_id: input.profile_id,
    target: input.target,
    selection_order: input.selection_order,
    status: input.status ?? 'implemented',
    workflows: input.workflows ?? [],
    result_kind: input.result_kind,
    ...(input.grounding_policy !== undefined && {
      grounding_policy: input.grounding_policy,
    }),
    observation_mode: input.observation_mode ?? 'api_output',
    corpora: [...input.corpora],
    retrieval_method: input.retrieval_method,
    access_mode: input.access_mode ?? 'direct',
    operator_id: input.operator_id,
    ...(input.collector_id !== undefined && {
      collector_id: input.collector_id,
    }),
    ...(input.surface_id !== undefined && { surface_id: input.surface_id }),
    ...(input.surface_context !== undefined && {
      surface_context: input.surface_context,
    }),
    invocation,
    resumability:
      input.resumability ?? (invocation === 'inline' ? 'none' : 'durable'),
    ...(input.features !== undefined && { features: input.features }),
  };
}

/**
 * A consumer surface answer collected by SearchAPI. Context exists but is not
 * disclosed by the collector, so every unknown field stays `unknown` rather
 * than being asserted as anonymous or unpersonalized.
 */
function surfaceProfile(input: {
  readonly selection_order: number;
  readonly operator_id: string;
  readonly surface_id: string;
}): ExecutableProfileDeclaration {
  return declare({
    profile_id: 'surface',
    selection_order: input.selection_order,
    // The surface operator owns the answering target and Librarium never picks
    // one. The kind stays unaudited: the collector returns a rendered consumer
    // answer, not a statement about what produced it.
    target: providerManagedTarget(),
    result_kind: 'surface_observation',
    grounding_policy: 'optional',
    observation_mode: 'surface_snapshot',
    corpora: ['web'],
    retrieval_method: 'surface_collector',
    access_mode: 'collected',
    operator_id: input.operator_id,
    collector_id: 'searchapi',
    surface_id: input.surface_id,
    surface_context: {
      account_context: 'unknown',
      personalization: 'unknown',
    },
    workflows: ['visibility'],
  });
}

const SEARCHAPI_SETUP_URL = 'https://www.searchapi.io/';
const PERPLEXITY_SETUP_URL =
  'https://docs.perplexity.ai/docs/getting-started/quickstart';
const GEMINI_SETUP_URL = 'https://ai.google.dev/gemini-api/docs/api-key';
const OPENAI_SETUP_URL = 'https://platform.openai.com/api-keys';
const BRAVE_SETUP_URL = 'https://brave.com/search/api/';
const OPENROUTER_SETUP_URL = 'https://openrouter.ai/docs/quickstart';

export const BUILTIN_PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    provider_id: 'brave-search',
    order: 10,
    aliases: [],
    display: {
      family: 'Brave',
      name: 'Brave Web Search',
      description: 'Fast raw web search from Brave’s independent index.',
      best_for: 'Broad source discovery and a low-friction first provider.',
      setup_url: BRAVE_SETUP_URL,
      recommended: true,
    },
    credential: { env_var: 'BRAVE_API_KEY', required: true, auto_enable: true },
    profiles: [
      declare({
        profile_id: 'search',
        selection_order: 320,
        target: NOT_APPLICABLE_TARGET,
        result_kind: 'search_results',
        corpora: ['web'],
        retrieval_method: 'search_endpoint',
        operator_id: 'brave',
      }),
    ],
  },
  {
    provider_id: 'perplexity-sonar-pro',
    order: 20,
    aliases: [],
    display: {
      family: 'Perplexity',
      name: 'Perplexity Sonar Pro',
      description: 'Grounded AI answers with citations through the Agent API.',
      best_for: 'Quick synthesized answers with source attribution.',
      setup_url: PERPLEXITY_SETUP_URL,
      recommended: true,
    },
    credential: {
      env_var: 'PERPLEXITY_API_KEY',
      required: true,
      auto_enable: true,
    },
    profiles: [
      declare({
        profile_id: 'grounded',
        selection_order: 200,
        target: fixedTarget('preset', 'low'),
        result_kind: 'grounded_answer',
        grounding_policy: 'required',
        corpora: ['web'],
        retrieval_method: 'model_search_tool',
        operator_id: 'perplexity',
        workflows: ['visibility'],
        features: { web_search: 'always' },
      }),
    ],
  },
  {
    provider_id: 'exa',
    order: 30,
    aliases: [],
    display: {
      family: 'Exa',
      name: 'Exa Search',
      description: 'AI-oriented web search for finding relevant pages quickly.',
      best_for: 'Semantic source discovery and agentic web search.',
      setup_url: 'https://exa.ai/docs/reference/getting-started',
      recommended: true,
    },
    credential: { env_var: 'EXA_API_KEY', required: true, auto_enable: true },
    profiles: [
      declare({
        profile_id: 'search',
        selection_order: 300,
        target: NOT_APPLICABLE_TARGET,
        result_kind: 'search_results',
        corpora: ['web'],
        retrieval_method: 'search_endpoint',
        operator_id: 'exa',
        workflows: ['quick'],
      }),
      declare({
        profile_id: 'research',
        selection_order: 170,
        target: providerManagedTarget('agent'),
        result_kind: 'research_report',
        grounding_policy: 'required',
        corpora: ['web'],
        retrieval_method: 'research_agent',
        operator_id: 'exa',
        invocation: 'background',
        resumability: 'durable',
        workflows: ['deep'],
        features: {
          web_search: 'always',
          json_schema_output: true,
        },
      }),
    ],
  },
  {
    provider_id: 'tavily',
    order: 40,
    aliases: [],
    display: {
      family: 'Tavily',
      name: 'Tavily Search',
      description: 'Search and extraction APIs designed for AI agents.',
      best_for: 'Agent workflows that need focused search results.',
      setup_url: 'https://docs.tavily.com/documentation/quickstart',
      recommended: true,
    },
    credential: {
      env_var: 'TAVILY_API_KEY',
      required: true,
      auto_enable: true,
    },
    profiles: [
      declare({
        profile_id: 'search',
        selection_order: 370,
        target: NOT_APPLICABLE_TARGET,
        result_kind: 'search_results',
        corpora: ['web'],
        retrieval_method: 'search_endpoint',
        operator_id: 'tavily',
      }),
    ],
  },
  {
    provider_id: 'openai-research',
    order: 110,
    aliases: [],
    display: {
      family: 'OpenAI',
      name: 'OpenAI Research',
      description:
        'OpenAI background research for slower, more thorough reports.',
      best_for: 'Important questions where depth matters more than latency.',
      setup_url: OPENAI_SETUP_URL,
    },
    credential: {
      env_var: 'OPENAI_API_KEY',
      required: true,
      auto_enable: true,
    },
    profiles: [
      declare({
        profile_id: 'research',
        selection_order: 130,
        target: configurableTarget('model', 'gpt-5.6-sol'),
        result_kind: 'research_report',
        grounding_policy: 'required',
        corpora: ['web'],
        retrieval_method: 'research_agent',
        operator_id: 'openai',
        invocation: 'background',
        resumability: 'durable',
        workflows: ['deep'],
        features: { web_search: 'always' },
      }),
    ],
  },
  {
    provider_id: 'gemini-grounded',
    order: 120,
    aliases: [],
    display: {
      family: 'Gemini',
      name: 'Gemini Grounded Search',
      description: 'Gemini answers with Google-grounded search.',
      best_for: 'Fast grounded answers from the Gemini ecosystem.',
      setup_url: GEMINI_SETUP_URL,
    },
    credential: {
      env_var: 'GEMINI_API_KEY',
      required: true,
      auto_enable: true,
    },
    profiles: [
      declare({
        profile_id: 'grounded',
        selection_order: 220,
        target: configurableTarget('model', 'gemini-2.5-flash'),
        result_kind: 'grounded_answer',
        grounding_policy: 'required',
        corpora: ['web'],
        retrieval_method: 'model_search_tool',
        operator_id: 'google',
        workflows: ['quick', 'visibility'],
        features: { web_search: 'always' },
      }),
    ],
  },
  {
    provider_id: 'gemini-deep',
    order: 121,
    aliases: [],
    display: {
      family: 'Gemini',
      name: 'Gemini Deep Research',
      description: 'Gemini deep research for longer-running investigations.',
      best_for: 'Deeper Gemini-backed research.',
      setup_url: GEMINI_SETUP_URL,
    },
    credential: {
      env_var: 'GEMINI_API_KEY',
      required: true,
      auto_enable: true,
    },
    profiles: [
      declare({
        profile_id: 'research',
        selection_order: 140,
        // The adapter submits the selected identifier as the API `agent`, so
        // this is a configurable agent. The model behind that agent is a
        // Google-owned runtime fact and is deliberately not invented here.
        target: configurableTarget('agent', 'deep-research-preview-04-2026'),
        result_kind: 'research_report',
        grounding_policy: 'required',
        corpora: ['web'],
        retrieval_method: 'research_agent',
        operator_id: 'google',
        invocation: 'background',
        resumability: 'durable',
        workflows: ['deep'],
        features: { web_search: 'always' },
      }),
    ],
  },
  {
    provider_id: 'perplexity-sonar-deep',
    order: 130,
    aliases: [],
    display: {
      family: 'Perplexity',
      name: 'Perplexity Sonar Deep Research',
      description: 'Durable high-effort Perplexity Agent research.',
      best_for: 'Longer Perplexity research runs.',
      setup_url: PERPLEXITY_SETUP_URL,
    },
    credential: {
      env_var: 'PERPLEXITY_API_KEY',
      required: true,
      auto_enable: true,
    },
    profiles: [
      declare({
        profile_id: 'research',
        selection_order: 100,
        target: fixedTarget('preset', 'high'),
        result_kind: 'research_report',
        grounding_policy: 'required',
        corpora: ['web'],
        retrieval_method: 'research_agent',
        operator_id: 'perplexity',
        invocation: 'background',
        resumability: 'durable',
        workflows: ['deep'],
        features: { web_search: 'always' },
      }),
    ],
  },
  {
    provider_id: 'perplexity-deep-research',
    order: 131,
    aliases: [],
    display: {
      family: 'Perplexity',
      name: 'Perplexity Deep Research',
      description: 'Durable medium-effort Perplexity Agent research.',
      best_for: 'Deep Perplexity-backed reports.',
      setup_url: PERPLEXITY_SETUP_URL,
    },
    credential: {
      env_var: 'PERPLEXITY_API_KEY',
      required: true,
      auto_enable: true,
    },
    profiles: [
      declare({
        profile_id: 'research',
        selection_order: 110,
        target: fixedPresetWithUnderlyingModel('medium'),
        result_kind: 'research_report',
        grounding_policy: 'required',
        corpora: ['web'],
        retrieval_method: 'research_agent',
        operator_id: 'perplexity',
        invocation: 'background',
        resumability: 'durable',
        workflows: ['deep'],
        features: { web_search: 'always' },
      }),
    ],
  },
  {
    provider_id: 'perplexity-search',
    order: 133,
    aliases: [],
    display: {
      family: 'Perplexity',
      name: 'Perplexity Search',
      description: 'Perplexity search results without full AI synthesis.',
      best_for: 'Fast Perplexity source discovery.',
      setup_url: PERPLEXITY_SETUP_URL,
    },
    credential: {
      env_var: 'PERPLEXITY_API_KEY',
      required: true,
      auto_enable: true,
    },
    profiles: [
      declare({
        profile_id: 'search',
        selection_order: 310,
        target: NOT_APPLICABLE_TARGET,
        result_kind: 'search_results',
        corpora: ['web'],
        retrieval_method: 'search_endpoint',
        operator_id: 'perplexity',
      }),
    ],
  },
  {
    provider_id: 'brave-answers',
    order: 140,
    aliases: [],
    display: {
      family: 'Brave',
      name: 'Brave AI Answers',
      description: 'Brave AI answers with web grounding.',
      best_for: 'A Brave-backed synthesized answer layer.',
      setup_url: BRAVE_SETUP_URL,
    },
    credential: {
      env_var: 'BRAVE_ANSWERS_API_KEY',
      required: true,
      auto_enable: true,
    },
    profiles: [
      declare({
        profile_id: 'grounded',
        selection_order: 270,
        // A dedicated product endpoint: changing the target would change the
        // contract, so it is fixed rather than provider-managed.
        target: fixedTarget('model', 'brave'),
        result_kind: 'grounded_answer',
        grounding_policy: 'required',
        corpora: ['web'],
        retrieval_method: 'search_endpoint',
        operator_id: 'brave',
        workflows: ['quick'],
        features: { web_search: 'always' },
      }),
    ],
  },
  {
    provider_id: 'openrouter',
    order: 150,
    aliases: ['openrouter-online', 'openrouter-chat'],
    display: {
      family: 'OpenRouter',
      name: 'OpenRouter',
      description:
        'Online search and direct model answers through OpenRouter routing.',
      best_for: 'Using one OpenRouter account for brokered model access.',
      setup_url: OPENROUTER_SETUP_URL,
    },
    credential: {
      env_var: 'OPENROUTER_API_KEY',
      required: true,
      auto_enable: true,
    },
    profiles: [
      declare({
        profile_id: 'grounded',
        selection_order: 260,
        target: configurableTarget('model', 'openai/gpt-4o-mini'),
        result_kind: 'grounded_answer',
        grounding_policy: 'required',
        corpora: ['web'],
        retrieval_method: 'model_search_tool',
        access_mode: 'brokered',
        operator_id: 'openrouter',
        workflows: ['quick'],
        features: { web_search: 'always' },
      }),
      declare({
        profile_id: 'chat',
        selection_order: 530,
        target: configurableTarget('model', 'openai/gpt-5.6-terra'),
        result_kind: 'grounded_answer',
        grounding_policy: 'optional',
        corpora: ['web'],
        retrieval_method: 'model_search_tool',
        access_mode: 'brokered',
        operator_id: 'openrouter',
        features: { web_search: 'configurable_default_on' },
      }),
    ],
  },
  {
    provider_id: 'grok',
    order: 155,
    aliases: [],
    display: {
      family: 'xAI',
      name: 'Grok (xAI)',
      description: 'Grok Responses API answers grounded with xAI web search.',
      best_for: 'Comparing Grok’s cited web-grounded answer visibility.',
      setup_url: 'https://console.x.ai',
    },
    credential: { env_var: 'XAI_API_KEY', required: true, auto_enable: true },
    profiles: [
      declare({
        profile_id: 'web',
        selection_order: 230,
        target: configurableTarget('model', 'grok-4.6'),
        result_kind: 'grounded_answer',
        grounding_policy: 'required',
        corpora: ['web'],
        retrieval_method: 'model_search_tool',
        operator_id: 'xai',
        workflows: ['visibility'],
        features: { web_search: 'always' },
      }),
    ],
  },
  {
    provider_id: 'grok-x-only',
    order: 156,
    aliases: [],
    display: {
      family: 'xAI',
      name: 'Grok X Search',
      description: 'Grok answers grounded only in the X corpus.',
      best_for: 'Observing what the X corpus alone supports.',
      setup_url: 'https://console.x.ai',
    },
    credential: { env_var: 'XAI_API_KEY', required: true, auto_enable: false },
    profiles: [
      declare({
        profile_id: 'x',
        selection_order: 240,
        target: configurableTarget('model', 'grok-4.6'),
        result_kind: 'grounded_answer',
        grounding_policy: 'required',
        corpora: ['x'],
        retrieval_method: 'model_search_tool',
        operator_id: 'xai',
      }),
    ],
  },
  {
    provider_id: 'grok-combined',
    order: 157,
    aliases: [],
    display: {
      family: 'xAI',
      name: 'Grok Combined Search',
      description: 'One Grok execution grounded in both web and X corpora.',
      best_for: 'A single cited answer spanning web and X sources.',
      setup_url: 'https://console.x.ai',
    },
    credential: { env_var: 'XAI_API_KEY', required: true, auto_enable: false },
    profiles: [
      declare({
        profile_id: 'combined',
        selection_order: 250,
        target: configurableTarget('model', 'grok-4.6'),
        result_kind: 'grounded_answer',
        grounding_policy: 'required',
        // One attempt, one result, one metering record, two corpora. This is
        // never two independent observations.
        corpora: ['web', 'x'],
        retrieval_method: 'model_search_tool',
        operator_id: 'xai',
        features: { web_search: 'always' },
      }),
    ],
  },
  {
    provider_id: 'you-research',
    order: 160,
    aliases: [],
    display: {
      family: 'You.com',
      name: 'You.com Research',
      description: 'You.com research API for real-time web intelligence.',
      best_for: 'Cited research through You.com APIs.',
      setup_url: 'https://you.com/docs/administration/api-keys',
    },
    credential: {
      env_var: 'YOU_COM_API_KEY',
      required: true,
      auto_enable: true,
    },
    profiles: [
      declare({
        profile_id: 'grounded',
        selection_order: 280,
        target: providerManagedTarget(),
        result_kind: 'grounded_answer',
        grounding_policy: 'required',
        corpora: ['web'],
        retrieval_method: 'search_endpoint',
        operator_id: 'you-com',
        features: { web_search: 'always' },
      }),
      declare({
        profile_id: 'research',
        selection_order: 190,
        target: providerManagedTarget('agent'),
        result_kind: 'research_report',
        grounding_policy: 'required',
        corpora: ['web'],
        retrieval_method: 'research_agent',
        operator_id: 'you-com',
        invocation: 'background',
        resumability: 'durable',
        workflows: ['deep'],
        features: { web_search: 'always', json_schema_output: true },
      }),
    ],
  },
  {
    provider_id: 'you-answer',
    order: 165,
    aliases: [],
    display: {
      family: 'You.com',
      name: 'You.com Answer',
      description:
        'A single inline You.com Answer API observation with citations.',
      best_for:
        'Focused web-grounded answers where Answer and Research remain distinct.',
      setup_url: 'https://you.com/docs/guides/answer',
    },
    credential: {
      // Canonical application credential. The provider docs also show
      // YDC_API_KEY in examples, but an alias must not duplicate a secret.
      env_var: 'YOU_COM_API_KEY',
      required: true,
      auto_enable: false,
    },
    profiles: [
      declare({
        profile_id: 'grounded',
        selection_order: 285,
        target: providerManagedTarget(),
        result_kind: 'grounded_answer',
        grounding_policy: 'required',
        corpora: ['web'],
        retrieval_method: 'search_endpoint',
        operator_id: 'you-com',
        features: { web_search: 'always' },
      }),
    ],
  },
  {
    provider_id: 'kagi-fastgpt',
    order: 170,
    aliases: [],
    display: {
      family: 'Kagi',
      name: 'Kagi FastGPT',
      description: 'Kagi FastGPT answers backed by Kagi search.',
      best_for: 'Kagi users who want premium search-backed answers.',
      setup_url: 'https://help.kagi.com/kagi/api/fastgpt.html',
    },
    credential: { env_var: 'KAGI_API_KEY', required: true, auto_enable: true },
    profiles: [
      declare({
        profile_id: 'grounded',
        selection_order: 290,
        // FastGPT is a dedicated Kagi product endpoint, not a model choice.
        target: fixedTarget('preset', 'fastgpt'),
        result_kind: 'grounded_answer',
        grounding_policy: 'required',
        corpora: ['web'],
        retrieval_method: 'search_endpoint',
        operator_id: 'kagi',
        workflows: ['quick'],
        features: { web_search: 'always' },
      }),
    ],
  },
  {
    provider_id: 'jina-search',
    order: 180,
    aliases: [],
    display: {
      family: 'Jina AI',
      name: 'Jina AI Search',
      description: 'Jina Search Foundation APIs for search-oriented retrieval.',
      best_for: 'Search and reader workflows in the Jina ecosystem.',
      setup_url: 'https://jina.ai/reader/',
    },
    credential: {
      env_var: 'JINA_AI_API_KEY',
      required: true,
      auto_enable: true,
    },
    profiles: [
      declare({
        profile_id: 'search',
        selection_order: 330,
        target: NOT_APPLICABLE_TARGET,
        result_kind: 'search_results',
        corpora: ['web'],
        retrieval_method: 'search_endpoint',
        operator_id: 'jina',
      }),
    ],
  },
  {
    provider_id: 'firecrawl-search',
    order: 190,
    aliases: [],
    display: {
      family: 'Firecrawl',
      name: 'Firecrawl Search',
      description: 'Firecrawl search for web search and extraction workflows.',
      best_for: 'Search plus downstream scraping/extraction workflows.',
      setup_url: 'https://docs.firecrawl.dev/api-reference/v2-introduction',
    },
    credential: {
      env_var: 'FIRECRAWL_API_KEY',
      required: true,
      auto_enable: true,
    },
    profiles: [
      declare({
        profile_id: 'search',
        selection_order: 340,
        target: NOT_APPLICABLE_TARGET,
        result_kind: 'search_results',
        // The news corpus is opt-in through the `sources` option; the binding
        // widens corpora only when the configuration proves it.
        corpora: ['web'],
        retrieval_method: 'search_endpoint',
        operator_id: 'firecrawl',
      }),
    ],
  },
  {
    provider_id: 'searchapi',
    order: 200,
    aliases: [],
    display: {
      family: 'SearchAPI',
      name: 'SearchAPI',
      description: 'SERP scraping API for structured search results.',
      best_for: 'Google-style SERP data and structured search output.',
      setup_url: SEARCHAPI_SETUP_URL,
    },
    credential: {
      env_var: 'SEARCHAPI_API_KEY',
      required: true,
      auto_enable: true,
    },
    profiles: [
      declare({
        profile_id: 'search',
        selection_order: 350,
        target: NOT_APPLICABLE_TARGET,
        result_kind: 'search_results',
        corpora: ['web'],
        retrieval_method: 'search_endpoint',
        // Google operates the index; SearchAPI brokers structured access to it.
        access_mode: 'brokered',
        operator_id: 'google',
      }),
    ],
  },
  {
    provider_id: 'searchapi-chatgpt',
    order: 201,
    aliases: [],
    display: {
      family: 'SearchAPI',
      name: 'SearchAPI ChatGPT',
      description:
        'SearchAPI-observed ChatGPT consumer answer with web search.',
      best_for: 'Comparing the cited answer visible on the ChatGPT surface.',
      setup_url: SEARCHAPI_SETUP_URL,
    },
    credential: {
      env_var: 'SEARCHAPI_API_KEY',
      required: true,
      auto_enable: false,
    },
    profiles: [
      surfaceProfile({
        selection_order: 400,
        operator_id: 'openai',
        surface_id: 'chatgpt',
      }),
    ],
  },
  {
    provider_id: 'searchapi-gemini',
    order: 202,
    aliases: [],
    display: {
      family: 'SearchAPI',
      name: 'SearchAPI Gemini',
      description: 'SearchAPI-observed Gemini consumer answer.',
      best_for: 'Comparing the cited answer visible on the Gemini surface.',
      setup_url: SEARCHAPI_SETUP_URL,
    },
    credential: {
      env_var: 'SEARCHAPI_API_KEY',
      required: true,
      auto_enable: false,
    },
    profiles: [
      surfaceProfile({
        selection_order: 410,
        operator_id: 'google',
        surface_id: 'gemini',
      }),
    ],
  },
  {
    provider_id: 'searchapi-perplexity',
    order: 203,
    aliases: [],
    display: {
      family: 'SearchAPI',
      name: 'SearchAPI Perplexity',
      description: 'SearchAPI-observed Perplexity consumer answer.',
      best_for: 'Comparing the cited answer visible on the Perplexity surface.',
      setup_url: SEARCHAPI_SETUP_URL,
    },
    credential: {
      env_var: 'SEARCHAPI_API_KEY',
      required: true,
      auto_enable: false,
    },
    profiles: [
      surfaceProfile({
        selection_order: 420,
        operator_id: 'perplexity',
        surface_id: 'perplexity',
      }),
    ],
  },
  {
    provider_id: 'searchapi-google-ai-mode',
    order: 204,
    aliases: [],
    display: {
      family: 'SearchAPI',
      name: 'SearchAPI Google AI Mode',
      description: 'SearchAPI-observed Google AI Mode consumer answer.',
      best_for: 'Comparing Google AI Mode answer visibility and citations.',
      setup_url: SEARCHAPI_SETUP_URL,
    },
    credential: {
      env_var: 'SEARCHAPI_API_KEY',
      required: true,
      auto_enable: false,
    },
    profiles: [
      surfaceProfile({
        selection_order: 430,
        operator_id: 'google',
        surface_id: 'google_ai_mode',
      }),
    ],
  },
  {
    provider_id: 'searchapi-bing-copilot',
    order: 205,
    aliases: [],
    display: {
      family: 'SearchAPI',
      name: 'SearchAPI Bing Copilot',
      description: 'SearchAPI-observed Bing Copilot consumer answer.',
      best_for: 'Comparing Bing Copilot answer visibility and citations.',
      setup_url: SEARCHAPI_SETUP_URL,
    },
    credential: {
      env_var: 'SEARCHAPI_API_KEY',
      required: true,
      auto_enable: false,
    },
    profiles: [
      surfaceProfile({
        selection_order: 440,
        operator_id: 'microsoft',
        surface_id: 'bing_copilot',
      }),
    ],
  },
  {
    provider_id: 'searchapi-google-ai-overview',
    order: 206,
    aliases: [],
    display: {
      family: 'SearchAPI',
      name: 'SearchAPI Google AI Overview',
      description:
        'Dedicated two-stage SearchAPI-observed Google AI Overview answer.',
      best_for: 'Comparing the dedicated Google AI Overview and its citations.',
      setup_url: SEARCHAPI_SETUP_URL,
    },
    credential: {
      env_var: 'SEARCHAPI_API_KEY',
      required: true,
      auto_enable: false,
    },
    profiles: [
      surfaceProfile({
        selection_order: 450,
        operator_id: 'google',
        surface_id: 'google_ai_overview',
      }),
    ],
  },
  {
    provider_id: 'serpapi',
    order: 210,
    aliases: [],
    display: {
      family: 'SerpApi',
      name: 'SerpAPI',
      description: 'Real-time SERP API with structured search results.',
      best_for: 'Search-engine result pages with rich structured data.',
      setup_url: 'https://serpapi.com/users/sign_up',
    },
    credential: {
      env_var: 'SERPAPI_API_KEY',
      required: true,
      auto_enable: true,
    },
    profiles: [
      declare({
        profile_id: 'search',
        selection_order: 360,
        target: NOT_APPLICABLE_TARGET,
        result_kind: 'search_results',
        corpora: ['web'],
        retrieval_method: 'search_endpoint',
        access_mode: 'brokered',
        operator_id: 'google',
      }),
    ],
  },
  {
    provider_id: 'claude',
    order: 500,
    aliases: [],
    display: {
      family: 'Anthropic',
      name: 'Claude',
      description: 'Claude model answer with optional web search citations.',
      best_for: 'Direct Claude answers; web search is on by default.',
      setup_url: 'https://platform.claude.com/docs',
    },
    credential: {
      env_var: 'ANTHROPIC_API_KEY',
      required: true,
      auto_enable: false,
    },
    profiles: [
      declare({
        profile_id: 'chat',
        selection_order: 500,
        target: configurableTarget('model', 'claude-sonnet-5'),
        result_kind: 'grounded_answer',
        grounding_policy: 'optional',
        corpora: ['web'],
        retrieval_method: 'model_search_tool',
        operator_id: 'anthropic',
        features: { web_search: 'configurable_default_on' },
      }),
    ],
  },
  {
    provider_id: 'openai-chat',
    order: 510,
    aliases: [],
    display: {
      family: 'OpenAI',
      name: 'OpenAI Chat',
      description: 'OpenAI model answer with optional web search citations.',
      best_for: 'Direct OpenAI answers; web search is on by default.',
      setup_url: OPENAI_SETUP_URL,
    },
    credential: {
      env_var: 'OPENAI_API_KEY',
      required: true,
      auto_enable: false,
    },
    profiles: [
      declare({
        profile_id: 'chat',
        selection_order: 510,
        target: configurableTarget('model', 'gpt-5-mini'),
        result_kind: 'grounded_answer',
        grounding_policy: 'optional',
        corpora: ['web'],
        retrieval_method: 'model_search_tool',
        operator_id: 'openai',
        features: { web_search: 'configurable_default_on' },
      }),
    ],
  },
  {
    provider_id: 'gemini-chat',
    order: 520,
    aliases: [],
    display: {
      family: 'Gemini',
      name: 'Gemini Chat',
      description: 'Gemini model answer with optional Google Search grounding.',
      best_for: 'Direct Gemini answers; web search is on by default.',
      setup_url: GEMINI_SETUP_URL,
    },
    credential: {
      env_var: 'GEMINI_API_KEY',
      required: true,
      auto_enable: false,
    },
    profiles: [
      declare({
        profile_id: 'chat',
        selection_order: 520,
        target: configurableTarget('model', 'gemini-3.6-flash'),
        result_kind: 'grounded_answer',
        grounding_policy: 'optional',
        corpora: ['web'],
        retrieval_method: 'model_search_tool',
        operator_id: 'google',
        features: { web_search: 'configurable_default_on' },
      }),
    ],
  },
  {
    provider_id: 'parallel',
    order: 600,
    aliases: [],
    display: {
      family: 'Parallel',
      name: 'Parallel',
      description:
        'Parallel search, turbo, chat, and research APIs for agents.',
      best_for: 'First-party Parallel retrieval and task execution.',
      setup_url: 'https://docs.parallel.ai/',
    },
    credential: {
      env_var: 'PARALLEL_API_KEY',
      required: true,
      auto_enable: false,
    },
    profiles: [
      declare({
        profile_id: 'search',
        selection_order: 380,
        target: NOT_APPLICABLE_TARGET,
        result_kind: 'search_results',
        corpora: ['web'],
        retrieval_method: 'search_endpoint',
        operator_id: 'parallel',
        status: 'implemented',
      }),
      declare({
        profile_id: 'turbo',
        selection_order: 375,
        target: NOT_APPLICABLE_TARGET,
        result_kind: 'search_results',
        corpora: ['web'],
        retrieval_method: 'search_endpoint',
        operator_id: 'parallel',
        status: 'implemented',
        workflows: ['quick'],
      }),
      declare({
        profile_id: 'chat',
        selection_order: 540,
        target: configurableTarget('model', 'base'),
        result_kind: 'grounded_answer',
        grounding_policy: 'optional',
        corpora: ['web'],
        retrieval_method: 'model_search_tool',
        operator_id: 'parallel',
        status: 'implemented',
        features: { json_schema_output: true, web_search: 'always' },
      }),
      declare({
        profile_id: 'research',
        selection_order: 150,
        target: configurableTarget('preset', 'pro'),
        result_kind: 'research_report',
        grounding_policy: 'required',
        corpora: ['web'],
        retrieval_method: 'research_agent',
        operator_id: 'parallel',
        invocation: 'background',
        resumability: 'durable',
        status: 'implemented',
        workflows: ['deep'],
      }),
    ],
  },
  {
    provider_id: 'valyu',
    order: 610,
    aliases: ['valyu-search', 'valyu-research'],
    display: {
      family: 'Valyu',
      name: 'Valyu',
      description: 'First-party search and durable research from Valyu.',
      best_for: 'Web and specialized-data discovery or cited research.',
      setup_url: 'https://platform.valyu.ai',
    },
    credential: {
      env_var: 'VALYU_API_KEY',
      required: true,
      auto_enable: true,
    },
    profiles: [
      declare({
        profile_id: 'search',
        selection_order: 390,
        target: NOT_APPLICABLE_TARGET,
        result_kind: 'search_results',
        // Specialized categories are citation/source metadata, never separate
        // providers and never a universal evidence lane.
        corpora: ['web', 'specialized'],
        retrieval_method: 'search_endpoint',
        operator_id: 'valyu',
      }),
      declare({
        profile_id: 'research',
        selection_order: 160,
        target: configurableTarget('preset', 'standard'),
        result_kind: 'research_report',
        grounding_policy: 'required',
        corpora: ['web', 'specialized'],
        retrieval_method: 'research_agent',
        operator_id: 'valyu',
        invocation: 'background',
        resumability: 'durable',
        workflows: ['deep'],
        features: { web_search: 'always', remote_cancellation: true },
      }),
    ],
  },
];

export interface CatalogProfileRef {
  readonly entry: ProviderCatalogEntry;
  readonly declaration: ExecutableProfileDeclaration;
}

/** `provider_id/profile_id`, the catalog's unique declaration key. */
export function catalogProfileKey(
  providerId: string,
  profileId: string,
): string {
  return `${providerId}/${profileId}`;
}

/**
 * Deterministic catalog order: `selection_order`, then `provider_id`, then
 * `profile_id`. Every dynamic roster and every projection uses exactly this.
 */
export function compareCatalogProfiles(
  left: CatalogProfileRef,
  right: CatalogProfileRef,
): number {
  return (
    left.declaration.selection_order - right.declaration.selection_order ||
    (left.entry.provider_id < right.entry.provider_id
      ? -1
      : left.entry.provider_id > right.entry.provider_id
        ? 1
        : 0) ||
    (left.declaration.profile_id < right.declaration.profile_id
      ? -1
      : left.declaration.profile_id > right.declaration.profile_id
        ? 1
        : 0)
  );
}

export function catalogProfileRefs(
  catalog: readonly ProviderCatalogEntry[] = BUILTIN_PROVIDER_CATALOG,
): CatalogProfileRef[] {
  return catalog
    .flatMap((entry) =>
      entry.profiles.map((declaration) => ({ entry, declaration })),
    )
    .sort(compareCatalogProfiles);
}

/** Build the contract `ExecutionProfile` a declaration advertises by default. */
export function declaredExecutionProfile(
  providerId: string,
  declaration: ExecutableProfileDeclaration,
): ExecutionProfile {
  const {
    profile_id,
    target,
    selection_order: _selectionOrder,
    status: _status,
    workflows: _workflows,
    features: _features,
    ...facts
  } = declaration;
  return {
    identity: { provider_id: providerId, profile_id, target },
    ...facts,
    corpora: [...facts.corpora],
  };
}

export function declaredProviderIdentity(
  providerId: string,
  declaration: ExecutableProfileDeclaration,
): ProviderIdentity {
  return {
    provider_id: providerId,
    profile_id: declaration.profile_id,
    target: declaration.target,
  };
}
