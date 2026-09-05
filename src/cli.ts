import { createCliProgram } from './cli-program.js';
import { isHandledPlanCliExit } from './commands/plan.js';

const program = createCliProgram();

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
    if (isHandledPlanCliExit(err)) return;
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
