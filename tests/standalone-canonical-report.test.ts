import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browseRunDir } from '../src/commands/browse.js';
import { registerHtmlCommand } from '../src/commands/html.js';
import { registerJsonlCommand } from '../src/commands/jsonl.js';
import { runCanonicalPreparedExecution } from '../src/node-canonical-run.js';
import type { Provider } from '../src/types.js';
import {
  canonicalFixtureBridge,
  canonicalFixtureCoordinator,
  canonicalFixturePrepared,
  canonicalFixtureProfile,
  canonicalFixtureResult,
} from './fixtures/canonical-run.js';

const roots: string[] = [];
const browseSelect = vi.hoisted(() => vi.fn());

vi.mock('@clack/prompts', () => ({
  select: (...args: unknown[]) => browseSelect(...args),
  confirm: vi.fn(),
  isCancel: () => false,
  log: { warn: vi.fn(), success: vi.fn() },
}));

afterEach(() => {
  vi.restoreAllMocks();
  browseSelect.mockReset();
  process.exitCode = undefined;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function canonicalRun(): Promise<string> {
  const root = join(tmpdir(), `librarium-report-${crypto.randomUUID()}`);
  const runDir = join(root, 'canonical-v3');
  mkdirSync(runDir, { recursive: true });
  roots.push(root);
  const profile = canonicalFixtureProfile('report');
  const provider: Provider = {
    id: 'adapter-report',
    displayName: 'Report',
    tier: 'ai-grounded',
    envVar: '',
    execution: 'inline',
    execute: async () => canonicalFixtureResult('adapter-report'),
  };
  await runCanonicalPreparedExecution(canonicalFixturePrepared([profile]), {
    runs_root: root,
    run_directory: runDir,
    coordinator: canonicalFixtureCoordinator(),
    attempt_bridge: canonicalFixtureBridge([profile], {
      'adapter-report': provider,
    }),
  });
  return runDir;
}

describe('standalone canonical report commands', () => {
  it('renders schemaVersion 3 HTML from canonical public output', async () => {
    const runDir = await canonicalRun();
    const runJsonBefore = readFileSync(join(runDir, 'run.json'), 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const program = new Command().exitOverride();
    registerHtmlCommand(program);

    await program.parseAsync(['node', 'test', 'html', runDir]);

    expect(readFileSync(join(runDir, 'report.html'), 'utf8')).toContain(
      'Canonical result',
    );
    expect(readFileSync(join(runDir, 'run.json'), 'utf8')).toBe(runJsonBefore);
  });

  it('renders schemaVersion 3 JSONL from canonical public output', async () => {
    const runDir = await canonicalRun();
    const runJsonBefore = readFileSync(join(runDir, 'run.json'), 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const program = new Command().exitOverride();
    registerJsonlCommand(program);

    await program.parseAsync(['node', 'test', 'jsonl', runDir]);

    const lines = readFileSync(join(runDir, 'results.jsonl'), 'utf8')
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual(
      expect.objectContaining({
        type: 'result',
        id: 'adapter-report',
        content: expect.stringContaining('Canonical result'),
      }),
    );
    expect(readFileSync(join(runDir, 'run.json'), 'utf8')).toBe(runJsonBefore);
  });

  it('opens a canonical v3 run in the interactive browse view', async () => {
    const runDir = await canonicalRun();
    browseSelect.mockResolvedValue('quit');

    await browseRunDir(runDir);

    expect(browseSelect).toHaveBeenCalledOnce();
    const options = browseSelect.mock.calls[0]?.[0] as {
      options: Array<{ label: string }>;
    };
    expect(options.options.map(({ label }) => label).join('\n')).toContain(
      'adapter-report',
    );
  });

  it('reports an invalid v3 manifest without throwing', async () => {
    const root = join(tmpdir(), `librarium-report-${crypto.randomUUID()}`);
    const runDir = join(root, 'invalid-v3');
    mkdirSync(runDir, { recursive: true });
    roots.push(root);
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({ schemaVersion: 3 }),
    );
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const program = new Command().exitOverride();
    registerHtmlCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'html', runDir]),
    ).resolves.toBeDefined();
    expect(error).toHaveBeenCalledWith(
      `No valid supported run manifest found in ${runDir}`,
    );
    expect(process.exitCode).toBe(2);
  });
});
