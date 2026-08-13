# Offline performance benchmark

`npm run benchmark:performance` measures local Librarium overhead only. It
uses generated run directories and in-memory synthetic providers; it never
loads credentials or calls a provider.

The command builds a temporary benchmark entry with the repository's local
esbuild, then writes one JSON document to stdout. Save that document with the
Git revision it measured:

```sh
npm run build
node benchmark/performance/cli.mjs --warmup 3 --iterations 15 > perf-before.json
```

Every result records the Git SHA, Node and host details, dataset parameters,
warmup/iteration counts, raw sample timings, and median/p95/min/max. It covers
fan-out, v2 artifact reading/reconciliation, browse discovery, HTML/JSONL
reports, URL normalization/deduplication, warm and cold CLI help, packed size,
and a SEA binary when one exists.

The provider quality benchmark under `benchmark/` is separate. Do not use this
command for live or paid benchmark calls. Timing data is host-specific, so it
is evidence for comparing the same host and revision stack, not an absolute CI
gate. Keep semantic tests beside an optimization and reject regressions against
the measured baseline rather than introducing a fixed millisecond threshold.
