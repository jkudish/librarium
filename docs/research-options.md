# Configure sources and Run storage

The CLI and Node client load `~/.config/librarium/config.json`. `setup` writes
version 3. A source is set up when it has a resolved key and `enabled` is not
false. An environment variable works without a config entry.

```json
{
  "version": 3,
  "sources": {
    "exa": { "key": "env:EXA_API_KEY" },
    "parallel": { "key": "env:PARALLEL_API_KEY", "processor": "pro" },
    "valyu": { "key": "env:VALYU_API_KEY", "mode": "standard", "output": ["markdown", "pdf"] },
    "grok": { "key": "env:XAI_API_KEY", "search": "both", "enabled": false }
  },
  "engines": { "collector": "searchapi", "key": "env:SEARCHAPI_API_KEY" },
  "groups": { "visibility": ["chatgpt", "gemini-app", "google-ai-mode"] },
  "summarize": { "source": "openai" },
  "max_cost": "1.00",
  "runs": { "store": "filesystem", "path": "./agents/librarium", "keep_days": null }
}
```

Relative run paths resolve from the calling directory. A custom store's module
path resolves relative to the config file. `runs.keep_days: null` disables
automatic retention. `cleanup` prunes only terminal Runs.

## Source options

Options are directly under a source's config entry. Library calls can override
them through `{ options: { parallel: { processor: 'ultra' } } }`. Unknown
options and invalid combinations fail before calls. `sources --json` reads
the authoritative shared option catalog.

| Source | Options |
| --- | --- |
| brave | `results: answer` (default) or `search` |
| claude | `model` |
| firecrawl | `sources` (`web`, `news`), `limit` |
| gemini | `quick: grounded` (default) or `chat` |
| google | `collector: searchapi` (default), `serpapi`, `serpbase`; `vertical: web` or `news` (news requires serpbase) |
| grok | `search: web` (default), `x`, `both` |
| openai | `model`, `effort` |
| openrouter | `quick: grounded` (default) or `chat`, `model` |
| parallel | `quick: turbo` (default) or `search`; `processor: pro` (default) |
| perplexity | `quick: sonar-pro` (default), `search`, `agent` (check language availability); `deep_effort: medium` (default) or `high` |
| valyu | `mode: standard` (default), `output` |
| you | `quick: answer` (default) or `research` |

Exa, Jina, Kagi and Tavily have no public source options. Variant mapping stays
inside the package; users select one flat source name.

Parallel processors are `lite`, `base`, `core`, `core2x`, `pro`, `ultra`,
`ultra2x`, `ultra4x`, `ultra8x`. Valyu modes are `fast`, `standard`, `heavy`,
`max`. Each uses the existing snapshot and per-target durable deadline. Valyu
PDF URLs, when returned, are bearer links; evidence must be reviewed before
sharing. A price hint is an admission estimate, never a reported charge.

## Summary source

`summarize.source` takes precedence, then `summarize --source`, then the first
set-up source in the fixed order `openai`, `claude`, `gemini`, `openrouter`.
Without one, synthesis fails with `no_summarize_source`. No failed call
cascades. `--verify` uses the same source. A summary is a new, budgeted Run
with `summary_of` linking to its unchanged source Run.
