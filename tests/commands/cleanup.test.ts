import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCleanupCommand } from '../../src/commands/cleanup.js';

function program(): Command {
  const command = new Command();
  command.exitOverride();
  registerCleanupCommand(command);
  return command;
}

describe('cleanup command confirmation', () => {
  let baseDir: string;
  let runDir: string;
  let output: string[];

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'librarium-cleanup-command-'));
    runDir = join(baseDir, '1-test-run');
    mkdirSync(runDir);
    writeFileSync(join(runDir, 'result.md'), 'evidence');
    output = [];
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation((message) => {
      output.push(String(message));
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it.each([['cleanup', '--all'], ['clear']])(
    '%s --json refuses destructive all-run cleanup without --yes',
    async (command, ...options) => {
      await program().parseAsync([
        'node',
        'librarium',
        command,
        ...options,
        '--json',
        '--output',
        baseDir,
      ]);

      expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({
        error: expect.stringContaining('--yes'),
      });
      expect(process.exitCode).toBe(1);
      expect(existsSync(runDir)).toBe(true);
    },
  );

  it('allows an all-run JSON dry run without --yes', async () => {
    await program().parseAsync([
      'node',
      'librarium',
      'cleanup',
      '--all',
      '--json',
      '--dry-run',
      '--output',
      baseDir,
    ]);

    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({
      dryRun: true,
      deleted: [expect.objectContaining({ path: runDir })],
    });
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(runDir)).toBe(true);
  });

  it('deletes all runs in JSON mode only with --yes', async () => {
    await program().parseAsync([
      'node',
      'librarium',
      'clear',
      '--json',
      '--yes',
      '--output',
      baseDir,
    ]);

    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({
      dryRun: false,
      deleted: [expect.objectContaining({ path: runDir })],
    });
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(runDir)).toBe(false);
  });
});
