<p align="center">
  <img src="art/gh-og.png" alt="Librarium" width="100%" />
</p>

<h1 align="center">Librarium</h1>

<p align="center"><strong>Evidence-aware, multi-provider research for people and agents.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/librarium"><img src="https://img.shields.io/npm/v/librarium?color=cb3837&label=npm" alt="npm version" /></a>
  <a href="https://github.com/jkudish/librarium/actions/workflows/ci.yml"><img src="https://github.com/jkudish/librarium/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://github.com/jkudish/librarium/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/librarium?color=blue" alt="License: MIT" /></a>
  <img src="https://img.shields.io/node/v/librarium?color=5fa04e" alt="Node >= 22.12" />
</p>

<p align="center">
  <a href="https://librarium.agentsy.build"><strong>Website</strong></a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#v2-catalog">Catalog</a> ·
  <a href="#cli">CLI</a> ·
  <a href="#for-agents">Agents</a>
</p>

<p align="center">
  <img src="art/demo.gif" alt="Offline Librarium canonical fixture replay in the terminal" width="100%" />
</p>

## What Librarium does

Librarium plans a research request against explicit provider profiles, executes
the selected work, and records what happened. It can combine web search,
grounded answers, consumer-surface observations, and durable research jobs.
It does not turn agreement into proof. Results preserve their collection and
access provenance so a caller can judge what each result means.

Version 2 separates the product into three import boundaries:

| Import | Use it for | It never does on import |
| --- | --- | --- |
| `librarium` | Worker-safe schemas, config migration, and the public catalog | Read the host, load adapters, access credentials, start the CLI, or write files |
| `librarium/core` | Injected catalog, planning, transport, coordination, and execution ports | Construct concrete provider adapters or a global registry |
| `librarium/node` | Explicit Node config-file services, trusted custom-provider loading, and canonical validation helpers | Promise a general high-level library runner or a portable persistence layer |

The `librarium` executable remains the complete Node application for research
runs. Node package installs require Node.js **22.12 or newer**. Standalone and
Homebrew binaries include their own runtime.

## Quick start

```bash
npm install -g librarium

# Configure credentials and select providers interactively.
librarium init

# Run a bounded selection.
librarium run "PostgreSQL connection pooling" --group quick

# Or make an evidence-bounded answer from the quick workflow.
librarium answer "What changed in PostgreSQL 17?" --verify
```

Use `librarium doctor` before a paid run when you want to check configured
providers. `librarium run --json` sends only JSON to standard output; progress
and diagnostics go to standard error.

## V2 catalog

The v2 catalog has **33 built-in providers** and **40 implemented public
profiles**. A profile is the unit of selection and provenance:
`provider_id/profile_id`. A provider can expose more than one profile, such as
`exa/search` and the durable `exa/research` profile. Adapter IDs are a Node
implementation detail; do not persist an internal adapter ID as public v2
configuration.

### Workflows

Only these four names are built in:

| Workflow | Membership | Purpose |
| --- | --- | --- |
| `quick` | Curated: `gemini-grounded/grounded`, `openrouter/grounded`, `brave-answers/grounded`, `exa/search`, `kagi-fastgpt/grounded` | Low-latency discovery and cited answers |
| `deep` | Derived from implemented research-report profiles | Longer research jobs, including durable and process-local profiles |
| `visibility` | Curated: six SearchAPI-collected surfaces, then `perplexity-sonar-pro/grounded`, `gemini-grounded/grounded`, `grok/web` | Compare labelled consumer-surface observations with first-party API baselines |
| `all` | Derived from implemented catalog capabilities | All selectable profiles that satisfy the workflow policy |

Custom groups must be stored and selected as `custom:<name>`. The old built-in
names `raw`, `fast`, `llm`, `models`, `comprehensive`, `social`, and `xai` are
not v2 workflows. During v1 migration, authored groups become `custom:<name>`
rather than silently replacing a reserved workflow.

### Provider/profile roster

This is the public catalog roster. `background/durable` means that the profile
has a persisted, provider-scoped handle that can be polled and retrieved across
processes. `background/process-local` can continue only while the owning
process state remains available. All other profiles are `inline/none`.

