export const PERFORMANCE_SCHEMA_VERSION = 1;

export function percentile(sorted, ratio) {
  if (sorted.length === 0) return null;
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  ];
}

export function summarizeSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('Benchmark samples must not be empty');
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples_ms: samples.map((sample) => Number(sample.toFixed(3))),
    median_ms: Number(percentile(sorted, 0.5).toFixed(3)),
    p95_ms: Number(percentile(sorted, 0.95).toFixed(3)),
    min_ms: Number(sorted[0].toFixed(3)),
    max_ms: Number(sorted.at(-1).toFixed(3)),
  };
}

export async function measure({ warmup, iterations, prepare, operation }) {
  for (let index = 0; index < warmup; index++) {
    const prepared = prepare === undefined ? undefined : await prepare();
    await operation(prepared);
  }
  const samples = [];
  for (let index = 0; index < iterations; index++) {
    const prepared = prepare === undefined ? undefined : await prepare();
    const started = performance.now();
    await operation(prepared);
    samples.push(performance.now() - started);
  }
  return summarizeSamples(samples);
}
