import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parseLibrariumRun } from '../../benchmark/lib/artifacts.mjs';
import { assertExactTargetRun } from '../../benchmark/lib/runner.mjs';
import { scoreCase } from '../../benchmark/lib/scoring.mjs';

it('feeds an offline public Run to the benchmark reader and scorer', () => {
  const home = mkdtempSync(join(tmpdir(), 'librarium-benchmark-run-'));
  try {
    mkdirSync(join(home, '.config/librarium'), { recursive: true });
    writeFileSync(
      join(home, '.config/librarium/config.json'),
      JSON.stringify({ version: 3, runs: { path: join(home, 'runs') } }),
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'research',
        'What is the capital of Australia?',
        '--only',
        'kagi',
        '--json',
      ],
      {
        cwd: home,
        env: {
          HOME: home,
          USERPROFILE: home,
          KAGI_API_KEY: 'dummy',
          NODE_OPTIONS: `--import=${resolve('tests/fixtures/run-transport.mjs')}`,
        },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const run = JSON.parse(result.stdout);
    const parsed = parseLibrariumRun(join(home, 'runs', run.id));
    expect(parsed.providerOutputs[0]).toMatchObject({
      provider: 'kagi',
      status: 'success',
      content: expect.stringContaining(
        'Canberra is the capital city of Australia.',
      ),
      usage: null,
    });
    assertExactTargetRun(parsed, { id: 'source:kagi', members: ['kagi'] });
    expect(() =>
      assertExactTargetRun(parsed, { id: 'other', members: ['exa'] }),
    ).toThrow('matrix mismatch');
    const score = scoreCase({
      question: {
        id: 'capital',
        expected: {
          answers: ['Canberra'],
          aliases: [],
          requiredFacts: [
            {
              id: 'capital',
              text: 'Canberra is the capital city of Australia',
              aliases: [],
            },
          ],
          requiredSources: [
            { url: 'https://example.org/capital', evidence: 'fixture' },
          ],
        },
        budgets: { maxLatencyMs: 1000, maxCostUsd: 1 },
      },
      target: {
        id: 'source:kagi',
        type: 'individual-provider',
        tier: 'ai-grounded',
        members: ['kagi'],
      },
      run: parsed,
      answer: {
        content: run.results[0].answer,
        synthesis: { costUsd: null, costConfidence: 'unknown' },
      },
      judge: {
        costUsd: null,
        costConfidence: 'unknown',
        promptSha256: 'offline',
        judgment: { correctness: 1, completeness: 1, evidenceSupport: 1 },
      },
    });
    expect(score).toMatchObject({
      performance: { failureCount: 0 },
      evidence: { sourceCount: 1, citationCount: 1 },
    });
    writeFileSync(
      join(home, 'runs', run.id, 'run.json'),
      JSON.stringify({ ...run, status: 'running', finished_at: null }),
    );
    expect(() => parseLibrariumRun(join(home, 'runs', run.id))).toThrow(
      'terminal response',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
