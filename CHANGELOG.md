# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-08-27

Version 2 replaces Librarium's provider, configuration, execution, package,
and artifact contracts. Review the breaking changes before upgrading from v1.

### Breaking changes

- Node package installs now require Node.js 22.12 or newer. The CLI uses
  Commander 15 and validates query, provider, workflow, mode, concurrency,
  timeout, budget, cleanup, usage, completion, and config inputs before running
  a command.
- Package exports have been redesigned. `librarium` is the side-effect-free,
  Worker-safe schema, migration, and catalog entry point. `librarium/core`
  exposes planning, transport, coordination, and execution with injected
  dependencies. `librarium/node` owns config files, credentials, trusted custom
  providers, and Node-specific validation. Legacy dispatcher, registry,
  adapter-constructor, file-runner, and raw keychain exports are no longer
  public. The CLI remains available through the `librarium` executable.
- Configuration is now a strict, versioned, snake_case v2 schema. Migration
  defaults to deterministic preview. Writing through `config migrate --output`
  or `saveConfigV2()` requires an explicit destination, validates
  before writing, preserves source files, and uses atomic owner-only saves.
  Project input produces a merged preview rather than a flattened project
  file. Custom groups use `custom:<name>` so they cannot shadow built-in
  workflows. Custom providers are executable code and must be explicitly
  trusted after migration.
- Provider selection and provenance now use public `provider_id/profile_id`
  identities. Internal adapter IDs are not stable configuration identifiers.
  The built-in workflow set is now exactly `quick`, `deep`, `visibility`, and
  `all`. The old `raw`, `fast`, `llm`, `models`, `comprehensive`, `social`, and
  `xai` built-ins have been removed.
- Retired provider IDs are rejected by the v2 CLI, MCP server, and native v2
  config. Migrate `perplexity-sonar` to `perplexity-sonar-pro`,
  `perplexity-deep` to `perplexity-sonar-deep`, and `openai-deep` or
  `openai-deep-o3` to `openai-research`. The migration-only
  `perplexity-pro-search` and `perplexity-advanced-deep` IDs map to the
  corresponding Agent API profiles. The v1 config migrator converts retired
  IDs without modifying the source file. Completed historical artifacts keep
  their recorded IDs, but pending handles cannot be resumed through a renamed
  provider.
- New runs use the canonical `run.json` schema version 3 and artifact version
  `3.0.0`. The manifest records request, lifecycle, provider attempts, durable
  handles, usage, metering, and concrete artifact filenames. The separate
  public artifact contracts for provider metadata, sources, and JSONL records
  are version `1.0.0`. Provider files now use collision-resistant
  `provider-${stem}--${sha256(providerId)}` names, and consumers must read the
  exact `outputFile` and `metaFile` values from `run.json`.
- Custom and hand-written providers must declare an inline or background
  execution contract. Background providers must implement the complete
  execute, submit, poll, and retrieve lifecycle. Script providers use a
  versioned process envelope on stdin and stdout; partial lifecycle
  declarations are rejected.
- `HttpRequestOptions.maxRetries` has been replaced by an explicit retry
  policy. GET requests use bounded safe retries by default. Non-GET requests
  retry only when configured as idempotent with an idempotency key.

### Fixed

- Keep Gemini Deep Research's reversible preview `failed` and `incomplete`
  observations provisional until completion or the frozen request deadline,
  while preserving terminal cancellation and budget-exhaustion states.
- Correlate Tavily Research submissions with the frozen canonical attempt ID
  and recover an uncertain create response only when Tavily's project-scoped
  Logs API proves exactly one accepted task; ambiguous custody never resubmits.
- Query Tavily's Logs API with a valid two-day UTC window during uncertain
  Research submission recovery; Tavily rejects equal start and end dates.

### Changed

- Remove `tavily/research` from the v2 public catalog because Tavily does not
  provide recoverable submission custody after an ambiguous create response.
  `tavily/search` remains available.
- Remove the redundant Amp plugin and its `install-plugin` command. Amp orbs
  now use the global Librarium User Skill with the v2 CLI; repository orbs
  install and verify the exact built checkout instead of npm's v1 `latest`.

### Added

- A typed public catalog with 33 built-in providers and 40 retained public
  profiles. Descriptors are the source of truth for profile identity,
  selection, credentials, models, options, metering, execution capabilities,
  and provenance.
- Four built-in workflows:
  - `quick` is a curated low-latency set of Gemini Grounded, OpenRouter
    Grounded, Brave Answers, Exa Search, Kagi FastGPT, and Parallel Turbo.
  - `deep` is derived from implemented research-report profiles.
  - `visibility` compares six SearchAPI-collected consumer surfaces with
    first-party Perplexity, Gemini, and Grok API baselines.
  - `all` is derived from all selectable profiles that satisfy workflow policy.
- SearchAPI consumer-surface profiles for ChatGPT, Gemini, Perplexity, Google
  AI Mode, Bing Copilot, and Google AI Overview. Results preserve collector,
  surface, access, and account-context provenance. The six surfaces share one
  collector, so agreement is recorded as correlated observation rather than
  independent confirmation.
