#!/usr/bin/env node
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { executeSurfaceCalibration } from './runner.mjs';

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--fixture' || argument === '--output') {
      const value = argv[++index];
      if (!value || value.startsWith('--'))
        throw new Error(`${argument} requires a value`);
      options[argument === '--fixture' ? 'fixture' : 'output'] = value;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function confirmPaidRun(details) {
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error(
      'Paid surface calibration requires an interactive terminal',
    );
  stdout.write(`${JSON.stringify(details, null, 2)}\n`);
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return (
      (
        await prompt.question(
          'Type RUN to authorize this exact sequential paid run: ',
        )
      ).trim() === 'RUN'
    );
  } finally {
    prompt.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const result = await executeSurfaceCalibration(parseArguments(argv), {
    confirm: confirmPaidRun,
  });
  stdout.write(
    `${JSON.stringify(result.dryRun ? { preflight: result.preflight, revisions: { core: result.config.coreRevision, firecrawl: result.config.firecrawlRevision }, corpus: result.corpus } : { outputDirectory: result.outputDirectory, recommendation: result.run.recommendation }, null, 2)}\n`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => (process.exitCode = code),
    (error) => {
      process.stderr.write(
        `[surface-calibration] ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
