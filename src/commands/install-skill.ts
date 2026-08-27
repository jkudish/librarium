import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { VERSION } from '../constants.js';
import { safeWriteFile } from '../core/fs-utils.js';

const SKILL_DIR = join(homedir(), '.claude', 'skills', 'librarium');
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md');
const SKILL_URL_VERSIONED = `https://raw.githubusercontent.com/jkudish/librarium/v${VERSION}/SKILL.md`;

interface InstallSkillDependencies {
  readonly skill_dir: string;
  readonly skill_file: string;
  readonly skill_url: string;
  readonly fetch_skill: typeof fetch;
  readonly write_atomically: (path: string, content: string) => void;
}

const defaultDependencies: InstallSkillDependencies = {
  skill_dir: SKILL_DIR,
  skill_file: SKILL_FILE,
  skill_url: SKILL_URL_VERSIONED,
  fetch_skill: fetch,
  write_atomically: safeWriteFile,
};

function isCompleteLibrariumSkill(content: string): boolean {
  if (content.length < 200 || content.length > 256 * 1024) return false;
  const normalized = content.replaceAll('\r\n', '\n');
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatter?.[1].match(/^description:\s*\S.+$/m)) return false;
  const body = normalized.slice(frontmatter[0].length);
  return /^# Librarium\b/m.test(body) && /\blibrarium run\b/.test(body);
}

function assertSafeDestination(skillDir: string, skillFile: string): void {
  if (existsSync(skillDir)) {
    const directoryStat = lstatSync(skillDir);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error(
        'Skill destination directory is not a regular directory; refusing to replace it.',
      );
    }
  }
  if (existsSync(skillFile)) {
    const fileStat = lstatSync(skillFile);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error(
        'Skill destination is not a regular file; refusing to replace it.',
      );
    }
  }
}

export function registerInstallSkillCommand(
  program: Command,
  dependencies: Partial<InstallSkillDependencies> = {},
): void {
  const resolved = { ...defaultDependencies, ...dependencies };
  program
    .command('install-skill')
    .description('Install the Claude Code skill for AI-assisted research')
    .option('--force', 'Overwrite existing skill file')
    .option('--dry-run', 'Show what would happen without installing')
    .action(async (opts) => {
      try {
        assertSafeDestination(resolved.skill_dir, resolved.skill_file);
        if (existsSync(resolved.skill_file)) {
          if (!opts.force) {
            console.log(`Skill already installed at ${resolved.skill_file}`);
            console.log('Use --force to overwrite.');
            return;
          }
        }

        if (opts.dryRun) {
          console.log(`Would download skill from:\n  ${resolved.skill_url}`);
          console.log(`Would install to:\n  ${resolved.skill_file}`);
          return;
        }

        console.log('Downloading librarium skill...');
        let response: Response;
        try {
          response = await resolved.fetch_skill(resolved.skill_url);
        } catch {
          throw new Error(
            `Failed to download the librarium skill for version ${VERSION}.`,
          );
        }
        if (!response.ok) {
          throw new Error(
            `The librarium skill tag for version ${VERSION} is unavailable.`,
          );
        }
        let content: string;
        try {
          content = await response.text();
        } catch {
          throw new Error(
            `Failed to download the librarium skill for version ${VERSION}.`,
          );
        }
        if (!isCompleteLibrariumSkill(content)) {
          throw new Error(
            `The downloaded librarium skill for version ${VERSION} is invalid.`,
          );
        }

        mkdirSync(resolved.skill_dir, { recursive: true });
        assertSafeDestination(resolved.skill_dir, resolved.skill_file);
        // safeWriteFile stages a complete sibling file and commits with rename,
        // preserving an existing installation if staging or replacement fails.
        resolved.write_atomically(resolved.skill_file, content);

        console.log(`Skill installed to ${resolved.skill_file}`);
        console.log(
          '\nClaude Code will now use librarium for research queries.',
        );
        console.log('Triggers: /librarium, /research, /deep-research');
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}
