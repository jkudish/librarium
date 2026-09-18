import { Command } from 'commander';
import { registerAnswerCommand } from './commands/answer.js';
import { registerBrowseCommand } from './commands/browse.js';
import { registerCleanupCommand } from './commands/cleanup.js';
import { registerCompletionsCommand } from './commands/completions.js';
import { registerConfigCommand } from './commands/config.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerGroupsCommand } from './commands/groups.js';
import { registerHtmlCommand } from './commands/html.js';
import { registerInitCommand } from './commands/init.js';
import { registerInstallSkillCommand } from './commands/install-skill.js';
import { registerJsonlCommand } from './commands/jsonl.js';
import { registerLiveValidationCommand } from './commands/live-validation.js';
import { registerLsCommand } from './commands/ls.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerPlanCommand } from './commands/plan.js';
import { registerRefineCommand } from './commands/refine.js';
import { registerRunCommand } from './commands/run.js';
import { registerStatusCommand } from './commands/status.js';
import { registerUpgradeCommand } from './commands/upgrade.js';
import { registerUsageCommand } from './commands/usage.js';
import { VERSION } from './constants.js';
import { replayCanonicalLiveValidationFixture } from './node-live-validation-fixture.js';

/** Build the complete CLI command tree without parsing argv or running actions. */
export function createCliProgram(): Command {
  const program = new Command();

  program
    .name('librarium')
    .description(
      'Fan out research queries to multiple search and deep-research APIs in parallel',
    )
    .version(VERSION);

  registerRunCommand(program);
  registerPlanCommand(program);
  registerLiveValidationCommand(program, {
    fixtureReplay: replayCanonicalLiveValidationFixture,
  });
  registerAnswerCommand(program);
  registerStatusCommand(program);
  registerUsageCommand(program);
  registerBrowseCommand(program);
  registerHtmlCommand(program);
  registerJsonlCommand(program);
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
  registerMcpCommand(program);

  return program;
}
