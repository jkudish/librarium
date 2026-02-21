import { Command } from 'commander';
import { registerCleanupCommand } from './commands/cleanup.js';
import { registerConfigCommand } from './commands/config.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerGroupsCommand } from './commands/groups.js';
import { registerInitCommand } from './commands/init.js';
import { registerInstallSkillCommand } from './commands/install-skill.js';
import { registerLsCommand } from './commands/ls.js';
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
registerLsCommand(program);
registerGroupsCommand(program);
registerInitCommand(program);
registerDoctorCommand(program);
registerConfigCommand(program);
registerCleanupCommand(program);
registerUpgradeCommand(program);
registerInstallSkillCommand(program);

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exitCode = 1;
});
