import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';

const SKILL_DIR = join(homedir(), '.claude', 'skills', 'librarium');
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md');
const SKILL_URL =
  'https://raw.githubusercontent.com/jkudish/librarium/main/SKILL.md';

export function registerInstallSkillCommand(program: Command): void {
  program
    .command('install-skill')
    .description('Install the Claude Code skill for AI-assisted research')
    .option('--force', 'Overwrite existing skill file')
    .option('--dry-run', 'Show what would happen without installing')
    .action(async (opts) => {
      try {
        if (!opts.force && existsSync(SKILL_FILE)) {
          console.log(`Skill already installed at ${SKILL_FILE}`);
          console.log('Use --force to overwrite.');
          return;
        }

        if (opts.dryRun) {
          console.log(`Would download skill from:\n  ${SKILL_URL}`);
          console.log(`Would install to:\n  ${SKILL_FILE}`);
          return;
        }

        console.log('Downloading librarium skill...');

        const response = await fetch(SKILL_URL);
        if (!response.ok) {
          console.error(`Failed to download skill: HTTP ${response.status}`);
          process.exitCode = 1;
          return;
        }

        const content = await response.text();

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
