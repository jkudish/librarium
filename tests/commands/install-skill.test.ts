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

const VALID_SKILL = `---
description: Run multi-provider research with librarium
---

# Librarium Research Skill

Use the immutable packaged instructions below when conducting research.

## Workflow

Run \`librarium run "the research question" --group quick\`, inspect every
generated source, preserve provenance, and report disagreements explicitly.
`;

function response(body: string, status = 200): Response {
  return new Response(body, { status });
}

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
    fetchSkill: typeof fetch,
    writeAtomically: (path: string, content: string) => void = safeWriteFile,
  ): Command {
    const program = new Command();
    program.exitOverride();
    registerInstallSkillCommand(program, {
      skill_dir: skillDir,
      skill_file: skillFile,
      skill_url:
        'https://raw.githubusercontent.com/jkudish/librarium/v2.0.0/SKILL.md',
      fetch_skill: fetchSkill,
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

  it('fails closed when the immutable version tag is missing', async () => {
    const fetchSkill = vi.fn(async () => response('not found', 404));

    await command(fetchSkill).parseAsync(['node', 'test', 'install-skill']);

    expect(fetchSkill).toHaveBeenCalledTimes(1);
    expect(fetchSkill.mock.calls[0]?.[0]).toContain('/v2.0.0/SKILL.md');
    expect(existsSync(skillFile)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('skill tag for version'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('leaves no partial install when the download fails', async () => {
    const fetchSkill = vi.fn(async () => {
      throw new Error('request included a secret');
    });

    await command(fetchSkill).parseAsync(['node', 'test', 'install-skill']);

    expect(existsSync(skillDir)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.not.stringContaining('secret'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('validates the complete skill before creating the destination', async () => {
    const fetchSkill = vi.fn(async () =>
      response('---\ndescription: plausible but incomplete\n---\n'),
    );

    await command(fetchSkill).parseAsync(['node', 'test', 'install-skill']);

    expect(existsSync(skillDir)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('skill for version'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('atomically replaces an existing install with --force', async () => {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, 'old install', { encoding: 'utf8', flag: 'wx' });
    const fetchSkill = vi.fn(async () => response(VALID_SKILL));

    await command(fetchSkill).parseAsync([
      'node',
      'test',
      'install-skill',
      '--force',
    ]);

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

    await command(
      vi.fn(async () => response(VALID_SKILL)),
      writeAtomically,
    ).parseAsync(['node', 'test', 'install-skill', '--force']);

    expect(writeAtomically).toHaveBeenCalledWith(skillFile, VALID_SKILL);
    expect(readFileSync(skillFile, 'utf8')).toBe('old install');
    expect(readdirSync(skillDir)).toEqual(['SKILL.md']);
    expect(process.exitCode).toBe(1);
  });
});
