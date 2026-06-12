---
description: Run multi-provider deep research queries using the librarium CLI
triggers:
  - /librarium
  - /research
  - /deep-research
  - deep research
  - multi-provider search
---

# Librarium -- Multi-Provider Deep Research

Run research queries across 10 search and deep-research APIs in parallel, collect results, deduplicate sources, and produce structured output.

## Prerequisites

- `librarium` CLI installed (`npm install -g librarium`)
- API keys configured (`librarium init --auto`)
- Binary at: `librarium` (or `npx librarium`)

## 7-Phase Research Workflow

### Phase 1: Query Analysis
Analyze the user's research question. Determine:
- Is this a technical, business, or general knowledge query?
- Which provider group is best suited? (`quick` for fast answers, `deep` for thorough research, `comprehensive` for important decisions, `all` for maximum coverage)
- What execution mode? (`sync` for quick queries, `mixed` for deep research)

### Phase 2: Provider Selection
Select providers based on query type:
- **Technical queries**: Use `comprehensive` group (deep research + AI-grounded)
- **Quick facts**: Use `quick` group (AI-grounded only, fast)
- **Competitive research**: Use `all` group (maximum coverage)
- **Specific provider**: Use `--providers` flag (accepts canonical IDs or display names, e.g. `-p "Exa Search,brave-search"`)

### Phase 3: Dispatch
Run the query:
```bash
librarium run "your query here" --group <group> [--mode mixed]
```

### Phase 4: Monitor Async Tasks
If deep-research providers were used in async mode:
```bash
librarium status --wait
```

### Phase 5: Retrieve Results
Once complete, async results can be retrieved:
```bash
librarium status --retrieve
```

### Phase 6: Analyze Output
Read the output files:
1. `summary.md` -- Overall research summary with statistics
2. `sources.json` -- Deduplicated citations ranked by frequency
3. Individual `{provider}.md` files for detailed per-provider results
4. `run.json` -- Machine-readable manifest

### Phase 7: Synthesize
Combine findings from multiple providers into a coherent answer. Cross-reference sources that appear across multiple providers (higher citation count = higher confidence).

## Key Commands

| Command | Purpose |
|---------|---------|
| `librarium run <query>` | Run research query |
| `librarium run <query> --group quick` | Fast AI-grounded search |
| `librarium run <query> --group deep` | Deep research (async) |
| `librarium run <query> --group all` | All providers |
| `librarium status` | Check async tasks |
| `librarium status --wait --retrieve` | Wait and fetch async results |
| `librarium run <query> --html --open` | Run, then open an HTML report |
| `librarium run <query> --jsonl` | Run, then write machine-readable results.jsonl |
| `librarium browse` | Browse past runs interactively |
| `librarium html [run-dir]` | Generate report.html for a run |
| `librarium jsonl [run-dir]` | Generate results.jsonl for a run |
| `librarium refine <goal>` | Tier-tuned query variants, no dispatch |
| `librarium ls` | List providers and status |
| `librarium doctor` | Health check providers |
| `librarium config` | Show resolved config |
| `librarium cleanup [--days N] [--dry-run]` | Delete run dirs older than N days (default 30) |
| `librarium clear [--dry-run] [-i] [--yes]` | Delete all run dirs (alias for `cleanup --all`); `-i` to pick interactively |

## MCP Server

Instead of shelling out to the CLI, agents can drive librarium over the Model Context Protocol with `librarium mcp` (stdio transport). Register it once with `claude mcp add librarium -- librarium mcp`, then call the tools: `research`, `get_results`, `check_async`, `list_providers`, `list_groups`. The `research` tool runs the same silent file-writing pipeline as `librarium run` and returns a compact structured result; fetch full provider markdown with `get_results`.

## Provider Tiers

| Tier | Providers | Speed | Depth |
|------|-----------|-------|-------|
| deep-research | perplexity-sonar-deep, perplexity-deep-research, perplexity-advanced-deep, openai-deep, openai-deep-o3, gemini-deep | Minutes | Comprehensive |
| ai-grounded | perplexity-sonar-pro, brave-answers, exa, you-research, kagi-fastgpt | Seconds | Good |
| raw-search | perplexity-search, brave-search, jina-search, searchapi, serpapi, tavily | Fast | Links only |

## Output Structure

```
./agents/librarium/{timestamp}-{slug}/
  prompt.md, run.json, summary.md, sources.json
  {provider}.md, {provider}.meta.json
  async-tasks.json (if applicable)
```
