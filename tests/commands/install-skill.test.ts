import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerInstallSkillCommand } from '../../src/commands/install-skill.js';
import { safeWriteFile } from '../../src/core/fs-utils.js';

const VALID_SKILL = readFileSync(
  new URL('../../SKILL.md', import.meta.url),
  'utf8',
);

describe('install-skill command', () => {
  let root: string;
  let skillDir: string;
  let skillFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'librarium-install-skill-'));
    skillDir = join(root, '.claude', 'skills', 'librarium');
    skillFile = join(skillDir, 'SKILL.md');
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  function command(
    content = VALID_SKILL,
    writeAtomically: (path: string, content: string) => void = safeWriteFile,
  ): Command {
    const program = new Command();
    program.exitOverride();
    registerInstallSkillCommand(program, {
      skill_dir: skillDir,
      skill_file: skillFile,
      skill_content: content,
      write_atomically: writeAtomically,
    });
    return program;
  }

  it('registers the install-skill command', () => {
    const program = new Command();
    registerInstallSkillCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'install-skill');
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toBe(
      'Install the Claude Code skill for AI-assisted research',
    );
  });

  it('has --force option', () => {
    const program = new Command();
    registerInstallSkillCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'install-skill');
    const forceOption = cmd?.options.find((o) => o.long === '--force');
    expect(forceOption).toBeDefined();
  });

  it('has --dry-run option', () => {
    const program = new Command();
    registerInstallSkillCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'install-skill');
    const dryRunOption = cmd?.options.find((o) => o.long === '--dry-run');
    expect(dryRunOption).toBeDefined();
  });

  it('installs the exact skill without any download', async () => {
    const fetchSkill = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network denied');
    });

    await command().parseAsync(['node', 'test', 'install-skill']);

    expect(fetchSkill).not.toHaveBeenCalled();
    expect(readFileSync(skillFile, 'utf8')).toBe(VALID_SKILL);
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    '',
    '---\ndescription: plausible but incomplete\n---\n',
    VALID_SKILL.replace('name: librarium', 'name: renamed-skill'),
  ])('rejects a missing or invalid bundle before writing', async (content) => {
    await command(content).parseAsync(['node', 'test', 'install-skill']);

    expect(existsSync(skillDir)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('skill for version'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('dry-run describes the bundled install without creating files', async () => {
    await command().parseAsync(['node', 'test', 'install-skill', '--dry-run']);

    expect(existsSync(skillDir)).toBe(false);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Would install the bundled skill'),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('preserves an existing installation without --force', async () => {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, 'old install');

    await command().parseAsync(['node', 'test', 'install-skill']);

    expect(readFileSync(skillFile, 'utf8')).toBe('old install');
    expect(process.exitCode).toBeUndefined();
  });

  it('atomically replaces an existing install with --force', async () => {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, 'old install', { encoding: 'utf8', flag: 'wx' });

    await command().parseAsync(['node', 'test', 'install-skill', '--force']);

    expect(readFileSync(skillFile, 'utf8')).toBe(VALID_SKILL);
    expect(readdirSync(skillDir)).toEqual(['SKILL.md']);
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Triggers:'),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('rolls back replacement failures without a partial install', async () => {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, 'old install', { encoding: 'utf8', flag: 'wx' });
    const writeAtomically = vi.fn(() => {
      throw new Error('injected replacement failure');
    });

    await command(VALID_SKILL, writeAtomically).parseAsync([
      'node',
      'test',
      'install-skill',
      '--force',
    ]);

    expect(writeAtomically).toHaveBeenCalledWith(skillFile, VALID_SKILL);
    expect(readFileSync(skillFile, 'utf8')).toBe('old install');
    expect(readdirSync(skillDir)).toEqual(['SKILL.md']);
    expect(process.exitCode).toBe(1);
  });
});
