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
- **Specific provider**: Use `--providers` flag

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
| `librarium ls` | List providers and status |
| `librarium doctor` | Health check providers |
| `librarium config` | Show resolved config |

## Provider Tiers

| Tier | Providers | Speed | Depth |
|------|-----------|-------|-------|
| deep-research | perplexity-sonar-deep, perplexity-deep-research, perplexity-advanced-deep, openai-deep, gemini-deep | Minutes | Comprehensive |
| ai-grounded | perplexity-sonar-pro, brave-answers, exa | Seconds | Good |
| raw-search | perplexity-search, brave-search, searchapi, serpapi, tavily | Fast | Links only |

## Output Structure

```
./agents/librarium/{timestamp}-{slug}/
  prompt.md, run.json, summary.md, sources.json
  {provider}.md, {provider}.meta.json
  async-tasks.json (if applicable)
```
