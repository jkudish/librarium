import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseLibrariumRun } from '../../benchmark/lib/artifacts.mjs';
import { assertExactTargetRun } from '../../benchmark/lib/runner.mjs';
import { scoreCase } from '../../benchmark/lib/scoring.mjs';
import { projectCanonicalRunPresentation } from '../../src/node-canonical-presentation.js';
import { buildMockConfig } from '../fixtures/config/mock-config.js';

const root = resolve(import.meta.dirname, '../..');
const cli = join(root, 'dist', 'cli.js');
const networkGuard = pathToFileURL(
  join(root, 'tests', 'fixtures', 'network-denied.mjs'),
).href;

describe('benchmark canonical artifact compatibility', () => {
  it('passes a network-denied current CLI artifact through the benchmark reader and scorer', () => {
    const temporary = mkdtempSync(
      join(tmpdir(), 'librarium-benchmark-canonical-'),
    );
    try {
      const home = join(temporary, 'home');
      const output = join(temporary, 'output');
      const configDirectory = join(home, '.config', 'librarium');
      mkdirSync(configDirectory, { recursive: true });
      writeFileSync(
        join(configDirectory, 'config.json'),
        JSON.stringify(
          buildMockConfig({
            providers: [
              {
                id: 'mock-benchmark',
                tier: 'raw-search',
                content: 'Canberra is the capital city of Australia.',
                citations: 1,
              },
            ],
          }),
        ),
      );
      const environment = {
        PATH: process.env.PATH ?? '',
        HOME: home,
        NO_COLOR: '1',
        NODE_OPTIONS: `--import=${networkGuard}`,
      };
      const denied = spawnSync(
        process.execPath,
        ['-e', "fetch('https://example.com')"],
        { cwd: root, env: environment, encoding: 'utf8' },
      );
      expect(denied.status).not.toBe(0);
      expect(denied.stderr).toContain(
        'Network access is disabled during benchmark fixture replay',
      );

      const produced = spawnSync(
        process.execPath,
        [
          cli,
          'run',
          'What is the capital city of Australia?',
          '--providers',
          'mock-benchmark',
          '--mode',
          'sync',
          '--output',
          output,
          '--no-fallback',
          '--json',
          '--yes',
        ],
        { cwd: temporary, env: environment, encoding: 'utf8' },
      );
      expect(produced.status, produced.stderr).toBe(0);
      const cliResult = JSON.parse(produced.stdout);
      const parsed = parseLibrariumRun(cliResult.outputDir);
      expect(parsed.manifest).toMatchObject({
        schemaVersion: 3,
        terminal_response: { status: 'succeeded' },
      });
      expect(parsed.providerOutputs).toEqual([
        expect.objectContaining({
          provider: 'mock-benchmark',
          profile: 'mock-benchmark/mock',
          tier: 'raw-search',
          status: 'success',
          model: 'mock-model-1',
          content: 'Canberra is the capital city of Australia.',
          citations: [
            expect.objectContaining({
              url: 'https://example.test/mock-benchmark/0',
            }),
          ],
        }),
      ]);
      const canonicalPresentation = projectCanonicalRunPresentation(
        parsed.manifest,
        cliResult.outputDir,
        'benchmark-fixture',
      );
      expect(parsed.providerOutputs[0]).toMatchObject({
        provider: canonicalPresentation.reports[0]?.id,
        tier: canonicalPresentation.reports[0]?.tier,
        status: canonicalPresentation.reports[0]?.status,
        durationMs: canonicalPresentation.reports[0]?.durationMs,
        model: canonicalPresentation.results[0]?.model,
        content: canonicalPresentation.results[0]?.text,
        citations: canonicalPresentation.results[0]?.citations.map(
          ({ url, title, snippet }) => ({ url, title, snippet }),
        ),
        usage: canonicalPresentation.reports[0]?.usage,
      });
      assertExactTargetRun(parsed, {
        id: 'provider:mock-benchmark',
        members: ['mock-benchmark'],
      });
      const score = scoreCase({
        question: {
          id: 'offline-canonical-capital',
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
              {
                url: 'https://example.test/mock-benchmark/0',
                evidence: 'fixture',
              },
            ],
          },
          budgets: { maxLatencyMs: 1_000, maxCostUsd: 1 },
        },
        target: {
          id: 'provider:mock-benchmark',
          type: 'individual-provider',
          tier: 'raw-search',
          members: ['mock-benchmark'],
        },
        run: parsed,
        answer: {
          content: 'Canberra is the capital city of Australia [1].',
          synthesis: { costUsd: null, costConfidence: 'unknown' },
        },
        judge: {
          costUsd: null,
          costConfidence: 'unknown',
          promptSha256: 'offline-canonical',
          judgment: {
            correctness: 1,
            completeness: 1,
            evidenceSupport: 1,
          },
        },
      });
      expect(score).toMatchObject({
        retrieval: { qualityScore: 0.8 },
        answer: { qualityScore: 1 },
        performance: { failureCount: 0 },
        evidence: { sourceCount: 1, citationCount: 1 },
      });

      const pendingDirectory = join(temporary, 'pending');
      cpSync(cliResult.outputDir, pendingDirectory, { recursive: true });
      const pending = parsed.manifest;
      delete pending.terminal_response;
      pending.coordination_state.status = 'running';
      writeFileSync(
        join(pendingDirectory, 'run.json'),
        JSON.stringify(pending),
      );
      expect(() => parseLibrariumRun(pendingDirectory)).toThrow(
        /has not reached a terminal response/,
      );

      const fallbackDirectory = join(temporary, 'fallback');
      cpSync(cliResult.outputDir, fallbackDirectory, { recursive: true });
      const fallback = JSON.parse(
        readFileSync(join(fallbackDirectory, 'run.json'), 'utf8'),
      );
      fallback.request.fallback_reserve.push({ fixture: true });
      writeFileSync(
        join(fallbackDirectory, 'run.json'),
        JSON.stringify(fallback),
      );
      expect(() => parseLibrariumRun(fallbackDirectory)).toThrow(
        /must not enable or contain provider fallbacks/,
      );
      expect(() =>
        assertExactTargetRun(parsed, {
          id: 'provider:other',
          members: ['other'],
        }),
      ).toThrow(/provider matrix mismatch/);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
