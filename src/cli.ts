import { checkRemoved, createRunCliProgram } from './run-cli-program.js';

async function main() {
  try {
    checkRemoved(process.argv.slice(2));
    await createRunCliProgram().parseAsync(process.argv);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

void main();
