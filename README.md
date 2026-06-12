<p align="center">
  <img src="art/gh-og.png" alt="Librarium" width="100%" />
</p>

# librarium

Fan out research queries to multiple search and deep-research APIs in parallel.

Inspired by Aaron Francis' [counselors](https://github.com/aarondfrancis/counselors), librarium applies the same fan-out pattern to search APIs. Where counselors fans out prompts to multiple LLM CLIs, librarium fans out research queries to search engines, AI-grounded search, and deep-research APIs -- collecting, normalizing, and deduplicating results into structured output.

Librarium is both a **CLI** and an **embeddable library**: `import { dispatch } from 'librarium/core'` gives you the same provider adapters and fan-out dispatcher as in-memory structured results, with no filesystem or Node-only dependencies -- it runs in Cloudflare Workers and other edge runtimes. See [Library Usage](#library-usage-librariumcore).

## Installation

### npm (requires Node.js >= 20.12)

```bash
npm install -g librarium
```

### pnpm

```bash
pnpm install -g librarium
```

### yarn

```bash
yarn global add librarium
```

### Homebrew (macOS / Linux)

```bash
brew install jkudish/tap/librarium
```

### Standalone binary

```bash
curl -fsSL https://raw.githubusercontent.com/jkudish/librarium/main/scripts/install.sh | sh
```

### npx (no install)

```bash
npx librarium run "your query"
```

### Upgrade

```bash
librarium upgrade
```

Auto-detects your install method (npm, pnpm, yarn, Homebrew, standalone) and runs the correct upgrade command.

## Quick Start

```bash
# Auto-configure (discovers API keys from environment)
librarium init --auto

# Run a research query
librarium run "PostgreSQL connection pooling best practices"

# Use a specific group
librarium run "React Server Components" --group quick

# Check async deep research status
librarium status --wait

# Or just run `librarium` with no arguments for an interactive wizard
librarium
```

## Providers

Librarium ships with 20 built-in provider adapters organized into three tiers:

| Provider | ID | Tier | API Key Env Var |
|---|---|---|---|
| Perplexity Sonar Deep Research | `perplexity-sonar-deep` | deep-research | `PERPLEXITY_API_KEY` |
| Perplexity Deep Research | `perplexity-deep-research` | deep-research | `PERPLEXITY_API_KEY` |
| Perplexity Advanced Deep Research | `perplexity-advanced-deep` | deep-research | `PERPLEXITY_API_KEY` |
| OpenAI Deep Research (o4-mini) | `openai-deep` | deep-research | `OPENAI_API_KEY` |
| OpenAI Deep Research (o3) | `openai-deep-o3` | deep-research | `OPENAI_API_KEY` |
| Gemini Deep Research | `gemini-deep` | deep-research | `GEMINI_API_KEY` |
| Perplexity Sonar Pro | `perplexity-sonar-pro` | ai-grounded | `PERPLEXITY_API_KEY` |
| Gemini Grounded Search | `gemini-grounded` | ai-grounded | `GEMINI_API_KEY` |
| ChatGPT Search (OpenRouter) | `openrouter-online` | ai-grounded | `OPENROUTER_API_KEY` |
| Brave AI Answers | `brave-answers` | ai-grounded | `BRAVE_API_KEY` |
| Exa Search | `exa` | ai-grounded | `EXA_API_KEY` |
| You.com Research | `you-research` | ai-grounded | `YOU_COM_API_KEY` |
| Kagi FastGPT | `kagi-fastgpt` | ai-grounded | `KAGI_API_KEY` |
| Perplexity Search | `perplexity-search` | raw-search | `PERPLEXITY_API_KEY` |
| Brave Web Search | `brave-search` | raw-search | `BRAVE_API_KEY` |
| Jina AI Search | `jina-search` | raw-search | `JINA_AI_API_KEY` |
| SearchAPI | `searchapi` | raw-search | `SEARCHAPI_API_KEY` |
| SerpAPI | `serpapi` | raw-search | `SERPAPI_API_KEY` |
| Tavily Search | `tavily` | raw-search | `TAVILY_API_KEY` |
| Firecrawl Search | `firecrawl-search` | raw-search | `FIRECRAWL_API_KEY` |

### Provider ID Migration (Legacy Aliases)

Perplexity provider IDs were renamed to match current product names:

- `perplexity-sonar` -> `perplexity-sonar-pro`
- `perplexity-deep` -> `perplexity-sonar-deep`

For backward compatibility, librarium still accepts legacy IDs in:

- `run --providers`
- provider config keys in `~/.config/librarium/config.json`
- custom group members
- `fallback` targets

Legacy IDs are normalized to canonical IDs and emit a warning. Output files and `run.json` always use canonical IDs.

You can also add **custom providers** (npm modules or local scripts) via config. See [Custom Providers](#custom-providers).

## Provider Tiers

Providers are categorized into three tiers based on their capabilities, latency, and depth:

- **deep-research** -- Async deep research providers that take minutes to complete but produce comprehensive, multi-source reports. These providers may use a submit/poll/retrieve pattern. Best for thorough research on important topics.

- **ai-grounded** -- AI-powered search with inline citations. Returns results in seconds with good quality and source attribution. A solid middle ground between speed and depth.

- **raw-search** -- Traditional search engine results. Fast responses with many links and snippets, but no AI synthesis. Useful for broad link discovery and verifying specific facts.

## Commands

### `run`

Run a research query across multiple providers.

```bash
librarium run <query> [options]
```

| Flag | Description |
|---|---|
| `-p, --providers <ids\|names>` | Comma-separated provider IDs or display names (e.g. `"Exa Search,brave-search"`) |
| `-g, --group <name>` | Use a predefined provider group |
| `-m, --mode <mode>` | Execution mode: `sync`, `async`, or `mixed` |
| `-o, --output <dir>` | Output base directory |
| `--parallel <n>` | Max parallel requests |
| `--timeout <n>` | Timeout per provider in seconds |
| `--json` | Output `run.json` to stdout |
| `--refine` | Rewrite the query into tier-tuned variants with one LLM call before dispatch |
| `--html` | Generate a self-contained `report.html` in the run directory |
| `--jsonl` | Generate a machine-readable `results.jsonl` in the run directory |
| `--open` | Open the output directory (or `report.html` with `--html`) when the run completes |

```bash
# Run with specific providers
librarium run "database indexing" --providers perplexity-sonar-pro,exa

# Provider display names also work on the CLI (mix and match with IDs)
librarium run "query" -p "Exa Search,brave-search"

# Deep research, wait for completion
librarium run "AI agent architectures" --group deep --mode sync

# Fast results only
librarium run "Node.js 22 features" --group fast
```

The `--providers` flag accepts canonical IDs, legacy aliases, or display names (case- and punctuation-insensitive, so `"Exa Search"`, `exa-search`, and `EXA SEARCH` all resolve to `exa`). Display names are a CLI input convenience only. If a name is ambiguous or unrecognized, the run stops with the matching candidates or a short list of suggestions. Config files (provider keys, custom groups, fallback targets) still require canonical IDs or legacy aliases.

In an interactive terminal, `run` shows a live per-provider results table. Every row appears at fan-out with a spinner and ticking elapsed time, then resolves in place as results arrive:

```
$ librarium run "postgres pooling best practices"

  fanning out to 6 providers

  ✓ perplexity-sonar-pro   ai-grounded        2.1s    12 sources
  ✓ gemini-grounded        ai-grounded        3.4s     9 sources
  ✓ exa                    ai-grounded        1.8s    25 sources
  ✓ brave-search           raw-search         0.9s    20 results
  ✗ tavily                 raw-search         0.4s   HTTP 401 Unauthorized
    ↳ falling back to jina-search
  ✓ jina-search            raw-search         0.7s     8 results   (fallback for tavily)
  ◷ openai-deep            deep-research   submitted

  5 succeeded, 0 failed, 1 async pending in 3.5s
  ▸ 74 unique sources after dedupe (74 total citations)
  ▸ ~/research/agents/librarium/1781136000-postgres-pooling-best-practices/

  ◷ async tasks pending: run `librarium status --wait` to poll and retrieve
```

Successes are green, failures red with the reason inline, async submissions amber. Durations of 10s or more are highlighted. When a provider's API reports usage, a dim suffix shows it on the line (`· 8.4k tok` or `· $0.012`), and the summary adds a `reported cost` line covering the providers that reported one -- costs are never estimated from pricing tables, only taken from API responses. Piped or CI output degrades to plain append-on-completion lines, and `--json` keeps stdout pure JSON (the table goes to stderr).

### `answer`

Fan out a query and synthesize one grounded, cited answer from the results.

```bash
librarium answer <query> [options]
```

`answer` runs the same fan-out as `run` (defaulting to the `quick` group, overridable with `-g`/`-p`/`-m` and the usual run flags), then makes one LLM synthesis call over the successful providers' content plus the deduped source list. The model is instructed to answer only from the findings, cite with inline `[n]` indices that map to the numbered source list, and state what is uncertain rather than invent. The answer is rendered in the terminal followed by a hyperlinked source list, and written to `answer.md` in the run directory.

```
$ librarium answer "what changed in postgres 17 logical replication"

  fanning out to 4 providers

  ✓ perplexity-sonar-pro   ai-grounded        2.0s    11 sources
  ✓ gemini-grounded        ai-grounded        2.7s     8 sources
  ✓ exa                    ai-grounded        1.6s    19 sources
  ✓ brave-search           raw-search         0.8s    15 results

  Postgres 17 makes logical replication materially easier to operate. Replication
  slots and subscription state now survive a major-version upgrade with pg_upgrade,
  so you no longer have to resync subscribers after an upgrade [1] [3]. It also adds
  failover-aware slots that can follow a promoted standby, closing a long-standing
  gap for high-availability setups [2].

  What the findings do not settle is exact performance deltas under heavy write load;
  the sources describe the features but not benchmarked throughput [4].

  Sources
  [1] PostgreSQL 17 Release Notes
  [2] Logical replication failover in PG17
  [3] pg_upgrade and replication slots
  [4] What's new in Postgres 17

  4 succeeded, 0 failed, 0 async pending in 2.9s
  ▸ 38 unique sources after dedupe (53 total citations)
  ▸ ~/research/agents/librarium/1781136000-what-changed-in-postgres-17/
```

The synthesis call uses the first available of OpenAI (`gpt-5-mini`), Gemini (`gemini-2.5-flash`), or Perplexity (`sonar`), overridable via an `answer: { provider, model }` config key that falls back to the `refine` config and then to those defaults. Synthesis fails open: if every client fails (quota, auth, timeout), a detailed warning prints and the run summary and output directory still appear, so the research is never lost. The exit code reflects the run, not the synthesis. (`report.html` / `results.jsonl` regeneration does not yet include `answer.md`, and the interactive wizard does not yet offer synthesis -- both are follow-ups.)

### Interactive wizard

Running `librarium` with no arguments in a terminal starts an interactive wizard: enter the query, pick a group (with provider counts and tier breakdowns as hints) or hand-pick providers, choose the mode, confirm, and the run executes with the live table. Afterwards it offers to open the results in the browser below. Non-TTY invocations print help instead, so scripts never hang.

### `browse`

Browse past runs and their provider results.

```bash
librarium browse [-o <output-dir>]
```

Pick a recent run (date, query, status tallies) and see its providers rendered in the same table format. Selecting a provider (or the run's `summary.md`) opens the full document in a built-in fullscreen reader: markdown rendered with ANSI styling (bold headings, dim code, normalized bullets, clickable links) and hard-wrapped to the terminal width, re-wrapping on resize. Other actions: export an HTML report, back, quit.

Reader key bindings:

| Key | Action |
| --- | --- |
| `j` / `k` or arrow down / up | scroll one line |
| `space` / `PageDown` | next page |
| `b` / `PageUp` | previous page |
| `g` / `G` | jump to top / bottom |
| `o` | open the raw file in `$PAGER` (fallback `less -R`) |
| `q` / `escape` | back to the provider list |

### `html`

Generate a self-contained `report.html` for a run directory (default: the most recent run).

```bash
librarium html [run-dir] [--open]
```

The report contains the query, run metadata, the provider results table as tabs, with each provider's rendered markdown in a panel below, and the deduped source list with provider attribution. Provider markdown is HTML-escaped, so untrusted output cannot inject script. Results retrieved after the run (async deep research) fill in when the report is regenerated; `status --retrieve` regenerates an existing `report.html` automatically.

### `jsonl`

Generate a machine-readable `results.jsonl` for a run directory (default: the most recent run).

```bash
librarium jsonl [run-dir]
```

The file contains one JSON object per line (JSONL / newline-delimited JSON). Each line can be parsed independently with `JSON.parse`:

- **Line 1 -- run header** (`"type":"run"`): query, slug, timestamp, mode, succeeded/failed/pending counts, unique source count, total citation count, and optional `refinedQueries` (only present when `--refine` was used).
- **One line per provider** (`"type":"result"`): id, tier, status, durationMs, citationCount, optional usage object, optional error string, optional fallbackFor string, and `content` (the full markdown from the provider's `.md` file, or `null` when missing or pending).
- **One line per deduped source** (`"type":"source"`): url, optional title, providers array, citationCount.

Keys with undefined values are omitted. `--jsonl` and `--html` are independent and combinable. `status --retrieve` regenerates an existing `results.jsonl` automatically when one is present. The JSONL export is also available as an action in `librarium browse`.

```bash
# Run and produce both formats at once
librarium run "postgres pooling" --html --jsonl

# Regenerate JSONL for an existing run
librarium jsonl ./agents/librarium/20250601-123456-postgres-pooling

# Stream-process with jq
librarium jsonl | xargs cat | jq 'select(.type=="result") | {id, status, citationCount}'
```

### `refine`

Rewrite a research goal into tier-tuned query variants without dispatching.

```bash
librarium refine "figure out how to scale postgres connections" [--json]
```

Prints a thorough brief for deep-research providers, a focused question for ai-grounded providers, a keyword query for raw-search providers, and a suggested group. The same transform powers `run --refine`, which dispatches each provider with its tier's variant (recorded in `run.json` and `prompt.md` for reproducibility). The LLM call uses the first available of OpenAI (`gpt-5-mini`), Gemini (`gemini-2.5-flash`), or Perplexity (`sonar`), overridable via a `refine: { provider, model }` config key. If the call fails, the run proceeds with the original query.

### `completions`

Print a static shell completion script covering commands, flags, and the builtin group names.

```bash
# zsh
eval "$(librarium completions zsh)"

# bash
eval "$(librarium completions bash)"

# fish
librarium completions fish > ~/.config/fish/completions/librarium.fish
```

### `status`

Check or wait for async deep-research tasks.

```bash
librarium status [options]
```

| Flag | Description |
|---|---|
| `--wait` | Block and poll until all async tasks complete |
| `--retrieve` | Fetch completed results and write output files |
| `--json` | Output JSON |

```bash
# Check pending tasks
librarium status

# Wait for completion then retrieve results
librarium status --wait --retrieve
```

Retrieved results render with the same table line format as `run`, with the output file and word count appended:

```
  ✓ openai-deep   deep-research     95.0s    14 sources   openai-deep.md, 2310 words
```

### `ls`

List all available providers with their status.

```bash
librarium ls [--json]
```

Shows each provider's ID, display name, tier, source (`builtin`, `npm`, `script`), enabled state, and whether an API key is configured.

### `groups`

List and manage provider groups.

```bash
# List all groups
librarium groups

# Add a custom group
librarium groups add my-stack perplexity-sonar-pro exa tavily

# Remove a custom group
librarium groups remove my-stack

# Output as JSON
librarium groups --json
```

### `init`

Set up librarium configuration. Auto mode discovers API keys from your environment and enables matching providers.

```bash
# Auto-discover (non-interactive)
librarium init --auto

# Interactive setup
librarium init
```

### `doctor`

Health check: tests API connectivity for all enabled providers.

```bash
librarium doctor [--json]
```

### `config`

Print the resolved configuration (global merged with project).

```bash
# Show resolved config
librarium config

# Show only global config
librarium config --global

# Output raw JSON
librarium config --json
```

### `cleanup`

Remove output directories. By default deletes runs older than 30 days; `--all`
deletes every run regardless of age.

```bash
# Delete directories older than 30 days (default)
librarium cleanup

# Custom age threshold
librarium cleanup --days 7

# Preview what would be deleted (count, total size, oldest/newest)
librarium cleanup --dry-run

# Delete every run directory (interactive confirm in a TTY)
librarium cleanup --all

# Pick exactly which runs to delete from a checklist
librarium cleanup -i

# JSON output and an alternate output base dir
librarium cleanup --all --json -o ./agents/librarium
```

In a terminal, `--all` prompts for confirmation (showing run count and total
size on disk) before deleting. In a non-interactive context (pipe, CI), pass
`--yes` to confirm, otherwise the command refuses to delete. Runs that still
have pending async tasks are flagged in the list and confirm, since deleting
them orphans the server-side task handle. The command never deletes anything
outside the resolved output base directory and refuses to operate if that
directory resolves to your home directory or a filesystem root.

### `clear`

Alias for `librarium cleanup --all`: deletes every run directory. Same flags
pass through (`--dry-run`, `-i`/`--interactive`, `--yes`, `-o`/`--output`,
`--json`).

```bash
# Delete all runs (interactive confirm in a TTY, --yes required in non-TTY)
librarium clear

# Preview everything that would be removed
librarium clear --dry-run

# Interactively pick which runs to clear
librarium clear -i
```

### `mcp`

Start an MCP server over stdio so AI agents can drive librarium through tool
calls. See [Using with AI Agents](#using-with-ai-agents) for setup and the full
tool list.

```bash
# Register with Claude Code
claude mcp add librarium -- librarium mcp

# Or run directly (stdout is the protocol stream; diagnostics go to stderr)
librarium mcp
```

## Groups

Groups are named collections of provider IDs. Librarium ships with six default groups:

| Group | Providers | Use Case |
|---|---|---|
| `deep` | perplexity-sonar-deep, perplexity-deep-research, perplexity-advanced-deep, openai-deep, openai-deep-o3, gemini-deep | Thorough async research |
| `quick` | gemini-grounded, openrouter-online, brave-answers, exa, kagi-fastgpt | Fast AI-grounded answers |
| `raw` | perplexity-search, brave-search, jina-search, firecrawl-search, searchapi, serpapi, tavily | Traditional search results |
| `fast` | perplexity-sonar-pro, gemini-grounded, openrouter-online, perplexity-search, brave-answers, exa, kagi-fastgpt, jina-search, brave-search, firecrawl-search, tavily | Quick results from multiple tiers |
| `comprehensive` | All deep-research + all ai-grounded | Deep + AI-grounded combined |
| `all` | All 20 providers | Maximum coverage |

### Custom Groups

Add custom groups via CLI or config file:

```bash
# Via CLI
librarium groups add my-research perplexity-sonar-pro exa brave-search

# Via config.json
{
  "groups": {
    "my-research": ["perplexity-sonar-pro", "exa", "brave-search"]
  }
}
```

## Execution Modes

Librarium supports three execution modes, configurable via `--mode` or the `defaults.mode` config key:

- **`sync`** -- Wait for all providers to complete, including deep-research providers. Deep research runs synchronously (can take several minutes).

- **`async`** -- Submit deep-research tasks and return immediately. Use `librarium status --wait --retrieve` to poll and fetch results later.

- **`mixed`** (default) -- Run ai-grounded and raw-search providers synchronously. Submit deep-research providers asynchronously. You get fast results right away and can retrieve deep research later.

True background submission depends on the provider's API. `openai-deep`, `openai-deep-o3`, and `perplexity-sonar-deep` (via Perplexity's Async Sonar API) submit and return immediately in `mixed`/`async` mode; poll with `librarium status --wait`. `perplexity-deep-research` and `perplexity-advanced-deep` use Perplexity's Agent API, which has no background mode, so they complete inline even in mixed mode. `gemini-deep` also completes inline.

## Provider Fallback

When a provider fails for any reason (exception, error response, timeout), librarium can automatically try a lighter alternative. Add an optional `fallback` field to any provider's config:

```json
{
  "providers": {
    "gemini-deep": {
      "apiKey": "$GEMINI_API_KEY",
      "enabled": true,
      "fallback": "openai-deep"
    },
    "openai-deep": {
      "apiKey": "$OPENAI_API_KEY",
      "enabled": false
    }
  }
}
```

**Behavior:**

- Fallback triggers after the primary provider's execution fails (error or timeout)
- Only single-level fallback is supported (a fallback's own fallback is ignored)
- The fallback provider must be configured with a valid API key but can be `enabled: false` (it will only activate as a backup)
- If the fallback provider is already running in the same dispatch (e.g., explicitly listed in `--providers`), it won't be triggered again
- Output files use the fallback provider's ID (e.g., `openai-deep.md`)

**In `run.json`**, both the original error report and the fallback result appear in the `providers` array. The fallback report includes a `fallbackFor` field indicating which provider it replaced:

```json
{
  "id": "openai-deep",
  "tier": "deep-research",
  "status": "success",
  "fallbackFor": "gemini-deep"
}
```

## Configuration

Librarium uses a layered configuration system:

1. **Global config**: `~/.config/librarium/config.json`
2. **Project config**: `.librarium.json` (in current directory)
3. **CLI flags**: Passed directly to commands

Each layer overrides the previous:

- `defaults`: project overrides global
- `providers`: deep-merged by provider ID (project overrides keys on conflict)
- `customProviders`: merged by provider ID (project overrides global on same ID)
- `trustedProviderIds`: union + dedupe across global and project
- `groups`: project overrides global group names on conflict

### Global Config Example

```json
{
  "version": 1,
  "defaults": {
    "outputDir": "./agents/librarium",
    "maxParallel": 6,
    "timeout": 30,
    "asyncTimeout": 1800,
    "asyncPollInterval": 10,
    "mode": "mixed"
  },
  "providers": {
    "perplexity-sonar-pro": {
      "apiKey": "$PERPLEXITY_API_KEY",
      "enabled": true
    },
    "brave-answers": {
      "apiKey": "$BRAVE_API_KEY",
      "enabled": true
    },
    "exa": {
      "apiKey": "$EXA_API_KEY",
      "enabled": true
    },
    "tavily": {
      "apiKey": "$TAVILY_API_KEY",
      "enabled": true
    }
  },
  "customProviders": {},
  "trustedProviderIds": [],
  "groups": {
    "my-custom-group": ["perplexity-sonar-pro", "exa"]
  }
}
```

API keys use the `$ENV_VAR` pattern -- the value `"$PERPLEXITY_API_KEY"` resolves to `process.env.PERPLEXITY_API_KEY` at runtime. Keys are never stored in plaintext.

Some providers support optional model overrides. For example, to override Gemini Deep Research:

```json
{
  "providers": {
    "gemini-deep": {
      "apiKey": "$GEMINI_API_KEY",
      "enabled": true,
      "model": "gemini-2.5-flash"
    }
  }
}
```

### Project Config Example

```json
{
  "defaults": {
    "outputDir": "./research",
    "timeout": 60
  },
  "providers": {
    "perplexity-sonar-pro": {
      "enabled": false
    },
    "my-script-provider": {
      "enabled": true
    }
  },
  "customProviders": {
    "my-script-provider": {
      "type": "script",
      "command": "node",
      "args": ["./scripts/librarium-provider.mjs"]
    }
  },
  "trustedProviderIds": ["my-script-provider"],
  "groups": {
    "project-research": ["my-script-provider", "exa"]
  }
}
```

## Custom Providers

Librarium supports external providers without changing core code. Add definitions to config and trust them explicitly.

For provider-author implementation details (module contract, script runtime semantics, timeouts, and troubleshooting), see [`docs/provider-development.md`](docs/provider-development.md).

### Trust Model

- Custom providers load only when their ID appears in `trustedProviderIds`
- Trust lists from global and project config are unioned and deduped
- Built-in IDs are reserved; custom providers cannot override built-ins

### NPM Provider Example

```json
{
  "customProviders": {
    "my-npm-provider": {
      "type": "npm",
      "module": "librarium-provider-myteam",
      "export": "createProvider",
      "options": { "preset": "fast" }
    }
  },
  "trustedProviderIds": ["my-npm-provider"],
  "providers": {
    "my-npm-provider": {
      "enabled": true,
      "apiKey": "$MY_PROVIDER_API_KEY"
    }
  }
}
```

`module` resolution order is:
1. Current project (`process.cwd()`)
2. Librarium runtime install context

In standalone/Homebrew binary installs, npm custom providers are skipped with a warning.

### Script Provider Example

```json
{
  "customProviders": {
    "my-script-provider": {
      "type": "script",
      "command": "node",
      "args": ["./scripts/librarium-provider.mjs"],
      "cwd": ".",
      "env": { "LOG_LEVEL": "warn" },
      "options": { "flavor": "deep" }
    }
  },
  "trustedProviderIds": ["my-script-provider"],
  "providers": {
    "my-script-provider": {
      "enabled": true
    }
  }
}
```

Script providers are invoked as one process per operation (`describe`, `execute`, `submit`, `poll`, `retrieve`, `test`) with JSON over stdin/stdout.

### Script Protocol (v1)

Request envelope:

```json
{
  "protocolVersion": 1,
  "operation": "execute",
  "providerId": "my-script-provider",
  "query": "research topic",
  "options": { "timeout": 30 },
  "providerConfig": { "enabled": true },
  "sourceOptions": { "flavor": "deep" }
}
```

Response envelope:

```json
{
  "ok": true,
  "data": {
    "provider": "my-script-provider",
    "tier": "ai-grounded",
    "content": "# Result",
    "citations": [],
    "durationMs": 1200
  }
}
```

Error response:

```json
{
  "ok": false,
  "error": "upstream timeout"
}
```

`describe` must return provider metadata and capabilities:

```json
{
  "ok": true,
  "data": {
    "displayName": "My Script Provider",
    "tier": "deep-research",
    "envVar": "MY_PROVIDER_API_KEY",
    "requiresApiKey": true,
    "capabilities": {
      "submit": true,
      "poll": true,
      "retrieve": true,
      "test": true
    }
  }
}
```

## Output Format

Each research run creates a timestamped output directory:

```
./agents/librarium/1771500000-postgresql-pooling/
  prompt.md              # The research query
  run.json               # Run manifest (machine-readable)
  summary.md             # Synthesized summary with statistics
  sources.json           # Deduplicated citations across all providers
  perplexity-sonar-pro.md    # Per-provider markdown results
  perplexity-sonar-pro.meta.json  # Per-provider metadata (model, timing, citations)
  brave-answers.md
  brave-answers.meta.json
  async-tasks.json       # Present if any async tasks were submitted
```

### run.json Schema

```json
{
  "version": 1,
  "timestamp": 1771500000,
  "slug": "postgresql-pooling",
  "query": "PostgreSQL connection pooling best practices",
  "mode": "mixed",
  "outputDir": "/absolute/path/to/output",
  "providers": [
    {
      "id": "perplexity-sonar-pro",
      "tier": "ai-grounded",
      "status": "success",
      "durationMs": 2340,
      "wordCount": 850,
      "citationCount": 12,
      "outputFile": "perplexity-sonar-pro.md",
      "metaFile": "perplexity-sonar-pro.meta.json"
    }
  ],
  "sources": {
    "total": 45,
    "unique": 28,
    "file": "sources.json"
  },
  "asyncTasks": [],
  "exitCode": 0
}
```

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | All providers succeeded |
| `1` | Partial success (some providers failed) |
| `2` | Total failure (all providers failed, or configuration error) |

## Library Usage (`librarium/core`)

Everything the CLI does with providers is importable. The `librarium/core` entry exposes the adapters, registry, dispatcher, normalizer, and types -- and returns results **in memory** (writing `run.json`/report files is a CLI concern). The core entry has zero Node-only dependencies: no `node:fs`, no `process.env` access, fetch-based HTTP only. It is tested in workerd (Cloudflare's runtime) on every CI run.

```bash
npm install librarium
```

```ts
import { dispatch, initializeProviders, type Config } from 'librarium/core';

// Credentials are injected -- core never reads process.env itself.
// Pass an env map (Workers: pass your `env` binding) or a resolveCredential fn.
const credentials = { env: { GEMINI_API_KEY: '...', OPENROUTER_API_KEY: '...' } };

await initializeProviders({ credentials });

const config: Config = {
  version: 1,
  defaults: { outputDir: '', maxParallel: 4, timeout: 60, asyncTimeout: 600, asyncPollInterval: 5, mode: 'sync' },
  providers: {
    'gemini-grounded': { enabled: true },
    'openrouter-online': { enabled: true },
  },
  customProviders: {},
  trustedProviderIds: [],
  groups: {},
};

const { results, asyncTasks } = await dispatch({
  config,
  providerIds: ['gemini-grounded', 'openrouter-online'],
  query: 'What is the best wholesale produce supplier in London?',
  mode: 'sync',
  credentials,
});

for (const r of results) {
  // { provider, tier, status, text, sourceUrls, citations, durationMs,
  //   model, tokenUsage, error, fallbackFor }
  console.log(r.provider, r.status, r.sourceUrls);
}
```

Notes:

- **Credential injection.** `CredentialContext` is `{ env?: Record<string, string | undefined>, resolveCredential?: (value: string) => string | undefined }`. `$ENV_VAR` references in provider config resolve against the injected `env`; literal keys pass through. In the CLI, this is backed by `process.env` -- in a Worker, pass your env binding.
- **Custom providers from the library.** Hand-written providers work anywhere via `registerProvider()` (edge included). npm- and script-based custom providers need Node (module resolution, child processes), so they load through the dedicated `librarium/node` entry -- the same loader the CLI uses. See [Custom providers](#custom-providers-librariumnode).
- **Async deep-research from the library.** `dispatch` with `mode: 'async'`/`'mixed'` returns `asyncTasks` handles; polling/retrieval is the caller's responsibility. See [Async deep-research](#async-deep-research-from-the-library).
- **Bring your own persistence.** Core returns data; where it goes (D1, R2, files, nowhere) is up to you.

### Custom providers (`librarium/node`)

Three flavors of custom provider:

1. **Hand-written** -- implement the `Provider` interface (fetch-based) and call `registerProvider(provider)` from `librarium/core`. This is edge-safe and works in Workers.
2. **npm modules** -- a published/local package exporting a provider (or a factory). Requires Node module resolution.
3. **scripts** -- an external executable that speaks librarium's JSON-over-stdio protocol. Requires child processes.

The last two are Node-only, so they live behind the `librarium/node` entry point (one implementation, shared with the CLI). It exposes:

- `loadCustomProviders(config, options?) -> { providers, loadedIds, skippedIds, warnings }` -- loads (but does not register) the npm/script providers declared in `config.customProviders`, applying the same `trustedProviderIds` gating and reserved-ID protection the CLI uses.
- `registerCustomProviders(config, options?)` -- convenience that loads and registers them into the core registry. Call it after `initializeProviders()` so reserved-ID detection sees the built-ins. Same return shape.

```ts
import { dispatch, initializeProviders, getProvider } from 'librarium/core';
import { registerCustomProviders } from 'librarium/node';

const credentials = { env: process.env };
await initializeProviders({ credentials });

const config = {
  version: 1 as const,
  defaults: { outputDir: '', maxParallel: 4, timeout: 60, asyncTimeout: 600, asyncPollInterval: 5, mode: 'sync' as const },
  providers: { 'my-search': { enabled: true } },
  // npm: { type: 'npm', module: 'my-search-provider', export: 'default' }
  // script: { type: 'script', command: './providers/my-search.mjs' }
  customProviders: { 'my-search': { type: 'npm' as const, module: 'my-search-provider' } },
  trustedProviderIds: ['my-search'], // untrusted IDs are skipped with a warning
  groups: {},
};

const { warnings, loadedIds } = await registerCustomProviders(config);
if (warnings.length) console.warn(warnings.join('\n'));

// Now registered alongside the built-ins -- dispatch sees it.
console.log(getProvider('my-search')?.source); // 'npm'
const { results } = await dispatch({
  config,
  providerIds: loadedIds,
  query: 'best wholesale produce supplier in London',
  mode: 'sync',
  credentials,
});
```

`librarium/core` stays Node-free: edge users never import `librarium/node` and keep using fetch-based `registerProvider()` providers.

### Async deep-research from the library

Deep-research providers can run asynchronously. In `mode: 'mixed'` (or `'async'`), `dispatch` submits each deep-research task and returns an `AsyncTaskHandle` in `asyncTasks` instead of blocking; sync-tier providers still return their results inline. The caller persists the handles, then later polls and retrieves through the registry -- there is no background worker in core.

```ts
import {
  dispatch,
  initializeProviders,
  getProvider,
  type AsyncTaskHandle,
  type Config,
} from 'librarium/core';

const credentials = { env: process.env };
await initializeProviders({ credentials });

const config: Config = {
  version: 1,
  defaults: { outputDir: '', maxParallel: 4, timeout: 60, asyncTimeout: 600, asyncPollInterval: 5, mode: 'mixed' },
  providers: {
    'openai-deep': { enabled: true },        // deep-research -> async
    'gemini-grounded': { enabled: true },    // ai-grounded -> sync, inline
  },
  customProviders: {},
  trustedProviderIds: [],
  groups: {},
};

// 1. Dispatch. Sync results are inline; deep-research tasks come back as handles.
const { results, asyncTasks } = await dispatch({
  config,
  providerIds: ['openai-deep', 'gemini-grounded'],
  query: 'State of solid-state battery commercialization in 2026',
  mode: 'mixed',
  credentials,
});

for (const r of results) {
  // r.status is one of: 'success' | 'error' | 'timeout' | 'skipped' | 'async-pending'
  // Deep-research providers submitted async show up here as 'async-pending'
  // (empty text); their real payload arrives via retrieve() below.
  if (r.status === 'success') console.log(r.provider, r.sourceUrls);
}

// 2. Persist the handles wherever you want (DB, KV, file, queue). They're plain
//    JSON: { provider, taskId, query, submittedAt, status, ... }.
await saveHandles(asyncTasks); // your storage

// ...later, in a separate invocation, reload the handles and resolve them:
const handles: AsyncTaskHandle[] = await loadHandles();

for (const handle of handles) {
  const provider = getProvider(handle.provider);
  if (!provider?.poll || !provider.retrieve) continue; // not an async provider

  // 3. Poll for status. AsyncPollResult.status is the AsyncTaskStatus enum:
  //    'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  const poll = await provider.poll(handle);
  if (poll.status === 'pending' || poll.status === 'running') {
    continue; // still cooking -- check again next time
  }
  if (poll.status !== 'completed') {
    console.warn(`${handle.provider} ${poll.status}: ${poll.message ?? ''}`);
    continue;
  }

  // 4. Retrieve the finished result. retrieve() returns a ProviderResult:
  //    { provider, tier, content, citations, durationMs, model?, tokenUsage?, usage?, error? }
  const result = await provider.retrieve(handle);
  if (result.error) {
    console.warn(`${handle.provider} retrieve error: ${result.error}`);
    continue;
  }
  console.log(result.provider, result.content);
  for (const c of result.citations) console.log(' -', c.title ?? c.url, c.url);
}
```

> **Workers note.** A single request can't block for minutes, so split the lifecycle: dispatch on the first request and persist `asyncTasks` (KV, D1, R2, or a Durable Object), then resolve them on a later request, a Cron Trigger, or a Durable Object alarm. `getProvider(handle.provider).poll/retrieve` is pure fetch, so it runs in the same Worker -- just reload the handle from storage between invocations.

## Using with AI Agents

Librarium is designed to be used by AI coding agents. There are four ways to set it up:

### Option 1: Claude Code Skill (Recommended)

The built-in skill teaches Claude Code how to use librarium through a 7-phase research workflow.

```bash
# Install via CLI
librarium install-skill

# Or manually
mkdir -p ~/.claude/skills/librarium
curl -o ~/.claude/skills/librarium/SKILL.md https://raw.githubusercontent.com/jkudish/librarium/main/SKILL.md
```

Once installed, Claude Code will automatically use librarium when you ask it to research a topic. Triggers: `/librarium`, `/research`, `/deep-research`.

### Option 2: MCP Server

Librarium ships an MCP (Model Context Protocol) server over stdio so agents can drive it directly through tool calls instead of shelling out to the CLI. Register it with Claude Code:

```bash
claude mcp add librarium -- librarium mcp
```

Or add it to any MCP client's stdio config:

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

The server exposes these tools:

- `research`: fan out a query across providers; writes the full run directory and returns a compact structured result (output dir, per-provider tallies, top deduped sources, pending async task ids). Full provider text is not inlined.
- `get_results`: read provider markdown from a run directory (defaults to the most recent run), capped per provider with a truncation marker, plus the manifest summary.
- `check_async`: one poll pass over pending async deep-research tasks; with `retrieve` it fetches completed results back into the run.
- `list_providers`: registry and config snapshot (id, name, tier, enabled, key configured).
- `list_groups`: configured provider groups and their members.

In MCP mode, stdout carries the protocol stream only; all diagnostics go to stderr. The server shuts down cleanly when the client disconnects.

### Option 3: Agent Prompt

Drop this into any AI agent's system prompt to give it librarium capabilities:

```
You have access to the `librarium` CLI for deep multi-provider research.

To research a topic, run:
  librarium run "<query>" --group <group>

Groups:
  quick          — Fast AI-grounded answers (seconds)
  deep           — Thorough async research (minutes)
  fast           — Quick results from multiple tiers
  comprehensive  — Deep + AI-grounded combined
  all            — All 20 providers

Output lands in ./agents/librarium/<timestamp>-<slug>/:
  summary.md     — Synthesized overview with stats
  sources.json   — Deduplicated citations ranked by frequency
  {provider}.md  — Per-provider detailed results
  run.json       — Machine-readable manifest

For async deep research, check status with:
  librarium status --wait

Cross-reference sources appearing in multiple providers for higher confidence.
```

### Option 4: CLAUDE.md Project Instructions

Add to your project's `CLAUDE.md` for project-scoped research:

```markdown
## Research

Use `librarium` for research queries. It's installed globally.
- Quick lookups: `librarium run "query" --group quick`
- Deep research: `librarium run "query" --group deep --mode sync`
- Results land in `./agents/librarium/` — read `summary.md` first, then `sources.json` for citations
```

### 7-Phase Research Workflow

The skill guides agents through:

1. **Query Analysis** -- Classify the research question and pick the right provider group
2. **Provider Selection** -- Match query type to tier (`quick` for facts, `deep` for thorough research, `all` for max coverage)
3. **Dispatch** -- Run the query with appropriate flags
4. **Monitor** -- Track async deep-research tasks
5. **Retrieve** -- Fetch completed async results
6. **Analyze** -- Read `summary.md`, `sources.json`, and per-provider output files
7. **Synthesize** -- Cross-reference multi-provider findings, weight by citation frequency

## Publishing

The release workflow at `.github/workflows/release.yml` handles npm publishing via [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (GitHub Actions OIDC) — no token secret required. The trusted publisher is configured in the package settings on npmjs.com (repo `jkudish/librarium`, workflow `release.yml`).

## Sponsoring

If librarium saves you time, consider [sponsoring development](https://github.com/sponsors/jkudish). ❤️

## License

MIT