- Grok profiles for web search (`grok/web`), X-only search
  (`grok-x-only/x`), and combined web and X search
  (`grok-combined/combined`). Each profile keeps a distinct public identity in
  config, artifacts, and reports.
- Durable research profiles for Exa Research, OpenAI Research, Parallel
  Research, Perplexity Agent medium and high, Valyu Research, and You Research.
  Durable work can be resumed across processes using provider-scoped handles.
- Parallel Search profiles for advanced search and turbo search, plus Parallel
  Chat and Parallel Research. `parallel/turbo` is included in `quick`.
- Valyu Search and Research, You.com Answer, and expanded You.com Research
  profiles with validated options, lifecycle handling, usage, and citations.
- Configurable Firecrawl Search for web and news sources, locale and time
  filters, source limits, domain filters, categories, deduplicated citations,
  and provider-reported credit usage.
- Perplexity Search controls for multi-query input, country and language,
  domain allow and deny filters, result limits, context size, and extraction
  token budgets.
- A canonical execution runtime for inline, process-local background, and
  durable background providers. It includes request compilation, preflight,
  admission, dispatch, polling, retrieval, fallback, deadline, cancellation,
  custody, and reconciliation boundaries.
- Shared CLI and MCP run reconciliation backed by locked, revisioned run
  state. `status` performs one reconciliation pass before rendering;
  `status --wait --retrieve` can finish durable work without resubmitting it.
- A language-neutral TypeScript/PHP terminal contract snapshot in
  `contracts/v1`. It defines exactly `ResearchResponse`, `ResearchResult`,
  `Citation`, `Source`, `ResultProvenance`, `Usage`, and `ResearchError`, with
  generated JSON Schema, fixtures, checksums, and compatibility tests.
- Frozen pricing definitions and network-free exact estimates where the
  selected provider options make an exact pre-dispatch price possible.
  Provider-reported costs, exact estimates, metered units, and unknown costs
  remain separate. `--max-cost` and `--max-estimated-cost` provide distinct
  lower-bound and admission controls.
- A network-denied live-validation fixture mode and a separately gated,
  targeted paid-validation path. Validation receipts preserve provider,
  profile, pricing, provenance, artifact, and custody evidence.
- Five MCP tools: `research`, `get_results`, `check_async`, `list_providers`,
  and `list_groups`.
- A shipped agent skill for agent-driven v2 research workflows.
- Offline performance benchmarks, packed-consumer checks, Worker declaration
  checks, terminal contract fixtures, and deterministic network-denied demo
  replay coverage.

### Changed

- OpenAI deep research now uses `openai-research/research` on the Responses API
  with GPT-5.6 Sol by default, current web search, configurable reasoning
  effort, durable background execution, normalized URL citations, token usage,
  model overrides, and `default` or `unlimited` return-token budgets.
- Perplexity research now uses the Agent API. Sonar Pro uses the inline low
  preset, Deep Research uses durable medium, and Sonar Deep uses durable high.
  Raw `perplexity-search/search` remains a separate Search API profile.
- OpenRouter Grounded uses the `openrouter:web_search` server tool instead of
  the deprecated `:online` model suffix. OpenRouter Chat defaults to
  `openai/gpt-5.6-terra`.
- Claude defaults to `claude-sonnet-5` with a 16,000-token output limit,
  adaptive thinking, and medium effort. Gemini Chat defaults to
  `gemini-3.6-flash`.
- SearchAPI authentication now uses an `Authorization: Bearer` header rather
  than URL credentials. The optional `zeroRetention` setting sends
  `zero_retention=true` and fails closed if the account rejects it.
- SearchAPI Google now normalizes AI Overview, top stories, discussions,
  inline videos, and Knowledge Graph evidence from one request. The dedicated
  Google AI Overview profile owns the separate page-token retrieval and
  reserves two logical request units.
- CLI and MCP research use the same Node run service, lifecycle events,
  provider catalog, reconciliation path, artifact store, and report
  presentation. Machine-readable CLI output stays on stdout while progress and
  diagnostics stay on stderr.
- Provider output distinguishes direct API responses from collected consumer
  surfaces. Citations, source overlap, collection provenance, provider-reported
  usage, and estimated cost remain separate facts rather than being collapsed
  into a confidence claim.
- HTML and JSONL reports now render from the canonical run state. URLs are
  treated as untrusted identifiers and sanitized before presentation.
- The project now builds with TypeScript 7 and Zod 4. The dependency stack was
  refreshed across the CLI, build, formatting, MCP, and Worker test tooling.

### Fixed

- Prevented duplicate or unsafe background submissions across ambiguous
  responses, retries, process restarts, and concurrent CLI or MCP
  reconciliation. Provider-specific custody handling now preserves exact
  remote identities and terminalizes bounded deadlines.
- Kept Gemini Deep Research preview failures provisional until completion or
  the frozen deadline while preserving terminal cancellation and budget states.
- Hardened Exa, Parallel, Perplexity, Tavily, Valyu, and You.com background
  parsing, polling, retrieval, error classification, identity binding, and
  provenance handling.
- Rejected insecure Firecrawl result URLs and unsafe provider metadata,
  including nested credentials, access tokens, raw responses, and binary
  payloads.
