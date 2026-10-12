# Librarium simplified surface: spec and plan

Status: **draft for review** (PlanMode #4925). Nothing here is implemented yet.
Applies to: Librarium JS 2.0 (npm `librarium`), Laravel AI Librarium 1.0
(`jkudish/laravel-ai-librarium`), the shared spec package, CLI, MCP, docs,
skills, and librarium.agentsy.build.

## 1. Goal

Librarium should be one interface for many research providers that a person
can learn in a minute and an agent can use without reading a manual. The public
surface keeps only the decisions a user actually makes:

1. **What to ask**: the question.
2. **How deep**: `quick` (seconds) or `deep` (minutes).
3. **Which sources**: by default, every source you have set up.
4. **How much to spend**: an optional `max_cost`.

Everything produces a **Run**: one record with an id that you can wait on, come
back to, and read. The same Run JSON is returned by the CLI, MCP, the JS
library, and the PHP package, and the same record is what gets stored.

The provider engine (adapters, drivers, pricing, redaction, durable provider
tasks, usage and cost reporting) stays. This spec replaces the layer people and
agents touch.

## 2. Concepts

```text
Today                                   This spec

provider ┐                              question
profile  ┤                              depth     quick | deep
group    ┤                              sources   default: all set up
custom:  ┼─→ run (sync|async|mixed)     max_cost  optional
mode     ┤                                  │
fallback ┘                                  ▼
                                           Run  ── stored, resumable
visibility = a group                    visibility = its own verb
```

| Concept | Meaning |
| --- | --- |
| Source | A research provider you can ask, such as `exa` or `openai`. One flat name, identical in JS and PHP. |
| Depth | `quick` asks each source's fast variant (answers and search, seconds). `deep` asks each source's research-report variant (minutes, runs in the background). |
| Engine | A consumer AI answer surface (`chatgpt`, `google-ai-overview`, …) observed by the `visibility` verb. |
| Run | One execution: id, status, per-source results with citations, cost, and skipped sources with reasons. |
| Run store | Where Runs live. Configurable (section 6). |

Removed from the public surface: profiles, built-in and custom groups, modes,
fallbacks, the estimated/actual budget split, capability selectors, and the
separate plan command (section 10).

## 3. Sources and engines

A source has at most one quick variant and one deep variant. Today's extra
profiles become source options. `deep` skips sources with no deep variant
(reason `no_deep_variant`).

| Source | quick | deep | Options (replace today's extra profiles) |
| --- | --- | --- | --- |
| `brave` | Brave answers | — | `results: answer \| search` (brave-search) |
| `claude` | Claude chat with web search | — | `model` |
| `exa` | Exa search | Exa research | — |
| `firecrawl` | Firecrawl search | — | PHP: provided by the Firecrawl adapter package |
| `gemini` | Gemini grounded | Gemini Deep Research | `quick: grounded \| chat` |
| `google` | Google results via a collector | — | `collector: searchapi \| serpapi \| serpbase \| dataforseo`, `vertical: web \| news` |
| `grok` | Grok web search | — | `search: web \| x \| both` (grok-x-only, grok-combined) |
| `jina` | Jina search | — | — |
| `kagi` | Kagi FastGPT | — | — |
| `openai` | OpenAI chat with web search | OpenAI research | `model`, `effort` |
| `openrouter` | OpenRouter grounded | — | `quick: grounded \| chat`, `model` |
| `parallel` | Parallel turbo | Parallel research | `quick: turbo \| search`, `processor` (research processor, default `pro`) |
| `perplexity` | Sonar Pro | Deep Research | `quick: sonar-pro \| search \| agent`, `deep_effort: medium \| high` (sonar-deep) |
| `tavily` | Tavily search | — | — |
| `valyu` | Valyu search | Valyu research | `mode` (research mode, default `standard`), `output` |
| `you` | You.com answer | You.com research | `quick: answer \| research` |

Deep today: `exa`, `gemini`, `openai`, `parallel`, `perplexity`, `valyu`, `you`.

Engines (visibility only). The collector is configuration, not part of the name:

| Engine | Collectors |
| --- | --- |
| `chatgpt` | searchapi, dataforseo |
| `gemini-app` | searchapi, dataforseo |
| `google-ai-mode` | searchapi, dataforseo |
| `google-ai-overview` | searchapi |
| `copilot` | searchapi |

Today's visibility "API baselines" (Sonar Pro, Gemini grounded, Grok web) are
dropped from visibility. To compare, run `research` on the same question.

Custom sources (JS custom providers, PHP custom drivers) register a new source
name with a quick and/or deep variant and appear exactly like built-ins.

The catalog above lives in the shared spec package as `sources.json`
(section 9): ids, display names, depth variants, option schemas, credential
names, pricing identities, docs URLs. Both languages and the website read it.

## 4. Contract: request and Run

All JSON is `snake_case`. Money is a decimal string in USD. Times are RFC 3339
UTC. Ids are `run_` followed by a ULID.

### Request

```json
{
  "kind": "research",
  "question": "Replacing GA4 for an EU SaaS: compare Plausible, Fathom, and Matomo",
  "depth": "deep",
  "only": ["exa", "openai", "perplexity"],
  "skip": [],
  "max_cost": "1.00",
  "dry_run": false,
  "options": { "parallel": { "processor": "ultra" } }
}
```

| Field | Rules |
| --- | --- |
| `kind` | `research` (default) or `visibility`. |
| `question` | Required, non-empty. |
| `depth` | `quick` (default) or `deep`. Research only. |
| `only` / `skip` | Source (or engine) names. `only` narrows the default set; naming an unconfigured source is an error, not a silent skip. |
| `max_cost` | Optional. Default from config. Over MCP it may only lower the configured cap. |
| `dry_run` | Return a Run with status `planned` and estimates; no provider calls. |
| `options` | Advanced. Per-source option overrides validated against `sources.json`. |
| `engines` | Visibility only: alias for `only`. |

### Run

```json
{
  "spec": "librarium.run/1",
  "id": "run_01JAB2C3D4E5F6G7H8J9K0M1N2",
  "kind": "research",
  "question": "…",
  "depth": "deep",
  "status": "running",
  "created_at": "2026-10-12T18:04:11Z",
  "finished_at": null,
  "cost": { "estimated": "0.35", "reported": "0.10", "complete": false, "max": "1.00" },
  "results": [
    {
      "source": "exa",
      "status": "done",
      "answer": "## Findings\n…",
      "citations": [{ "url": "https://plausible.io/features", "title": "Plausible features" }],
      "cost": { "estimated": "0.10", "reported": "0.10" },
      "started_at": "2026-10-12T18:04:12Z",
      "duration_ms": 122000,
      "provenance": { "provider": "exa", "variant": "research", "model": null, "collector": null, "observation": "api" },
      "error": null
    }
  ],
  "skipped": [{ "source": "kagi", "reason": "no_deep_variant" }],
  "notices": []
}
```

- Run `status`: `planned` (dry run), `running`, `done` (every result done),
  `partial` (some failed), `failed` (none succeeded).
- Result `status`: `queued`, `running`, `done`, `failed`. `error` is
  `{ code, message, retryable }`.
- Skip reasons: `not_configured`, `no_deep_variant`, `unpriced` (a `max_cost`
  is set and the source has no bounded estimate), `over_budget`, `excluded`
  (`skip`), `no_collector` (engine without a configured collector).
- `answer` is Markdown (null for search-only sources); `citations` are always
  present. Raw provider bodies are evidence (section 6), never inline.
- `cost.reported` is provider-reported only; an unknown cost is `null`, never
  `"0"`. `cost.complete` is true only when every result reported a cost.
- `observation` is `api` for research sources and `surface` for engines.

### Budget rule (one rule, both languages)

With `max_cost`: sum the bounded estimates of the selected sources; skip any
source without a bounded estimate (`unpriced`) and drop sources in catalog
order until the sum fits (`over_budget`). During the run, reported spend plus
reservations stops unstarted work. In-flight calls may finish above the cap;
the docs say so.

## 5. Lifecycle and waiting

Every request creates a Run in the store before any provider call. Waiting is
a client choice, not a request field.

```text
research(...) ──▶ Run created (running) ──▶ results land one by one ──▶ done | partial | failed
                        │                                ▲
                        └── client stops waiting ──▶ show/get/find(id) ──┘
```

- **quick** sources run inline in the calling process. If that process stops,
  their results are marked `failed` with `interrupted`.
- **deep** sources are durable provider tasks. Their handles are saved in the
  store, so any later `show`/`get`/`find` can observe and finish them. Every
  deep variant must be durable (PHP gap: OpenAI and You.com research need
  recoverable handles, see plan).
- One Run never mixes depths, so there is no mode to choose.

| Surface | Default | Not waiting |
| --- | --- | --- |
| CLI | waits with live progress; Ctrl-C detaches and prints `librarium show <id>` | `--no-wait` |
| MCP | waits up to `wait_seconds` (default 45, max 50), then returns the Run as `running` | `wait_seconds: 0` |
| JS | `await research()` resolves when the Run finishes | `{ wait: false }` |
| PHP | `run()` waits | `queue()` dispatches one encrypted job and returns the running Run |

## 6. Storage

Runs are stored through one **RunStore** interface in each language, chosen in
config. Every surface reads and writes Runs only through it.

```text
RunStore
  create(document)                 → version
  get(id)                          → document | null
  update(id, expected_version, doc)→ ok | conflict      (compare-and-swap)
  list({ limit, before })          → summaries, newest first
  delete(id)
  put_blob(id, name, bytes) / get_blob(id, name)        (evidence, answers)

document = { run: Run, state: private }   state = provider handles, ledger, reservations
```

Built-in stores:

| Store | JS | PHP | Use |
| --- | --- | --- | --- |
| `filesystem` | default for the CLI, MCP, and `librarium/node` | default; any Laravel disk (`local`, `s3`, …), encrypted with the app key by default | durable, resumable |
| `memory` | default for `librarium/core` (Workers, browsers) | testing | not resumable across processes |
| `cache` | — | any Laravel cache store, with a TTL | short-lived apps |
| custom | implement `RunStore` (Redis, D1, S3, a database) | bind a class implementing `RunStore` (Eloquent, etc.) | app-owned persistence |

Filesystem layout (shared by both languages; PHP encrypts each file unless
`encrypt` is false):

```text
<path>/<run_id>/run.json             the Run record (contract above)
<path>/<run_id>/state.json           private: handles, ledger, version
<path>/<run_id>/answers/<source>.md  full answer Markdown
<path>/<run_id>/evidence/<source>.json  redacted provider bodies and safe headers
```

Rules:

- No credentials are ever stored. Evidence is always redacted with the
  current PHP redaction semantics (configured credentials and encodings,
  secret-bearing keys, configured paths and patterns), which JS adopts.
- Retention: `runs.keep_days` (default unset, keep everything);
  `librarium cleanup` and a PHP `librarium:prune` command apply it.
- PHP signs stored provider handles with the app key, as `ResearchHandle`
  does today, so a tampered store cannot redirect retrieval.
- Concurrent writers use compare-and-swap; the JS coordinator's existing
  `CoordinationStateStore` becomes the `state` half of the document.

## 7. Surfaces

### CLI

```bash
librarium research "q"                                  # quick, all set-up sources, waits
librarium research "q" --deep                           # deep, background, waits with progress
librarium research "q" --only exa,openai --max-cost 1   # narrow and cap
librarium research "q" --deep --dry-run                 # Run(planned) with estimates, no calls
librarium research "q" --deep --no-wait                 # print the run id and exit
librarium visibility "How do AI engines describe Acme?" [--engines chatgpt,copilot]
librarium show [run-id] [--wait] [--source exa] [--json]  # default: latest run
librarium summarize [run-id] [--verify]                 # synthesis over a saved Run
librarium sources [--json]                              # what's set up, depth variants, prices
librarium setup [--check] [--live]                      # keys and options; --check = doctor
librarium mcp
```

Kept as tools: `browse`, `html`, `jsonl`, `usage`, `cleanup`, `config`,
`completions`, `upgrade`, `install-skill`. `--json` prints the Run.

### MCP (4 tools)

| Tool | Input | Output |
| --- | --- | --- |
| `research` | `question`, `depth?`, `only?`, `skip?`, `max_cost?` (can only lower), `dry_run?`, `wait_seconds?` | Run summary: id, status, per-source status and citation counts, cost, skipped |
| `visibility` | `question`, `engines?`, `max_cost?`, `wait_seconds?` | same |
| `get_run` | `id`, `wait_seconds?`, `source?`, `cursor?` | summary, or one source's answer and citations, paged |
| `list_sources` | — | sources and engines: set up or not, depth variants, price hints |

### JavaScript

```ts
import { createLibrarium } from 'librarium';

const librarium = createLibrarium();                 // config + filesystem store (Node)
const run = await librarium.research('q', { depth: 'deep', only: ['exa'], maxCost: '1.00' });
const started = await librarium.research('q', { depth: 'deep', wait: false });
const later = await librarium.get(started.id, { wait: true });
await librarium.visibility('q', { engines: ['chatgpt'] });
librarium.sources();
await librarium.summarize(run);
// createLibrarium({ store: myRunStore, config }) in librarium/core
```

JS option names are camelCase; the Run object is the contract JSON.

### PHP

```php
use Jkudish\LaravelAiLibrarium\Facades\Librarium;

$run = Librarium::research('q')->deep()->only(['exa', 'openai'])->maxCost('1.00')->run();
$run = Librarium::research('q')->deep()->dryRun();            // Run(planned)

$queued = Librarium::research('q')->deep()->queue()->onQueue('research')
    ->then(fn (Run $run) => /* … */);                            // $queued->id()

$run = Librarium::find($id);       // from the store
$run = $run->refresh();            // observe pending deep sources once
Librarium::visibility('q')->engines(['chatgpt'])->run();
Librarium::sources();
```

Artisan: `librarium:research`, `librarium:visibility`, `librarium:show`,
`librarium:sources`, `librarium:prune`. The Laravel AI SDK evidence tool stays
and reads Runs.

PHP method review (checked against `docs/collection-and-recovery.md`):

| Today | Purpose | New surface |
| --- | --- | --- |
| `run()` | wait for a response | `run()` |
| `collect()` | response plus redacted provider bodies, coverage, diagnostics | folded in: every stored Run keeps redacted evidence; `$run->evidence($source)` and `$run->diagnostics()` |
| `collectSensitive()` | unredacted bodies, memory-only, for apps doing their own encryption | **removed from 1.0** (recommended); re-addable later without a break |
| `submit()` + `retrieve()` | one exact durable profile; app persists a signed handle; one observation per call | folded in: `queue()` stores signed handles in the Run; `find()` + `refresh()` observe. Works for every deep source, not one profile |
| `queue()` | one encrypted job | `queue()` |
| `preview()` / `spendingBound()` | dry run and budget | `dryRun()` returns a planned Run with costs |
| `using()` / `fanOut()` / `group()` / `matching()` / `fallbacks()` | selection | `only()` / `skip()` / `deep()`; the rest removed |

## 8. Configuration

JS (`librarium setup` writes it; one schema version bump, `version: 3`):

```json
{
  "version": 3,
  "sources": {
    "exa": { "key": "env:EXA_API_KEY" },
    "parallel": { "key": "env:PARALLEL_API_KEY", "processor": "pro" },
    "grok": { "key": "env:XAI_API_KEY", "enabled": false }
  },
  "engines": { "collector": "searchapi", "key": "env:SEARCHAPI_API_KEY" },
  "max_cost": "1.00",
  "runs": { "store": "filesystem", "path": "./agents/librarium", "keep_days": null }
}
```

PHP (`config/librarium.php`):

```php
'sources' => [
    'exa' => ['key' => env('EXA_API_KEY')],
    'parallel' => ['key' => env('PARALLEL_API_KEY'), 'processor' => 'pro'],
],
'engines' => ['collector' => 'searchapi', 'key' => env('SEARCHAPI_API_KEY')],
'max_cost' => null,
'runs' => ['store' => 'filesystem', 'disk' => 'local', 'path' => 'librarium/runs', 'encrypt' => true, 'keep_days' => null],
'timeout' => 6900,
```

A source is set up when it has a key and `enabled` is not `false`.
`librarium setup` asks for a default `max_cost`.

Migration:

- JS v1 configs (1.x is published) migrate to v3 on load with a written
  backup: providers become sources, extra profiles become options, `mode` and
  fallbacks are dropped with notices, custom groups are dropped with a notice
  listing their members as an `--only` value. Config v2 never shipped.
- PHP 1.0 is unreleased; its config is rewritten, no migration.
- v1 run directories are not readable by `show` (documented).

## 9. Shared spec package

New repository `jkudish/librarium-spec`, published to npm (`librarium-spec`)
and Packagist (`jkudish/librarium-spec`). "spec" rather than "core" because
`librarium/core` is already the JS runtime-neutral entry point. It holds data
and tests, no runtime code:

```text
schema/request.schema.json   schema/run.schema.json   schema/store-layout.md
sources.json                 sources, engines, variants, options, credentials, pricing identities, docs, logos
fixtures/                    conformance cases: config + request → selection, skips, budget outcome; Run records
CHANGELOG.md
```

Both packages pin a minor version and run the fixtures in their test suites.
This replaces `contracts/v1` in the JS repo and the PHP `typescript:repin`
step. The website reads `sources.json` for its provider grid and counts.

## 10. Removed and renamed

| Today | Becomes |
| --- | --- |
| `run`, MCP `research` matrix fields | `research` |
| `-p provider/profile`, `-g`, built-in groups, `custom:` groups, `groups`, `list_groups` | `--only` / `--skip`, `--deep`, `visibility` |
| `--mode sync\|async\|mixed` | automatic (section 5) |
| `--no-fallback`, fallbacks, reserves | removed |
| `--max-estimated-cost` | `--max-cost` |
| `plan`, `preview()`, `spendingBound()` | `--dry-run`, `dryRun()` |
| `status`, `check_async`, `get_results`, `retrieve()` | `show`, `get_run`, `find()` / `refresh()` |
| `answer`, `answer --verify` | `summarize [id]`, `summarize --verify` |
| `refine`, `--refine` | removed |
| `ls`, `init`, `doctor` | `sources`, `setup`, `setup --check` |
| `live-validation` | maintainer script, not a user command |

Removed names fail with a message naming the replacement.

## 11. Plan

### Workstreams

| # | Work | Owner | Branch / repo | Depends on |
| --- | --- | --- | --- | --- |
| W1 | Spec package: schemas, `sources.json`, fixtures | lead | new `jkudish/librarium-spec` | spec approval, repo creation approval |
| W2 | JS 2.0: Run model and RunStore; source resolution from `sources.json`; budget rule; request compiler without selectors, modes, fallbacks; JS API; CLI verbs; MCP 4 tools; config v1→v3 migration; README, docs, CHANGELOG, SKILL.md | worker thread, Librarium-js project | `feat/4925-simplified-surface` → `release/v2-candidate` | W1 (git dependency until published) |
| W3 | PHP 1.0: facade and fluent API; RunStore (filesystem/cache/custom); queue job writes the store; `find`/`refresh` with signed handles; recoverable handles for OpenAI and You.com research; config rewrite; Artisan; README, docs, CHANGELOG | worker thread, Librarium-php project | `feat/4925-simplified-surface` → `release/1.0-prep` | W1 |
| W4 | Firecrawl adapter: register `firecrawl` as a source | W3 worker, after W3 | `laravel-ai-librarium-firecrawl` PR #9 | W3 |
| W5 | Skills and install.md: Librarium skill (PR #11), Amp user skill branch, `/install.md` | lead | existing branches | W2 CLI/MCP frozen |
| W6 | Website: homepage, /agents, /cli, /javascript, /laravel, docs, compare; provider grid from `sources.json`; remove groups and modes | lead | `librarium-site` `review/site-release` | W2/W3 API frozen |
| W7 | Verification and review: full gates per repo, cross-language fixtures, `plan_check`, Oracle review per PR, live canary (one quick and one deep Run per language, one visibility Run; about USD 4 cap) | lead + workers | — | W2–W6 |
| W8 | Release (unchanged gates; each step approved separately) | Joey | spec 1.0 → JS 2.0 → PHP 1.0 → site | W7 |

### Order

```text
spec approved ─▶ W1 spec package ─┬─▶ W2 JS ──┬─▶ W5 skills ─┐
                                   └─▶ W3 PHP ─┴─▶ W4 Firecrawl ├─▶ W6 site ─▶ W7 verify ─▶ W8 release
```

W2 and W3 start from this document the same day W1 starts; W1's fixtures land
first and become their acceptance tests.

### Verification per repo

- JS: `npm run build`, test, typecheck, lint, `test:workers`,
  `test:integration`, `test:pty`, `test:declarations`, plus spec fixtures.
- PHP: `composer test`, `analyse`, `format:check`, `validate --strict`,
  conformance against spec fixtures, lowest and highest dependency lanes,
  `composer pr:check` at the final head.
- Site: `npm run verify`, screenshots of every changed page.
- Cross-language: the same fixture set passes in both; a JS-written
  unencrypted run folder is readable by PHP `find()` and vice versa.
- No live provider calls until W7, and only with a separately approved cap.

### What does not change

Adapters and drivers, pricing (laravel-ai-pricing 0.3.1 and the JS snapshot),
redaction, durable provider task handling, usage and cost truthfulness (#4866),
deadlines, the encrypted queue job, and the GitHub release environment.

### Risks

| Risk | Mitigation |
| --- | --- |
| Fanning out to every set-up source costs more | `setup` asks for a default `max_cost`; `sources` and `--dry-run` show it |
| PHP deep sources without recoverable handles (OpenAI, You.com research) | W3 adds handles; until then they cannot be `deep` sources in PHP |
| PHP now stores Runs, against the current "no package-owned persistence" rule | store uses Laravel disks/cache only, no migrations or Eloquent; AGENTS.md updated when approved |
| MCP clients time out long calls | `wait_seconds` caps at 50; `get_run` resumes |
| Release slips | roughly 1.5 to 2 weeks to release-ready, mostly W2/W3 in parallel |
| Losing v1 run history in `show` | documented; `browse`/`html` on old folders are out of scope |

## 12. Open decisions

1. Remove `collectSensitive()` from PHP 1.0 (recommended) or keep it as an
   option on `run()`.
2. Spec package name `librarium-spec` (recommended) vs `librarium-core`.
3. Create the `jkudish/librarium-spec` repository and later publish it
   (external actions).
4. Worker allocation: two orb threads (Librarium-js, Librarium-php projects) in
   `high` mode; lead keeps W1, W5, W6, W7.
5. Approving this spec counts as the AGENTS.md checkpoint for selector,
   budget, fallback, and execution-policy API changes, and for PHP Run storage.
