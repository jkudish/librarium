# Parallel and Valyu research options

`parallel/research` and `valyu/research` are durable background profiles. Each
lets you choose a processor or mode and pass the vendor's documented request
options. The defaults are Parallel `pro` and Valyu `standard`. Prices come from
the frozen pricing snapshot, so `--max-cost` can admit any tier listed below.

Set options in the provider's `options` object in the Librarium config, for
example:

```json
{
  "providers": {
    "parallel-research": {
      "enabled": true,
      "options": { "processor": "ultra", "afterDate": "2026-01-01" }
    },
    "valyu-research": {
      "enabled": true,
      "options": { "mode": "heavy", "outputFormats": ["markdown"] }
    }
  }
}
```

The PHP package uses the same names in snake_case (`after_date`,
`output_formats`, and so on).

## Deadlines

When you have not set a background deadline, each processor or mode below gets
its own attempt deadline. A background deadline you set yourself
(`defaults.asyncTimeout` in v1 config, `execution_defaults.background_attempt_deadline_ms`
in v2, or a project config) applies to every background profile instead. A
configured value equal to the shipped default (`asyncTimeout` 1800, or
`timeout` 30 for inline calls) counts as unset, because earlier `init` runs and
v1 migrations wrote those values without asking; set any other value to
override the per-profile defaults. The
request deadline grows to cover the longest planned attempt, and an explicit
request deadline still caps every attempt. `librarium plan` shows each
profile's deadline. `--timeout` sets the inline deadline only.

## Parallel Task API (`parallel/research`)

Prices are from <https://docs.parallel.ai/getting-started/pricing> and latency
from <https://docs.parallel.ai/task-api/guides/choose-a-processor>, both
accessed 2026-10-11. Parallel bills only completed runs. The documented latency
covers the running phase only; queue time is extra.

| Processor | Price per run | Documented latency | Default deadline |
| --- | --- | --- | --- |
| `lite` | $0.005 | 10 s – 2 min | 30 min (global) |
| `base` | $0.01 | 15 s – 3 min | 30 min (global) |
| `core` | $0.025 | 1 – 5 min | 30 min (global) |
| `core2x` | $0.05 | 1 – 10 min | 30 min (global) |
| `pro` (default) | $0.10 | 2 – 10 min | 30 min (global) |
| `ultra` | $0.30 | 3 – 25 min | 45 min |
| `ultra2x` | $0.60 | 5 – 50 min | 75 min |
| `ultra4x` | $1.20 | 5 – 90 min | 135 min |
| `ultra8x` | $2.40 | 5 min – 2 h | 180 min |

Processors that can run longer than the 30-minute global default get 1.5 times
their documented upper bound, rounded up to 15 minutes. The delisted `pro-fast`
and `ultra-fast` processors are rejected.

Select the processor with `options.processor` or the provider `model` field.

| Option | Create Task Run field | Notes |
| --- | --- | --- |
| `processor` | `processor` | One of the processors above. |
| `includeDomains` | `source_policy.include_domains` | Domains, domain/path prefixes such as `docs.python.org/3`, or bare extensions such as `.edu`. |
| `excludeDomains` | `source_policy.exclude_domains` | Same forms. Parallel ignores it when `includeDomains` is set. At most 200 entries across both lists. |
| `afterDate` | `source_policy.after_date` | `YYYY-MM-DD`. Limits sources to content published on or after the date. |
| `location` | `advanced_settings.location` | ISO 3166-1 alpha-2 country code. |
| `outputSchema` | `task_spec.output_schema` | A string replaces the text report description. A JSON Schema object requests JSON output, and the result content is that JSON. The default is a cited text report. |
| `metadata` | `metadata` | Flat object stored with the run. Keys are at most 16 characters; values are strings (at most 512 characters), numbers, or booleans. |
| `memoryScopeKey` | `memory_scope_key` | 1–128 characters of `A-Z a-z 0-9 _ -`. Omit it to use personal memory. |

These documented parameters are not exposed:

| Parameter | Reason |
| --- | --- |
| `previous_interaction_id` | It chains a run to an earlier run. The interaction id equals that run's private run id, and a fixed config value would chain every request to the same run. |
| `mcp_servers` | Server entries carry credential headers in plain config and add tools beyond web research. |
| `advanced_settings.data_sources` | Connectors add non-web corpora, and pay-per-use connectors bill per call outside the processor price, so `--max-cost` could not bound them. |
| `enable_events` | Librarium polls run status and never reads the event stream. |
| `webhook` | Librarium polls; the CLI has no webhook receiver. |
| `task_spec.input_schema`, JSON `input` | Librarium always sends the research query as text. |
| `parallel-beta` header | Beta features are not stable request contracts. |

The Source Policy guide lists `after_date` for the Search API, while the Create
Task Run schema accepts it for tasks. It has not been checked live for tasks.

## Valyu DeepResearch (`valyu/research`)

Prices are from <https://docs.valyu.ai/pricing> and run times and recommended
timeouts from <https://docs.valyu.ai/guides/deepresearch>, both accessed
2026-10-11. DeepResearch is a fixed price per task. Optional tools add
surcharges, but Librarium never enables them, and PDF output is not a billed
deliverable.

| Mode | Price per task | Typical runtime | Default deadline |
| --- | --- | --- | --- |
| `fast` | $0.10 | ~5 min | 10 min |
| `standard` (default) | $0.50 | ~10–20 min | 30 min |
| `heavy` | $2.50 | up to ~90 min | 120 min |
| `max` | $15.00 | up to ~180 min | 180 min |

Each default deadline is Valyu's recommended timeout for that mode. `max` is
never a default and is not a member of any built-in group; select it with
`options.mode`. Valyu requires at least $15 in available credits for `max`.

The other Valyu options are `researchStrategy`, `reportFormat`, `search`
(`searchType`, `includedSources`, `excludedSources`, `sourceBiases`,
`startDate`, `endDate`, `countryCode`), `urls`, and `outputFormats`.

### PDF report link

Librarium asks Valyu for a PDF report by default (`outputFormats` defaults to
`["markdown", "pdf"]`). Valyu documents no surcharge or extra runtime for PDF
output. Set `outputFormats` to `["markdown"]` to skip it. When Valyu returns a
PDF, the result's
`provider_meta["valyu:artifacts"]` contains
`{ "kind": "pdf", "url": "...", "expires_at": "..." }`.

The URL is a signed bearer link: anyone who has it can download the report
until it expires. Librarium keeps it out of logs, diagnostics, and error
messages, but it is stored with the run's results, so share run directories
and result exports with the same care as the report. `expires_at` appears only
when the link's signature parameters state an expiry (`X-Amz-Date` with
`X-Amz-Expires`, `X-Goog-Date` with `X-Goog-Expires`, or an `Expires` epoch).
Valyu does not document the link's lifetime, so treat a link without
`expires_at` as short-lived too. Signed links for images and other deliverables
are still dropped.
