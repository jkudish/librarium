import { describe, expect, it } from 'vitest';
import {
  measure,
  PERFORMANCE_SCHEMA_VERSION,
  summarizeSamples,
} from '../benchmark/performance/lib.mjs';

describe('offline performance benchmark helpers', () => {
  it('records raw samples with deterministic distribution summaries', () => {
    expect(summarizeSamples([5, 1, 4, 2, 3])).toEqual({
      samples_ms: [5, 1, 4, 2, 3],
      median_ms: 3,
      p95_ms: 5,
      min_ms: 1,
      max_ms: 5,
    });
  });

  it('uses a versioned result schema', () => {
    expect(PERFORMANCE_SCHEMA_VERSION).toBe(1);
  });

  it('runs the configured warmup before retaining raw samples', async () => {
    let calls = 0;
    const result = await measure({
      warmup: 2,
      iterations: 3,
      operation: () => {
        calls++;
      },
    });

    expect(calls).toBe(5);
    expect(result.samples_ms).toHaveLength(3);
    expect(result.min_ms).toBeLessThanOrEqual(result.median_ms);
    expect(result.median_ms).toBeLessThanOrEqual(result.p95_ms);
  });

  it('prepares each fixture outside the timed operation', async () => {
    let prepared = 0;
    const seen: number[] = [];
    const result = await measure({
      warmup: 1,
      iterations: 3,
      prepare: () => ++prepared,
      operation: (fixture) => {
        seen.push(fixture);
      },
    });

    expect(prepared).toBe(4);
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(result.samples_ms).toHaveLength(3);
  });
});
