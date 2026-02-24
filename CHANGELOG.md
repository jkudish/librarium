# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/jkudish/librarium/compare/v0.1.2...HEAD
[0.1.0]: https://github.com/jkudish/librarium/releases/tag/v0.1.0
[0.1.1]: https://github.com/jkudish/librarium/releases/tag/v0.1.1
[0.1.2]: https://github.com/jkudish/librarium/releases/tag/v0.1.2
