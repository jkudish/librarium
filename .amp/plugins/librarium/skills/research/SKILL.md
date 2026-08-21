---
description: Multi-provider, evidence-aware deep research via the librarium Amp plugin (33 providers, 40 profiles).
triggers:
  - /librarium
  - /research
  - /deep-research
  - deep research
  - multi-provider search
builtin-tools:
  - librarium_research
  - librarium_get_results
  - librarium_check_async
  - librarium_list_providers
  - librarium_list_groups
---

# Librarium — Multi-Provider Deep Research

Run research queries through Librarium's v2 public provider/profile catalog.
There are 33 built-in providers and 40 implemented profiles. Preserve the
profile and collection provenance when reporting results; do not turn source
counts or agreement into a confidence claim.

## When to use each tool

| Tool | Use it when |
|------|-------------|
| `librarium_research` | You need to fan a query across multiple providers for cited, multi-perspective evidence. This is the primary research tool. |
| `librarium_check_async` | A prior `librarium_research` call returned pending async work (deep-research profiles). Polls one bounded resume pass. |
| `librarium_get_results` | You need the full provider markdown content from a completed run. Content is marked untrusted — verify sources before relying on claims. |
| `librarium_list_providers` | You need to see which providers are configured, enabled, and have API keys set. |
| `librarium_list_groups` | You need to see available provider groups and their members before selecting one. |

## Research workflow

### 1. Analyze the query
Determine the query type and select a group:
- **Quick facts / low-latency**: `quick` (curated AI-grounded providers)
- **Deep research**: `deep` (research-report profiles, may run async)
- **Full catalog coverage**: `all` (catalog-derived, confirm cost exposure first)
- **Custom**: `custom:<name>` (user-authored group)

### 2. Dispatch
Call `librarium_research` with the query and group. Group/providers default
per the calling agent — pass them explicitly to override. The result includes
a `selection` field showing which branch won (explicit-input, agent-default,
or fallback-quick).

### 3. Poll async work
If the result indicates pending async work (from `background/durable`
profiles), call `librarium_check_async` to run a bounded resume pass.
schemaVersion 3 retrieves observed completion immediately.

### 4. Read full results
Call `librarium_get_results` to get the full provider markdown content from
the run directory. Content is capped per provider (~40k chars) and marked
untrusted.

### 5. Synthesize
Combine findings from multiple providers into a coherent answer. Record
source overlap and provenance, but do not convert a higher citation count
into a confidence score: shared collectors and repeated sources can make
that evidence correlated.

## Provider tiers

| Tier | Providers | Speed | Depth |
|------|-----------|-------|-------|
| background/durable | Exa, Tavily, OpenAI Research, Gemini Deep, Perplexity Deep Research, Perplexity Sonar Deep, Parallel, Valyu, You Research | Minutes to longer | Persisted handles that can be polled and retrieved |
| inline | Search, grounded, collected surface, and chat profiles | Usually seconds | Immediate response; no durable handle |

## Evidence boundaries

- A direct API response is `api_output`. It reports the response returned by
  the named API; it does not make a result universally correct.
- A citation is a source reference, not a guarantee that the source is safe
  to fetch, authoritative, reachable, or supportive of every nearby claim.
- Provenance records what happened; it is not a confidence score or a claim
  of consumer behaviour.
- Do not turn agreement into proof. Shared collectors and repeated sources
  can make evidence correlated.

## Output structure

```
./agents/librarium/{timestamp}-{slug}/
  prompt.md, run.json, summary.md, sources.json
  {provider}.md, {provider}.meta.json
```