| Provider | Public profiles |
| --- | --- |
| Brave | `brave-search/search`, `brave-answers/grounded` |
| Claude | `claude/chat` |
| Exa | `exa/search`, `exa/research` (background/durable) |
| Firecrawl | `firecrawl-search/search` |
| Gemini | `gemini-grounded/grounded`, `gemini-deep/research` (background/durable), `gemini-chat/chat` |
| Grok (xAI) | `grok/web`, `grok-x-only/x`, `grok-combined/combined` |
| Jina | `jina-search/search` |
| Kagi | `kagi-fastgpt/grounded` |
| OpenAI | `openai-research/research` (background/durable), `openai-chat/chat` |
| OpenRouter | `openrouter/grounded`, `openrouter/chat` |
| Parallel | `parallel/search`, `parallel/chat`, `parallel/research` (background/durable) |
| Perplexity | `perplexity-search/search` (raw Search, unchanged), `perplexity-sonar-pro/grounded` (Agent low, inline), `perplexity-deep-research/research` (Agent medium, background/durable), `perplexity-sonar-deep/research` (Agent high, background/durable) |
| SearchAPI | `searchapi/search`, `searchapi-chatgpt/surface`, `searchapi-gemini/surface`, `searchapi-perplexity/surface`, `searchapi-google-ai-mode/surface`, `searchapi-bing-copilot/surface`, `searchapi-google-ai-overview/surface` |
| SerpAPI | `serpapi/search` |
| Tavily | `tavily/search`, `tavily/research` (background/durable) |
| Valyu | `valyu/search`, `valyu/research` (background/durable; exact-profile remote cancellation is advertised) |
| You.com | `you-research/grounded`, `you-research/research` (background/durable), `you-answer/grounded` |

`grok-x-only/x` is the X-only profile. `grok-combined/combined` is a separate
combined-search profile; it is not an alias for `grok/web` and must retain its
own identity in configuration, artifacts, and reports.

### What evidence means

- A direct API response is `api_output`. It reports the response returned by
  the named API; it does not make a result universally correct.
- SearchAPI consumer profiles are `surface_snapshot` records collected by
  SearchAPI. They are not official OpenAI, Google, Microsoft, or Perplexity
  APIs. They do not establish parity with a specific account, location,
  subscription, experiment cohort, or time.
- The six SearchAPI consumer surfaces share one collector. Agreement between
  them is correlated visibility evidence, not six independent confirmations.
- A citation is a source reference supplied or normalized for a result. It is
  not a guarantee that the source is safe to fetch, authoritative, reachable,
  or supportive of every nearby claim. Treat URLs as untrusted identifiers.
- Provenance records the provider/profile, operator, access mode, optional
  collector and surface IDs, and the unknown account/personalization context
  where that context is not disclosed. It records what happened; it is not a
  confidence score or a claim of consumer behaviour.

## CLI

### `run`

```bash
librarium run <query> [options]
```

| Option | Meaning |
| --- | --- |
| `--providers <ids>` | Comma-separated provider IDs for the Node CLI compatibility layer |
| `--group <name>` | Select a group or v2 workflow |
| `--mode <mode>` | `sync`, `async`, or `mixed` execution |
| `--output <dir>` | Run-directory base path |
| `--parallel <n>` / `--timeout <n>` | Concurrency and per-provider timeout limits |
| `--max-cost <usd>` | Stop launching not-yet-started calls once provider-reported spend crosses this bound |
| `--max-estimated-cost <usd>` | Reserve only known exact pre-dispatch estimates; do not interpret an omitted estimate as free |
| `--yes` / `--no-fallback` | Skip the deep preflight confirmation / require the exact primary matrix |
| `--json` / `--refine` / `--html` / `--jsonl` / `--open` | Machine output, optional query refinement, and presentation artifacts |

`answer` accepts the same run options and adds `--verify`. Verification is
bounded and opt-in. It may use successful evidence from the run and limited
follow-up searches, but it does not make a result verified merely because a
model produced it. It leaves the original answer intact when verification is
incomplete, budget-limited, or fails.

Other public commands are `live-validation`, `status`, `usage`, `browse`,
`html`, `jsonl`, `refine`, `completions`, `ls`, `groups`, `init`, `doctor`,
`config`, `cleanup`, `clear`, `upgrade`, `install-skill`, and `mcp`.

### Command option ledger

This ledger is intentionally compact. It covers the registered command options
that are not in the `run` table above.

| Command | Options |
| --- | --- |
| `answer` | `--providers`, `--group`, `--mode`, `--output`, `--parallel`, `--timeout`, `--max-cost`, `--max-estimated-cost`, `--yes`, `--no-fallback`, `--json`, `--refine`, `--verify`, `--html`, `--jsonl`, `--open` |
| `live-validation` | `--targets`, `--approval`, `--confirm`, `--paid`, `--continue`, `--candidate-root`, `--artifact-root`, `--artifact`, `--fixture` |
| `status` | `--wait`, `--retrieve`, `--json` |
| `usage` | `--days`, `--json`, `--output` |
| `browse` | `--output` |
| `html` | `--open` |
| `jsonl` | no explicit option |
| `refine` | `--json` |
| `completions` | no explicit option |
| `ls` | `--json` |
| `groups` | `--json` |
| `init` | `--auto` |
| `doctor` | `--json` |
| `config` | `--json`, `--global`, `--menu` |
| `cleanup` | `--days`, `--all`, `--interactive`, `--dry-run`, `--yes`, `--output`, `--json` |
| `clear` | `--interactive`, `--dry-run`, `--yes`, `--output`, `--json` |
| `upgrade` | `--check`, `--dry-run`, `--force` |
| `install-skill` | `--force`, `--dry-run` |
| `mcp` | no explicit option |

