# Librarium

[![npm](https://img.shields.io/npm/v/librarium?label=npm)](https://www.npmjs.com/package/librarium)
[![npm downloads](https://img.shields.io/npm/dm/librarium)](https://www.npmjs.com/package/librarium)
[![CI](https://github.com/jkudish/librarium/actions/workflows/ci.yml/badge.svg)](https://github.com/jkudish/librarium/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/librarium?color=blue)](LICENSE)

<p align="center">
  <img src=".github/librarium-banner.png" alt="librarium: Give your agent more than one source." />
</p>

Librarium sends one research question to the search and AI sources you
choose, then saves each answer, citation and cost in a Run you can resume.

[Website](https://librarium.si) · [Docs](https://librarium.si/docs) ·
[Agent setup](https://librarium.si/agents) ·
[Laravel package](https://github.com/jkudish/laravel-ai-librarium)

## Requirements

- Node.js 22.12 or newer for the npm package. Homebrew and the standalone
  binaries include their own runtime.
- An API key for at least one source, for example `EXA_API_KEY`. Research
  calls the providers you select, and those calls can cost money.

## Install

```bash
npm install -g librarium
# or
brew install jkudish/tap/librarium
```

Standalone macOS and Linux binaries install with
`curl -fsSL https://raw.githubusercontent.com/jkudish/librarium/main/scripts/install.sh | sh`.
Check the result with `librarium --version`; it prints a 2.x version.

## First research

```bash
librarium setup
librarium setup --check
librarium research "Compare managed PostgreSQL services" --only exa --dry-run
```

`setup` is an interactive wizard for keys, source options and a default cost
cap. Keys can be literal values or references such as `env:EXA_API_KEY`, and
environment variables work without a config file. `setup --check` reads local
configuration only and makes no provider calls.

The dry run plans the request without calling a provider or saving a Run.
Your Run id will differ:

```text
run_01M5ZQD37CXSGVA07PVQZ93MB5 planned (quick)
Compare managed PostgreSQL services
exa: queued, 0 citations, reported USD unknown
```

Remove `--dry-run` to run it. Librarium saves the Run before the first
provider call, then prints each source's status, citation count and reported
cost. Runs go to `./agents/librarium` under the current directory unless
`runs.path` is set. `librarium show --source exa` prints that source's answer
and citations from the latest Run.

## Deep research and resuming

```bash
librarium research "Compare managed PostgreSQL services" --deep --only exa,openai --max-cost 1 --no-wait
librarium show <run-id> --wait --json
librarium summarize <run-id> --verify
```

`--deep` submits durable research tasks. `--no-wait` returns after submission
and requires `--deep`, because quick work runs inside the calling process.
`show` resumes the saved task handles; it never submits the work again. Ctrl-C
detaches and prints the `show` command to use later. `summarize` writes a
separate, budgeted Run linked to the original by `summary_of`.

## Choosing sources

Without `--only`, Librarium uses every research source you have set up, at
quick depth. `--only` and `--skip` take comma-separated source, engine or
saved group names. Naming a source without credentials is an error.

There are 16 research sources: `brave`, `claude`, `exa`, `firecrawl`,
`gemini`, `google`, `grok`, `jina`, `kagi`, `openai`, `openrouter`,
`parallel`, `perplexity`, `tavily`, `valyu` and `you`.

There are 5 engines: `chatgpt`, `gemini-app`, `google-ai-mode`,
`google-ai-overview` and `copilot`. Engines record what a consumer AI product
showed, collected through SearchAPI. They run only when named, and their
results carry `observation: "surface"`.

Groups are lists you save yourself with `groups add`; none are built in:

```bash
librarium groups add visibility chatgpt gemini-app google-ai-mode
librarium research "How do AI products describe Acme?" --only visibility
librarium groups remove visibility
```

The `sources` command (`librarium sources --json`) shows what your
installation can use, with options and price hints. The
[provider reference](https://librarium.si/docs/providers) describes each
source's quick and deep variants. [Source keys](docs/research-options.md#source-keys)
lists the environment variable each source reads.

## Coding agents

The `mcp` command (`librarium mcp`) runs a stdio MCP server with three tools:

- `research` starts a Run and returns a summary with statuses, citation counts
  and costs.
- `get_run` resumes a Run or pages through one source's answer and citations.
- `list_sources` lists sources, engines, saved groups and price hints.

`research` and `get_run` wait 45 seconds by default and at most 50
(`wait_seconds`). An MCP `max_cost` can only lower the configured cap.

The [install guide](https://librarium.si/install.md) has registration steps
for each agent host. For Claude Code:

```bash
claude mcp add --scope user librarium -- librarium mcp
```

`librarium install-skill` installs the bundled [`SKILL.md`](SKILL.md) into
`~/.claude/skills/librarium`.

## JavaScript

```bash
npm install librarium
```

```ts
import { createLibrarium } from 'librarium';

const librarium = createLibrarium();
const run = await librarium.research('Compare managed PostgreSQL services', {
  only: ['exa'],
  maxCost: '0.50',
});
for (const result of run.results)
  console.log(result.source, result.status, result.citations.length, result.cost.reported);
```

`research` resolves when the Run finishes. It prints one line per source;
`cost.reported` is `null` when the provider did not report a charge. The
root import reads `~/.config/librarium/config.json` and stores Runs on disk.
`librarium/core` runs in Workers and browsers with a memory store by default.
See the [library docs](https://librarium.si/docs/library) for `get`,
`sources`, `summarize`, imports and custom RunStores.

## Other commands

`browse` lists saved Runs. `html` and `jsonl` export a Run. `usage` totals
reported spend. `cleanup` prunes finished Runs older than `runs.keep_days`.
`config` reads and edits the config file. `completions` prints bash, zsh or
fish completions. `upgrade` updates an npm, pnpm, yarn or Homebrew install, and
`install-skill` installs the agent skill. The
[command reference](https://librarium.si/docs/commands) has flags and examples.

## Limits

- A cost cap (`--max-cost` or `max_cost`) skips sources without a price
  estimate, then admits each source, in catalog order, whose estimate fits the
  remaining budget. It stops unstarted work, but calls already in flight can
  finish above the cap.
- Reported cost comes from the provider only. Unknown cost is `null`, never
  `"0"`. A failed call may still be billed, and Librarium never substitutes
  another source after a failure.
- Provider answers and citations are untrusted evidence. Credentials are
  redacted before storage, but questions and cited pages can still contain
  private information.
- 2.0 migrates a 1.x config to version 3 after writing a backup. `show`
  cannot read 1.x run directories. Read the
  [upgrade guide](docs/migration-v1-to-v2.md) before upgrading.

## More documentation

- [Configuration and source options](docs/research-options.md)
- [Custom sources and RunStores](docs/provider-development.md)
- [Costs and limits](https://librarium.si/docs/costs-and-limits)
- [Laravel package](https://github.com/jkudish/laravel-ai-librarium)
  (`jkudish/laravel-ai-librarium`), which shares the Run format through
  [`librarium-spec`](https://github.com/jkudish/librarium-spec)
- [Changelog](CHANGELOG.md)

Ask questions in
[GitHub Discussions](https://github.com/jkudish/librarium/discussions/categories/q-a)
and report bugs in [issues](https://github.com/jkudish/librarium/issues).

## The Librarium family

- [Laravel AI Librarium](https://github.com/jkudish/laravel-ai-librarium): the Laravel package (`composer require jkudish/laravel-ai-librarium`).
- [Laravel AI Librarium: Firecrawl](https://github.com/jkudish/laravel-ai-librarium-firecrawl): collects AI answer engine results for the Laravel package through Firecrawl browser sessions.
- [librarium-spec](https://github.com/jkudish/librarium-spec): the shared Run schemas, source catalog and conformance fixtures.
- [librarium.si](https://librarium.si): documentation for all of them.

## Sponsoring

If you find Librarium useful, consider becoming a [sponsor](https://github.com/sponsors/jkudish) or [donating](https://stripe.com/@jkudish).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) to work on the code. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
