# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Security
- Sanitize provider IDs before use in filenames
- API keys use environment variable references, never stored in plaintext
- Response size guard (10MB) on HTTP client

[Unreleased]: https://github.com/jkudish/librarium/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jkudish/librarium/releases/tag/v0.1.0
