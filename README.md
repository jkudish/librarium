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

Librarium sends a research query to explicit provider profiles and keeps the
results, citations, cost data, and provenance together. It supports search,
grounded answers, consumer-surface observations, and longer research jobs.
Agreement is not proof. The output records what happened so callers can inspect
the evidence.

The CLI and MCP server are complete applications. The package also exposes
composable library boundaries for custom runtimes.

## Install

Install with npm (requires Node.js **22.12 or newer**):

```bash
npm install -g librarium
```

Or install the standalone binary, which bundles its own runtime:

```bash
# Homebrew (macOS and Linux)
brew install jkudish/tap/librarium

# Installer (macOS and Linux, x64 and arm64)
curl -fsSL https://raw.githubusercontent.com/jkudish/librarium/main/scripts/install.sh | sh
```

Then check the version:

```bash
librarium --version
```

The installer downloads the latest GitHub release, verifies its SHA-256
against the release's `SHA256SUMS`, and installs to `/usr/local/bin` (it uses
`sudo` when that directory is not writable). Set `LIBRARIUM_INSTALL_DIR` to
install elsewhere. On Windows, download `librarium-windows-x64.exe` from
[GitHub releases](https://github.com/jkudish/librarium/releases) or use npm.
Standalone binaries skip npm custom-provider modules; use the npm package if
you need them.

`librarium upgrade` updates npm and Homebrew installs. For an installer
install, run the installer again.

## Run your first query

```bash
librarium init
librarium doctor

# Offline preview. No provider request.
librarium plan "What changed in PostgreSQL 17?"

# May make paid provider requests.
librarium run "What changed in PostgreSQL 17?" --group quick
```

`init` walks you through choosing providers and where to store each key: the
OS keychain (macOS), a shell environment variable, or the config file. If your
provider keys are already exported as environment variables, run
`librarium init --auto` instead. It enables every provider whose key it finds,
except opt-in providers.

The SearchAPI consumer surfaces in the `visibility` workflow are opt-in. With
`SEARCHAPI_API_KEY` exported, enable them in the same step:

```bash
librarium init --auto --enable searchapi-chatgpt,searchapi-gemini,searchapi-google-ai-mode,searchapi-bing-copilot,searchapi-google-ai-overview
```

A `visibility` run names each member it skips and the `init --enable` command
that enables it.

`doctor` checks configuration and credential presence offline. Only
`doctor --live` loads trusted custom code, makes provider requests, and may
incur charges.

`plan` runs canonical compilation, local credential-reference resolution, and
budget admission. It stops before adapter initialization and makes no provider
requests. “Plan ready” is not authentication, availability, a frozen executable
plan, a price quote, or a final-bill guarantee.

New requests default to `quick` in `sync` mode. `run --json` reserves stdout for
JSON and sends progress to stderr. Use `answer --verify` for evidence-bounded
answer synthesis; incomplete verification does not turn a model answer into a
verified claim.

## Catalog

The v2 catalog has **34 built-in providers** and **41 implemented public
profiles**. Selection and provenance use `provider_id/profile_id`.

| Provider family | Public profiles |
| --- | --- |
| Brave | `brave-search/search`, `brave-answers/grounded` |
| Claude | `claude/chat` |
| Exa | `exa/search`, `exa/research` |
| Firecrawl | `firecrawl-search/search` |
| Gemini | `gemini-grounded/grounded`, `gemini-deep/research`, `gemini-chat/chat` |
| Grok | `grok/web`, `grok-x-only/x`, `grok-combined/combined` |
| Jina | `jina-search/search` |
| Kagi | `kagi-fastgpt/grounded` |
| OpenAI | `openai-research/research`, `openai-chat/chat` |
| OpenRouter | `openrouter/grounded`, `openrouter/chat` |
| Parallel | `parallel/search`, `parallel/turbo`, `parallel/research` |
| Perplexity | `perplexity-search/search`, `perplexity-sonar-pro/grounded`, `perplexity-deep-research/research`, `perplexity-sonar-deep/research` |
| SearchAPI | `searchapi/search`, `searchapi-chatgpt/surface`, `searchapi-gemini/surface`, `searchapi-perplexity/surface`, `searchapi-google-ai-mode/surface`, `searchapi-bing-copilot/surface`, `searchapi-google-ai-overview/surface` |
| SerpAPI | `serpapi/search` |
| SerpBase | `serpbase/search`, `serpbase/news` |
| Tavily | `tavily/search` |
| Valyu | `valyu/search`, `valyu/research` |
| You.com | `you-research/grounded`, `you-research/research`, `you-answer/grounded` |

Built-in workflows:

| Workflow | Selection |
| --- | --- |
| `quick` | Curated low-latency search and grounded answers |
| `deep` | Derived from implemented research-report profiles |
| `visibility` | Six collected consumer surfaces and three API baselines |
| `all` | Derived from every selectable profile allowed by workflow policy |

Custom groups must be stored and selected as `custom:<name>`. `quick` includes
raw `exa/search`. Explicit provider selection takes precedence over a group and
does not silently widen to all enabled providers.

## Evidence and custody

- Direct APIs are `api_output`. SearchAPI consumer profiles are
  `surface_snapshot` records collected by SearchAPI. They are
  not official OpenAI, Google, Microsoft, or Perplexity APIs.
- The six SearchAPI surfaces share one collector. Agreement is
  correlated visibility evidence, not six independent confirmations.
- Citations are untrusted source references, not guarantees that a URL is safe,
  authoritative, reachable, or supportive of a nearby claim.
- `background/durable` work keeps provider-scoped handles for later polling and
  retrieval. `background/process-local` work needs the owning process state.
- Remote cancellation is not universal. Preserve run directories for recovery.
- A missing estimate, missing reported cost, API unit, or token price is unknown,
  never a zero-cost guarantee.

Every provider call can send the query and selected options upstream. Retention,
billing, and account behavior belong to that provider. SearchAPI zero retention
is sent only when configured and fails closed if the account rejects it.

The normal tests and demo make no provider requests. Paid validation uses a
separate live-validation approval protocol with a frozen target and explicit
authorization.

## CLI reference

```bash
librarium run <query> [options]
librarium plan <query> [--answer] [--verify] [selection options]
librarium answer <query> [run options] [--verify]
```

| Command | Options |
| --- | --- |
| `run` | `--providers`, `--group`, `--mode`, `--output`, `--parallel`, `--timeout`, `--max-cost`, `--max-estimated-cost`, `--yes`, `--no-fallback`, `--json`, `--refine`, `--html`, `--jsonl`, `--open` |
| `plan` | `--providers`, `--group`, `--mode`, `--parallel`, `--timeout`, `--max-cost`, `--max-estimated-cost`, `--no-fallback`, `--refine`, `--answer`, `--verify`, `--json` |
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
| `init` | `--auto`, `--enable` |
| `doctor` | `--json`, `--live` |
| `config` | `--json`, `--global`, `--menu` |
| `config migrate` | `--from`, `--project`, `--output`, `--force` |
| `cleanup` | `--days`, `--all`, `--interactive`, `--dry-run`, `--yes`, `--output`, `--json` |
| `clear` | `--interactive`, `--dry-run`, `--yes`, `--output`, `--json` |
| `upgrade` | `--check`, `--dry-run`, `--force`, `--target` |
| `install-skill` | `--force`, `--dry-run` |
| `mcp` | no explicit option |

`async` admits only durable background profiles. Historical `mixed` mode
migrates to `async`; it does not detach inline or process-local work. Use
`status --wait --retrieve` to reconcile saved durable work.

Hard budget flags require bounded network-free estimates for every primary and
fallback reserve. In-flight calls may still finish above a limit. Known failure
costs count. Saved paid-attempt state and the original deadline carry into
recovery; deleting a ledger does not reset a budget.

## Use Librarium with agents

Install the skill that matches your CLI version. It is written to
`~/.claude/skills/librarium/SKILL.md` for Claude Code; other hosts that read
Agent Skills can use the same file.

```bash
librarium install-skill
```

To give the agent tools, register `librarium mcp` as a stdio MCP server. Every
host runs the same command:

```bash
claude mcp add --scope user librarium -- librarium mcp   # Claude Code
codex mcp add librarium -- librarium mcp                 # Codex
amp mcp add librarium -- librarium mcp                   # Amp
```

For Cursor, add the server to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a
project):

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

