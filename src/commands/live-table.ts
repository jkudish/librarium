import type { ProviderReport, ProviderTier } from '../types.js';
import {
  formatFallbackNotice,
  formatPendingLine,
  formatProviderLine,
  type LineWidths,
  truncateAnsi,
} from './run-format.js';

/**
 * In-place (resolve-as-they-finish) renderer for the `librarium run` table.
 *
 * All provider rows are printed up front with an animated spinner glyph,
 * then each row is rewritten in place as its provider resolves. The whole
 * block is re-rendered on every update (cursor up N, clear line, rewrite),
 * which keeps fallback-row insertion trivial. Rows are truncated to the
 * terminal width so wrapped lines never break the cursor math.
 *
 * Only used when the pretty stream is a TTY and color is enabled; non-TTY
 * and NO_COLOR environments keep the append-on-completion output.
 */

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL_MS = 80;
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';

interface ProviderRow {
  kind: 'provider';
  id: string;
  tier: ProviderTier;
  fallbackFor?: string;
  startedAt?: number;
  resolvedLine?: string;
}

interface NoticeRow {
  kind: 'notice';
  text: string;
}

type Row = ProviderRow | NoticeRow;

interface LiveStream {
  write(chunk: string): unknown;
  columns?: number;
}

export class LiveRunTable {
  private rows: Row[] = [];
  private renderedLines = 0;
  private timer: NodeJS.Timeout | undefined;
  private frameIndex = 0;
  private active = false;
  private readonly restoreCursorOnExit = (): void => {
    if (this.active) this.stream.write(SHOW_CURSOR);
  };

  constructor(
    private readonly stream: LiveStream,
    private readonly widths: LineWidths,
    private readonly color: boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** Register a provider row (call once per primary before start()). */
  addProvider(id: string, tier: ProviderTier): void {
    this.rows.push({ kind: 'provider', id, tier });
  }

  /** Print the initial block and start the spinner animation. */
  start(): void {
    this.active = true;
    this.stream.write(HIDE_CURSOR);
    process.once('exit', this.restoreCursorOnExit);
    this.render();
    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      this.render();
    }, FRAME_INTERVAL_MS);
  }

  /** Mark a provider as actually running (starts its elapsed ticker). */
  markStarted(id: string): void {
    const row = this.findPending(id);
    if (row) row.startedAt = this.now();
    this.render();
  }

  /** Insert the fallback notice and a pending fallback row under the failed primary. */
  addFallback(primaryId: string, fallbackId: string, tier: ProviderTier): void {
    const index = this.rows.findIndex(
      (row) =>
        row.kind === 'provider' && row.id === primaryId && !row.fallbackFor,
    );
    const notice: NoticeRow = {
      kind: 'notice',
      text: formatFallbackNotice(fallbackId, this.color),
    };
    const fallbackRow: ProviderRow = {
      kind: 'provider',
      id: fallbackId,
      tier,
      fallbackFor: primaryId,
      startedAt: this.now(),
    };
    if (index === -1) {
      this.rows.push(notice, fallbackRow);
    } else {
      this.rows.splice(index + 1, 0, notice, fallbackRow);
    }
    this.render();
  }

  /** Resolve a provider row with its final report line. */
  resolve(report: ProviderReport): void {
    const row = this.rows.find(
      (candidate): candidate is ProviderRow =>
        candidate.kind === 'provider' &&
        candidate.id === report.id &&
        (candidate.fallbackFor ?? null) === (report.fallbackFor ?? null) &&
        candidate.resolvedLine === undefined,
    );
    const line = formatProviderLine(report, this.widths, this.color);
    if (row) {
      row.resolvedLine = line;
    } else {
      this.rows.push({
        kind: 'provider',
        id: report.id,
        tier: report.tier,
        fallbackFor: report.fallbackFor,
        resolvedLine: line,
      });
    }
    this.render();
  }

  /**
   * Resolve any rows that never received a progress event (e.g. skipped
   * providers) from the final reports. Call before stop().
   */
  resolveRemaining(reports: ProviderReport[]): void {
    for (const row of this.rows) {
      if (row.kind !== 'provider' || row.resolvedLine !== undefined) continue;
      const report = reports.find(
        (candidate) =>
          candidate.id === row.id &&
          (candidate.fallbackFor ?? null) === (row.fallbackFor ?? null),
      );
      if (report) {
        row.resolvedLine = formatProviderLine(report, this.widths, this.color);
      }
    }
    this.render();
  }

  /** Stop the animation and leave the final block printed. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.render();
    this.stream.write(SHOW_CURSOR);
    this.active = false;
    process.removeListener('exit', this.restoreCursorOnExit);
  }

  private findPending(id: string): ProviderRow | undefined {
    return this.rows.find(
      (row): row is ProviderRow =>
        row.kind === 'provider' &&
        row.id === id &&
        row.resolvedLine === undefined,
    );
  }

  private lineFor(row: Row): string {
    if (row.kind === 'notice') return row.text;
    if (row.resolvedLine !== undefined) return row.resolvedLine;
    const frame = SPINNER_FRAMES[this.frameIndex] as string;
    const elapsed =
      row.startedAt === undefined ? undefined : this.now() - row.startedAt;
    return formatPendingLine(
      row.id,
      row.tier,
      this.widths,
      this.color,
      frame,
      elapsed,
    );
  }

  private render(): void {
    const maxWidth = Math.max(20, (this.stream.columns ?? 80) - 1);
    let out = '';
    if (this.renderedLines > 0) {
      out += `\u001b[${this.renderedLines}A`;
    }
    for (const row of this.rows) {
      out += `\u001b[2K${truncateAnsi(this.lineFor(row), maxWidth)}\n`;
    }
    this.stream.write(out);
    this.renderedLines = this.rows.length;
  }
}
