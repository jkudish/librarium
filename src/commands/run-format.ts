import { pathToFileURL } from 'node:url';
import type { ProviderReport, ProviderTier, ProviderUsage } from '../types.js';

/**
 * Pure formatting helpers for the `librarium run` live results table.
 * No I/O here — everything returns strings so it stays trivially testable.
 */

const ANSI = {
  reset: '\u001b[0m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  dim: '\u001b[2m',
} as const;

/** Durations at or above this threshold are highlighted in color mode. */
export const SLOW_DURATION_MS = 10_000;

/**
 * Decide whether to emit ANSI colors for a given stream.
 * Honors NO_COLOR / FORCE_COLOR and falls back to TTY detection.
 */
export function isColorEnabled(
  stream: { isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return Boolean(stream.isTTY);
}

function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${ANSI.reset}` : text;
}

/** Column widths so provider lines align across the whole run. */
export interface LineWidths {
  id: number;
  tier: number;
}

export function computeLineWidths(
  ids: string[],
  tiers: ProviderTier[],
): LineWidths {
  return {
    id: Math.max(0, ...ids.map((id) => id.length)),
    tier: Math.max(0, ...tiers.map((tier) => tier.length)),
  };
}

export function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/** Abbreviate a token count: 950 -> "950", 8400 -> "8.4k", 1200000 -> "1.2M". */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/** Format an API-reported cost in USD, e.g. "$0.038". */
export function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(costUsd < 0.1 ? 3 : 2)}`;
}

/**
 * Short usage label for a provider line: prefers API-reported cost, falls
 * back to a token count. Returns undefined when nothing was reported.
 */
export function usageLabel(
  usage: ProviderUsage | undefined,
): string | undefined {
  if (!usage) return undefined;
  if (usage.costUsd !== undefined) return formatCost(usage.costUsd);
  const tokens =
    usage.totalTokens ??
    (usage.inputTokens !== undefined || usage.outputTokens !== undefined
      ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      : undefined);
  if (tokens === undefined) return undefined;
  return `${formatTokens(tokens)} tok`;
}

function citationLabel(report: ProviderReport): string {
  const noun = report.tier === 'raw-search' ? 'results' : 'sources';
  return `${String(report.citationCount).padStart(3)} ${noun}`;
}

function compactError(error: string | undefined, maxLength = 80): string {
  const flat = (error ?? 'unknown error').replace(/\s+/g, ' ').trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

/**
 * Format one provider's result as a table line:
 *
 *   ✓ perplexity-sonar-pro   ai-grounded      2.1s    12 sources
 *   ✗ brave-search           raw-search       0.3s   HTTP 401 Unauthorized
 *   ◷ openai-deep            deep-research   submitted
 */
export function formatProviderLine(
  report: ProviderReport,
  widths: LineWidths,
  color: boolean,
): string {
  const id = report.id.padEnd(Math.max(widths.id, report.id.length));
  const tier = paint(
    report.tier.padEnd(Math.max(widths.tier, report.tier.length)),
    ANSI.dim,
    color,
  );
  // Highlight slow providers so they pop in the table.
  const duration =
    report.durationMs >= SLOW_DURATION_MS
      ? paint(formatDuration(report.durationMs).padStart(7), ANSI.yellow, color)
      : formatDuration(report.durationMs).padStart(7);
  const fallbackSuffix = report.fallbackFor
    ? `   ${paint(`(fallback for ${report.fallbackFor})`, ANSI.dim, color)}`
    : '';
  const usage = usageLabel(report.usage);
  const usageSuffix = usage ? `   ${paint(`· ${usage}`, ANSI.dim, color)}` : '';

  switch (report.status) {
    case 'success': {
      const glyph = paint('✓', ANSI.green, color);
      return `  ${glyph} ${id}   ${tier}   ${duration}   ${citationLabel(report)}${usageSuffix}${fallbackSuffix}`;
    }
    case 'async-pending': {
      const glyph = paint('◷', ANSI.yellow, color);
      return `  ${glyph} ${id}   ${tier}   ${paint('submitted', ANSI.yellow, color)}`;
    }
    case 'skipped': {
      const glyph = paint('-', ANSI.dim, color);
      return `  ${glyph} ${id}   ${tier}   ${paint('skipped', ANSI.dim, color)}`;
    }
    default: {
      // error / timeout
      const glyph = paint('✗', ANSI.red, color);
      const reason = paint(compactError(report.error), ANSI.red, color);
      return `  ${glyph} ${id}   ${tier}   ${duration}   ${reason}${fallbackSuffix}`;
    }
  }
}

/** Dim a piece of text (no-op when color is disabled). */
export function dimText(text: string, color: boolean): string {
  return paint(text, ANSI.dim, color);
}

/**
 * Format an unresolved provider row for the live (in-place) table.
 * The glyph slot shows a spinner frame; the duration column ticks while
 * the provider runs, or shows "queued" before it starts.
 */
export function formatPendingLine(
  id: string,
  tier: ProviderTier,
  widths: LineWidths,
  color: boolean,
  frame: string,
  elapsedMs?: number,
): string {
  const paddedId = id.padEnd(Math.max(widths.id, id.length));
  const paddedTier = paint(
    tier.padEnd(Math.max(widths.tier, tier.length)),
    ANSI.dim,
    color,
  );
  const glyph = paint(frame, ANSI.cyan, color);
  const status =
    elapsedMs === undefined
      ? paint('queued', ANSI.dim, color)
      : paint(formatDuration(elapsedMs).padStart(7), ANSI.dim, color);
  return `  ${glyph} ${paddedId}   ${paddedTier}   ${status}`;
}

/**
 * Truncate a line to a maximum visible width, preserving ANSI escape
 * sequences (they don't count toward the width). Appends a reset when the
 * line is cut so styling never bleeds into the next line.
 */
export function truncateAnsi(line: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  let visible = 0;
  let out = '';
  let i = 0;
  let sawAnsi = false;
  let truncated = false;
  while (i < line.length) {
    const char = line[i];
    if (char === '\u001b') {
      // Copy the full escape sequence without counting it as visible width.
      let j = i + 1;
      if (line[j] === '[') {
        // CSI: ESC [ ... final alphabetic byte.
        j++;
        while (j < line.length && !/[a-zA-Z]/.test(line[j] as string)) j++;
        j++; // include the final byte
      } else if (
        line[j] === ']' ||
        line[j] === 'P' ||
        line[j] === 'X' ||
        line[j] === '^' ||
        line[j] === '_'
      ) {
        // OSC/DCS/SOS/PM/APC: runs until ST (ESC \\) or BEL (\u0007). OSC 8
        // hyperlinks land here; splitting mid-sequence corrupts the line.
        j++;
        while (j < line.length) {
          if (line[j] === '\u0007') {
            j++;
            break;
          }
          if (line[j] === '\u001b' && line[j + 1] === '\\') {
            j += 2;
            break;
          }
          j++;
        }
      }
      out += line.slice(i, j);
      sawAnsi = true;
      i = j;
      continue;
    }
    if (visible >= maxWidth) {
      // Drop remaining visible chars but keep scanning for ANSI resets.
      truncated = true;
      i++;
      continue;
    }
    out += char;
    visible++;
    i++;
  }
  if (truncated && sawAnsi && !out.endsWith(ANSI.reset)) {
    out += ANSI.reset;
  }
  return out;
}

/** Indented notice printed when a failed primary triggers its fallback. */
export function formatFallbackNotice(
  fallbackId: string,
  color: boolean,
): string {
  return `    ${paint(`↳ falling back to ${fallbackId}`, ANSI.yellow, color)}`;
}

/**
 * Strip C0/C1 control bytes (including ESC and BEL) and collapse internal
 * whitespace to single spaces, then trim. Untrusted display labels and URLs
 * must pass through this before being embedded in an OSC 8 sequence: an
 * embedded ESC \\ or BEL would otherwise terminate the hyperlink early and let
 * the remainder break out into raw terminal control.
 */
export function sanitizeForTerminal(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control bytes is the intent.
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * OSC 8 terminal hyperlink. When enabled, emits
 * ESC ] 8 ; ; url ESC backslash text ESC ] 8 ; ; ESC backslash so modern
 * terminals make the text clickable; plain text otherwise.
 *
 * Defense-in-depth: both the label and the URL are sanitized of control bytes
 * so an untrusted payload can never terminate the sequence early. Trusted call
 * sites (internally-generated file:// paths) pass clean values already, so this
 * is a no-op for them.
 */
export function hyperlink(text: string, url: string, enabled: boolean): string {
  const safeText = sanitizeForTerminal(text);
  if (!enabled) return safeText;
  const safeUrl = sanitizeForTerminal(url);
  return `\u001b]8;;${safeUrl}\u001b\\${safeText}\u001b]8;;\u001b\\`;
}

/** file:// URL for an absolute path (handles Windows paths and encoding). */
export function fileUrl(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

/** Replace the home directory prefix with ~ for display. */
export function shortenHomePath(
  path: string,
  home: string | undefined = process.env.HOME,
): string {
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

export interface RunSummaryInput {
  succeeded: number;
  failed: number;
  pending: number;
  uniqueSources: number;
  totalCitations: number;
  outputDir: string;
  color: boolean;
  home?: string;
  /** Wall-clock duration of the whole dispatch, in milliseconds. */
  totalDurationMs?: number;
  /** API-reported cost across providers, when at least one reported it. */
  reportedCost?: { totalUsd: number; reporting: number; providers: number };
}

/** End-of-run summary block (returned as individual lines). */
export function formatRunSummary(input: RunSummaryInput): string[] {
  const lines: string[] = [''];
  const total =
    input.totalDurationMs === undefined
      ? ''
      : ` in ${formatDuration(input.totalDurationMs)}`;
  lines.push(
    paint(
      `  ${input.succeeded} succeeded, ${input.failed} failed, ${input.pending} async pending${total}`,
      ANSI.dim,
      input.color,
    ),
  );
  lines.push(
    `  ▸ ${input.uniqueSources} unique sources after dedupe (${input.totalCitations} total citations)`,
  );
  lines.push(
    `  ▸ ${hyperlink(
      `${shortenHomePath(input.outputDir, input.home)}/`,
      fileUrl(input.outputDir),
      input.color,
    )}`,
  );
  if (input.reportedCost && input.reportedCost.reporting > 0) {
    lines.push(
      `  ▸ reported cost: ${formatCost(input.reportedCost.totalUsd)} (${input.reportedCost.reporting} of ${input.reportedCost.providers} providers)`,
    );
  }
  if (input.pending > 0) {
    lines.push('');
    lines.push(
      paint(
        '  ◷ async tasks pending: run `librarium status --wait` to poll and retrieve',
        ANSI.yellow,
        input.color,
      ),
    );
  }
  return lines;
}
