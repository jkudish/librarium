import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { safeWriteFile } from '../core/fs-utils.js';
import { createNodeCredentialContext } from '../node-credentials.js';
import type { Config, ProviderDispatchResult } from '../types.js';
import {
  type AnswerSource,
  buildAnswerSources,
  buildSynthesisPrompt,
  renderAnswerMarkdown,
} from './answer-synthesis.js';
import { verifyAnswer } from './claim-verification.js';
import {
  callWithCascade,
  preferenceFromConfig,
  resolveLlmClients,
} from './llm-client.js';
import { renderMarkdownAnsi } from './markdown-ansi.js';
import {
  type ExecuteRunHooks,
  executeRun,
  type PostDispatchContext,
  type PostDispatchResult,
  parseMaxCost,
  type RunOptions,
} from './run.js';
import { dimText, hyperlink, sanitizeForTerminal } from './run-format.js';

/**
 * `librarium answer` - a grounded, cited answer synthesized from a fan-out.
 *
 * It fans out exactly like `run` (defaulting to the `quick` group), then makes
 * ONE LLM synthesis call over the successful providers' content plus the
 * deduped source list, producing a concise answer with inline [n] citations.
 * The research is never lost: if synthesis fails, the run summary and output
 * directory still print and the exit code reflects the run, not the synthesis.
 */

/** Synthesis runs longer than refine (longer outputs), so it gets more time. */
const SYNTHESIS_TIMEOUT_MS = 90_000;

export function registerAnswerCommand(program: Command): void {
  program
    .command('answer')
    .description(
      'Fan out a query and synthesize one grounded, cited answer from the results',
    )
    .argument('<query>', 'The research query')
    .option(
      '-p, --providers <ids>',
      'Comma-separated provider IDs',
      (v: string) => v.split(','),
    )
    .option('-g, --group <name>', 'Use a predefined provider group')
    .option('-m, --mode <mode>', 'Execution mode: sync, async, or mixed')
    .option('-o, --output <dir>', 'Output base directory')
    .option('--parallel <n>', 'Max parallel requests', Number.parseInt)
    .option('--timeout <n>', 'Timeout per provider in seconds', Number.parseInt)
    .option(
      '--max-cost <usd>',
      'Stop launching providers once API-reported cost crosses this budget (USD)',
      parseMaxCost,
    )
    .option(
      '--max-estimated-cost <usd>',
      'Reserve each provider’s pre-dispatch estimated cost; skip launches once the estimate crosses this ceiling (USD)',
      parseMaxCost,
    )
    .option('-y, --yes', 'Skip the deep-research pre-flight confirm')
    .option('--json', 'Output run.json to stdout')
    .option(
      '--refine',
      'Rewrite the query into tier-tuned variants with one LLM call before dispatch',
    )
    .option(
      '--verify',
      'Verify material factual claims with bounded follow-up evidence searches',
    )
    .option(
      '--html',
      'Generate a self-contained report.html in the run directory',
    )
    .option(
      '--jsonl',
      'Generate a machine-readable results.jsonl in the run directory',
    )
    .option(
      '--open',
      'Open the output directory (or report.html with --html) when the run completes',
    )
    .action(async (query: string, opts: RunOptions) => {
      // Default to the quick group when the user did not pick providers/group.
      const runOpts: RunOptions = { ...opts };
      if (!runOpts.providers && !runOpts.group) {
        runOpts.group = 'quick';
      }
      const hooks: ExecuteRunHooks = {
        postDispatch: (context) =>
          opts.verify
            ? synthesizeAndVerifyAnswer(context)
            : synthesizeAnswer(context),
      };
      await executeRun(query, runOpts, hooks);
    });
}

/**
 * Opt-in verification wrapper. The normal `synthesizeAnswer` path is kept
 * untouched so `librarium answer` remains byte/behavior compatible without
 * `--verify`. Verification only ever replaces answer.md after a complete,
 * evidence-backed revision; all partial failures preserve the original file.
 */
