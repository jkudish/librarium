<p align="center">
  <img src="art/gh-og.png" alt="Librarium" width="100%" />
</p>

<h1 align="center">librarium</h1>

<p align="center"><strong>The meta harness for research queries.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/librarium"><img src="https://img.shields.io/npm/v/librarium?color=cb3837&label=npm" alt="npm version" /></a>
  <a href="https://github.com/jkudish/librarium/actions/workflows/ci.yml"><img src="https://github.com/jkudish/librarium/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://github.com/jkudish/librarium/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/librarium?color=blue" alt="License: MIT" /></a>
  <img src="https://img.shields.io/node/v/librarium?color=5fa04e" alt="Node >= 22.12" />
</p>

<p align="center">
  <a href="https://librarium.agentsy.build"><strong>Website</strong></a> &nbsp;·&nbsp;
  <a href="#quick-start">Quick start</a> &nbsp;·&nbsp;
  <a href="#commands">Commands</a> &nbsp;·&nbsp;
  <a href="#library-usage">Library</a> &nbsp;·&nbsp;
  <a href="#using-with-ai-agents">Agents</a>
</p>

<p align="center">
  <img src="art/demo.gif" alt="librarium fanning out a query to multiple providers, resolving the live table, and printing the deduped summary" width="100%" />
</p>

## What it is

Ask once. Librarium fans your query out to search engines, AI-grounded answers, and deep-research APIs **in parallel**, then merges everything into one structured output -- deduplicating sources across providers and ranking them by how often they were cited.

Inspired by Aaron Francis' [counselors](https://github.com/aarondfrancis/counselors), librarium applies the same fan-out pattern to search. Where counselors fans out prompts to multiple LLM CLIs, librarium fans out research queries to search engines, AI-grounded search, and deep-research APIs -- collecting, normalizing, and deduplicating results into structured output.