- Preserved provider-reported pricing units and safe failure evidence without
  inventing USD values or replacing unknown costs with zero.
- Added atomic config and run-state writes, lock contention recovery, Windows
  owner-only ACL handling, bounded rename retries, and path-containment checks.
- Hardened Commander ingress, HTTP response limits, cancellation, retry
  boundaries, custom-provider process termination, and post-commit dispatch
  fencing.

### Removed

- `tavily/research` from the public v2 catalog because Tavily cannot provide
  recoverable custody after an ambiguous create response. `tavily/search`
  remains available.
- New submissions to OpenAI's retired `o4-mini-deep-research` and
  `o3-deep-research` models.
- Retired execution IDs `perplexity-sonar`, `perplexity-deep`,
  `perplexity-pro-search`, `perplexity-advanced-deep`, `openai-deep`, and
  `openai-deep-o3`, plus the deprecated OpenAI deep adapter wrappers.
- The legacy `async-tasks.json` store and its read, write, and fallback paths.
- Legacy public dispatcher, registry, adapter-constructor, file-runner, and raw
  keychain exports.

## [1.4.1] - 2026-07-23

### Fixed

- **`brave-answers` citations restored** (live-verified against the Answers
  API): `enable_citations` is a top-level request body parameter; nesting it
  under `web_search_options` silently disabled citations, so every answer came
  back with zero sources.
- **`brave-answers` inline `<usage>` accounting parsed** (live-verified):
  Brave delivers its cost breakdown as a trailing inline `<usage>` stream tag,
  not response headers. The raw tag previously leaked verbatim into answer
  content; it is now stripped and reported as token usage plus the
  API-reported dollar cost (`usage.costUsd` from `X-Request-Total-Cost`),
  which flows through to `metering.actual`.
- `brave-answers` token usage falls back to the final stream chunk's
  OpenAI-style `usage` counts when no inline tag is present; legacy
  `x-request-*` header parsing is retained as a further fallback.


## [1.4.0] - 2026-07-22

### Added

- **xAI Grok grounded provider** (`grok`, ai-grounded tier): queries xAI's
  official Responses API with the `web_search` tool, normalizes `url_citation`
  annotations into citations (inline `[[n]](url)` markers preserved), and
  reports honest API-reported cost converted from xAI's `cost_in_usd_ticks`.
  Defaults to `grok-4.5` with a per-provider model override (`grok-4.3` for
  cost-sensitive runs). Requires `XAI_API_KEY`. Joins the `comprehensive` and
  `all` groups only — deliberately not `quick`/`fast`, so default-group runs
  see no cost change. X/social search is intentionally excluded from requests.
- Benchmark CI guard lockstep test: every provider credential env var must be
  present in the benchmark secret blocklist.

### Changed

- **`brave-answers` migrated to Brave's Answers API** (the OpenAI-compatible
  `chat/completions` endpoint) from the deprecated Summarizer Search flow.
  Citations arrive as inline stream metadata and are normalized/deduplicated;
  usage comes from Brave's response headers; `usage.costUsd` is set only when
  Brave reports an explicit dollar figure. Provider id, env var, tier, and
  group membership are unchanged. Answer content is now the native Answers
  markdown — the adapter-fabricated `## AI Summary`/`## Web Results` headings
  are gone.
- `brave-answers` metering moved from `request_priced` (fixed $0.009 estimate)
  to `api_unit_priced` (search + token billing, units-only — no fabricated USD
  pre-dispatch estimate). `PRICING_VERSION` bumped to `2026-07`.
- Dependency refresh within existing ranges (biome 2.5.5, wrangler 4.113,
  marked, p-limit, vitest-pool-workers).

### Fixed

- Brave error messages now carry actionable hints keyed to live-verified error
  codes: an invalid key (`422 SUBSCRIPTION_TOKEN_INVALID`) points at
  `BRAVE_API_KEY`, and a key without the Answers subscription
  (`400 OPTION_NOT_IN_PLAN`) points at the plan upgrade. Grok's live-verified
  bad-key response (HTTP 400) also gets the `XAI_API_KEY` hint.
- Hardened Brave stream handling: byte-accurate response-size caps for streams
  and error bodies, JSON-string-aware citation-tag boundary parsing, malformed
  stream frames skipped instead of discarding the answer, and mid-stream
  aborts terminating hung streams without hanging on cancellation.
- README parity with the site docs: the `answer` example reflects the real
  `quick` group, the `run.json` sample documents the optional `usage`/`metering`
  fields, and the run-directory anatomy includes `answer.md` and
  `verification.json`.


## [1.3.0] - 2026-07-18

### Added
- **Opt-in claim verification**: `librarium answer --verify` extracts up to eight
  material factual claims from the synthesized answer, checks them against the
  fan-out's independent source evidence, runs at most three successful follow-up
  evidence queries (three provider attempts each, fast tiers only), and revises
  the answer only after a complete evidence-backed verification. Fails open: any
  incomplete evidence, budget exhaustion, or provider/LLM failure preserves the
  original grounded answer. A full audit trail lands in `verification.json`, the
  run manifest, `results.jsonl` (a `"type":"verification"` line), and
  `report.html`, with provider and verification-LLM spend accounted separately
  and unknown costs flagged as explicit lower bounds.
