import { join } from 'node:path';
import type { Command } from 'commander';
import { safeWriteFile } from '../core/fs-utils.js';
import type { Config, ProviderDispatchResult } from '../types.js';
import {
  type AnswerSource,
  buildAnswerSources,
  buildSynthesisPrompt,
  renderAnswerMarkdown,
} from './answer-synthesis.js';
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
  type RunOptions,
} from './run.js';
import { hyperlink } from './run-format.js';

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
    .option('--json', 'Output run.json to stdout')
    .option(
      '--refine',
      'Rewrite the query into tier-tuned variants with one LLM call before dispatch',
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
        postDispatch: (context) => synthesizeAnswer(context),
      };
      await executeRun(query, runOpts, hooks);
    });
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

  // Persist answer.md (answer body + numbered source list).
  const answerMarkdown = renderAnswerMarkdown(
    query,
    synthesis.text,
    answerSources,
  );
  safeWriteFile(join(outputDir, 'answer.md'), answerMarkdown);

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
  const clients = resolveLlmClients(preference, process.env);
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
      const label = source.title ? source.title : source.url;
      const linked = hyperlink(label, source.url, color);
      printLine(`  [${source.index}] ${linked}`);
    }
  }
}
