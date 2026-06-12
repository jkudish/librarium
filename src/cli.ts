import { Command } from 'commander';
import { registerBrowseCommand } from './commands/browse.js';
import { registerCleanupCommand } from './commands/cleanup.js';
import { registerCompletionsCommand } from './commands/completions.js';
import { registerConfigCommand } from './commands/config.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerGroupsCommand } from './commands/groups.js';
import { registerHtmlCommand } from './commands/html.js';
import { registerInitCommand } from './commands/init.js';
import { registerInstallSkillCommand } from './commands/install-skill.js';
import { registerLsCommand } from './commands/ls.js';
import { registerRefineCommand } from './commands/refine.js';
import { registerRunCommand } from './commands/run.js';
import { registerStatusCommand } from './commands/status.js';
import { registerUpgradeCommand } from './commands/upgrade.js';
import { VERSION } from './constants.js';

const program = new Command();

program
  .name('librarium')
  .description(
    'Fan out research queries to multiple search and deep-research APIs in parallel',
  )
  .version(VERSION);

registerRunCommand(program);
registerStatusCommand(program);
registerBrowseCommand(program);
registerHtmlCommand(program);
registerRefineCommand(program);
registerCompletionsCommand(program);
registerLsCommand(program);
registerGroupsCommand(program);
registerInitCommand(program);
registerDoctorCommand(program);
registerConfigCommand(program);
registerCleanupCommand(program);
registerUpgradeCommand(program);
registerInstallSkillCommand(program);

// Bare `librarium` in an interactive terminal launches the wizard. Non-TTY
// bare invocations (pipes, CI) keep printing help so scripts never hang.
const bareInvocation = process.argv.length <= 2;
if (bareInvocation && process.stdout.isTTY && process.stdin.isTTY) {
  import('./commands/wizard.js')
    .then(({ runWizard }) => runWizard())
    .catch((err: Error) => {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exitCode = 1;
    });
} else {
  program.parseAsync(process.argv).catch((err: Error) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