export async function synthesizeAndVerifyAnswer(
  context: PostDispatchContext,
): Promise<PostDispatchResult | undefined> {
  const synthesis = await synthesizeAnswer(context);
  if (!synthesis?.manifestExtra?.answer) return synthesis;

  let originalAnswer: string;
  try {
    originalAnswer = readFileSync(
      join(context.outputDir, 'answer.md'),
      'utf-8',
    );
  } catch (error) {
    context.printLine(
      `  ! answer verification skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return synthesis;
  }

  const answerBody = originalAnswer
    .replace(/^\s*#[^\S\n]+[^\n]*\n+/, '')
    .replace(/\n#{1,6}[^\S\n]+Sources\b[\s\S]*$/i, '\n')
    .trim();
  const verification = await verifyAnswer({
    query: context.query,
    answer: answerBody,
    config: context.config,
    results: context.results,
    reports: context.reports,
    sources: context.sources,
  });
  safeWriteFile(
    join(context.outputDir, verification.metadata.matrixFile),
    `${JSON.stringify(verification.metadata, null, 2)}\n`,
  );

  let answer = synthesis.manifestExtra.answer;
  if (verification.revisedAnswer && verification.revision) {
    safeWriteFile(
      join(context.outputDir, 'answer.md'),
      renderAnswerMarkdown(
        context.query,
        verification.revisedAnswer,
        buildAnswerSources(context.sources),
      ),
    );
    answer = verification.revision;
    context.printLine('');
    context.printLine(
      '  verification complete; revised answer written to answer.md',
    );
  } else {
    context.printLine('');
    context.printLine(
      `  verification ${verification.metadata.status}; original grounded answer preserved`,
    );
  }

  return {
    manifestExtra: {
      ...synthesis.manifestExtra,
      answer,
      verification: verification.metadata,
    },
  };
}

/**
 * The post-dispatch synthesis step. Fails open: any failure prints a detailed
 * warning and returns without manifest extras, so the run summary and output
 * directory still print and the exit code reflects the run.
 */
export async function synthesizeAnswer(
  context: PostDispatchContext,
): Promise<PostDispatchResult | undefined> {
  const { query, config, results, sources, outputDir, color, printLine } =
    context;

  const successful = results.filter(
    (result) => result.status === 'success' && result.text.trim().length > 0,
  );

  if (successful.length === 0) {
    printLine('');
    printLine(
      '  ! no successful provider content to synthesize; skipping answer',
    );
    return undefined;
  }

  const answerSources = buildAnswerSources(sources);

  let synthesis: { provider: string; model: string; text: string } | null =
    null;
  try {
    synthesis = await runSynthesis(query, config, successful, answerSources);
  } catch (e) {
    printLine('');
    printLine(
      `  ! answer synthesis failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    printLine('  the research above is intact; see the run directory below');
    return undefined;
  }

  // Persist answer.md (answer body + numbered source list). We always write it,
  // even when citations look off, so the research is never lost.
  const answerMarkdown = renderAnswerMarkdown(
    query,
    synthesis.text,
    answerSources,
  );
  safeWriteFile(join(outputDir, 'answer.md'), answerMarkdown);

  // Fail-open citation sanity check: warn (do not retry) on out-of-range or
  // missing citations so a bad synthesis is visible without losing the answer.
  for (const warning of citationWarnings(
    synthesis.text,
    answerSources.length,
  )) {
    printLine('');
    printLine(dimText(`  ! ${warning}`, color));
  }

  // Print the rendered answer, then a hyperlinked numbered source list.
  printRenderedAnswer(printLine, synthesis.text, answerSources, color);

  return {
    manifestExtra: {
      answer: { provider: synthesis.provider, model: synthesis.model },
    },
  };
}

/** Run the single grounded-synthesis LLM call with the shared client cascade. */
async function runSynthesis(
  query: string,
  config: Config,
  successful: ProviderDispatchResult[],
  answerSources: AnswerSource[],
): Promise<{ provider: string; model: string; text: string }> {
  const preference = preferenceFromConfig(config, 'answer', 'refine');
  const clients = resolveLlmClients(preference, {
    env: process.env,
    config,
    credentials: createNodeCredentialContext(),
  });
  if (clients.length === 0) {
    throw new Error(
      preference?.provider
        ? `answer provider "${preference.provider}" has no API key configured`
        : 'no synthesis provider available (set OPENAI_API_KEY, GEMINI_API_KEY, or PERPLEXITY_API_KEY)',
    );
  }

  const prompt = buildSynthesisPrompt({
    query,
    results: successful,
    sources: answerSources,
  });

  const { client, result } = await callWithCascade<string>({
    clients,
    prompt,
    action: 'synthesis',
    timeoutMs: SYNTHESIS_TIMEOUT_MS,
    json: false,
    onWarning: (message) => console.error(`[librarium] answer: ${message}`),
  });

  const text = result.trim();
  if (!text) throw new Error('synthesis returned an empty answer');
  return { provider: client.provider, model: client.model, text };
}

/**
 * Inspect the synthesized answer's inline [n] citations against the available
 * source count. Returns human-readable warnings (never throws, never retries):
 * - any bracket index outside 1..sourceCount is flagged as invalid
 * - if sources exist but the answer cites none, that is flagged too
 * Returns an empty array when citations look fine or no sources were extracted.
 */
export function citationWarnings(
  answer: string,
  sourceCount: number,
): string[] {
  if (sourceCount <= 0) return [];

  const indices: number[] = [];
  // Match [1], [12], etc. — a bracketed run of digits.
  const re = /\[(\d+)\]/g;
  let match: RegExpExecArray | null = re.exec(answer);
  while (match !== null) {
    indices.push(Number.parseInt(match[1] as string, 10));
    match = re.exec(answer);
  }

  const warnings: string[] = [];

  if (indices.length === 0) {
    warnings.push(
      `the answer cites no sources, but ${sourceCount} ${
        sourceCount === 1 ? 'source is' : 'sources are'
      } available; treat its grounding with caution`,
    );
    return warnings;
  }

  const invalid = [...new Set(indices)]
    .filter((index) => index < 1 || index > sourceCount)
    .sort((a, b) => a - b);
  if (invalid.length > 0) {
    warnings.push(
      `the answer cites ${
        invalid.length === 1
          ? 'an invalid source index'
          : 'invalid source indices'
      } [${invalid.join('], [')}] outside the 1..${sourceCount} range`,
    );
  }

  return warnings;
}

/** Render the answer through markdown-ansi and append a numbered, hyperlinked
 * source list. Width matches the run summary's stream. */
function printRenderedAnswer(
  printLine: (line: string) => void,
  answer: string,
  sources: AnswerSource[],
  color: boolean,
): void {
  const width = Math.min(Math.max((process.stdout.columns ?? 80) - 2, 40), 100);
  printLine('');
  const rendered = renderMarkdownAnsi(answer, { color, width });
  for (const line of rendered.replace(/\n$/, '').split('\n')) {
    printLine(`  ${line}`);
  }

  if (sources.length > 0) {
    printLine('');
    printLine('  Sources');
    for (const source of sources) {
      const rawLabel = source.title ? source.title : source.url;
      printLine(
        `  [${source.index}] ${renderSourceLink(rawLabel, source.url, color)}`,
      );
    }
  }
}

/** Schemes safe to make clickable from provider-supplied URLs. Anything else
 * (javascript:, data:, file:, etc.) is rendered as sanitized plain text. */
const CLICKABLE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Render one source as a terminal hyperlink, but ONLY when the provider-supplied
 * URL uses a known-safe scheme. The display label is always sanitized of
 * control bytes; for unsafe or unparseable URLs we emit sanitized plain text so
 * nothing clickable points at a dangerous scheme.
 */
export function renderSourceLink(
  label: string,
  url: string,
  color: boolean,
): string {
  const safeLabel = sanitizeForTerminal(label);
  let scheme: string | undefined;
  try {
    scheme = new URL(url).protocol;
  } catch {
    scheme = undefined;
  }
  if (scheme && CLICKABLE_SCHEMES.has(scheme.toLowerCase())) {
    return hyperlink(safeLabel, url, color);
  }
  return safeLabel;
}
