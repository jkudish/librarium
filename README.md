<p align="center">
  <img src="art/gh-og.png" alt="Librarium" width="100%" />
</p>

# librarium

Fan out research queries to multiple search and deep-research APIs in parallel.

Inspired by Aaron Francis' [counselors](https://github.com/aarondfrancis/counselors), librarium applies the same fan-out pattern to search APIs. Where counselors fans out prompts to multiple LLM CLIs, librarium fans out research queries to search engines, AI-grounded search, and deep-research APIs -- collecting, normalizing, and deduplicating results into structured output.

Librarium is both a **CLI** and an **embeddable library**: `import { dispatch } from 'librarium/core'` gives you the same provider adapters and fan-out dispatcher as in-memory structured results, with no filesystem or Node-only dependencies -- it runs in Cloudflare Workers and other edge runtimes. See [Library Usage](#library-usage-librariumcore).

## Installation

### npm (requires Node.js >= 20)

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
| `-p, --providers <ids>` | Comma-separated provider IDs |
| `-g, --group <name>` | Use a predefined provider group |
| `-m, --mode <mode>` | Execution mode: `sync`, `async`, or `mixed` |
| `-o, --output <dir>` | Output base directory |
| `--parallel <n>` | Max parallel requests |
| `--timeout <n>` | Timeout per provider in seconds |
| `--json` | Output `run.json` to stdout |
| `--refine` | Rewrite the query into tier-tuned variants with one LLM call before dispatch |
| `--html` | Generate a self-contained `report.html` in the run directory |
| `--open` | Open the output directory (or `report.html` with `--html`) when the run completes |

```bash
# Run with specific providers
librarium run "database indexing" --providers perplexity-sonar-pro,exa

# Deep research, wait for completion
librarium run "AI agent architectures" --group deep --mode sync

# Fast results only
librarium run "Node.js 22 features" --group fast
```

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

### Interactive wizard

Running `librarium` with no arguments in a terminal starts an interactive wizard: enter the query, pick a group (with provider counts and tier breakdowns as hints) or hand-pick providers, choose the mode, confirm, and the run executes with the live table. Afterwards it offers to open the results in the browser below. Non-TTY invocations print help instead, so scripts never hang.

### `browse`

Browse past runs and their provider results.

```bash
librarium browse [-o <output-dir>]
```

Pick a recent run (date, query, status tallies), see its providers rendered in the same table format, and expand any provider for an inline preview of its output. Actions: open the full file in `$PAGER` (fallback `less -R`), open the run's `summary.md`, export an HTML report, back, quit.

### `html`

Generate a self-contained `report.html` for a run directory (default: the most recent run).

```bash
librarium html [run-dir] [--open]
```

The report contains the query, run metadata, the provider results table as expandable sections with each provider's rendered markdown, and the deduped source list with provider attribution. Provider markdown is HTML-escaped, so untrusted output cannot inject script. Results retrieved after the run (async deep research) fill in when the report is regenerated; `status --retrieve` regenerates an existing `report.html` automatically.

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

Remove old output directories.

```bash
# Delete directories older than 30 days (default)
librarium cleanup

# Custom age threshold
librarium cleanup --days 7

# Preview what would be deleted
librarium cleanup --dry-run
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
- **Custom providers are CLI-only.** npm- and script-based custom providers require Node (module resolution, child processes) and live behind the CLI boundary. The core registry contains the built-in adapters; you can add your own at runtime with `registerProvider()`.
- **Async deep-research from the library.** `dispatch` with `mode: 'async'`/`'mixed'` returns `asyncTasks` handles; polling/retrieval is the caller's responsibility (in the CLI, `librarium status` does this).
- **Bring your own persistence.** Core returns data; where it goes (D1, R2, files, nowhere) is up to you.

## Using with AI Agents

Librarium is designed to be used by AI coding agents. There are three ways to set it up:

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

### Option 2: Agent Prompt

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
  all            — All 17 providers

Output lands in ./agents/librarium/<timestamp>-<slug>/:
  summary.md     — Synthesized overview with stats
  sources.json   — Deduplicated citations ranked by frequency
  {provider}.md  — Per-provider detailed results
  run.json       — Machine-readable manifest

For async deep research, check status with:
  librarium status --wait

Cross-reference sources appearing in multiple providers for higher confidence.
```

### Option 3: CLAUDE.md Project Instructions

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