- `--no-fallback` flag on `librarium run` and `librarium answer`: disables
  configured provider fallbacks for an exact provider matrix.
- Repo-local, reproducible provider benchmark under `benchmark/` (not part of
  the npm package): curated stable and freshness-sensitive corpora, offline
  fixture replay in CI, pinned synthesis/judge configuration, resumable runs,
  and interactive confirmation before any paid call.

### Changed
- HTML report link sanitization hardened: URL-parse-based scheme allowlist,
  rejecting protocol-relative URLs, control characters, and backslashes.
- The answer/refine LLM cascade now records normalized token usage and reported
  cost per attempt.
- Claim selection treats modal statements with active verbs ("may require X")
  as checkable claims; only explicit hedges are excluded from verification.


## [1.1.0] - 2026-06-29

### Added
- **Guided first-run onboarding**: bare `librarium` now starts a setup wizard when no usable providers are configured. The flow explains what Librarium does, links to the docs, recommends starter providers, keeps the full provider list available, shows provider descriptions/setup URLs, prompts for API keys with masked input, and saves only providers with usable credentials.
- **Credential storage choices**: onboarding and `librarium config` support OS keychain storage, private shell env-file storage (`~/.config/librarium/env` or `env.fish`), and config-file fallback. Keychain/config/env references now resolve through the same credential layer across provider dispatch, `answer`, `refine`, the wizard, and MCP research.
- **First-query guidance from onboarding**: setup now offers to run a first query immediately. When an OpenAI, Gemini, or Perplexity synthesis key is configured, the first query uses the same grounded synthesis hook as `librarium answer` so the terminal shows the synthesized answer and writes `answer.md`; otherwise it shows the provider run summary and explains how to enable synthesis later.
- **Provider catalog and config menu**: providers now have catalog metadata for setup URLs, descriptions, family labels, recommendations, and alphabetical browsing. `librarium config` can configure providers/API keys and settings such as `defaults.llmWebSearch`.
- **LLM web search and citations**: LLM-tier providers can use provider-native web search/citations by default, with opt-out via `defaults.llmWebSearch: false` or per-provider `options.webSearch: false`. LLM providers remain opt-in for normal grounded runs.
- **Provider metering capability registry** (`librarium/core`): every provider now declares a `metering_kind` (`native_cost`, `native_tokens`, `request_priced`, `credit_priced`, `api_unit_priced`, or `manual_unmetered`), visible in `librarium ls` and `ls --json`. A network-free `estimateMetering()` returns a pre-dispatch estimate (`estimatedCostUsd`, `billableUnits`, `unit`, `pricingVersion`, `costConfidence`) without any API call, and `buildProviderMetering()` is the single normalization path used across sync dispatch, fallback, and async retrieval. New `getMeteringKind()`, `estimateMetering()`, `buildProviderMetering()`, and `createEstimateBudgetTracker()` exports.
- **`--max-estimated-cost <usd>` flag** (and `defaults.maxEstimatedCostUsd`) on `run` and `answer`: a pre-dispatch *reservation* ceiling that reserves each provider's estimated cost before it launches and skips launches once the estimate crosses the ceiling. Independent of the reported-only `--max-cost` (the two never reconcile); providers with no estimable cost reserve `0`.
- Metering is exposed through dispatch results, `run.json`, per-provider `.meta.json` (CLI run, MCP `research`, and both async-retrieval paths: `status --retrieve` and the MCP `check_async` tool), `results.jsonl`, MCP shaping, and the `usage` command (a separate `est. cost` lane).

### Changed
- `librarium init` now routes interactive setup through the onboarding wizard. `init --auto` remains non-interactive, but LLM-tier providers stay opt-in even when their shared API keys are present.
- Explicit `-p` and `--group` selections can use credentialed providers that are not enabled in config, which lets users opt into LLM providers on demand without making them part of default runs.

### Notes
- Honesty preserved: `usage.costUsd` remains provider-reported only. Estimates live under `metering.estimate` and never become facts; plan-dependent credit/API-unit providers emit unit metadata without a fabricated USD figure until pricing is configured via provider `options`. Actual-cost provenance is recorded under `metering.actual.source`.

## [1.0.0] - 2026-06-12

The first stable release: the 0.1.x research fan-out core plus a complete interactive and agent-integration layer shipped in one release -- live per-provider results table, interactive wizard, results browser with a fullscreen reader, HTML and JSONL reports, grounded `answer` synthesis, an MCP server, an `llm` provider tier, spend guardrails, true async deep research on Perplexity and Gemini, and committed PTY test coverage.