Librarium is both a **CLI** and a set of **embeddable foundations**. The
side-effect-free `librarium` root validates canonical requests and terminal
results; `librarium/core` adds Worker-safe catalog, planning, transport, and
execution ports; `librarium/node` adds deliberate Node-only services. The v2
package boundary does not yet expose a high-level library runner -- use the
`librarium` executable for complete research runs. See
[Library Usage](#library-usage).

The full docs live at **[librarium.agentsy.build](https://librarium.agentsy.build)**.

## Quick Start

```bash
# Install from npm (requires Node.js >= 22.12)
npm install -g librarium

# Start guided setup if no providers are configured yet
librarium

# After setup, fan out a research query across providers
librarium run "PostgreSQL connection pooling best practices"

# Or get one grounded, cited answer synthesized from the results
librarium answer "what changed in postgres 17 logical replication"

# Opt in to bounded claim verification for material factual claims
librarium answer "what changed in postgres 17 logical replication" --verify
```

On first run, `librarium` opens a guided onboarding wizard: pick providers, choose where API keys should be stored, enter keys with masked prompts, and optionally run a first query. Once at least one usable provider is configured, bare `librarium` opens the research wizard instead. Output lands in a timestamped run directory you can read, browse, or feed to a pipeline. See the [full command reference](#commands) and [more install methods](#installation) below.

## Features

- **Live fan-out table** -- every provider resolves in place with timing, source counts, and reported cost. Slow ones get highlighted; failures fall back to a configured backup.
- **Grounded answers** -- [`librarium answer`](#answer) fans out, then synthesizes one cited answer from what actually came back. Every claim maps to a real source.
- **Reports for humans and machines** -- a tabbed [HTML report](#html) for reading, [`results.jsonl`](#jsonl) with full content for pipelines, and a [browsable run directory](#browse) for everything else.
- **Tier-tuned queries** -- [`--refine`](#refine) rewrites your query three ways with one LLM call: a brief for deep research, a question for AI answers, keywords for raw search.
- **Async deep research** -- submit long-running jobs and walk away. [`status --wait --retrieve`](#status) collects the reports when they land.
- **Built for agents** -- an [agent skill](#option-1-claude-code-skill-recommended), an [MCP server](#option-2-mcp-server), and [embeddable edge-safe foundations](#library-usage). Your agents fan out, browse, and cite without screen-scraping a terminal.

Plus provider groups, automatic fallbacks, and custom providers from npm or local scripts.

## Installation

### npm (requires Node.js >= 22.12)

```bash
npm install -g librarium
```

### pnpm

```bash
pnpm install -g librarium
```

### yarn

```bash
yarn global add librarium
```

### Homebrew (macOS / Linux)

```bash
brew install jkudish/tap/librarium
```

### Standalone binary

```bash
curl -fsSL https://raw.githubusercontent.com/jkudish/librarium/main/scripts/install.sh | sh
```

The standalone and Homebrew installations ship a self-contained executable with
its own Node runtime. They do not require Node.js to be installed on the host.

### npx (no install)

```bash
npx librarium run "your query"
```

The npm, pnpm, yarn, and npx methods, including `librarium/core` and
`librarium/node` library imports, require Node.js 22.12 or newer.

### Upgrade

```bash
librarium upgrade
```

Auto-detects your install method (npm, pnpm, yarn, Homebrew, standalone) and runs the correct upgrade command.

### More recipes

```bash
# Use a specific provider group
librarium run "React Server Components" --group quick

# Synthesize one cited answer instead of a raw run
librarium answer "what changed in postgres 17 logical replication"

# Check / wait on async deep research
librarium status --wait

# Run `librarium` with no arguments for an interactive wizard
librarium
```

## Providers

Librarium ships with 33 built-in provider adapters organized into four tiers:

The onboarding wizard starts with a short recommended starter list, but the full provider list is always available from setup. Recommendations are meant to get a first successful query quickly:

| Provider | Good for | API Key Env Var |
|---|---|---|
| Brave Web Search | Fast raw web results and broad source discovery | `BRAVE_API_KEY` |
| Perplexity Sonar Pro | Quick grounded AI answers with citations | `PERPLEXITY_API_KEY` |
| Exa Search | AI-oriented semantic web search | `EXA_API_KEY` |
| Tavily Search | Agent-focused search and extraction workflows | `TAVILY_API_KEY` |

Some provider families unlock multiple adapters with one key. For example, `PERPLEXITY_API_KEY` can power Perplexity search, grounded answers, and deep research adapters; onboarding explains that rather than making repeated provider rows look accidental.

| Provider | ID | Tier | API Key Env Var |
|---|---|---|---|
| Perplexity Sonar Deep Research | `perplexity-sonar-deep` | deep-research | `PERPLEXITY_API_KEY` |
| Perplexity Deep Research | `perplexity-deep-research` | deep-research | `PERPLEXITY_API_KEY` |
| Perplexity Advanced Deep Research | `perplexity-advanced-deep` | deep-research | `PERPLEXITY_API_KEY` |
| OpenAI Research (GPT-5.6 Sol) | `openai-research` | deep-research | `OPENAI_API_KEY` |
| Gemini Deep Research | `gemini-deep` | deep-research | `GEMINI_API_KEY` |
| Perplexity Sonar Pro | `perplexity-sonar-pro` | ai-grounded | `PERPLEXITY_API_KEY` |
| Perplexity Pro Search | `perplexity-pro-search` | ai-grounded | `PERPLEXITY_API_KEY` |
| Gemini Grounded Search | `gemini-grounded` | ai-grounded | `GEMINI_API_KEY` |
| Grok (xAI) | `grok` | ai-grounded | `XAI_API_KEY` |
| Grok X Search (xAI) | `grok-x-only` | ai-grounded | `XAI_API_KEY` |
| Grok Combined Search (xAI) | `grok-combined` | ai-grounded | `XAI_API_KEY` |
| ChatGPT Search (OpenRouter) | `openrouter-online` | ai-grounded | `OPENROUTER_API_KEY` |
| Brave AI Answers | `brave-answers` | ai-grounded | `BRAVE_API_KEY` |
| Exa Search | `exa` | ai-grounded | `EXA_API_KEY` |
| You.com Research | `you-research` | ai-grounded | `YOU_COM_API_KEY` |
| Kagi FastGPT | `kagi-fastgpt` | ai-grounded | `KAGI_API_KEY` |
| SearchAPI ChatGPT | `searchapi-chatgpt` | ai-grounded | `SEARCHAPI_API_KEY` |
| SearchAPI Gemini | `searchapi-gemini` | ai-grounded | `SEARCHAPI_API_KEY` |
| SearchAPI Perplexity | `searchapi-perplexity` | ai-grounded | `SEARCHAPI_API_KEY` |
| SearchAPI Google AI Mode | `searchapi-google-ai-mode` | ai-grounded | `SEARCHAPI_API_KEY` |
| SearchAPI Bing Copilot | `searchapi-bing-copilot` | ai-grounded | `SEARCHAPI_API_KEY` |
| SearchAPI Google AI Overview | `searchapi-google-ai-overview` | ai-grounded | `SEARCHAPI_API_KEY` |
| Perplexity Search | `perplexity-search` | raw-search | `PERPLEXITY_API_KEY` |
| Brave Web Search | `brave-search` | raw-search | `BRAVE_API_KEY` |
| Jina AI Search | `jina-search` | raw-search | `JINA_AI_API_KEY` |
| SearchAPI | `searchapi` | raw-search | `SEARCHAPI_API_KEY` |
| SerpAPI | `serpapi` | raw-search | `SERPAPI_API_KEY` |
| Tavily Search | `tavily` | raw-search | `TAVILY_API_KEY` |
| Firecrawl Search | `firecrawl-search` | raw-search | `FIRECRAWL_API_KEY` |
| Claude | `claude` | llm | `ANTHROPIC_API_KEY` |
| OpenAI Chat | `openai-chat` | llm | `OPENAI_API_KEY` |
| Gemini Chat | `gemini-chat` | llm | `GEMINI_API_KEY` |
| OpenRouter Chat | `openrouter-chat` | llm | `OPENROUTER_API_KEY` |

Brave AI Answers uses Brave's streaming Answers endpoint so its grounded answer text and inline citations can be normalized together.

ChatGPT Search (OpenRouter) keeps its GPT-4o Mini/Exa-backed search profile but
uses OpenRouter's current `openrouter:web_search` server tool rather than the
deprecated `:online` model suffix.

### SearchAPI consumer surfaces

The six `searchapi-*` answer adapters observe consumer-facing answers collected
by SearchAPI. They are not the official OpenAI, Google, Microsoft, or
Perplexity APIs, and they do not claim parity with a particular logged-in user,
location, subscription, experiment cohort, or moment in the consumer product.
Use the official `perplexity-sonar-pro`, `gemini-grounded`, and `grok` adapters
when first-party API provenance matters.

All six surfaces share SearchAPI as their upstream collection vendor. Separate
provider IDs preserve which surface produced each answer and citation, but
agreement between those results is correlated evidence, not six independent
confirmations. SearchAPI also owns upstream collection and retention; Librarium
can request `"options": { "zeroRetention": true }`, fails closed if that
capability is rejected, and never silently retries without it, but cannot make
a broader retention or compliance guarantee for SearchAPI.

Librarium sends SearchAPI credentials in an `Authorization: Bearer` header and
never places them in URLs. Bearer authentication is live-validated across all
seven SearchAPI request surfaces (the existing Google adapter plus the six
answer adapters); no query-parameter credential fallback is implemented.
Zero retention remains an account capability: Librarium sends it only when
explicitly configured and fails closed if the account rejects it.

The six new SearchAPI adapters are opt-in even when `SEARCHAPI_API_KEY` is
present: interactive setup lists them unselected and `init --auto` leaves them
disabled. Select a provider directly or explicitly choose `visibility`,
`comprehensive`, or `all`. Explicit group selection is consent to call every
configured, credentialed member of that group, including opt-in providers that
are disabled for bare/default runs.

`perplexity-pro-search` is the official Perplexity forced Pro Search lane. It
uses streaming Sonar Pro with Pro search required and performs no hidden retry
or downgraded second submission. Perplexity reports its actual cost only after a
successful response, so Librarium cannot reserve a pre-dispatch dollar estimate
for it. Sharing `PERPLEXITY_API_KEY` does not auto-enable this higher-cost lane.

### Provider ID Migration (Legacy Aliases)

These provider IDs were renamed as their upstream products changed:

- `perplexity-sonar` -> `perplexity-sonar-pro`
- `perplexity-deep` -> `perplexity-sonar-deep`
- `openai-deep` -> `openai-research`
- `openai-deep-o3` -> `openai-research`

These IDs are retired from current Librarium 2.0 selection. Use their
replacement IDs in CLI, MCP, and native v2 configuration. The v1 config
migrator still converts old IDs without rewriting the source file. If more
than one historical OpenAI key is present, it selects `openai-research` first,
then `openai-deep-o3`, then `openai-deep`, regardless of JSON key order.

Completed historical runs remain readable with their recorded provider IDs and
filenames. Pending historical handles for retired IDs cannot resume, poll, or
retrieve through a replacement provider.

You can also add **custom providers** (npm modules or local scripts) via config. See [Custom Providers](#custom-providers).

## Provider Tiers

Providers are categorized into four tiers based on their capabilities, latency, and depth. Their execution contract is separate: an `inline` provider finishes in `execute()`, while a `background` provider also provides complete `submit`/`poll`/`retrieve` lifecycle hooks.

- **deep-research** -- Async deep research providers that take minutes to complete but produce comprehensive, multi-source reports. These providers may use a submit/poll/retrieve pattern. Best for thorough research on important topics.

- **ai-grounded** -- AI-powered search with inline citations. Returns results in seconds with good quality and source attribution. A solid middle ground between speed and depth.

- **raw-search** -- Traditional search engine results. Fast responses with many links and snippets, but no AI synthesis. Useful for broad link discovery and verifying specific facts.

- **llm** -- Generic LLM answers from Claude, OpenAI, Gemini, or OpenRouter. They are provider-style model calls, not dedicated research/search APIs. Web search and citations are **on by default** for these adapters, and you can turn that off globally with `defaults.llmWebSearch: false` or per provider with `options.webSearch: false`. They stay **excluded from every grounded default group** (`quick`, `fast`, `raw`, `deep`, `visibility`, `comprehensive`, and `all`) so a normal grounded run does not silently add extra model calls. Opt in explicitly via `-p claude,openai-chat,...`, a custom group, or `--group llm`. Each provider takes a default model with a per-provider `model` config override.

### The LLM tier

The `llm` tier is deliberately kept apart from the grounded tiers. These adapters now use their provider's web-search feature by default where available:

- `claude` uses Anthropic's Messages API web search tool.
- `openai-chat` uses the OpenAI Responses API with the `web_search` tool.
- `gemini-chat` uses Gemini Google Search grounding.
- `openrouter-chat` uses OpenRouter's `openrouter:web_search` server tool.

Default models are `claude-sonnet-5`, `gpt-5-mini`, `gemini-3.6-flash`, and
`openai/gpt-5.6-terra`, respectively. Each accepts a per-provider `model`
override.

If you want old-style direct model answers with no web search, set `"llmWebSearch": false` under `defaults`, or set `"options": { "webSearch": false }` on a specific llm provider. When web search is off, llm providers contribute no citations or source URLs.

**Opt-in, never auto-enabled.** Several llm-tier providers share an API key with their grounded counterparts (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`; Claude uses `ANTHROPIC_API_KEY`). To keep a plain `librarium run` -- which dispatches every *enabled* provider -- from silently calling extra LLM APIs, `init` treats the llm tier specially:

- `librarium init --auto` **does not** enable llm-tier providers, even when their key is present. It prints them as found-but-opt-in with a hint to opt in.
- Interactive setup **lists** the llm-tier providers but does not select them for you, so you must choose them deliberately.

As a result they stay out of the default run unless you explicitly enable them in config. Reach for them on demand via `-p claude,openai-chat,...`, a custom group, or `--group llm` regardless of your init choices.

### Built-in provider descriptors

Each built-in provider is represented by one typed descriptor. It combines the
adapter factory with its tier, display/catalog metadata, credential environment
variable, metering declaration, option schema, aliases, default model, and a
discriminated inline/background capability contract. Registry initialization,
the onboarding catalog, provider names, credential lookup, aliases, and
metering are derived from that inventory. The v2 provider-profile catalog owns
workflow facts: `quick` and `visibility` use curated profile rosters, while
`deep` and `all` are derived from profile capabilities. Automatic validation
rejects missing bindings, invalid workflow declarations, and stale curated
memberships.

Library consumers can inspect the public capability catalog without importing
adapter constructors or initializing a global registry:

```ts
import { BUILTIN_PROVIDER_CATALOG } from 'librarium';

for (const provider of BUILTIN_PROVIDER_CATALOG) {
  console.log({
    id: provider.provider_id,
    profiles: provider.profiles.map(({ profile_id, invocation, target }) => ({
      profile_id,
      invocation,
      target,
    })),
  });
}
```

Configured options are checked against the descriptor schema during
initialization. Invalid values produce a warning while the adapter stays
registered, so background retrieval and built-in ID protection remain intact;
the adapter blocks `execute`, `submit`, and `test` before HTTP. Background
`poll` and `retrieve` remain available for work submitted before the config
became invalid.

## Commands

### `run`

Run a research query across multiple providers.

```bash
librarium run <query> [options]
```

| Flag | Description |
|---|---|
| `-p, --providers <ids\|names>` | Comma-separated provider IDs or display names (e.g. `"Exa Search,brave-search"`) |
| `-g, --group <name>` | Use a predefined provider group |
| `-m, --mode <mode>` | Execution mode: `sync`, `async`, or `mixed` |
| `-o, --output <dir>` | Output base directory |
| `--parallel <n>` | Max parallel requests |
| `--timeout <n>` | Timeout per provider in seconds |
| `--max-cost <usd>` | Stop launching providers once API-reported cost crosses this budget (see [Spend guardrails](#spend-guardrails)) |
| `--max-estimated-cost <usd>` | Reserve each provider's pre-dispatch *estimated* cost and skip launches once the estimate crosses this ceiling (see [Spend guardrails](#spend-guardrails)) |
| `--no-fallback` | Disable configured provider fallbacks for an exact provider matrix |
| `-y, --yes` | Skip the deep-research pre-flight confirm |
| `--json` | Output `run.json` to stdout |
| `--refine` | Rewrite the query into tier-tuned variants with one LLM call before dispatch |
| `--html` | Generate a self-contained `report.html` in the run directory |
| `--jsonl` | Generate a machine-readable `results.jsonl` in the run directory |
| `--open` | Open the output directory (or `report.html` with `--html`) when the run completes |

```bash
# Run with specific providers
librarium run "database indexing" --providers perplexity-sonar-pro,exa

# Provider display names also work on the CLI (mix and match with IDs)
librarium run "query" -p "Exa Search,brave-search"

# Deep research, wait for completion
librarium run "AI agent architectures" --group deep --mode sync

# Fast results only
librarium run "Node.js 22 features" --group fast
```

The `--providers` flag accepts canonical IDs or display names (case- and
punctuation-insensitive, so `"Exa Search"`, `exa-search`, and `EXA SEARCH` all
resolve to `exa`). Display names are a CLI input convenience only. If a name is
ambiguous or unrecognized, the run stops with matching candidates or a short
list of suggestions. Current configuration requires canonical IDs; only the v1
migrator accepts retired IDs.

In an interactive terminal, `run` shows a live per-provider results table. Every row appears at fan-out with a spinner and ticking elapsed time, then resolves in place as results arrive:

```
$ librarium run "postgres pooling best practices"

  fanning out to 6 providers

  ✓ perplexity-sonar-pro   ai-grounded        2.1s    12 sources
  ✓ gemini-grounded        ai-grounded        3.4s     9 sources
  ✓ exa                    ai-grounded        1.8s    25 sources
  ✓ brave-search           raw-search         0.9s    20 results
  ✗ tavily                 raw-search         0.4s   HTTP 401 Unauthorized
    ↳ falling back to jina-search
  ✓ jina-search            raw-search         0.7s     8 results   (fallback for tavily)
  ◷ openai-research        deep-research   submitted

  5 succeeded, 0 failed, 1 async pending in 3.5s
  ▸ 74 unique sources after dedupe (74 total citations)
  ▸ ~/research/agents/librarium/1781136000-postgres-pooling-best-practices/

  ◷ async tasks pending: run `librarium status --wait` to poll and retrieve
```

Successes are green, failures red with the reason inline, async submissions amber. Durations of 10s or more are highlighted. When a provider's API reports usage, a dim suffix shows it on the line (`· 8.4k tok` or `· $0.012`), and the summary adds a `reported cost` line covering the providers that reported one -- costs are never estimated from pricing tables, only taken from API responses. Piped or CI output degrades to plain append-on-completion lines, and `--json` keeps stdout pure JSON (the table goes to stderr).

### `answer`

Fan out a query and synthesize one grounded, cited answer from the results.

```bash
librarium answer <query> [options]
```

`answer` runs the same fan-out as `run` (defaulting to the `quick` group, overridable with `-g`/`-p`/`-m` and the usual run flags), then makes one LLM synthesis call over the successful providers' content plus the deduped source list. The model is instructed to answer only from the findings, cite with inline `[n]` indices that map to the numbered source list, and state what is uncertain rather than invent. The answer is rendered in the terminal followed by a hyperlinked source list, and written to `answer.md` in the run directory.

| Flag | Description |
|---|---|
| `-p, --providers <ids\|names>` | Use specific provider IDs or display names instead of the default `quick` group |
| `-g, --group <name>` | Use a predefined provider group |
| `-m, --mode <mode>` | Execution mode: `sync`, `async`, or `mixed` |
| `-o, --output <dir>` | Output base directory |
| `--parallel <n>` | Max parallel requests |
| `--timeout <n>` | Timeout per provider in seconds |
| `--max-cost <usd>` | Stop launching providers once API-reported cost crosses this budget |
| `--max-estimated-cost <usd>` | Skip launches once reserved estimated cost crosses this ceiling |
| `--no-fallback` | Disable configured provider fallbacks for an exact provider matrix |
| `-y, --yes` | Skip the deep-research pre-flight confirm |
| `--json` | Output `run.json` to stdout |
| `--refine` | Rewrite the query into tier-tuned variants before dispatch |
| `--verify` | Add a bounded evidence-verification pass after synthesis |
| `--html` | Generate `report.html` in the run directory |
| `--jsonl` | Generate `results.jsonl` in the run directory |
| `--open` | Open the output directory (or `report.html` with `--html`) when complete |

```
$ librarium answer "what changed in postgres 17 logical replication"

  fanning out to 5 providers

  ✓ gemini-grounded        ai-grounded        2.7s     8 sources
  ✓ openrouter-online      ai-grounded        2.3s    10 sources
  ✓ brave-answers          ai-grounded        1.1s    14 sources
  ✓ exa                    ai-grounded        1.6s    19 sources
  ✓ kagi-fastgpt           ai-grounded        1.4s     7 sources

  Postgres 17 makes logical replication materially easier to operate. Replication
  slots and subscription state now survive a major-version upgrade with pg_upgrade,
  so you no longer have to resync subscribers after an upgrade [1] [3]. It also adds
  failover-aware slots that can follow a promoted standby, closing a long-standing
  gap for high-availability setups [2].

  What the findings do not settle is exact performance deltas under heavy write load;
  the sources describe the features but not benchmarked throughput [4].

  Sources
  [1] PostgreSQL 17 Release Notes
  [2] Logical replication failover in PG17
  [3] pg_upgrade and replication slots
  [4] What's new in Postgres 17

  5 succeeded, 0 failed, 0 async pending in 2.9s
  ▸ 38 unique sources after dedupe (53 total citations)
  ▸ ~/research/agents/librarium/1781136000-what-changed-in-postgres-17/
```

The synthesis call uses the first available of OpenAI (`gpt-5-mini`), Gemini (`gemini-2.5-flash`), or Perplexity (`sonar`), overridable via an `answer: { provider, model }` config key that falls back to the `refine` config and then to those defaults. Synthesis fails open: if every client fails (quota, auth, timeout), a detailed warning prints and the run summary and output directory still appear, so the research is never lost. The exit code reflects the run, not the synthesis. `answer` accepts the same run flags, including `--no-fallback`, `--max-cost`, `--max-estimated-cost`, `--html`, and `--jsonl`. When the run directory contains `answer.md`, both `report.html` (an Answer section leading the report) and `results.jsonl` (an `"type":"answer"` line) pick it up automatically on generation and regeneration. The interactive wizard also offers grounded synthesis after its refine prompt when an LLM client key is configured.

Pass `--verify` to add a bounded, opt-in evidence pass after synthesis. Librarium selects up to eight material factual claims, checks the independent source evidence already returned by the fan-out, and only then collects evidence from up to three successful targeted searches for unresolved claims. A query whose provider attempts all fail does not consume that successful-query allowance. Follow-ups start with eligible successful `ai-grounded` and `raw-search` providers from the original run and may traverse their configured eligible fallback chains, including a fallback provider that was not part of the original result set; deep-research providers are never used. Each selected claim gets at most one query with at most three provider attempts, honoring configured fallbacks, eligible alternates, the inherited per-call timeout, and both inherited cost ceilings. If either ceiling is already exhausted by the original fan-out, verification makes no LLM or provider call. Verification fails open: any incomplete evidence, budget exhaustion, provider failure, or LLM failure leaves the original grounded `answer.md` intact.

`verification.json`, `run.json`, `results.jsonl` (a `"type":"verification"` line), and `report.html` carry the complete verification audit record: status and reasons, the claim-support matrix, every follow-up query and provider attempt, every verification LLM attempt, explicit revision state, and verification-only usage. `verification.usage.reportedCostUsd` and `estimatedCostUsd` are totals for the incremental provider follow-ups **plus** verification LLM calls; the original answer-synthesis call is intentionally outside this accounting. The nested `verification.usage.provider` and `.llm` objects keep token and cost lanes separate, while `successfulProviderAttempts` and `successfulLlmCalls` distinguish successful calls from all paid attempts. `reportedCostIsLowerBound`, `estimatedCostIsLowerBound`, and each lane's corresponding flags are true whenever an attempted provider could not report or be estimated, so a displayed zero is never presented as a known-free call. Per-attempt normalized API usage remains available on the provider-attempt and LLM records.
### Spend guardrails

Two opt-in guardrails help avoid surprise spend on large fan-outs.

**Deep-research pre-flight confirm.** When a run would dispatch three or more deep-research-tier providers, an interactive terminal shows a confirmation first, listing the providers and warning that deep research takes minutes and bills per call. Pass `-y, --yes` to skip it. Non-TTY runs (pipes, CI) never prompt and are never refused, so scripts never hang. The wizard's own confirm counts as consent, so running through the wizard never double-prompts.

**Cost budget (`--max-cost <usd>` or `defaults.maxCostUsd`).** A runtime circuit breaker, not an estimator. As provider results arrive, librarium accumulates the cost each provider's API actually reported. Once the accumulated total crosses the budget, providers that have not started yet are skipped (shown as `skipped` in the table and `run.json`, with a budget reason); in-flight requests are allowed to finish, because aborting a request mid-flight is hostile to most provider APIs and you would be billed anyway. The flag wins over the config key. When the breaker trips, the summary adds a line like:

```
  ▸ budget reached: $0.48 reported of $0.50 budget, skipped 3 providers
```

#### What counts toward the budget

The budget is honest, not predictive. Only costs an API actually reports count toward it. A provider that reports no cost contributes `0`, so the accumulated total is always a lower bound on real spend, never an estimate from a pricing table. That has two consequences worth understanding:

- Providers that report nothing can run "for free" as far as the breaker is concerned, even though they may cost real money. The budget cannot stop what it cannot see.
- Deep-research costs land at *retrieval* (when you run `librarium status --wait`), long after the dispatch that submitted them has returned. Those async costs cannot be pre-metered and so cannot be enforced by `--max-cost` at submit time.

Use `--max-cost` as a backstop against runaway synchronous fan-outs, not as a hard billing cap.

#### Metering registry and the estimated budget

`--max-cost` is deliberately reported-only: it never guesses. The gap it leaves — providers that report no cost (most raw-search APIs) run "for free" as far as the breaker is concerned — is filled by a separate, opt-in **estimated** lane.

Every provider declares a **metering kind** in its built-in descriptor, visible in `librarium ls` (and its `--json`):

| Kind | Meaning | Examples |
|---|---|---|
| `native_cost` | API returns a real per-call cost | Perplexity, Exa, OpenRouter |
| `native_tokens` | API returns token counts but no cost | Claude, OpenAI, Gemini |
| `request_priced` | Deterministic/plan price per request | SerpAPI, SearchAPI, Brave Web Search, Kagi |
| `credit_priced` | Priced in account credits per request | Tavily, Firecrawl, You.com |
| `api_unit_priced` | Priced per API unit/token, size known only after the call | Jina, Brave AI Answers |
| `manual_unmetered` | No reliable per-call metering | custom providers |

For request- and credit-priced providers, librarium can produce a **network-free estimate** *before* a call runs. Estimates are guesses, never facts: they live under each result's `metering.estimate` (never in `usage.costUsd`), carry a `costConfidence` (`estimated` from a built-in default snapshot, `configured` when you supply pricing, `unknown` when there's no basis) and a `pricingVersion`. Plan-dependent credit providers emit unit metadata (`billableUnits`, `unit`) **without** an invented dollar figure until you configure a price via provider `options` (`perRequestUsd`, or `creditUsd` + `creditsPerRequest`).

Request-priced estimates multiply the configured/default per-request price by
the descriptor's logical request units. One-stage SearchAPI adapters reserve one
unit; dedicated `searchapi-google-ai-overview` reserves two because its normal
success path is a Google token request followed by an Overview request. These
logical billing units describe provider operations and are distinct from
low-level transport attempts or retries.

Brave AI Answers is billed by searches plus input/output tokens, so librarium does not manufacture a single pre-dispatch dollar estimate — but Brave reports its own cost breakdown (an inline `<usage>` stream tag with an `X-Request-Total-Cost` dollar figure), which librarium surfaces as reported cost in `usage.costUsd`.

**Estimated budget (`--max-estimated-cost <usd>` or `defaults.maxEstimatedCostUsd`).** A pre-dispatch *reservation* ceiling, independent of `--max-cost` (the two never reconcile into one number). Before each provider launches, Librarium skips it if its estimate would put the reserved total over the ceiling; otherwise the estimate is reserved. Providers with no estimable cost reserve `0`, so the reserved total is an honest lower bound. Gemini Deep Research reserves a conservative $3 per submitted task by default; override it with the provider option `perRequestUsd` if your observed workload differs. This gives products pre-call budget reservation that `--max-cost` (which only learns cost *after* a call) cannot. When it trips, the summary adds a line like:

```
  ▸ estimated budget reached: ~$0.05 reserved of $0.05 budget, skipped 2 providers
```

The actual-cost provenance of a reported figure is recorded as `metering.actual.source` (`provider_reported` today; reserved values like `computed_from_tokens`/`computed_from_credits` are defined for future computed lanes).

### Interactive wizard

Running `librarium` with no arguments in a terminal starts an interactive wizard: enter the query, pick a group (with provider counts and tier breakdowns as hints) or hand-pick providers, choose the mode, confirm, and the run executes with the live table. Afterwards it offers to open the results in the browser below. Non-TTY invocations print help instead, so scripts never hang.

### `browse`

Browse past runs and their provider results.

```bash
librarium browse [-o <output-dir>]
```

Pick a recent run (date, query, status tallies) and see its providers rendered in the same table format. Selecting a provider (or the run's `summary.md`) opens the full document in a built-in fullscreen reader: markdown rendered with ANSI styling (bold headings, dim code, normalized bullets, clickable links) and hard-wrapped to the terminal width, re-wrapping on resize. Other actions: export an HTML report, back, quit.

Reader key bindings:

| Key | Action |
| --- | --- |
| `j` / `k` or arrow down / up | scroll one line |
| `space` / `PageDown` | next page |
| `b` / `PageUp` | previous page |
| `g` / `G` | jump to top / bottom |
| `o` | open the raw file in `$PAGER` (fallback `less -R`) |
| `q` / `escape` | back to the provider list |

### `html`

Generate a self-contained `report.html` for a run directory (default: the most recent run).

```bash
librarium html [run-dir] [--open]
```

The report contains the query, run metadata, the provider results table as tabs, with each provider's rendered markdown in a panel below, and the deduped source list with provider attribution. When the run directory contains an `answer.md` (from `librarium answer` or the wizard's synthesis toggle), an Answer section leads the report before the provider tabs, showing the synthesizing provider/model dimly. Answer and provider markdown are HTML-escaped with the same untrusted handling, so untrusted output cannot inject script. Results retrieved after the run (async deep research) fill in when the report is regenerated; `status --retrieve` regenerates an existing `report.html` automatically.

### `jsonl`

Generate a machine-readable `results.jsonl` for a run directory (default: the most recent run).

```bash
librarium jsonl [run-dir]
```

The file contains one JSON object per line (JSONL / newline-delimited JSON). Each line can be parsed independently with `JSON.parse`:

- **Line 1 -- run header** (`"type":"run"`): query, slug, timestamp, mode, succeeded/failed/pending counts, unique source count, total citation count, and optional `refinedQueries` (only present when `--refine` was used).
- **Optional answer line** (`"type":"answer"`): emitted right after the run header when the run directory contains an `answer.md` (from `librarium answer` or the wizard's synthesis toggle). Carries optional `provider` and `model` (from `run.json`'s `answer` metadata) and `content` (the full `answer.md` body).
- **Optional verification line** (`"type":"verification"`): emitted after the answer line for `librarium answer --verify`. Carries the full claim-support matrix, follow-up attempts, actual LLM provider/model records, incomplete reasons, and verification-only usage/cost totals.
- **One line per provider** (`"type":"result"`): id, tier, status, durationMs, citationCount, optional usage object, optional error string, optional fallbackFor string, and `content` (the full markdown from the provider's `.md` file, or `null` when missing or pending).
- **One line per deduped source** (`"type":"source"`): url, optional title, providers array, citationCount.

Keys with undefined values are omitted. `--jsonl` and `--html` are independent and combinable. `status --retrieve` regenerates an existing `results.jsonl` automatically when one is present. The JSONL export is also available as an action in `librarium browse`.

```bash
# Run and produce both formats at once
librarium run "postgres pooling" --html --jsonl

# Regenerate JSONL for an existing run
librarium jsonl ./agents/librarium/20250601-123456-postgres-pooling

# Stream-process with jq
librarium jsonl | xargs cat | jq 'select(.type=="result") | {id, status, citationCount}'
```

### `refine`

Rewrite a research goal into tier-tuned query variants without dispatching.

```bash
librarium refine "figure out how to scale postgres connections" [--json]
```

Prints a thorough brief for deep-research providers, a focused question for ai-grounded providers, a keyword query for raw-search providers, and a suggested group. The same transform powers `run --refine`, which dispatches each provider with its tier's variant (recorded in `run.json` and `prompt.md` for reproducibility). The LLM call uses the first available of OpenAI (`gpt-5-mini`), Gemini (`gemini-2.5-flash`), or Perplexity (`sonar`), overridable via a `refine: { provider, model }` config key. If the call fails, the run proceeds with the original query.

### `completions`

Print a static shell completion script covering commands, flags, and the builtin group names.

```bash
# zsh
eval "$(librarium completions zsh)"

# bash
eval "$(librarium completions bash)"

# fish
librarium completions fish > ~/.config/fish/completions/librarium.fish
```

### `status`

Check or wait for async deep-research tasks.

```bash
librarium status [options]
```

| Flag | Description |
|---|---|
| `--wait` | Block and poll until all async tasks complete |
| `--retrieve` | Fetch completed results and write output files |
| `--json` | Output JSON |

```bash
# Check pending tasks
librarium status

# Wait for completion then retrieve results
librarium status --wait --retrieve
```

Retrieved results render with the same table line format as `run`, with the output file and word count appended:

```
  ✓ openai-research   deep-research     95.0s    14 sources   openai-research.md, 2310 words
```

### `usage`

Aggregate API-reported cost and tokens across past runs.

```bash
librarium usage [options]
```

| Flag | Description |
|---|---|
| `--days <n>` | Only include runs from the last N days (filtered by manifest timestamp) |
| `--json` | Output JSON |
| `-o, --output <dir>` | Output base directory |

`usage` walks the `run.json` manifests under the output base directory and totals up cost and tokens per provider, plus a run count and date range. As with the run summary, only API-reported costs are counted in the `cost` column (providers that report nothing contribute `0`), so figures are honest lower bounds, never pricing-table estimates. A separate `est. cost` column sums any pre-dispatch estimates from the [metering registry](#metering-registry-and-the-estimated-budget) — a guess, never billed, never mixed with reported cost. The output notes how many runs had no reported usage.

```
$ librarium usage --days 30

Usage (last 30 days):

  provider       cost  est. cost  tokens  runs
  -----------  ------  ---------  ------  ----
  openai-research   $0.50          -    5.0k     1
  exa          $0.020          -    1.5k     1
  serpapi           -    ~$0.015       -     1

  runs: 2
  total reported cost: $0.52
  total estimated cost: ~$0.015 (pre-dispatch estimate, not billed)
  date range: 2026-01-14 15:58 to 2026-01-14 16:00
  1 of 2 runs had no reported usage
```

### `ls`

List all available providers with their status.

```bash
librarium ls [--json]
```

Shows each provider's ID, display name, tier, source (`builtin`, `npm`, `script`), enabled state, and whether an API key is configured.

### `groups`

List and manage provider groups.

```bash
# List all groups
librarium groups

# Add a custom group
librarium groups add my-stack perplexity-sonar-pro exa tavily

# Remove a custom group
librarium groups remove my-stack

# Output as JSON
librarium groups --json
```

### `init`

Set up librarium configuration. Interactive mode runs the same guided onboarding flow as first-run `librarium`: choose providers, choose credential storage, enter keys, and save only providers with usable credentials. Auto mode remains non-interactive: it discovers API keys from your environment and enables matching grounded providers.

```bash
# Auto-discover (non-interactive)
librarium init --auto

# Interactive setup
librarium init
```

### `doctor`

Health check: tests API connectivity for all enabled providers.

```bash
librarium doctor [--json]
```

### `config`

Print the resolved configuration (global merged with project), or open the interactive config menu.

```bash
# Show resolved config
librarium config

# Open provider/settings menu
librarium config menu

# Show only global config
librarium config --global

# Output raw JSON
librarium config --json
```

The config menu can configure providers/API keys, credential storage, `defaults.llmWebSearch`, execution mode, output directory, parallelism, and timeouts.

### `cleanup`

Remove output directories. By default deletes runs older than 30 days; `--all`
deletes every run regardless of age.

```bash
# Delete directories older than 30 days (default)
librarium cleanup

# Custom age threshold
librarium cleanup --days 7

# Preview what would be deleted (count, total size, oldest/newest)
librarium cleanup --dry-run

# Delete every run directory (interactive confirm in a TTY)
librarium cleanup --all

# Pick exactly which runs to delete from a checklist
librarium cleanup -i

# JSON output and an alternate output base dir
librarium cleanup --all --json -o ./agents/librarium
```

In a terminal, `--all` prompts for confirmation (showing run count and total
size on disk) before deleting. In a non-interactive context (pipe, CI), pass
`--yes` to confirm, otherwise the command refuses to delete. Runs that still
have pending async tasks are flagged in the list and confirm, since deleting
them orphans the server-side task handle. The command never deletes anything
outside the resolved output base directory and refuses to operate if that
directory resolves to your home directory or a filesystem root.

### `clear`

Alias for `librarium cleanup --all`: deletes every run directory. Same flags
pass through (`--dry-run`, `-i`/`--interactive`, `--yes`, `-o`/`--output`,
`--json`).

```bash
# Delete all runs (interactive confirm in a TTY, --yes required in non-TTY)
librarium clear

# Preview everything that would be removed
librarium clear --dry-run

# Interactively pick which runs to clear
librarium clear -i
```

### `mcp`

Start an MCP server over stdio so AI agents can drive librarium through tool
calls. See [Using with AI Agents](#using-with-ai-agents) for setup and the full
tool list.

```bash
# Register with Claude Code
claude mcp add librarium -- librarium mcp

# Or run directly (stdout is the protocol stream; diagnostics go to stderr)
librarium mcp
```

## Groups

Groups are named collections of provider IDs. Librarium ships with eight default groups:

| Group | Providers | Use Case |
|---|---|---|
| `deep` | perplexity-sonar-deep, perplexity-deep-research, perplexity-advanced-deep, openai-research, gemini-deep | Thorough async research |
| `quick` | gemini-grounded, openrouter-online, brave-answers, exa, kagi-fastgpt | Fast AI-grounded answers |
| `raw` | perplexity-search, brave-search, jina-search, firecrawl-search, searchapi, serpapi, tavily | Traditional search results |
| `fast` | perplexity-sonar-pro, gemini-grounded, openrouter-online, perplexity-search, brave-answers, exa, kagi-fastgpt, jina-search, brave-search, firecrawl-search, tavily | Quick results from multiple tiers |
| `visibility` | searchapi-chatgpt, searchapi-gemini, searchapi-perplexity, searchapi-google-ai-mode, searchapi-bing-copilot, searchapi-google-ai-overview, perplexity-sonar-pro, gemini-grounded, grok | Explicit nine-surface answer visibility comparison |
| `comprehensive` | All deep-research + all ai-grounded (including Grok web, X, and combined) | Deep + AI-grounded combined |
| `llm` | claude, openai-chat, gemini-chat, openrouter-chat | Opt-in LLM answers; web search and citations on by default |
| `all` | All 29 grounded providers (including Grok web, X, and combined) | Maximum grounded coverage (excludes the `llm` tier) |

`visibility`, `comprehensive`, and `all` are explicit cost boundaries. Choosing
one may run credentialed members whose setup descriptor is opt-in and whose
stored provider entry is disabled; a bare/default run still selects only
enabled providers. The six SearchAPI answer surfaces are absent from `quick`,
`fast`, `raw`, `deep`, and `llm`. Pro Search is in `comprehensive` and `all`,
not `visibility`, `quick`, or `fast`.

When loading older global config, Librarium upgrades an explicitly stored
`comprehensive` or `all` roster only when it is an ordered exact match for the
enumerated prior built-in roster after legacy provider aliases are
canonicalized. Reordered, added/removed, custom, and project-level group
rosters are never rewritten. An absent stored roster is not migrated, but the
effective configuration still receives the current built-in default; repeated
loading is idempotent.

### Custom Groups

Add custom groups via CLI or config file:

```bash
# Via CLI
librarium groups add my-research perplexity-sonar-pro exa brave-search

# Via config.json
{
  "groups": {
    "my-research": ["perplexity-sonar-pro", "exa", "brave-search"]
  }
}
```

## Execution Modes

Librarium supports three execution modes, configurable via `--mode` or the `defaults.mode` config key:

- **`sync`** -- Wait for all providers to complete, including deep-research providers. Deep research runs synchronously (can take several minutes).

- **`async`** -- Submit deep-research tasks and return immediately. Use `librarium status --wait --retrieve` to poll and fetch results later.

- **`mixed`** (default) -- Run ai-grounded and raw-search providers synchronously. Submit deep-research providers asynchronously. You get fast results right away and can retrieve deep research later.

True background submission depends on the provider's API. `openai-research`,
`perplexity-sonar-deep` (via Perplexity's Async Sonar API), and `gemini-deep`
(via Google's Interactions API with `background: true`) submit and return
immediately in `mixed`/`async` mode. A plain `librarium status` performs one
poll pass and persists terminal provider errors; use `librarium status --wait`
to keep polling. `perplexity-deep-research` and
`perplexity-advanced-deep` use Perplexity's Agent API, which has no background
mode, so they complete inline even in mixed mode.

OpenAI's background mode is not compatible with Zero Data Retention. If your
organization requires ZDR, do not enable `openai-research` in its current
background configuration. See OpenAI's
[background mode guide](https://developers.openai.com/api/docs/guides/background/).

## Provider Fallback

When a provider fails (exception, error response, timeout), librarium can
automatically try a lighter alternative unless that result explicitly blocks
fallback. When `zeroRetention` is configured, any SearchAPI answer-adapter
failure blocks fallback so Librarium never silently retries with weaker
privacy. The dedicated Google AI Overview adapter blocks fallback on every
failure to preserve its two-stage surface semantics. Add an optional `fallback`
field to any provider's config:

```json
{
  "providers": {
    "gemini-deep": {
      "apiKey": "$GEMINI_API_KEY",
      "enabled": true,
      "fallback": "openai-research"
    },
    "openai-research": {
      "apiKey": "$OPENAI_API_KEY",
      "enabled": false
    }
  }
}
```

**Behavior:**

- Fallback triggers after the primary provider's execution fails (error or timeout)
- A provider result can set `preventFallback`; SearchAPI uses it to preserve
  requested privacy, provenance, and product-surface semantics
- Only single-level fallback is supported (a fallback's own fallback is ignored)
- The fallback provider must be configured with a valid API key but can be `enabled: false` (it will only activate as a backup)
- If the fallback provider is already running in the same dispatch (e.g., explicitly listed in `--providers`), it won't be triggered again
- Output files use the fallback provider's ID (e.g., `openai-research.md`)

**In `run.json`**, both the original error report and the fallback result appear in the `providers` array. The fallback report includes a `fallbackFor` field indicating which provider it replaced:

```json
{
  "id": "openai-research",
  "tier": "deep-research",
  "status": "success",
  "fallbackFor": "gemini-deep"
}
```

## Configuration

Librarium uses a layered configuration system:

1. **Global config**: `~/.config/librarium/config.json`
2. **Project config**: `.librarium.json` (in current directory)
3. **CLI flags**: Passed directly to commands

Each layer overrides the previous:

- `defaults`: project overrides global
- `providers`: deep-merged by provider ID (project overrides keys on conflict)
- `customProviders`: merged by provider ID (project overrides global on same ID)
- `trustedProviderIds`: union + dedupe across global and project
- `groups`: project overrides global group names on conflict

The optional `defaults.maxCostUsd` key sets a default cost budget for runs (the runtime circuit breaker described in [Spend guardrails](#spend-guardrails)). The `--max-cost` flag wins over it. Omit it for no limit. The optional `defaults.maxEstimatedCostUsd` key sets a default pre-dispatch reservation ceiling (the estimated budget); the `--max-estimated-cost` flag wins over it.

### SearchAPI options

All seven SearchAPI adapters share `SEARCHAPI_API_KEY`, use bearer
authentication, and accept the same strict options:

```json
{
  "providers": {
    "searchapi-chatgpt": {
      "apiKey": "$SEARCHAPI_API_KEY",
      "enabled": false,
      "options": {
        "zeroRetention": true,
        "perRequestUsd": 0.004
      }
    }
  }
}
```

- `zeroRetention` is boolean and defaults to `false`. When `true`, Librarium
  sends `zero_retention=true`; rejection returns an actionable provider error,
  blocks fallback, and never triggers an unprotected retry. SearchAPI documents
  this capability for Enterprise accounts, so verify entitlement before
  enabling it.
- `perRequestUsd` is an optional positive local pricing override used only for
  pre-dispatch estimates. It is not sent upstream and never becomes reported
  cost.

Unknown options fail before HTTP. The dedicated Google AI Overview adapter is
a two-stage operation and reserves two logical request units, so the default
`$0.004` per-unit estimate becomes `$0.008` for one Overview operation.

### Perplexity Search options

`perplexity-search` accepts only documented camelCase options, which Librarium
maps to the `/search` request: `maxResults`, two-letter `country`,
`searchLanguageFilter`, `searchDomainAllowlist` or `searchDomainDenylist`,
`searchContextSize`, `maxTokens`, `maxTokensPerPage`, and up to four unique
non-empty `additionalQueries`. Allowlist and denylist conflict, as do
`searchContextSize` and explicit token budgets; invalid or unknown options fail
before HTTP. With no options, the existing single-query request shape and
rendering limits remain unchanged.

Additional queries are sent in the same upstream request, so Librarium meters
the operation as one billed request estimate. Additional queries may consume
provider rate-limit capacity independently; exact account behavior remains
unverified until the separately approved live validation.

### Global Config Example

```json
{
  "version": 1,
  "defaults": {
    "outputDir": "./agents/librarium",
    "maxParallel": 6,
    "timeout": 30,
    "asyncTimeout": 1800,
    "asyncPollInterval": 30,
    "mode": "mixed",
    "llmWebSearch": true,
    "maxCostUsd": 0.5,
    "maxEstimatedCostUsd": 0.25
  },
  "providers": {
    "perplexity-sonar-pro": {
      "apiKey": "$PERPLEXITY_API_KEY",
      "enabled": true
    },
    "brave-answers": {
      "apiKey": "$BRAVE_API_KEY",
      "enabled": true
    },
    "exa": {
      "apiKey": "$EXA_API_KEY",
      "enabled": true
    },
    "grok": {
      "apiKey": "$XAI_API_KEY",
      "enabled": true,
      "model": "grok-4.5"
    },
    "tavily": {
      "apiKey": "$TAVILY_API_KEY",
      "enabled": true
    }
  },
  "customProviders": {},
  "trustedProviderIds": [],
  "groups": {
    "my-custom-group": ["perplexity-sonar-pro", "exa"]
  }
}
```

API keys can be stored three ways:

1. **OS keychain**: recommended when available. Config stores a reference such as `"keychain:PERPLEXITY_API_KEY"` and the secret lives outside the config file.
2. **Shell environment variables**: config stores a reference such as `"$PERPLEXITY_API_KEY"`. The onboarding wizard writes exports to `~/.config/librarium/env` (or `env.fish`) with `0600` permissions and, with confirmation, adds a non-secret source line to your detected shell profile.
3. **Config file**: explicit fallback. Config stores the literal key in `~/.config/librarium/config.json`, which is written with `0600` permissions.

The CLI cannot change the parent shell's live environment. If you choose shell environment variables, open a new terminal or source your shell profile before expecting the key to exist in future sessions.

LLM providers use web search and citations by default. Turn that off globally with:

```json
{
  "defaults": {
    "llmWebSearch": false
  }
}
```

Or turn it off for one provider:

```json
{
  "providers": {
    "openai-chat": {
      "apiKey": "$OPENAI_API_KEY",
      "enabled": true,
      "options": {
        "webSearch": false
      }
    }
  }
}
```

Claude defaults to Sonnet 5 with a 16,000-token output ceiling, adaptive
thinking, and `medium` effort. The larger ceiling leaves room for both thinking
and the visible answer; it is a cap, not a target. Configure these controls per
provider:

```json
{
  "providers": {
    "claude": {
      "apiKey": "$ANTHROPIC_API_KEY",
      "enabled": true,
      "model": "claude-sonnet-5",
      "options": {
        "maxTokens": 16000,
        "thinking": "adaptive",
        "effort": "medium"
      }
    }
  }
}
```

`maxTokens` must be a positive integer. `thinking` accepts `adaptive` or
`disabled`; `effort` accepts `low`, `medium`, `high`, `xhigh`, or `max`.
Adaptive thinking and medium effort are automatic only for the default Sonnet
5 model. When `model` is overridden, thinking and effort are omitted unless
they are explicitly configured, avoiding unsupported fields on older models.

OpenAI Research defaults to GPT-5.6 Sol with `high` reasoning, OpenAI's
standard web-search return-token budget, and no tool-call ceiling. Configure
its model and research limits under the canonical `openai-research` provider
ID:

```json
{
  "providers": {
    "openai-research": {
      "apiKey": "$OPENAI_API_KEY",
      "enabled": true,
      "model": "gpt-5.6-sol",
      "options": {
        "reasoningEffort": "medium",
        "returnTokenBudget": "default"
      }
    }
  }
}
```

`reasoningEffort` accepts `none`, `low`, `medium`, `high`, `xhigh`, or `max`
and defaults to `high`. Use `medium` as a speed-oriented setting and `xhigh`
as a quality-first override. `maxToolCalls` must be a positive integer when
set; it is uncapped by default because low ceilings can prevent complete
research. `returnTokenBudget` accepts `default` or `unlimited` and defaults to
`default`. Use `unlimited` only for high-effort research that needs to inspect
unusually large amounts of web content; it can increase latency and token
usage.

Firecrawl Search defaults to ten web results. Its `limit` is applied **per
source**, so selecting both web and news can return up to twice that number.
Configure the supported Firecrawl Search API fields under `firecrawl-search`:

```json
{
  "providers": {
    "firecrawl-search": {
      "apiKey": "$FIRECRAWL_API_KEY",
      "enabled": true,
      "options": {
        "sources": ["web", "news"],
        "limit": 5,
        "tbs": "qdr:w",
        "country": "US",
        "location": "Toronto, Ontario, Canada",
        "includeDomains": ["docs.firecrawl.dev"],
        "categories": ["github", "research"],
        "ignoreInvalidURLs": true
      }
    }
  }
}
```

`sources` accepts `web` and/or `news`; `limit` must be a safe integer from 1
to 100. `includeDomains` and `excludeDomains` are mutually exclusive hostname
lists. `categories` accepts `github`, `research`, and `pdf`. Images,
`scrapeOptions`, and enterprise options are intentionally unsupported by this
raw-search adapter.

Some providers support optional model overrides. Gemini Deep Research defaults to the `deep-research-preview-04-2026` agent; set `model` to `deep-research-max-preview-04-2026` for the heavier (and more expensive) variant:

Librarium requests only the final report from Gemini Deep Research. Thinking summaries and automatic visualization are disabled because Librarium does not stream or display those intermediate artifacts.

```json
{
  "providers": {
    "gemini-deep": {
      "apiKey": "$GEMINI_API_KEY",
      "enabled": true,
      "model": "deep-research-max-preview-04-2026"
    }
  }
}
```

### Project Config Example

```json
{
  "defaults": {
    "outputDir": "./research",
    "timeout": 60
  },
  "providers": {
    "perplexity-sonar-pro": {
      "enabled": false
    },
    "my-script-provider": {
      "enabled": true
    }
  },
  "customProviders": {
    "my-script-provider": {
      "type": "script",
      "command": "node",
      "args": ["./scripts/librarium-provider.mjs"]
    }
  },
  "trustedProviderIds": ["my-script-provider"],
  "groups": {
    "project-research": ["my-script-provider", "exa"]
  }
}
```

## Custom Providers

Librarium supports external providers without changing core code. Add definitions to config and trust them explicitly.

For provider-author implementation details (module contract, script runtime semantics, timeouts, and troubleshooting), see [`docs/provider-development.md`](docs/provider-development.md).

### Trust Model

- Custom providers load only when their ID appears in `trustedProviderIds`
- Trust lists from global and project config are unioned and deduped
- Built-in IDs are reserved; custom providers cannot override built-ins

### NPM Provider Example

```json
{
  "customProviders": {
    "my-npm-provider": {
      "type": "npm",
      "module": "librarium-provider-myteam",
      "export": "createProvider",
      "options": { "preset": "fast" }
    }
  },
  "trustedProviderIds": ["my-npm-provider"],
  "providers": {
    "my-npm-provider": {
      "enabled": true,
      "apiKey": "$MY_PROVIDER_API_KEY"
    }
  }
}
```

`module` resolution order is:
1. Current project (`process.cwd()`)
2. Librarium runtime install context

In standalone/Homebrew binary installs, npm custom providers are skipped with a warning.

### Script Provider Example

```json
{
  "customProviders": {
    "my-script-provider": {
      "type": "script",
      "command": "node",
      "args": ["./scripts/librarium-provider.mjs"],
      "cwd": ".",
      "env": { "LOG_LEVEL": "warn" },
      "options": { "flavor": "deep" }
    }
  },
  "trustedProviderIds": ["my-script-provider"],
  "providers": {
    "my-script-provider": {
      "enabled": true
    }
  }
}
```

Script providers are invoked as one process per operation (`describe`, `execute`, `submit`, `poll`, `retrieve`, `test`) with JSON over stdin/stdout.

### Script Protocol (v1)

Request envelope:

```json
{
  "protocolVersion": 1,
  "operation": "execute",
  "providerId": "my-script-provider",
  "query": "research topic",
  "options": { "timeout": 30 },
  "providerConfig": { "enabled": true },
  "sourceOptions": { "flavor": "deep" }
}
```

Response envelope:

```json
{
  "ok": true,
  "data": {
    "provider": "my-script-provider",
    "tier": "ai-grounded",
    "content": "# Result",
    "citations": [],
    "durationMs": 1200
  }
}
```

Error response:

```json
{
  "ok": false,
  "error": "upstream timeout"
}
```

`describe` must return provider metadata and capabilities:

```json
{
  "ok": true,
  "data": {
    "displayName": "My Script Provider",
    "tier": "deep-research",
    "execution": "background",
    "envVar": "MY_PROVIDER_API_KEY",
    "requiresApiKey": true,
    "capabilities": {
      "execute": true,
      "submit": true,
      "poll": true,
      "retrieve": true,
      "test": true
    }
  }
}
```

## Output Format

Each research run creates a timestamped output directory:

```
./agents/librarium/1771500000-postgresql-pooling/
  prompt.md              # The research query
  run.json               # Run manifest (machine-readable)
  summary.md             # Synthesized summary with statistics
  answer.md              # Grounded synthesis (present after `librarium answer`)
  sources.json           # Deduplicated citations across all providers
  perplexity-sonar-pro.md    # Per-provider markdown results
  perplexity-sonar-pro.meta.json  # Per-provider metadata (model, timing, citations)
  brave-answers.md
  brave-answers.meta.json
  verification.json      # Present after `librarium answer --verify`
```

### run.json Schema

```json
{
  "schemaVersion": 2,
  "revision": 4,
  "status": "completed",
  "timestamp": 1771500000,
  "slug": "postgresql-pooling",
  "query": "PostgreSQL connection pooling best practices",
  "mode": "mixed",
  "outputDir": "/absolute/path/to/output",
  "providers": [
    {
      "id": "perplexity-sonar-pro",
      "tier": "ai-grounded",
      "status": "success",
      "durationMs": 2340,
      "wordCount": 850,
      "citationCount": 12,
      "outputFile": "perplexity-sonar-pro.md",
      "metaFile": "perplexity-sonar-pro.meta.json",
      "usage": {
        "inputTokens": 1200,
        "outputTokens": 640,
        "totalTokens": 1840,
        "costUsd": 0.0123
      },
      "metering": {
        "kind": "native_cost",
        "actual": { "costUsd": 0.0123, "source": "provider_reported" }
      }
    },
    {
      "id": "exa",
      "tier": "ai-grounded",
      "status": "success",
      "durationMs": 1620,
      "wordCount": 210,
      "citationCount": 19,
      "outputFile": "exa.md",
      "metaFile": "exa.meta.json",
      "usage": {
        "costUsd": 0.005
      },
      "metering": {
        "kind": "native_cost",
        "actual": { "costUsd": 0.005, "source": "provider_reported" }
      }
    }
  ],
  "sources": {
    "total": 45,
    "unique": 28,
    "file": "sources.json"
  },
  "exitCode": 0
}
```

`run.json` is created before dispatch and is the only persisted source of truth for the run. Per-run inter-process locking serializes mutations, and `revision` increases on every atomic mutation. Locks fail closed: an orphaned lock after a hard process crash must be removed manually only after confirming no Librarium process is using that run. `status` is `running`, `awaiting_async`, `completed`, `partial`, `failed`, or `cancelled`; `exitCode` is `null` while work is still running or awaiting retrieval. Background providers add a `task` object directly to their provider entry containing the provider task ID, timestamps, mapped status, and safe diagnostics. After retrieval, the compact task audit remains with `retrievedAt`; Librarium does not create or read `async-tasks.json`.

SIGINT records a local terminal cancellation. It does not claim that already accepted remote provider work stopped. Canonical runs retain explicit remote custody and reconcile that work without adding late results or fallbacks after the local cutoff.

The `usage` and `metering` fields are optional. `usage` is reported-only: its `inputTokens`, `outputTokens`, `totalTokens`, and `costUsd` appear only when the provider's API actually returns them, and `usage.costUsd` is never a pricing-table estimate. `metering` carries the provider's metering `kind` and, once a real figure is known, the actual-cost lane (`metering.actual.source` is `provider_reported` for a cost the API returned); network-free pre-dispatch estimates live under `metering.estimate` instead. See [Metering registry and the estimated budget](#metering-registry-and-the-estimated-budget) for the full model.

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | All providers succeeded |
| `1` | Partial success (some providers failed) |
| `2` | Total failure (all providers failed, or configuration error) |

## Library Usage

Install the package when you need Librarium's schemas, catalog, or execution
ports in application code:

```bash
npm install librarium
```

The v2 package boundary is deliberately lower-level than the CLI. There is no
public `createLibrarium().research()`, global provider registry, adapter
constructor inventory, or headless file-writing runner yet. Use the
`librarium` executable for complete configured research runs while the
canonical runner is integrated.

### Root API (`librarium`)

The package root is side-effect-free and Worker-safe. It exposes the canonical
request and terminal-response schemas/types, the built-in provider capability
catalog, pure v1-to-v2 configuration migration/validation, and `VERSION`.

```ts
import {
  BUILTIN_PROVIDER_CATALOG,
  migrateConfig,
  ResearchRequestSchema,
  ResearchResponseSchema,
  type ResearchRequest,
} from 'librarium';

const request: ResearchRequest = ResearchRequestSchema.parse({
  query: 'Compare current deep-research APIs',
  mode: 'sync',
  selector: { kind: 'group', group_id: 'deep' },
  fallback: { kind: 'configured' },
  limits: {
    max_concurrency: 4,
    request_deadline_ms: 600_000,
    inline_attempt_deadline_ms: 60_000,
    background_attempt_deadline_ms: 600_000,
    poll_interval_ms: 5_000,
  },
});

console.log(BUILTIN_PROVIDER_CATALOG.length, request.query);

// Validate a terminal payload produced by Librarium or another conforming
// implementation. This does not execute the request.
const response = ResearchResponseSchema.parse(receivedPayload);
console.log(response.status, response.results.length);

// Configuration migration is pure: no files, code loading, or network.
const migrated = migrateConfig({ global: parsedJson });
if (!migrated.ok) console.error(migrated.issues);
```

Importing the root does not parse CLI arguments, write files, initialize
providers, install signal handlers, or read credentials.

### Advanced Worker-safe API (`librarium/core`)

`librarium/core` re-exports the root and adds explicit catalog, planning,
HTTP/stream transport, coordination-store, and attempt-execution ports. These
APIs are dependency-injected and contain no concrete provider adapters or
global registry.

```ts
import { ResearchRequestSchema } from 'librarium';
import {
  buildProviderCatalog,
  prepareResearchExecution,
  type PreparationDependencies,
} from 'librarium/core';

const catalog = buildProviderCatalog({
  providerConfigs: {
    'brave-search': { enabled: true },
  },
  credentials: {
    env: { BRAVE_API_KEY: workerEnv.BRAVE_API_KEY },
  },
});

const dependencies: PreparationDependencies = {
  clock: { now: () => Date.now() },
  ids: {
    next(scope) {
      return crypto.randomUUID() + '-' + scope;
    },
  },
};

const prepared = prepareResearchExecution(
  ResearchRequestSchema.parse({
    query: 'Independent web evidence',
    mode: 'sync',
    selector: {
      kind: 'targets',
      targets: [{ provider_id: 'brave-search', profile_id: 'search' }],
    },
    fallback: { kind: 'disabled' },
    limits: {
      max_concurrency: 1,
      request_deadline_ms: 30_000,
      inline_attempt_deadline_ms: 30_000,
      background_attempt_deadline_ms: 30_000,
      poll_interval_ms: 1_000,
    },
  }),
  catalog,
  dependencies,
);

if (!prepared.ok) {
  console.error(prepared.issues);
}
```

Preparation is network-free. `runPreparedExecution` is an advanced
coordination primitive that requires an injected `AttemptExecutionPort` and
`CoordinationStateStore`; it is not a preconfigured research client.

### Node-only API (`librarium/node`)

`librarium/node` re-exports the Worker-safe API and adds deliberate
Node services:

- `createNodeCredentialContext()` resolves environment and supported OS
  keychain references without exposing raw keychain CRUD.
- `loadCustomProviders(config, options?)` trust-checks and loads npm/script
  providers, returning provider instances and diagnostics without registering
  global state.
- `loadConfigV2({ global_path, project_path? })` reads and migrates without
  rewriting either file.
- `saveConfigV2(config, { path })` is the explicit atomic v2 write boundary. It
  validates first and enforces owner-only permissions before commit. Unix uses
  a verified `0600` mode. Windows establishes and reads back a protected DACL
  that grants full control only to the current process user. It retains the
  creation handle through writing, verification, and atomic replacement.
  Missing ACL support fails closed before destination replacement.

```ts
import {
  loadCustomProviders,
  type CustomProviderLoadConfig,
} from 'librarium/node';

const config: CustomProviderLoadConfig = {
  providers: {
    'my-search': { enabled: true },
  },
  customProviders: {
    'my-search': {
      type: 'npm',
      module: 'librarium-provider-myteam',
      export: 'createProvider',
    },
  },
  trustedProviderIds: ['my-search'],
};

const { providers, loadedIds, skippedIds, warnings } =
  await loadCustomProviders(config);

console.log({ loadedIds, skippedIds, warnings });
const result = await providers[0]?.execute('Research question', {
  timeout: 30,
});
```

> **Security:** trusted npm modules and script declarations execute arbitrary
> code with the current process's permissions and inherited environment.
> `trustedProviderIds` is an execution allowlist, not a sandbox. Load only
> code you explicitly trust.

The Node entry does not expose legacy `executeResearchRun`, writable
configuration mutation during ordinary loading, run-manifest mutation, or a
registration convenience. Configuration is rewritten only when an application
explicitly calls `saveConfigV2`. New CLI and MCP research runs use one canonical
schemaVersion 3 `run.json`; schemaVersion 2 remains a historical reconciliation
format and is never selected for new execution.

## Using with AI Agents

Librarium is designed to be used by AI coding agents. There are four ways to set it up:

### Option 1: Claude Code Skill (Recommended)

The built-in skill teaches Claude Code how to use librarium through a 7-phase research workflow.

```bash
# Install via CLI
librarium install-skill

# Or manually
mkdir -p ~/.claude/skills/librarium
curl -o ~/.claude/skills/librarium/SKILL.md https://raw.githubusercontent.com/jkudish/librarium/main/SKILL.md
```

Once installed, Claude Code will automatically use librarium when you ask it to research a topic. Triggers: `/librarium`, `/research`, `/deep-research`.

### Option 2: MCP Server

Librarium ships an MCP (Model Context Protocol) server over stdio so agents can drive it directly through tool calls instead of shelling out to the CLI. Register it with Claude Code:

```bash
claude mcp add librarium -- librarium mcp
```

Or add it to any MCP client's stdio config:

```json
{
  "mcpServers": {
    "librarium": {
      "command": "librarium",
      "args": ["mcp"]
    }
  }
}
```

The server exposes these tools:

- `research`: fan out a query across providers and write the full run directory. Pending schemaVersion 3 runs return a compact receipt. Terminal runs inline the canonical `ResearchResponse`, including full provider content.
- `get_results`: read provider markdown from a run directory (defaults to the most recent run), capped per provider with a truncation marker, plus the manifest summary.
- `check_async`: one bounded resume pass over pending async work. For schemaVersion 3, observed completion is always retrieved and committed immediately. `retrieve` only gates retrieval for historical schemaVersion 2 runs. A terminal v3 result can include the full canonical `ResearchResponse` content.
- `list_providers`: registry and config snapshot (id, name, tier, enabled, key configured).
- `list_groups`: configured provider groups and their members.

In MCP mode, stdout carries the protocol stream only; all diagnostics go to stderr. The server shuts down cleanly when the client disconnects.

### Option 3: Agent Prompt

Drop this into any AI agent's system prompt to give it librarium capabilities:

```
You have access to the `librarium` CLI for deep multi-provider research.

To research a topic, run:
  librarium run "<query>" --group <group>

Groups:
  quick          -- Fast AI-grounded answers (seconds)
  deep           -- Thorough async research (minutes)
  fast           -- Quick results from multiple tiers
  visibility     -- Explicit nine-surface answer visibility comparison
  comprehensive  -- Deep + AI-grounded combined
  llm            -- Opt-in LLM answers; web search/citations on by default
  all            -- All 27 grounded providers (excludes the llm tier)

Output lands in ./agents/librarium/<timestamp>-<slug>/:
  summary.md     -- Synthesized overview with stats
  sources.json   -- Deduplicated citations ranked by frequency
  {provider}.md  -- Per-provider detailed results
  run.json       -- Machine-readable manifest

For async deep research, check status with:
  librarium status --wait

Cross-reference sources appearing in multiple providers for higher confidence.
```

### Option 4: CLAUDE.md Project Instructions

Add to your project's `CLAUDE.md` for project-scoped research:

```markdown
## Research

Use `librarium` for research queries. It's installed globally.
- Quick lookups: `librarium run "query" --group quick`
- Deep research: `librarium run "query" --group deep --mode sync`
- Results land in `./agents/librarium/` -- read `summary.md` first, then `sources.json` for citations
```

### 7-Phase Research Workflow

The skill guides agents through:

1. **Query Analysis** -- Classify the research question and pick the right provider group
2. **Provider Selection** -- Match query type to tier (`quick` for facts, `deep` for thorough research, `all` for max coverage)
3. **Dispatch** -- Run the query with appropriate flags
4. **Monitor** -- Track async deep-research tasks
5. **Retrieve** -- Fetch completed async results
6. **Analyze** -- Read `summary.md`, `sources.json`, and per-provider output files
7. **Synthesize** -- Cross-reference multi-provider findings, weight by citation frequency

## Provider Benchmark

The repository includes a local-only, reproducible provider benchmark with
curated stable/live datasets and offline CI fixture replay. See
[`benchmark/README.md`](benchmark/README.md) for commands, scoring methodology,
artifact formats, and paid-call safety.

## Publishing

The release workflow at `.github/workflows/release.yml` handles npm publishing via [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (GitHub Actions OIDC) -- no token secret required. The trusted publisher is configured in the package settings on npmjs.com (repo `jkudish/librarium`, workflow `release.yml`).

## Sponsoring

If librarium saves you time, consider [sponsoring development](https://github.com/sponsors/jkudish). ❤️

## License

MIT
