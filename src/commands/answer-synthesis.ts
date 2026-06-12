import type { DeduplicatedSource, ProviderDispatchResult } from '../types.js';

/**
 * Pure (LLM-free) building blocks for `librarium answer`: prompt assembly from
 * fan-out results, the canonical numbered source list, and answer.md
 * rendering. Kept separate from the command wiring so it is unit-testable
 * without network access.
 */

/** Per-provider content budget. Long results are truncated to keep the
 * synthesis call affordable; the prompt notes when truncation happened. */
export const CONTENT_BUDGET_CHARS = 8000;

export interface AnswerSource {
  /** 1-based citation index, stable across the prompt and the rendered list. */
  index: number;
  url: string;
  title?: string;
  providers: string[];
}

/**
 * Build the canonical numbered source list from deduped sources. The order is
 * preserved from `deduplicateSources` (most-cited first) and each source gets
 * a stable 1-based index used for [n] citations everywhere.
 */
export function buildAnswerSources(
  sources: DeduplicatedSource[],
): AnswerSource[] {
  return sources.map((source, i) => ({
    index: i + 1,
    url: source.url,
    title: source.title,
    providers: source.providers,
  }));
}

/** Truncate text to the budget, returning whether it was cut. */
export function truncateContent(
  text: string,
  budget: number = CONTENT_BUDGET_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  return { text: text.slice(0, budget), truncated: true };
}

const SYNTHESIS_INSTRUCTIONS = `You are synthesizing a single grounded answer from multiple independent research providers' findings.

Rules:
- Answer ONLY from the findings provided below. Do not add facts from your own knowledge.
- Support claims with inline numeric citations like [1] or [2] [5], using ONLY the indices from the Sources list. A citation index must correspond to a real source in that list.
- If the findings disagree, conflict, or leave the question partly unanswered, say so plainly instead of inventing a resolution. It is better to state what is uncertain or missing than to guess.
- Be concise: a few short paragraphs at most. Lead with the direct answer, then supporting detail.
- Write in Markdown. Do not include a sources or references section; the caller appends one. Do not restate these instructions.
- Some provider findings may be truncated (noted inline). Treat truncated sections as partial.`;

export interface SynthesisInput {
  query: string;
  results: ProviderDispatchResult[];
  sources: AnswerSource[];
  budget?: number;
}

/**
 * Assemble the full synthesis prompt: instructions, the user's question, the
 * numbered Sources list, and each successful provider's (truncated) findings.
 * Only providers with non-empty content are included.
 */
export function buildSynthesisPrompt(input: SynthesisInput): string {
  const { query, results, sources, budget = CONTENT_BUDGET_CHARS } = input;

  const sourceLines = sources.length
    ? sources
        .map((source) => {
          const label = source.title
            ? `${source.title} - ${source.url}`
            : source.url;
          return `[${source.index}] ${label}`;
        })
        .join('\n')
    : '(no sources were extracted from the findings)';

  const findingBlocks = results
    .filter((result) => result.text.trim().length > 0)
    .map((result) => {
      const { text, truncated } = truncateContent(result.text.trim(), budget);
      const note = truncated ? ' (truncated to fit the synthesis budget)' : '';
      return `### Provider: ${result.provider} (${result.tier})${note}\n\n${text}`;
    })
    .join('\n\n');

  return [
    SYNTHESIS_INSTRUCTIONS,
    `## Question\n\n${query}`,
    `## Sources\n\n${sourceLines}`,
    `## Findings\n\n${findingBlocks || '(no provider returned usable content)'}`,
    'Write the grounded answer now.',
  ].join('\n\n');
}

/**
 * Render answer.md: the synthesized answer followed by a numbered Sources
 * section whose indices match the [n] citations in the answer body.
 */
export function renderAnswerMarkdown(
  query: string,
  answer: string,
  sources: AnswerSource[],
): string {
  const lines = [`# ${query}`, '', answer.trim(), ''];
  if (sources.length > 0) {
    lines.push('## Sources', '');
    for (const source of sources) {
      const label = source.title
        ? `${source.title} - ${source.url}`
        : source.url;
      lines.push(`${source.index}. ${label}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