### Added
- New `librarium/node` package export: the documented Node-only bridge for loading npm- and script-based custom providers from library code (previously CLI-only). Exposes `loadCustomProviders(config, options?)` (loads with the same `trustedProviderIds` gating and reserved-ID protection the CLI uses, without registering) and `registerCustomProviders(config, options?)` (loads and registers into the core registry). The CLI now routes through this shared loader (one implementation, two callers); `librarium/core` stays Node-free, and edge users keep using fetch-based `registerProvider()`. The `core` and `node` entries are built with code splitting so the published dist shares a single provider-registry module instance: registrations made via `librarium/node` are visible to `getProvider()`/`dispatch()` imported from `librarium/core`, and reserved-ID protection sees core's registered built-ins
- Deep-research pre-flight confirm: in an interactive terminal, a `librarium run` that would dispatch three or more deep-research-tier providers shows a confirm first, listing the providers and warning that deep research takes minutes and bills per call. `-y, --yes` skips it. Non-TTY runs (pipes, CI) never prompt and are never refused, so scripts never hang. The wizard's own confirm counts as consent, so it never double-prompts
- `librarium run --max-cost <usd>` and the `defaults.maxCostUsd` config key (flag wins): an honest runtime cost circuit breaker, not an estimator. As provider results arrive, librarium accumulates each provider's API-reported `costUsd`; once the accumulated total crosses the budget, not-yet-started providers are skipped (shown as `skipped` in the table and `run.json` with a budget reason) while in-flight requests finish. The summary adds a `▸ budget reached: $X reported of $Y budget, skipped N providers` line. Only API-reported costs count (providers that report nothing count as 0); deep-research async costs land at retrieval and cannot be pre-metered. Core `dispatch()` gains an optional additive `budget` option (a `BudgetTracker` from the new `librarium/core` `budget` module)
- `librarium usage [--days N] [--json]`: aggregates the `run.json` manifests under the output base dir into per-provider totals (API-reported cost, tokens, run count), overall run count, total reported cost, and date range, rendered as an aligned table. `--days` filters by manifest timestamp; the output notes how many runs had no reported usage. Only API-reported costs are counted (honest lower bounds, never pricing-table estimates)
- PTY smoke test suite (`npm run test:pty`) covering librarium's interactive terminal flows end-to-end against the built CLI: the live run table (rows resolving to ✓/◷/✗, fallback `↳` notice and recovered row, summary lines, cursor restore), the wizard (query → group → mode → confirm → run → decline browse), `browse` + the fullscreen pager (status-line landmark, scroll, balanced alt-screen on exit), and Ctrl+C mid-run cursor restore with non-zero exit. Tests spawn the CLI in a real pseudo-terminal (`node-pty`, a dev dependency) against committed offline mock script providers with an isolated per-test `HOME`, so they're deterministic and never touch the user's real config. The suite is excluded from the default `npm test`, builds the CLI first, skips cleanly on Windows or when `node-pty` is unavailable, and runs in CI on Ubuntu + macOS (Node 22). See `tests/pty/README.md`
- `librarium run --providers` now accepts human-friendly provider display names in addition to canonical IDs and legacy aliases. Matching is case- and punctuation-insensitive (`"Exa Search"`, `exa-search`, and `EXA SEARCH` all resolve to `exa`). Display-name matches emit no warning (legacy aliases still warn). Ambiguous names error with the candidate list; unrecognized names error with up to three `id (Display Name)` suggestions. Names are a CLI input convenience; config files (provider keys, custom groups, fallback targets) still require canonical IDs or legacy aliases
- `librarium mcp`: start an MCP (Model Context Protocol) server over stdio so AI agents can drive librarium directly through tool calls. Register with `claude mcp add librarium -- librarium mcp` or any MCP client's stdio config. Exposes five tools: `research` (full run with the same file outputs as `run`, returning a compact structured result with per-provider tallies, top deduped sources capped at 25, and pending async task ids; provider text is not inlined), `get_results` (provider markdown from a run dir, default most recent, capped ~40k chars per provider with a truncation marker), `check_async` (one non-blocking poll pass over pending async tasks, optionally retrieving completed ones), `list_providers`, and `list_groups`. In MCP mode stdout carries only the protocol stream (all diagnostics route to stderr) and the research path uses the silent file-writing pipeline, not the interactive table. The new `@modelcontextprotocol/sdk` dependency is CLI-layer only; `librarium/core` stays dependency-clean
- `librarium answer <query>`: a grounded, cited quick-answer mode. Fans out exactly like `run` (defaulting to the `quick` group, overridable with `-g`/`-p`/`-m` and the usual run flags), then makes one LLM synthesis call over the successful providers' content plus the deduped source list. The model is instructed to answer only from the findings, cite with inline `[n]` indices that map to the numbered source list, and state what is uncertain rather than invent; per-provider content is truncated to a budget so the call stays affordable. The answer renders in the terminal through the markdown-ansi renderer followed by a hyperlinked numbered source list, and is written to `answer.md` in the run directory with `answer: {provider, model}` recorded additively in `run.json`. Synthesis fails open: if every client fails, a detailed warning prints and the run summary and output directory still appear, so the research is never lost, and the exit code reflects the run rather than the synthesis. The synthesis call shares `refine`'s key-based client resolution and cascade (OpenAI `gpt-5-mini`, then Gemini `gemini-2.5-flash`, then Perplexity `sonar`) with a longer 90s timeout, overridable via an `answer: {provider, model}` config key that falls back to the `refine` config.
- New `llm` provider tier with four ungrounded LLM adapters -- `claude` (Anthropic Messages API, `ANTHROPIC_API_KEY`), `openai-chat` (OpenAI chat completions, `OPENAI_API_KEY`), `gemini-chat` (Gemini `generateContent` with no grounding, `GEMINI_API_KEY`), and `openrouter-chat` (OpenRouter chat completions, `OPENROUTER_API_KEY`). Each returns the model's direct answer to the research prompt with **no citations** and contributes zero sources, so the dedupe pipeline, `sources.json`, and report tallies are unaffected. Each takes a cheap default model (haiku/gpt-5-mini/flash class) with a per-provider `model` config override. `openrouter-chat` requests usage accounting so it reports cost in USD when available. Provider count goes from 20 to 24
- New default group `llm` (`claude, openai-chat, gemini-chat, openrouter-chat`) for opt-in ungrounded baseline/contrast. The `llm` tier is **excluded from every grounded group** (`quick`, `fast`, `raw`, `deep`, `comprehensive`, `all`); `all` keeps its grounded-all semantics. Opt in via `-p`, a custom group, or `--group llm`. In the run table, `llm`-tier rows render a dim `ungrounded` in place of the source count
- `librarium clear` and `librarium cleanup --all`: delete every run directory regardless of age (one implementation, two names). In a terminal `--all` shows an interactive confirm with run count and total size on disk before deleting; in a non-TTY context it refuses unless `--yes` is passed. `--dry-run` lists what would go (count, total size, oldest/newest) without deleting, and deletion reports a human-readable freed-space figure
- `librarium clear -i` / `cleanup -i`: interactive multiselect of runs (date, query, size, pending-async marker) to delete exactly the chosen ones with a confirm. Runs with pending async tasks are flagged in the list hint and called out in the confirm, since deleting one orphans the server-side task handle
- Cleanup safety guards: every candidate path is verified to be strictly inside the resolved output base dir before removal, and the command refuses to operate when the base dir resolves to your home directory or a filesystem root
- Live per-provider results table for `librarium run`: each provider prints an aligned status line as it finishes (✓ success / ✗ error with reason / ◷ async-submitted), with tier, duration, and source/result counts, plus an indented `↳ falling back to …` notice when a fallback fires
- Resolve-in-place rendering in interactive terminals: all provider rows print at fan-out with an animated spinner glyph and ticking elapsed time, then update in place as results arrive (non-TTY and NO_COLOR environments keep append-on-completion output)
- End-of-run summary with `▸` unique-source and output-directory lines, and a `librarium status --wait` hint when async tasks are pending
- Wall-clock total on the tallies line (`4 succeeded, 0 failed, 0 async pending in 13.3s`) and a yellow highlight on provider durations of 10s or more
- `librarium run --open`: opens the output directory when the run completes (`open` on macOS, `xdg-open` on Linux)
- `librarium status --wait` / `--retrieve` now render retrieved results with the same table line format as `run`, with the output file and word count as a dim suffix
- Dispatcher progress events now include the provider report on `error` and `async-submitted` events (additive; `ProgressEvent.report` was already optional)
- Interactive wizard: bare `librarium` in a terminal prompts for query, providers (enabled set, a group with tier-breakdown hints, or hand-picked), and mode, confirms, then runs the standard flow with the live table and offers to browse the results (non-TTY bare invocations keep printing help)
- `librarium browse`: results browser over past run manifests; pick a recent run (date, query, tallies), see providers in the run table format, and open any provider's result or the run's summary.md in the built-in reader
- Fullscreen in-terminal reader for `browse`: provider markdown rendered with ANSI styling (bold headings, dim inline code and indented code blocks, normalized list bullets, blockquote gutters, OSC 8 hyperlinks) and hard-wrapped to the terminal width, re-wrapping on resize. Scroll with j/k or arrow keys, page with space/b or PageDown/PageUp, jump with g/G, press o to open the raw file in `$PAGER` (fallback `less -R`), q or escape to go back. Replaces the old static 25-line preview
- New CLI-only dependency `@clack/prompts` powers the wizard and browser; `librarium/core` remains dependency-clean
- `librarium run --html`: writes a self-contained `report.html` into the run directory (query title, run metadata, provider results table as native `<details>` blocks with rendered markdown, deduped sources with provider attribution); with `--open` the report opens instead of the directory
- `librarium html [run-dir]`: regenerates the report for any existing run (default: most recent), also available as an "export HTML report" action in `browse`; `status --retrieve` regenerates an existing report.html so retrieved deep-research results fill in
- Report styling matches the marketing site (inline CSS only): IBM Plex Mono and Geist via Google Fonts with swap fallbacks, white background, neutral text scale, amber accents, dark rounded code blocks. Markdown is rendered with `marked` (CLI-layer dependency) with raw HTML escaped so provider output cannot inject script; external links get `rel="noopener"`
- `librarium ls` dims providers that have no entry in config (API Key shows "Not configured") and suggests `librarium init --auto` when builtins are missing; `librarium doctor` warns about builtin providers absent from config
- `librarium run --open` now also works on Windows (`cmd /c start`)
- Usage and cost tracking (honest data only): a normalized optional `usage` object (`inputTokens`, `outputTokens`, `totalTokens`, `costUsd`, `raw`) on `ProviderResult`/`ProviderDispatchResult`/`ProviderReport`, populated from whatever each provider's API actually reports (never estimated from pricing tables). Shown as a dim suffix on run table lines (`· 8.4k tok`, `· $0.012`), included in `.meta.json` and `run.json`, surfaced in `report.html`, and totaled in a `▸ reported cost` summary line when at least one provider reported cost
- `librarium run --refine` and standalone `librarium refine <goal>`: one LLM call rewrites the query into tier-tuned variants (deep-research brief, ai-grounded question, raw-search keywords) which dispatch per tier; variants are recorded in `run.json` and `prompt.md`. Client resolution: OpenAI, then Gemini, then Perplexity by available API key, overridable via the `refine` config key; refine failures never break a run. The wizard offers refine as a toggle. Core `dispatch()` gains an optional additive `tierQueries` override
- `librarium completions <zsh|bash|fish>`: static shell completion scripts covering commands, flags, and builtin group names

