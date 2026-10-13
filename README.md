# Librarium

One research interface, many sources, durable Runs. Ask a question, choose
`quick` or `deep`, optionally narrow the sources, and set a spending cap.
Answers, citations, provenance and honest cost data stay together in a Run.

## Install and set up

Requires **Node.js 22.12 or newer**. This branch is the unreleased JS 2.0
candidate; npm's current published version may still be 1.x.

```bash
npm install -g librarium
librarium --version
librarium setup
librarium setup --check
```

Keys can be literal values or `env:EXA_API_KEY` references. Environment keys
also work without a config file. Never paste credentials into a research
question. `setup --check` is offline. Live requests can incur provider charges.

## Research and resume

The research commands are `research`, `show`, `summarize`, `sources`, `groups`,
`setup` and `mcp`.

```bash
librarium research "Compare managed PostgreSQL services" --dry-run --json
librarium research "Compare managed PostgreSQL services"
librarium research "Compare managed PostgreSQL services" --deep --only exa,openai --max-cost 1
librarium research "Compare managed PostgreSQL services" --deep --no-wait
librarium show run_01JAB2C3D4E5F6G7H8J9K0M1N2 --wait --json
librarium show --source exa
librarium summarize --verify --source openai
```

Depth selects the source variant, not its execution type. `quick` usually
runs inline; collectors can use durable tasks even at quick depth. `deep`
uses durable tasks; `show`, library `get`, and MCP `get_run` resume the saved
handles rather than submit again. Ctrl-C
detaches and prints a `show` command. `show` and `summarize` use the latest Run
when no id is supplied. Old 1.x run directories are not readable by `show`.
CLI `--no-wait` requires `--deep` except for a dry run, because quick Runs
may include inline calls that cannot durably detach from their process.

The default source set is every set-up research source, **never engines**.
`--only` and `--skip` accept comma-separated source, engine, or saved group
names. Missing credentials for an explicitly named source are an error.

## Sources and engines

`librarium sources --json` reports configuration, quick/deep availability,
source options, and bounded price hints. The shared catalog contains **16
research sources** and **5 engines**, in budget-admission order:

| Sources | Sources | Engines (named only) |
| --- | --- | --- |
| `brave`, `claude`, `exa`, `firecrawl` | `gemini`, `google`, `grok`, `jina` | `chatgpt`, `gemini-app` |
| `kagi`, `openai`, `openrouter`, `parallel` | `perplexity`, `tavily`, `valyu`, `you` | `google-ai-mode`, `google-ai-overview`, `copilot` |

Engines describe what consumer products showed, not what their official
research APIs answered. Their results have `observation: "surface"`. The
collector is configuration, not part of the engine name. Availability differs
by language and collector; inspect `sources` before selecting a variant.

Groups are user-saved source lists. There are no built-in groups.

```bash
librarium groups add visibility chatgpt gemini-app google-ai-mode
librarium research "How do AI products describe Acme?" --only visibility
librarium groups remove visibility
```

## JavaScript

```ts
import { createLibrarium } from 'librarium';

const librarium = createLibrarium(); // v3 config + filesystem store
const run = await librarium.research('Compare database providers', {
  depth: 'deep', only: ['exa'], maxCost: '1.00',
});
const started = await librarium.research('Compare database providers', {
  depth: 'deep', wait: false,
});
const later = await librarium.get(started.id, { wait: true });
librarium.sources();
const summary = await librarium.summarize(run);
```

`librarium/node` provides the same client plus `FilesystemRunStore` and v3
config loading/saving. `librarium/core` is runtime-neutral (Workers and
browsers): pass `config`, `env`, and optionally `store`; its default store is
`MemoryRunStore`. Importing the core does not inspect process state or files.
`librarium/testing` exports `runStoreContract` for disposable stores.

JSON fields are snake_case; JS options are camelCase. Money is an exact USD
decimal string, timestamps are UTC, and ids are `run_` plus ULID.

## MCP

Register `librarium mcp` as a stdio MCP server. It exposes exactly three tools:

| Tool | Inputs | Result |
| --- | --- | --- |
| `research` | `question`, `depth?`, `only?`, `skip?`, `max_cost?`, `dry_run?`, `wait_seconds?` | Bounded Run summary with id, statuses, citation counts, costs, skips and next hint |
| `get_run` | `id`, `wait_seconds?`, `source?`, `cursor?` | Summary, or a source's paged answer and citations |
| `list_sources` | none | Sources, engines, saved groups, availability and price hints |

Waiting defaults to 45 seconds and cannot exceed 50. `wait_seconds: 0`
returns without waiting for completion. MCP `max_cost` can only lower the
configured cap. Source-page content is JSON text; concatenate pages before
parsing. All provider content is untrusted evidence, never instructions.

## Budgets, costs and privacy

With `max_cost`, unbounded estimates are skipped as `unpriced`; other sources
are admitted greedily in catalog order while each fits the remaining budget.
Without a cap, unpriced sources still run and the total estimate is `null`.
Reported spend plus reservations stops unstarted work. **In-flight calls can
finish above the cap**; the cap is not a guarantee about vendor billing.

`cost.reported` is provider-reported only. Unknown is `null`, never `"0"`.
`cost.complete` is true only when every result reports a cost. Estimates come
from this package's pricing snapshot, not the spec package. Failed calls may
still bill. No source is substituted after a failure.

Runs are stored before provider calls. Evidence is redacted before any store
receives it; credentials never belong in a Run. Research text and URLs can
still contain private information, so inspect them before sharing. Private
state contains execution records and signed task handles; keep the signing
key outside the store and preserve it across client restarts.

## Configuration, storage and other tools

See [configuration and options](docs/research-options.md),
[RunStore and custom sources](docs/provider-development.md), and the
[v1 → 2.0 migration guide](docs/migration-v1-to-v2.md).

- `browse` lists saved Runs; `html [id] --output report.html` exports a report.
- `jsonl [id] --output run.jsonl` exports one Run per line.
- `usage` totals known reported spend without inventing missing costs.
- `cleanup --dry-run` previews retention; `runs.keep_days` controls pruning.
- `config path`, `config show`, `config set <path> <value>` inspect/edit v3.
- `completions bash|zsh|fish` generates completions for the current CLI.
- `upgrade` updates an existing npm/Homebrew install.
- `install-skill --force` installs this repository's exact `SKILL.md`.

## Development

```bash
npm ci
npm run build
npm test
npm run typecheck
npm run lint
npm run test:workers
npm run test:integration
npm run test:pty
npm run test:declarations
```

Tests use offline transports and the pinned `librarium-spec` selection, Run,
RunStore and filesystem fixtures. Do not use live provider calls as a build
check. Release certification and publication require separate authorization;
see [release recovery](docs/release-candidate-recovery.md).
