---
title: Commands
description: Every CLI command with flags and examples.
order: 2
---

## run

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

## status

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

## ls

List all available providers with their status.

```bash
librarium ls [--json]
```

Shows each provider's ID, display name, tier, source (`builtin`, `npm`, `script`), enabled state, and whether an API key is configured.

## groups

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

## init

Set up librarium configuration. Auto mode discovers API keys from your environment and enables matching providers.

```bash
# Auto-discover (non-interactive)
librarium init --auto

# Interactive setup
librarium init
```

## doctor

Health check: tests API connectivity for all enabled providers.

```bash
librarium doctor [--json]
```

## config

Print the resolved configuration (global merged with project).

```bash
# Show resolved config
librarium config

# Show only global config
librarium config --global

# Output raw JSON
librarium config --json
```

## cleanup

Remove old output directories.

```bash
# Delete directories older than 30 days (default)
librarium cleanup

# Custom age threshold
librarium cleanup --days 7

# Preview what would be deleted
librarium cleanup --dry-run
```

## upgrade

Auto-detects your install method and runs the correct upgrade command.

```bash
librarium upgrade
```

## Output format

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

### run.json schema

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

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All providers succeeded |
| `1` | Partial success (some providers failed) |
| `2` | Total failure (all providers failed, or configuration error) |