For any other host, register a stdio server named `librarium` with command
`librarium` and arguments `["mcp"]`. If the host cannot find `librarium`, use
the absolute path that `command -v librarium` prints.

The MCP server reads the same configuration as the CLI. Keys saved in the
config file or the macOS keychain work in every host. Keys stored as
environment-variable references, which `init --auto` writes, must be present in
the server's environment. Claude Code passes your shell environment. Codex
passes only a small default set, so list the variables in `env_vars` under
`[mcp_servers.librarium]` in `~/.codex/config.toml`. In Cursor, add an `env`
entry such as `"EXA_API_KEY": "${env:EXA_API_KEY}"`. Other hosts have their own
`env` setting, such as `amp mcp add --env`.

The MCP tools are `research`, `get_results`, `check_async`, `list_providers`,
and `list_groups`. Research returns a bounded index. Read complete evidence and
citations with `get_results` pages instead of assuming the first response
contains the whole result.

## Library boundaries

| Import | Ownership |
| --- | --- |
| `librarium` | Worker-safe schemas, catalog, and pure contract utilities |
| `librarium/core` | Injected planning, coordination, and execution ports |
| `librarium/node` | Node configuration, credentials, trusted custom providers, and artifact services |

Importing `librarium` does not read the host, load adapters, access credentials,
start the CLI, or write files. Core callers supply concrete adapters and
runtime dependencies. Custom providers are executable code; trust them as code,
not as data.

The language-neutral terminal interchange lives in
[`contracts/v1`](contracts/README.md). It does not make the JavaScript and PHP
runtimes interchangeable.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and checks. Provider authors
should also read [provider development](docs/provider-development.md).

## License

Librarium is open-source software licensed under the [MIT license](LICENSE).
