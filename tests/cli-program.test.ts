import type { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { createCliProgram } from '../src/cli-program.js';

function command(program: Command, name: string): Command {
  const found = program.commands.find((candidate) => candidate.name() === name);
  if (!found) throw new Error(`Missing command: ${name}`);
  return found;
}

async function expectRejectedBeforeAction(
  args: string[],
  commandName: string,
): Promise<void> {
  const program = createCliProgram();
  program.exitOverride();
  const output = { writeErr: () => {}, writeOut: () => {} };
  program.configureOutput(output);
  const action = vi.fn();
  command(program, commandName)
    .exitOverride()
    .configureOutput(output)
    .action(action);

  await expect(
    program.parseAsync(['node', 'librarium', ...args]),
  ).rejects.toThrow();
  expect(action).not.toHaveBeenCalled();
}

describe('CLI program factory', () => {
  it('builds independent complete command trees without parsing argv', () => {
    const first = createCliProgram();
    const second = createCliProgram();
    expect(first).not.toBe(second);
    expect(first.commands.map((item) => item.name())).toEqual(
      second.commands.map((item) => item.name()),
    );
    expect(first.commands.map((item) => item.name())).toContain('mcp');
    expect(first.commands.map((item) => item.name())).toContain('plan');
    expect(first.commands.map((item) => item.name())).not.toContain(
      'install-plugin',
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects invalid run values before invoking the action', async () => {
    await expectRejectedBeforeAction(['run', '   '], 'run');
    await expectRejectedBeforeAction(
      ['run', 'query', '--parallel', '2workers'],
      'run',
    );
    await expectRejectedBeforeAction(
      ['run', 'query', '--mode', 'background'],
      'run',
    );
    await expectRejectedBeforeAction(
      ['run', 'query', '--providers', 'openai,'],
      'run',
    );
    await expectRejectedBeforeAction(
      ['run', 'query', '--max-cost', '0.0000001'],
      'run',
    );
  });

  it('rejects invalid answer and refine values before invoking actions', async () => {
    await expectRejectedBeforeAction(
      ['answer', 'query', '--timeout', '0'],
      'answer',
    );
    await expectRejectedBeforeAction(['refine', 'x'.repeat(100_001)], 'refine');
  });

  it('registers only the approved plan interface with run parsing parity', async () => {
    const program = createCliProgram();
    const plan = command(program, 'plan');
    expect(plan.options.map(({ long }) => long)).toEqual(
      expect.arrayContaining([
        '--providers',
        '--group',
        '--mode',
        '--parallel',
        '--timeout',
        '--max-cost',
        '--max-estimated-cost',
        '--no-fallback',
        '--refine',
        '--answer',
        '--verify',
        '--json',
      ]),
    );
    expect(plan.options.map(({ long }) => long)).not.toContain('--for');
    await expectRejectedBeforeAction(
      ['plan', 'query', '--max-estimated-cost', 'unbounded'],
      'plan',
    );
  });

  it('rejects closed command arguments before invoking their actions', async () => {
    await expectRejectedBeforeAction(['completions', 'pwsh'], 'completions');
    await expectRejectedBeforeAction(['config', 'edit'], 'config');
    await expectRejectedBeforeAction(['cleanup', '--days', '-1'], 'cleanup');
    await expectRejectedBeforeAction(['usage', '--days', '1.5'], 'usage');
  });

  it('uses exit code 1 for an invalid completion shell in v2', async () => {
    const program = createCliProgram();
    program.exitOverride();
    const output = { writeErr: () => {}, writeOut: () => {} };
    program.configureOutput(output);
    command(program, 'completions').exitOverride().configureOutput(output);

    await expect(
      program.parseAsync(['node', 'librarium', 'completions', 'pwsh']),
    ).rejects.toMatchObject({
      code: 'commander.invalidArgument',
      exitCode: 1,
    });
  });

  it('keeps Commander lone-negation fallback semantics aligned', async () => {
    for (const commandName of ['run', 'answer']) {
      for (const expectation of [
        { flags: [] as string[], fallback: true },
        { flags: ['--no-fallback'], fallback: false },
      ]) {
        const program = createCliProgram();
        program.exitOverride();
        const output = { writeErr: () => {}, writeOut: () => {} };
        program.configureOutput(output);
        const selected = command(program, commandName);
        selected.configureOutput(output);
        const action = vi.fn();
        selected.action(action);

        await program.parseAsync([
          'node',
          'librarium',
          commandName,
          '  query  ',
          ...expectation.flags,
        ]);

        expect(action).toHaveBeenCalledOnce();
        expect(action.mock.calls[0]?.[0]).toBe('query');
        expect(selected.opts().fallback).toBe(expectation.fallback);
      }
    }
  });
});
