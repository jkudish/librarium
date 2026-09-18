# Offline performance benchmark

`npm run benchmark:performance` measures synthetic local Librarium overhead
only. It uses deterministic fake adapters and generated canonical run
directories; it never loads credentials or calls a provider. These timings are
not live-provider performance.

The command builds a temporary benchmark entry with the repository's local
esbuild, then writes one JSON document to stdout. Save that document with the
Git revision it measured:

```sh
npm run build
node benchmark/performance/cli.mjs --warmup 3 --iterations 15 > perf-before.json
```

Every result records a schema version, Git SHA, Node and host details, dataset
parameters, warmup/iteration counts, raw sample timings, and
median/p95/min/max. It covers canonical planning, coordinator scheduling and
fan-out through the filesystem runtime and terminal result projection,
canonical reading/discovery, the version-dispatching browse and HTML/JSONL
report consumers, URL normalization/deduplication, warm and cold CLI help,
packed size, and a SEA binary when one exists.

The fake adapters synchronize each admitted scheduler wave so the runner can
assert peak concurrency, but add no network call or simulated provider delay.
Execution samples therefore include canonical scheduling, filesystem CAS
persistence, and projection overhead—not provider latency.

Schema version 2 replaced the legacy execution-engine and v2 reconciliation
timings with canonical planner/runtime measurements. Metric names and schema
versions are part of the comparison contract: do not compare renamed or
removed v1 metrics as though their semantics were unchanged.

The provider quality benchmark under `benchmark/` is separate. Do not use this
command for live or paid benchmark calls. Timing data is host-specific, so it
is evidence for comparing the same host and revision stack, not an absolute CI
gate. Keep semantic tests beside an optimization and reject regressions against
the measured baseline rather than introducing a fixed millisecond threshold.