- `librarium html --open` opens the generated report, and the browse "export HTML report" action offers to open it in the browser
- `librarium run --jsonl`: writes a `results.jsonl` (JSONL / newline-delimited JSON) into the run directory alongside other outputs; `--jsonl` and `--html` are independent and combinable
- `librarium jsonl [run-dir]`: regenerates `results.jsonl` for any existing run (default: most recent); also available as an "export JSONL" action in `librarium browse`
- `status --retrieve` regenerates an existing `results.jsonl` automatically when one is present, keeping it in sync with retrieved async deep-research results
- JSONL format: line 1 is a run header (`type:run`) with counts and optional refinedQueries; one line per provider (`type:result`) with full markdown content embedded (null when missing or pending); one line per deduped source (`type:source`); undefined-valued keys are omitted throughout
- Printed paths are now clickable in modern terminals via OSC 8 hyperlinks (output directory summary line, report.html paths from run --html, librarium html, browse export, and the status --retrieve regeneration notice); non-TTY and NO_COLOR output stays plain

### Changed
- HTML report layout: the provider table now drives tabs instead of accordions. Each single-line row (glyph, provider, tier, duration, result count or truncated error with full title tooltip, right-aligned usage) is a real tab trigger with aria-selected and arrow-key support; one panel below shows the active provider's full rendered output (default: first success). Sources move into their own tab so long lists no longer render on initial view; the unique-source count stays in the always-visible meta line. Content column widened to 940px; tiny inline vanilla JS with a noscript fallback that stacks all panels
- Perplexity Sonar/provider paths now use the shared `/v1/agent` client. Grounded
  Sonar Pro uses Agent low inline; Deep Research uses durable Agent medium; and
  Sonar Deep uses durable Agent high. Accepted background submissions persist
  the provider id and never resubmit after an ambiguous write.
