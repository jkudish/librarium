import type { ProviderReport, ProviderTier } from '../types.js';

/**
 * Pure formatting helpers for the `librarium run` live results table.
 * No I/O here — everything returns strings so it stays trivially testable.
 */

const ANSI = {
  reset: '\u001b[0m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  dim: '\u001b[2m',
} as const;

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
  const duration = formatDuration(report.durationMs).padStart(7);
  const fallbackSuffix = report.fallbackFor
    ? `   ${paint(`(fallback for ${report.fallbackFor})`, ANSI.dim, color)}`
    : '';

  switch (report.status) {
    case 'success': {
      const glyph = paint('✓', ANSI.green, color);
      return `  ${glyph} ${id}   ${tier}   ${duration}   ${citationLabel(report)}${fallbackSuffix}`;
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

/** Indented notice printed when a failed primary triggers its fallback. */
export function formatFallbackNotice(
  fallbackId: string,
  color: boolean,
): string {
  return `    ${paint(`↳ falling back to ${fallbackId}`, ANSI.yellow, color)}`;
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
}

/** End-of-run summary block (returned as individual lines). */
export function formatRunSummary(input: RunSummaryInput): string[] {
  const lines: string[] = [''];
  lines.push(
    paint(
      `  ${input.succeeded} succeeded, ${input.failed} failed, ${input.pending} async pending`,
      ANSI.dim,
      input.color,
    ),
  );
  lines.push(
    `  ▸ ${input.uniqueSources} unique sources after dedupe (${input.totalCitations} total citations)`,
  );
  lines.push(`  ▸ ${shortenHomePath(input.outputDir, input.home)}/`);
  if (input.pending > 0) {
    lines.push('');
    lines.push(
      paint(
        '  ◷ async tasks pending — run `librarium status --wait` to poll and retrieve',
        ANSI.yellow,
        input.color,
      ),
    );
  }
  return lines;
}
