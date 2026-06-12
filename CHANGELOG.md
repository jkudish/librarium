# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `librarium run --providers` now accepts human-friendly provider display names in addition to canonical IDs and legacy aliases. Matching is case- and punctuation-insensitive (`"Exa Search"`, `exa-search`, and `EXA SEARCH` all resolve to `exa`). Display-name matches emit no warning (legacy aliases still warn). Ambiguous names error with the candidate list; unrecognized names error with up to three `id (Display Name)` suggestions. Names are a CLI input convenience; config files (provider keys, custom groups, fallback targets) still require canonical IDs or legacy aliases
- `librarium mcp`: start an MCP (Model Context Protocol) server over stdio so AI agents can drive librarium directly through tool calls. Register with `claude mcp add librarium -- librarium mcp` or any MCP client's stdio config. Exposes five tools: `research` (full run with the same file outputs as `run`, returning a compact structured result with per-provider tallies, top deduped sources capped at 25, and pending async task ids; provider text is not inlined), `get_results` (provider markdown from a run dir, default most recent, capped ~40k chars per provider with a truncation marker), `check_async` (one non-blocking poll pass over pending async tasks, optionally retrieving completed ones), `list_providers`, and `list_groups`. In MCP mode stdout carries only the protocol stream (all diagnostics route to stderr) and the research path uses the silent file-writing pipeline, not the interactive table. The new `@modelcontextprotocol/sdk` dependency is CLI-layer only; `librarium/core` stays dependency-clean
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
- `perplexity-sonar-deep` now uses Perplexity's Async Sonar API (`POST /v1/async/sonar`, polled via `GET /v1/async/sonar/{id}`): mixed and async modes submit and return immediately instead of blocking for minutes, and `librarium status --wait --retrieve` polls and retrieves like openai-deep tasks. Retrieved results keep token usage and API-reported cost, and prefer `search_results` (titles, snippets) for citations. Sync mode is unchanged. `perplexity-deep-research` and `perplexity-advanced-deep` still complete inline: Perplexity's Agent API has no background mode
- Refine failures now include the API's own error detail (code and message, truncated), and refine cascades to the next available provider (openai, then gemini, then perplexity) before falling back to the original query; an explicit `refine.provider` pin disables the cascade
- Wizard copy: execution modes explain themselves (mixed recommended), the refine toggle gets a one-line explainer and is skipped entirely when no refine-capable API key is configured
- `librarium run --json` now keeps stdout pure JSON: all pretty/table output is routed to stderr in that mode

### Fixed
- README groups table said the `all` group covers 18 providers; there are 20 builtin adapters

## [0.2.0] - 2026-06-11

### Added
- `librarium/core` package export for programmatic use from Workers-compatible runtimes
- Structured in-memory dispatch results with provider text, citations/source URLs, duration, status, and errors
- Gemini Grounded Search provider adapter: `gemini-grounded` — Gemini `gemini-2.5-flash` with the `googleSearch` tool
- OpenRouter Online Search provider adapter: `openrouter-online` — OpenRouter `openai/gpt-4o-mini:online` with Exa-backed grounding annotations
- Cloudflare Workers compatibility test suite using `@cloudflare/vitest-pool-workers`

### Changed
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
- Perplexity Agent API endpoint updated from `/v1/responses` to canonical `/v1/agent` — fixes HTTP 400 errors for all Perplexity Agent providers (`perplexity-sonar-deep`, `perplexity-deep-research`, `perplexity-advanced-deep`) in both health checks and live queries
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

[Unreleased]: https://github.com/jkudish/librarium/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jkudish/librarium/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/jkudish/librarium/compare/v0.1.2...v0.1.3
[0.1.0]: https://github.com/jkudish/librarium/releases/tag/v0.1.0
[0.1.1]: https://github.com/jkudish/librarium/compare/v0.1.0...v0.1.1
[0.1.2]: https://github.com/jkudish/librarium/compare/v0.1.1...v0.1.2