- `gemini-deep` now runs Google's real Deep Research agent via the Interactions API (`POST /v1beta/interactions` with `background: true`, polled via `GET /v1beta/interactions/{id}`) instead of a synchronous `generateContent` imitation. Mixed and async modes submit and return immediately; `librarium status --wait --retrieve` polls and retrieves like the other async deep providers. Sync mode polls inline within `asyncTimeout`. Citations are extracted from `url_citation` annotations on the report text (real source URLs), and token usage is taken from the interaction's `usage` totals. Defaults to the `deep-research-preview-04-2026` agent; set `model` to `deep-research-max-preview-04-2026` for the heavier variant
- Refine failures now include the API's own error detail (code and message, truncated), and refine cascades to the next available provider (openai, then gemini, then perplexity) before falling back to the original query; an explicit `refine.provider` pin disables the cascade
- Wizard copy: execution modes explain themselves (mixed recommended), the refine toggle gets a one-line explainer and is skipped entirely when no refine-capable API key is configured
- `librarium run --json` now keeps stdout pure JSON: all pretty/table output is routed to stderr in that mode

### Fixed
- README groups table said the `all` group covers 18 providers; there are 20 builtin adapters



### Previously staged (never published as 0.2.0; first shipped here)

#### Added
- `librarium/core` package export for programmatic use from Workers-compatible runtimes
- Structured in-memory dispatch results with provider text, citations/source URLs, duration, status, and errors
- Gemini Grounded Search provider adapter: `gemini-grounded` — Gemini `gemini-2.5-flash` with the `googleSearch` tool
- OpenRouter Online Search provider adapter: `openrouter-online` — OpenRouter `openai/gpt-4o-mini:online` with Exa-backed grounding annotations
- Cloudflare Workers compatibility test suite using `@cloudflare/vitest-pool-workers`

#### Changed
- Split core orchestration from CLI filesystem output so the CLI consumes the same in-memory dispatcher API exported by `librarium/core`
- Provider API key resolution now flows through injectable credentials while the CLI preserves `$ENV_VAR` resolution from `process.env`

## [0.1.3] - 2026-04-11

