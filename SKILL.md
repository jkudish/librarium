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

Run research queries across 31 search, deep-research, answer-engine, and LLM
provider adapters in parallel, collect results, deduplicate sources, and
produce structured output.

## Prerequisites

- `librarium` CLI installed (`npm install -g librarium`)
- API keys configured (`librarium init --auto`)
- Binary at: `librarium` (or `npx librarium`)

## 7-Phase Research Workflow

### Phase 1: Query Analysis
Analyze the user's research question. Determine:
- Is this a technical, business, or general knowledge query?
- Which provider group is best suited? (`quick` for fast answers, `deep` for
  thorough research, `visibility` for an explicit nine-surface answer-engine
  comparison, `comprehensive` for important decisions, `all` for all 27
  grounded providers, `llm` for direct model answers with web search enabled by
  default)
- What execution mode? (`sync` for quick queries, `mixed` for deep research)

### Phase 2: Provider Selection
Select providers based on query type:
- **Technical queries**: Use `comprehensive` group (deep research + AI-grounded)
- **Quick facts**: Use `quick` group (AI-grounded only, fast)
- **Competitive research**: Use `all` group (maximum grounded coverage)
- **Answer visibility**: Use `visibility` only when you deliberately want the
  nine-surface consumer/first-party comparison
- **Direct model answers**: Use `llm` group (Claude, OpenAI, Gemini, OpenRouter). Web search is enabled by default; disable `llmWebSearch` for an ungrounded baseline with no citations.
- **Specific provider**: Use `--providers` (canonical IDs or display names,
  e.g. `-p "Exa Search,brave-search"`)

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
| `librarium run <query> --group visibility` | Compare nine answer-engine surfaces |
| `librarium run <query> --group all` | All providers |
| `librarium answer <query>` | Fan out (default `quick`) and synthesize one grounded, cited answer to `answer.md` |
| `librarium run <query> --max-cost 0.50` | Stop launching providers once API-reported cost crosses the budget |
| `librarium run <query> --yes` | Skip the deep-research pre-flight confirm (3+ deep providers) |
| `librarium status` | Check async tasks |
| `librarium status --wait --retrieve` | Wait and fetch async results |
| `librarium usage [--days N] [--json]` | Aggregate API-reported cost and tokens across past runs |
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
| deep-research | perplexity-sonar-deep, perplexity-deep-research, perplexity-advanced-deep, openai-research, gemini-deep | Minutes | Comprehensive |
| ai-grounded | perplexity-sonar-pro, perplexity-pro-search, gemini-grounded, grok, openrouter-online, brave-answers, exa, you-research, kagi-fastgpt, six SearchAPI answer surfaces | Seconds | Grounded answers and observed consumer surfaces |
| raw-search | perplexity-search, brave-search, jina-search, firecrawl-search, searchapi, serpapi, tavily | Fast | Links and SERP evidence |
| llm | claude, openai-chat, gemini-chat, openrouter-chat | Seconds | Model-native web search by default; optionally ungrounded |

### Visibility and privacy boundary

The six SearchAPI answer adapters observe consumer-facing ChatGPT, Gemini,
Perplexity, Google AI Mode, Bing Copilot, and Google AI Overview output through
one upstream vendor. Treat agreement among them as correlated visibility
evidence, not independent corroboration or parity with a particular logged-in
user. Librarium uses bearer authentication and supports explicit
`options.zeroRetention`; a rejected retention request fails closed and is never
retried without the option.

## Output Structure

```
./agents/librarium/{timestamp}-{slug}/
  prompt.md, run.json, summary.md, sources.json
  {provider}.md, {provider}.meta.json
  answer.md (when using `librarium answer`)
```
