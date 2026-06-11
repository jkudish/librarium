---
title: Providers
description: The three provider tiers and all 20 built-in providers.
order: 3
---

## Provider tiers

Librarium organizes its 20 built-in providers into three tiers based on capabilities, latency, and depth.

**deep-research.** Async deep research providers that take minutes to complete but produce comprehensive, multi-source reports. These providers may use a submit/poll/retrieve pattern. Best for thorough research on important topics.

**ai-grounded.** AI-powered search with inline citations. Returns results in seconds with good quality and source attribution. A solid middle ground between speed and depth.

**raw-search.** Traditional search engine results. Fast responses with many links and snippets, but no AI synthesis. Useful for broad link discovery and verifying specific facts.

## Provider list

| Provider | ID | Tier | API key env var |
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

## Legacy provider ID aliases

Perplexity provider IDs were renamed to match current product names:

- `perplexity-sonar` renamed to `perplexity-sonar-pro`
- `perplexity-deep` renamed to `perplexity-sonar-deep`

For backward compatibility, librarium still accepts legacy IDs in:

- `run --providers`
- provider config keys in `~/.config/librarium/config.json`
- custom group members
- `fallback` targets

Legacy IDs are normalized to canonical IDs and emit a warning. Output files and `run.json` always use canonical IDs.

## Custom providers

You can also add custom providers (npm modules or local scripts) via config. See [Custom providers](/docs/custom-providers) for the full implementation guide.