### Added
- Firecrawl Search provider adapter: `firecrawl-search` — web search via Firecrawl v2 Search API (raw-search tier)
- OpenAI Deep Research (o3) provider adapter: `openai-deep-o3` — higher-quality deep research using the o3-deep-research model
- You.com Research provider adapter: `you-research` — AI-powered research with cited answers (ai-grounded tier)
- Jina AI Search provider adapter: `jina-search` — search-to-markdown API for LLM-native content (raw-search tier)
- Kagi FastGPT provider adapter: `kagi-fastgpt` — AI answers with curated, ad-free sources (ai-grounded tier)

### Fixed
- Perplexity Agent API endpoint updated from `/v1/responses` to canonical `/v1/agent` — fixes HTTP 400 errors for the canonical Agent providers (`perplexity-sonar-pro`, `perplexity-sonar-deep`, `perplexity-deep-research`) in both health checks and live queries
- Perplexity Deep Research health check: removed unsupported `max_output_tokens` parameter from test request
- OpenAI Deep Research health check failing with HTTP 404 — deep research models don't appear in `/v1/models` endpoint; test now verifies API key via general models list

## [0.1.2] - 2026-02-23

### Added
- Perplexity Agent API provider adapters: `perplexity-deep-research` and `perplexity-advanced-deep`
- Perplexity Search API provider adapter: `perplexity-search` (raw-search tier)

### Changed
- Renamed Perplexity provider IDs to match current product naming:
  - `perplexity-sonar` -> `perplexity-sonar-pro`
  - `perplexity-deep` -> `perplexity-sonar-deep`
- Updated default provider groups and docs to include 13 total providers

### Fixed
- Added backward-compatible legacy ID support for `perplexity-sonar` and `perplexity-deep` across CLI provider selection, config provider keys, group members, and fallback targets
- `librarium ls` output table now uses dynamic column widths for long provider IDs


## [0.1.1] - 2026-02-23

### Added
- Provider-level fallback on failure — optional `fallback` field in provider config triggers a backup provider when the primary fails for any reason (exception, error response, or timeout). Fallback providers can be `enabled: false` to only activate as backups. ([#2](https://github.com/jkudish/librarium/issues/2) — thanks @taocoding99)


## [0.1.0] - 2026-02-21

### Added
- Multi-provider parallel dispatch with `p-limit` and progress callbacks
- 10 provider adapters across three tiers: deep-research (Perplexity Deep, OpenAI Deep, Gemini Deep), ai-grounded (Perplexity Sonar, Brave Answers, Exa), raw-search (Brave Search, SearchAPI, SerpAPI, Tavily)
- Mixed async mode: sync providers return immediately, deep-research providers submit background tasks
- Cross-provider citation deduplication with URL normalization (strips tracking params, www, trailing slashes)
- Layered configuration: global (`~/.config/librarium/config.json`) -> project (`.librarium.json`) -> CLI flags
- `$ENV_VAR` pattern for API keys in config (resolved at runtime, never stored in plaintext)
- Commands: `run`, `status`, `ls`, `groups`, `init`, `doctor`, `config`, `cleanup`
- Provider groups: `deep`, `quick`, `raw`, `fast`, `comprehensive`, `all` with custom group support
- Structured output: `run.json` manifest, `summary.md`, `sources.json`, per-provider `.md` and `.meta.json`
- Async task management with `status --wait` polling and `status --retrieve` for completed results
- Claude Code skill (`SKILL.md`) with 7-phase research workflow
- Atomic file writes via temp+rename pattern
- Standalone binaries via Node.js Single Executable Applications (SEA) for Linux (x64, arm64), macOS (x64, arm64), and Windows (x64)
- Curl-based installer script (`scripts/install.sh`) for one-line binary installation
- Homebrew tap (`brew install jkudish/tap/librarium`) for macOS and Linux
- Install method detection (`detectInstallMethod()`) supporting npm, pnpm, yarn, Homebrew, and standalone binary
- Multi-method upgrade command — `librarium upgrade` auto-detects install method and uses the correct upgrade path
- GitHub Releases with platform binaries attached automatically on release
- `build:sea` script for building standalone executables locally

### Security
- Sanitize provider IDs before use in filenames
- API keys use environment variable references, never stored in plaintext
- Response size guard (10MB) on HTTP client

[Unreleased]: https://github.com/jkudish/librarium/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/jkudish/librarium/compare/v1.4.1...v2.0.0
[1.1.0]: https://github.com/jkudish/librarium/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/jkudish/librarium/releases/tag/v1.0.0
[0.2.0]: https://github.com/jkudish/librarium/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/jkudish/librarium/compare/v0.1.2...v0.1.3
[0.1.0]: https://github.com/jkudish/librarium/releases/tag/v0.1.0
[0.1.1]: https://github.com/jkudish/librarium/compare/v0.1.0...v0.1.1
[0.1.2]: https://github.com/jkudish/librarium/compare/v0.1.1...v0.1.2
[1.3.0]: https://github.com/jkudish/librarium/releases/tag/v1.3.0
[1.4.0]: https://github.com/jkudish/librarium/releases/tag/v1.4.0
[1.4.1]: https://github.com/jkudish/librarium/releases/tag/v1.4.1
