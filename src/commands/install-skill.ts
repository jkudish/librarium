import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { VERSION } from '../constants.js';

const SKILL_DIR = join(homedir(), '.claude', 'skills', 'librarium');
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md');
const SKILL_URL_VERSIONED = `https://raw.githubusercontent.com/jkudish/librarium/v${VERSION}/SKILL.md`;
const SKILL_URL_MAIN =
  'https://raw.githubusercontent.com/jkudish/librarium/main/SKILL.md';

export function registerInstallSkillCommand(program: Command): void {
  program
    .command('install-skill')
    .description('Install the Claude Code skill for AI-assisted research')
    .option('--force', 'Overwrite existing skill file')
    .option('--dry-run', 'Show what would happen without installing')
    .action(async (opts) => {
      try {
        if (existsSync(SKILL_FILE)) {
          if (!opts.force) {
            console.log(`Skill already installed at ${SKILL_FILE}`);
            console.log('Use --force to overwrite.');
            return;
          }
          // Refuse to overwrite symlinks
          const stat = lstatSync(SKILL_FILE);
          if (stat.isSymbolicLink()) {
            console.error(`${SKILL_FILE} is a symlink — refusing to overwrite`);
            process.exitCode = 1;
            return;
          }
        }

        if (opts.dryRun) {
          console.log(`Would download skill from:\n  ${SKILL_URL_VERSIONED}`);
          console.log(`Would install to:\n  ${SKILL_FILE}`);
          return;
        }

        console.log('Downloading librarium skill...');

        // Try version-pinned URL first, fall back to main
        let content: string | null = null;
        for (const url of [SKILL_URL_VERSIONED, SKILL_URL_MAIN]) {
          try {
            const response = await fetch(url);
            if (response.ok) {
              content = await response.text();
              break;
            }
          } catch {
            // Try next URL
          }
        }

        if (!content || content.trim().length < 50) {
          console.error('Failed to download skill or content appears invalid.');
          process.exitCode = 1;
          return;
        }

        mkdirSync(SKILL_DIR, { recursive: true });
        writeFileSync(SKILL_FILE, content, 'utf-8');

        console.log(`Skill installed to ${SKILL_FILE}`);
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
