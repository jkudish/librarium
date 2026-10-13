# Changelog

## 2.0.0 — Unreleased

Librarium 2.0 uses the approved simplified-surface spec. This candidate is not
a claim that npm, Homebrew or standalone releases have been published.
See the [v1 → 2.0 migration guide](docs/migration-v1-to-v2.md) before upgrading.

- Public CLI: `research`, `show`, `summarize`, `sources`, `groups add|remove`,
  `setup`, `mcp`. `setup --check` is offline configuration diagnosis.
- Kept tools read the new Run layout: `browse`, `html`, `jsonl`, `usage`,
  `cleanup`, `config`, `completions`, `upgrade`, `install-skill`.
- MCP exposes exactly `research`, `get_run`, `list_sources`; bounded waiting
  defaults to 45 seconds, maximum 50. Per-call caps can only lower config caps.
- Library clients expose `research`, `get`, `sources`, `summarize`.
  `librarium/core` defaults to runtime-neutral memory storage;
  `librarium` and `librarium/node` load config and use filesystem storage.
- Flat sources replace public variant selectors. Depth selects quick/deep.
  Engines are named-only and carry `observation: "surface"`. Saved groups
  contain source lists; no built-in groups, modes, or fallback substitution.
- Every non-dry-run request creates a stored Run before provider calls.
  Deep tasks resume from private handles with coordinator CAS protection.
- Money stays exact decimal USD. Unknown reported cost is `null`, not `"0"`;
  estimates never replace provider-reported charges. Budget admission skips
  unpriced sources and greedily admits bounded sources in catalog order.
- RunStore has four methods and ships memory/filesystem implementations plus
  a `librarium/testing` conformance runner. Config can load a custom store.
  Public `run.json` and versioned private `state.json` share the PHP layout.
- V1 config migrates automatically to v3 only after writing a backup.
  V2 config never shipped. Old run directories are not read by `show`.
- Synthesis creates a separate Run linked by `summary_of`, uses an explicit
  or deterministically selected source, and never cascades after failure.
- Shared `librarium-spec` schemas/catalog/fixtures replace `contracts/v1`.
- Existing provider adapters, pricing, redaction, deadlines, durable task
  machinery and coordinator remain the execution engine.