### Durable work: wait, retrieve, and cancel

`librarium status --wait --retrieve` waits for existing Node CLI async work,
then fetches completed output. The v2 canonical runtime uses a durable handle
only for `background/durable` profiles. A poll observes state; a retrieve
turns an observed successful durable handle into a terminal result. A
`background/process-local` profile must not be represented as durable work.

Do not promise remote cancellation for every background provider. The canonical
validation protocol explicitly marks a target as either
`supported_exact_profile` cancellation or `reconcile_only`. The published
catalog currently advertises remote cancellation only for `valyu/research`.
All other cancellation behaviour requires reconciliation, not an invented
provider-side cancel call.

### Offline canonical validation

`live-validation` has a network-denied default. Use it to inspect the exact
public `provider/profile` matrix or replay a strict local fixture:

```bash
librarium live-validation --fixture /absolute/path/to/fixture.json
```

Paid execution is deliberately harder: it needs `--paid`, an absolute frozen
preregistration, the exact `--confirm` fingerprint, the matching approval
environment value, and an immutable candidate checkout with matching catalog,
pricing, and artifact fingerprints. A fixture replay does not validate a live
account, provider behaviour, price, privacy setting, or production network.

## Configuration and migration

The v2 config is strict, snake_case JSON. The root configuration has
`version: 2`, `execution_defaults`, `providers`, `custom_providers`,
`trusted_provider_ids`, `groups`, and `runtime`. Project config may override
only the documented optional fields.

```json
{
  "version": 2,
  "execution_defaults": {
    "mode": "sync",
    "max_concurrency": 4,
    "inline_attempt_deadline_ms": 30000,
    "background_attempt_deadline_ms": 1800000,
    "poll_interval_ms": 10000
  },
  "providers": { "exa": { "enabled": true } },
  "custom_providers": {},
  "trusted_provider_ids": [],
  "groups": { "custom:team": ["exa/search"] },
  "runtime": { "output_dir": "./agents/librarium", "llm_web_search": true }
}
```

`migrateConfig()` accepts v1 or v2 data and returns either an immutable v2
configuration plus notices or structured issues. It does not rewrite source
files. `loadConfigV2()` also never rewrites; it requires explicit paths. Only
`saveConfigV2()` persists a validated v2 config, atomically and owner-only. It
fails closed when it cannot verify equivalent owner-only protection on Windows.

Custom providers are executable code. `trusted_provider_ids` is an allowlist,
not a sandbox. An npm module or script can run with the process permissions and
environment. Review and trust that code deliberately. See
[provider development](docs/provider-development.md) for the v2 protocol.

## Pricing and privacy

Librarium can record provider-reported use and can reserve an exact,
network-free price when a reviewed price definition makes that possible. A
missing estimate, missing reported cost, API unit, or token price is unknown —
never a zero-cost guarantee. `--max-cost` is a lower-bound circuit breaker;
in-flight work can still finish and incur cost. `--max-estimated-cost` admits
only calls with an exact known estimate under its reserve.

Every provider call can send a query and selected options to that provider.
Retention, billing, and account-specific behavior belong to the upstream
provider. SearchAPI `zeroRetention` is an account capability: Librarium sends
it only when explicitly configured and fails closed if the account rejects it.
It does not make a broader compliance, retention, or privacy promise.

The normal test suite and this repository’s demo do not make provider, paid,
or network calls. The separate live-validation approval protocol is the only
path that may construct its frozen paid target.

## For agents

Run `librarium install-skill` to install the shipped agent skill, or use the
MCP stdio server:

```bash
claude mcp add librarium -- librarium mcp
```

The MCP server exposes five tools: `research`, `get_results`, `check_async`,
`list_providers`, and `list_groups`. `research` writes a run directory and
returns a compact result. `get_results` returns presentation content with a
per-provider cap and marks it untrusted. `check_async` performs one bounded
resume pass; for canonical schema version 3 it retrieves an observed completed
result immediately, while its `retrieve` flag applies only to historical
schema version 2 runs.

## Shared TypeScript/PHP boundary

[`contracts/v1`](contracts/README.md) is a language-neutral, terminal snapshot
of exactly seven values: `ResearchResponse`, `ResearchResult`, `Citation`,
`Source`, `ResultProvenance`, `Usage`, and `ResearchError`. It is generated
from Zod, versioned independently from npm runtime APIs, and vendored by exact
reviewed Git snapshot plus checksums. It has no requests, attempts, lifecycle
records, durable handles, coordinator state, config, artifact store, JSONL, or
custom-provider protocol. PHP `run()`/`queue()` and TypeScript runtime services
are outside that boundary; neither runtime architecture is implied by the
terminal interchange schema.

## Documentation facts protected by tests

`tests/public-documentation-drift.test.ts` derives the roster, curated
workflows, CLI command/options, MCP tools, package exports, Node floor, and
protocol/artifact versions from source. It verifies the factual blocks in this
README and the companion public docs. Prose outside those blocks remains
human-authored.
