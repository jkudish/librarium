import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = readFileSync(
  new URL('../scripts/you-answer-live-smoke.mjs', import.meta.url),
  'utf8',
);

describe('You.com Answer live smoke script', () => {
  it('requires an explicit paid-call opt-in before the network request', () => {
    expect(script).toContain("LIBRARIUM_YOU_ANSWER_LIVE_SMOKE === '1'");
    expect(script.indexOf('if (!enabled)')).toBeLessThan(
      script.indexOf("fetch('https://api.you.com/v1/answer'"),
    );
    expect(script).toContain('YOU_COM_API_KEY');
    expect(script).not.toContain('console.log(data)');
  });
});
