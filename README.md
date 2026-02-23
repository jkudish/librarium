<p align="center">
  <img src="art/gh-og.png" alt="Librarium" width="100%" />
</p>

# librarium

Fan out research queries to multiple search and deep-research APIs in parallel.

Inspired by Aaron Francis' [counselors](https://github.com/aarondfrancis/counselors), librarium applies the same fan-out pattern to search APIs. Where counselors fans out prompts to multiple LLM CLIs, librarium fans out research queries to search engines, AI-grounded search, and deep-research APIs -- collecting, normalizing, and deduplicating results into structured output.

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
```

## Providers

Librarium ships with 13 provider adapters organized into three tiers:

| Provider | ID | Tier | API Key Env Var |
|---|---|---|---|
| Perplexity Sonar Deep Research | `perplexity-sonar-deep` | deep-research | `PERPLEXITY_API_KEY` |
| Perplexity Deep Research | `perplexity-deep-research` | deep-research | `PERPLEXITY_API_KEY` |
| Perplexity Advanced Deep Research | `perplexity-advanced-deep` | deep-research | `PERPLEXITY_API_KEY` |
| OpenAI Deep Research | `openai-deep` | deep-research | `OPENAI_API_KEY` |
| Gemini Deep Research | `gemini-deep` | deep-research | `GEMINI_API_KEY` |
| Perplexity Sonar Pro | `perplexity-sonar-pro` | ai-grounded | `PERPLEXITY_API_KEY` |
| Brave AI Answers | `brave-answers` | ai-grounded | `BRAVE_API_KEY` |
| Exa Search | `exa` | ai-grounded | `EXA_API_KEY` |
| Perplexity Search | `perplexity-search` | raw-search | `PERPLEXITY_API_KEY` |
| Brave Web Search | `brave-search` | raw-search | `BRAVE_API_KEY` |
| SearchAPI | `searchapi` | raw-search | `SEARCHAPI_API_KEY` |
| SerpAPI | `serpapi` | raw-search | `SERPAPI_API_KEY` |
| Tavily Search | `tavily` | raw-search | `TAVILY_API_KEY` |

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

```bash
# Run with specific providers
librarium run "database indexing" --providers perplexity-sonar-pro,exa

# Deep research, wait for completion
librarium run "AI agent architectures" --group deep --mode sync

# Fast results only
librarium run "Node.js 22 features" --group fast
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

### `ls`

List all available providers with their status.

```bash
librarium ls [--json]
```

Shows each provider's ID, display name, tier, enabled state, and whether an API key is configured.

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
| `deep` | perplexity-sonar-deep, perplexity-deep-research, perplexity-advanced-deep, openai-deep, gemini-deep | Thorough async research |
| `quick` | perplexity-sonar-pro, brave-answers, exa | Fast AI-grounded answers |
| `raw` | perplexity-search, brave-search, searchapi, serpapi, tavily | Traditional search results |
| `fast` | perplexity-sonar-pro, perplexity-search, brave-answers, exa, brave-search, tavily | Quick results from multiple tiers |
| `comprehensive` | All deep-research + all ai-grounded | Deep + AI-grounded combined |
| `all` | All 13 providers | Maximum coverage |

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

Each layer overrides the previous. Project config can override defaults but cannot define providers (providers are global only).

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
  all            — All 13 providers

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

The release workflow at `.github/workflows/release.yml` handles npm publishing. It requires a `NPM_TOKEN` repository secret configured in GitHub Settings > Secrets.

## Sponsoring

If librarium saves you time, consider [sponsoring development](https://github.com/sponsors/jkudish). ❤️

## License

MIT
