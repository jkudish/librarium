#!/usr/bin/env node
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { executeBenchmark } from './lib/runner.mjs';

const usage = `Librarium provider benchmark

Usage:
  npm run benchmark -- [options]

Options:
  --track <stable|live|all>  Dataset track (default: stable)
  --providers <ids>          Comma-separated individual provider IDs
  --groups <names>           Comma-separated built-in group names
  --candidates <names>       Comma-separated curated candidate groups
  --questions <ids>          Comma-separated question IDs for canaries
  --resume <directory>       Resume a timestamped benchmark output
  --output <directory>       Parent directory for timestamped output
  --fixture <manifest>       Replay an offline fixture pack
  --dry-run                  Print resolved config and preflight; make no calls
  --help                     Show this help

Live runs require a TTY and the operator must type RUN after reviewing the
resolved pinned synthesis/judge configuration, partial cost estimate, and every
unknown-cost operation. Fixture replay never prompts or makes network calls.`;

function commaList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseArguments(argv) {
  const options = {
    track: 'stable',
    providers: [],
    groups: [],
    candidates: [],
    questionIds: [],
  };
  const valueFlags = new Map([
    ['--track', 'track'],
    ['--providers', 'providers'],
    ['--groups', 'groups'],
    ['--candidates', 'candidates'],
    ['--questions', 'questionIds'],
    ['--resume', 'resume'],
    ['--output', 'output'],
    ['--fixture', 'fixture'],
  ]);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const key = valueFlags.get(argument);
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    options[key] = [
      'providers',
      'groups',
      'candidates',
      'questionIds',
    ].includes(key)
      ? commaList(value)
      : value;
  }
  if (!['stable', 'live', 'all'].includes(options.track)) {
    throw new Error('--track must be stable, live, or all');
  }
  if (options.resume && options.output) {
    throw new Error('--resume cannot be combined with --output');
  }
  return options;
}

async function confirmPaidRun(confirmation) {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      'Paid live benchmark confirmation requires an interactive terminal',
    );
  }
  stdout.write('\nResolved paid-call configuration and preflight:\n');
  stdout.write(`${JSON.stringify(confirmation, null, 2)}\n\n`);
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(
      'Type RUN to confirm this exact provider, synthesis, judge, and cost configuration: ',
    );
    return answer.trim() === 'RUN';
  } finally {
    prompt.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    stdout.write(`${usage}\n`);
    return 0;
  }
  const result = await executeBenchmark(options, {
    confirm: confirmPaidRun,
    onProgress: ({ key, status }) => {
      process.stderr.write(`[benchmark] ${key} (${status})\n`);
    },
  });
  if (result.dryRun) {
    stdout.write(
      `${JSON.stringify(
        { resolvedConfig: result.resolvedConfig, preflight: result.preflight },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  stdout.write(
    `${JSON.stringify(
      {
        outputDirectory: result.outputDirectory,
        completed: result.completed,
        failed: result.failed,
      },
      null,
      2,
    )}\n`,
  );
  return result.failed === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        `[benchmark] ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
