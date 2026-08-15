# Librarium provider benchmark

This repository-local benchmark compares retrieval quality, answer quality,
latency, cost, and reliability without adding a command to the shipped
`librarium` CLI. Benchmark code and datasets live under `benchmark/`; published
runtime code comes only from `dist`, and the build has no benchmark entry
point.

Generated `benchmark/results/` directories are ignored by default. Publishing
a reviewed run is deliberate: force-add the complete timestamped directory so
the confirmation, failures, raw artifacts, scores, and report stay together.

## Tracks and coverage

- `stable`: 28 curated regression questions with frozen answers, facts, and
  supporting evidence.
- `live`: 12 freshness-sensitive questions. Every question has a validation
  date, expiry date, cadence, validator, and revalidation instructions.
- A full run covers 39 individual providers, all 8 built-in named groups, and
  3 curated candidate groups. Candidate groups are deliberately bounded; the
  runner never searches every provider combination.

Run corpus and target validation with:

```sh
npm run benchmark:validate
```

## Local command

Build Librarium before a real run, then start with a dry run or a small canary:

```sh
npm run build
npm run benchmark -- --track stable --providers brave-search --questions stable-capital-australia --dry-run
npm run benchmark -- --track stable --providers brave-search --questions stable-capital-australia
```

The command supports:

- `--track stable|live|all`
- `--providers <comma-separated ids>`
- `--groups <comma-separated built-in names>`
- `--candidates <comma-separated candidate names>`
- `--questions <comma-separated ids>` for canaries
- `--resume <timestamped-output-directory>`
- `--output <parent-directory>`
- `--fixture <fixture-manifest>` for offline replay
- `--dry-run` for resolved configuration and cost preflight only

With no target selectors, a live run resolves the bounded full target set. With
no `--output`, results go to `benchmark/results/<ISO timestamp>`. `--resume`
reopens that exact directory and skips completed question × target checkpoints.

## Paid-call safety

Real runs are local-only. In CI, the runner rejects live mode before any child
process or network call. CI also rejects provider/judge secrets and installs a
network-deny guard around fixture replay.

Before local paid calls, the runner prints and records:

- the exact question and target matrix;
- resolved provider members for every group;
- the pinned synthesis and judge provider, model, and model version;
- known estimates, their confidence/pricing version, and every unknown-cost
  operation;
- credential availability by environment-variable name, never value.

The operator must review this exact configuration in an interactive terminal
and type `RUN`. There is no non-interactive confirmation bypass. The pinned
judge and synthesis clients never cascade to another provider or model.
Unknown cost is recorded as unknown, never as zero or free.

Every live invocation, including `--resume`, requires a new confirmation tied
to the unchanged configuration fingerprint and the remaining operations. The
benchmark invokes Librarium with configured fallbacks disabled and rejects any
fallback-marked or out-of-matrix provider artifact.

The benchmark runner forces synchronous mode. Durable submit, resume, poll,
retrieve, and cancellation behavior is covered by the separate canonical live
validation lane. Benchmark scoring still refuses any manifest that contains
pending or unretrieved async work.

## Scoring and reporting

Retrieval and answer quality are independent:

- Retrieval: expected-answer evidence, required-fact recall, required-source
  recall, citation URL validity, provider failures, latency, and actual cost.
- Answer: accepted answer/alias match, required-fact coverage, citation index
  validity, and blinded semantic correctness, completeness, and evidence
  support.

Deterministic checks are reproducible string/URL checks. Semantic grading uses
the pinned judge and a prompt that excludes the target identity. Candidate
answers and retrieved evidence are fenced as untrusted data; fence-like text is
escaped before interpolation. Every judge prompt, hash, model/version, raw
response, parsed judgment, usage, and unknown cost is retained.

Reports group individual providers by tier, then show built-in and candidate
groups separately. Pareto flags use quality, known provider-call cost, and
latency. Evaluation overhead from synthesis and judging is preserved in each
case's total-cost evidence but excluded from provider comparisons. Rows with
unknown provider cost are explicitly ineligible for a cost Pareto conclusion.
Failed cases count as zero in target quality aggregates, and incomplete targets
are visibly marked and excluded from Pareto comparisons.
The report does not choose a simplistic cross-tier winner and cannot change
Librarium defaults.

## Artifact contract

Each timestamped run is self-contained and schema-versioned:

```text
config.json                    resolved immutable configuration + revision
preflight.json                 known and unknown cost lanes
confirmation.json              live-only confirmation record
state.json                     durable question × target checkpoints
raw/<question>/<target>/       Librarium run, answer, synthesis, stdout/stderr
judge/<question>/<target>.json prompt, pinned model, raw and parsed judgment
scores/<question>/<target>.json deterministic and semantic evidence
results.jsonl                  one scored case per line
summary.json                   tier/group aggregates and Pareto metadata
report.md                      human-readable report
```

Committed fixture v1 under `benchmark/fixtures/v1` uses existing Librarium
`run.json`, provider markdown/meta files, and `sources.json`. It lets CI replay
parsing, orchestration, scoring, checkpoints, and reporting with no paid or live
call. Published runs should commit the complete reviewed timestamped directory,
including raw artifacts; do not hand-edit scores or omit failed cases.

## Publishing policy

Before publishing a run:

1. Have a maintainer audit the initial corpus (and every contributed question),
   then revalidate every selected live question and update its evidence
   metadata.
2. Complete the full bounded target matrix or explain exclusions in review.
3. Audit a sample of deterministic checks and raw judge judgments manually.
4. Review unknown costs and provider/model version metadata.
5. Commit the complete timestamped artifact directory for reproducibility.

Benchmark evidence may motivate a separate proposal to change defaults or
groups. A benchmark run never changes them automatically.
