import { describe, expect, it, vi } from 'vitest';
import { finalizeDispatchPresentation } from '../src/commands/run.js';
import type { ProviderReport } from '../src/types.js';

const reports: ProviderReport[] = [
  {
    id: 'completed-provider',
    tier: 'raw-search',
    status: 'success',
    durationMs: 1,
    wordCount: 1,
    citationCount: 0,
    outputFile: 'completed-provider.md',
    metaFile: 'completed-provider.meta.json',
  },
];

describe('dispatch presentation boundary', () => {
  it('stops and resolves the live renderer before later hook output', () => {
    const order: string[] = [];
    const live = {
      resolveRemaining: vi.fn(() => order.push('resolve')),
      stop: vi.fn(() => order.push('live-stop')),
    };

    finalizeDispatchPresentation(reports, {
      spinner: { stop: () => order.push('spinner-stop') },
      live,
      printLine: () => order.push('provider-line'),
      widths: { id: 18, tier: 10 },
      color: false,
    });
    order.push('post-dispatch-output');

    expect(order).toEqual([
      'spinner-stop',
      'resolve',
      'live-stop',
      'post-dispatch-output',
    ]);
    expect(live.resolveRemaining).toHaveBeenCalledWith(reports);
  });

  it('prints skipped rows after stopping a non-live spinner', () => {
    const order: string[] = [];
    const skipped: ProviderReport = {
      ...reports[0],
      id: 'skipped-provider',
      status: 'skipped',
      outputFile: '',
      metaFile: '',
    };

    finalizeDispatchPresentation([skipped], {
      spinner: { stop: () => order.push('spinner-stop') },
      live: null,
      printLine: (line) => order.push(`line:${line}`),
      widths: { id: 16, tier: 10 },
      color: false,
    });

    expect(order[0]).toBe('spinner-stop');
    expect(order[1]).toContain('skipped-provider');
  });
});
