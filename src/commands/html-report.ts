import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Marked } from 'marked';
import { sanitizeId } from '../constants.js';
import { safeWriteFile } from '../core/fs-utils.js';
import type {
  DeduplicatedSource,
  ProviderReport,
  RunManifest,
} from '../types.js';
import { readRunEntry } from './browse-data.js';
import { formatDuration } from './run-format.js';

/**
 * Self-contained HTML report generator for a run directory.
 *
 * generateHtmlReport() is a pure function (manifest + file contents in,
 * HTML string out) so it stays unit-testable; writeHtmlReport() is the
 * filesystem wrapper used by `run --html`, `librarium html`, browse, and
 * status --retrieve regeneration.
 */

export interface HtmlReportInput {
  manifest: RunManifest;
  /** Provider markdown contents keyed by report outputFile. */
  providerContents: Record<string, string>;
  sources: DeduplicatedSource[];
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Markdown renderer that never passes raw HTML through (provider output is
 * untrusted) and adds rel="noopener" to external links.
 */
const markdown = new Marked({
  renderer: {
    html(token: { text: string }): string {
      return escapeHtml(token.text);
    },
    link(token: {
      href: string;
      title?: string | null;
      tokens: unknown;
    }): string {
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      // biome-ignore lint/suspicious/noExplicitAny: marked renderer this-binding
      const body = (this as any).parser.parseInline(token.tokens);
      return `<a href="${escapeHtml(token.href)}"${title} rel="noopener" target="_blank">${body}</a>`;
    },
  },
});

export function renderMarkdown(content: string): string {
  return markdown.parse(content, { async: false }) as string;
}

function glyphFor(report: ProviderReport): { glyph: string; cls: string } {
  switch (report.status) {
    case 'success':
      return { glyph: '&#10003;', cls: 'ok' }; // check mark
    case 'async-pending':
      return { glyph: '&#9711;', cls: 'pending' }; // large circle (clock-ish)
    case 'skipped':
      return { glyph: '-', cls: 'muted' };
    default:
      return { glyph: '&#10007;', cls: 'fail' }; // cross
  }
}

function countLabel(report: ProviderReport): string {
  if (report.status === 'async-pending') return 'submitted';
  if (report.status === 'skipped') return 'skipped';
  if (report.status === 'error') return report.error ? 'error' : 'error';
  const noun = report.tier === 'raw-search' ? 'results' : 'sources';
  return `${report.citationCount} ${noun}`;
}

function formatReportDate(timestampSeconds: number): string {
  const date = new Date(timestampSeconds * 1000);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function talliesLine(manifest: RunManifest): string {
  const ok = manifest.providers.filter((p) => p.status === 'success').length;
  const failed = manifest.providers.filter((p) => p.status === 'error').length;
  const pending = manifest.providers.filter(
    (p) => p.status === 'async-pending',
  ).length;
  return `${ok} succeeded, ${failed} failed, ${pending} async pending`;
}

function providerDetails(
  report: ProviderReport,
  content: string | undefined,
): string {
  const { glyph, cls } = glyphFor(report);
  const duration =
    report.status === 'async-pending' || report.status === 'skipped'
      ? ''
      : formatDuration(report.durationMs);
  const fallbackNote = report.fallbackFor
    ? `<span class="fallback">fallback for ${escapeHtml(report.fallbackFor)}</span>`
    : '';

  let body: string;
  if (report.status === 'async-pending') {
    body =
      '<p class="pending-note">Result not retrieved yet. Run <code>librarium status --wait</code> to poll and retrieve, then regenerate this report with <code>librarium html</code>.</p>';
  } else if (report.status === 'skipped') {
    body = `<p class="pending-note">Provider skipped: ${escapeHtml(report.error ?? 'not enabled')}.</p>`;
  } else if (report.status === 'error' && !content) {
    body = `<p class="error-note">${escapeHtml(report.error ?? 'unknown error')}</p>`;
  } else if (content !== undefined) {
    const errorBanner =
      report.status === 'error'
        ? `<p class="error-note">${escapeHtml(report.error ?? 'unknown error')}</p>`
        : '';
    body = `${errorBanner}${renderMarkdown(content)}`;
  } else {
    body =
      '<p class="pending-note">No output file found for this provider.</p>';
  }

  return `<details class="provider">
<summary>
<span class="glyph ${cls}">${glyph}</span>
<span class="pid">${escapeHtml(report.id)}</span>
<span class="tier">${escapeHtml(report.tier)}</span>
<span class="duration">${duration}</span>
<span class="count">${escapeHtml(countLabel(report))}</span>
${fallbackNote}
</summary>
<div class="provider-body">${body}</div>
</details>`;
}

function sourcesSection(sources: DeduplicatedSource[]): string {
  if (sources.length === 0) {
    return '<p class="pending-note">No sources recorded.</p>';
  }
  const items = sources
    .map((source) => {
      const label = source.title?.trim() || source.url;
      const cited = source.providers.length
        ? `<span class="cited">${escapeHtml(source.providers.join(', '))}</span>`
        : '';
      return `<li><a href="${escapeHtml(source.url)}" rel="noopener" target="_blank">${escapeHtml(label)}</a> ${cited}</li>`;
    })
    .join('\n');
  return `<ol class="sources">\n${items}\n</ol>`;
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #ffffff;
  color: #0a0a0a;
  font-family: 'Geist', system-ui, sans-serif;
  font-size: 16px;
  line-height: 1.65;
}
code, pre, .mono, .pid, .tier, .duration, .count, .wordmark, .eyebrow, .meta, .cited {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
}
header {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  padding: 1.25rem 2rem;
  border-bottom: 1px solid rgba(10, 10, 10, 0.1);
}
.wordmark { font-weight: 600; letter-spacing: -0.02em; }
header .meta { color: #525252; font-size: 0.8rem; }
main { max-width: 72ch; margin: 0 auto; padding: 3rem 1.5rem 5rem; }
h1 {
  font-size: 1.7rem;
  font-weight: 600;
  letter-spacing: -0.025em;
  line-height: 1.25;
  margin: 0.35rem 0 0.75rem;
}
h2, h3, h4 { font-weight: 600; letter-spacing: -0.02em; }
.eyebrow {
  color: #d97706;
  font-size: 0.72rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin: 0 0 0.25rem;
}
section { margin-top: 3rem; }
.meta { color: #525252; font-size: 0.85rem; }
a { color: #b45309; text-decoration: none; }
a:hover { text-decoration: underline; }
details.provider {
  border: 1px solid rgba(10, 10, 10, 0.1);
  border-radius: 10px;
  margin: 0.5rem 0;
  overflow: hidden;
}
details.provider summary {
  display: grid;
  grid-template-columns: 1.25rem minmax(11rem, max-content) 8.5rem 4rem 1fr;
  gap: 0.75rem;
  align-items: baseline;
  cursor: pointer;
  padding: 0.7rem 1rem;
  font-size: 0.85rem;
  list-style: none;
}
details.provider summary::-webkit-details-marker { display: none; }
details.provider[open] summary { border-bottom: 1px solid rgba(10, 10, 10, 0.1); }
.glyph.ok { color: #16a34a; }
.glyph.fail { color: #dc2626; }
.glyph.pending { color: #d97706; }
.glyph.muted, .tier, .duration { color: #525252; }
.count, .cited, .fallback { color: #525252; font-size: 0.8rem; }
.provider-body { padding: 0.25rem 1.25rem 1rem; font-size: 0.95rem; }
.provider-body img { max-width: 100%; }
pre {
  background: #0a0a0a;
  color: #fafafa;
  border-radius: 10px;
  padding: 1rem 1.25rem;
  overflow-x: auto;
  font-size: 0.85rem;
}
:not(pre) > code {
  background: rgba(10, 10, 10, 0.05);
  border-radius: 4px;
  padding: 0.1em 0.35em;
  font-size: 0.85em;
}
pre code { background: none; padding: 0; }
blockquote {
  border-left: 2px solid rgba(10, 10, 10, 0.1);
  margin: 1rem 0;
  padding-left: 1rem;
  color: #525252;
}
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { border: 1px solid rgba(10, 10, 10, 0.1); padding: 0.4rem 0.6rem; text-align: left; }
ol.sources { padding-left: 1.4rem; font-size: 0.9rem; }
ol.sources li { margin: 0.35rem 0; }
.error-note { color: #dc2626; font-size: 0.9rem; }
.pending-note { color: #525252; font-size: 0.9rem; }
footer {
  border-top: 1px solid rgba(10, 10, 10, 0.1);
  padding: 1.25rem 2rem;
  color: #525252;
  font-size: 0.78rem;
}
`;

/** Pure generator: manifest plus file contents in, full HTML document out. */
export function generateHtmlReport(input: HtmlReportInput): string {
  const { manifest, providerContents, sources } = input;
  const providerBlocks = manifest.providers
    .map((report) =>
      providerDetails(
        report,
        report.outputFile ? providerContents[report.outputFile] : undefined,
      ),
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(manifest.query)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${STYLE}</style>
</head>
<body>
<header>
<span class="wordmark">librarium</span>
<span class="meta">research report</span>
</header>
<main>
<p class="eyebrow">query</p>
<h1>${escapeHtml(manifest.query)}</h1>
<p class="meta">${escapeHtml(formatReportDate(manifest.timestamp))} &middot; mode ${escapeHtml(manifest.mode)} &middot; ${escapeHtml(talliesLine(manifest))}</p>
<section>
<p class="eyebrow">providers</p>
${providerBlocks}
</section>
<section>
<p class="eyebrow">sources</p>
<p class="meta">${sources.length} unique sources after dedupe (${manifest.sources.total} total citations)</p>
${sourcesSection(sources)}
</section>
</main>
<footer>generated by librarium</footer>
</body>
</html>
`;
}

/**
 * Async-pending reports whose results have since been retrieved (via
 * `status --wait`/`--retrieve`) have their .md and .meta.json on disk but
 * run.json still says pending. Overlay those so regenerated reports fill in.
 */
export function enrichRetrievedReports(
  runDir: string,
  reports: ProviderReport[],
): ProviderReport[] {
  return reports.map((report) => {
    if (report.status !== 'async-pending') return report;
    const safeId = sanitizeId(report.id);
    const outputFile = `${safeId}.md`;
    if (!existsSync(join(runDir, outputFile))) return report;
    let durationMs = 0;
    let citationCount = 0;
    try {
      const meta = JSON.parse(
        readFileSync(join(runDir, `${safeId}.meta.json`), 'utf-8'),
      ) as { durationMs?: number; citationCount?: number };
      durationMs = meta.durationMs ?? 0;
      citationCount = meta.citationCount ?? 0;
    } catch {
      // Meta is optional; the content alone is enough to render.
    }
    return {
      ...report,
      status: 'success' as const,
      outputFile,
      metaFile: `${safeId}.meta.json`,
      durationMs,
      citationCount,
    };
  });
}

/**
 * Build and write report.html for an existing run directory.
 * Returns the report path, or null when the directory has no run manifest.
 */
export function writeHtmlReport(runDir: string): string | null {
  const entry = readRunEntry(runDir);
  if (!entry) return null;
  entry.manifest.providers = enrichRetrievedReports(
    runDir,
    entry.manifest.providers,
  );

  const providerContents: Record<string, string> = {};
  for (const report of entry.manifest.providers) {
    if (!report.outputFile) continue;
    const filePath = join(runDir, report.outputFile);
    if (!existsSync(filePath)) continue;
    try {
      providerContents[report.outputFile] = readFileSync(filePath, 'utf-8');
    } catch {
      // Missing/unreadable provider files render as a note instead.
    }
  }

  let sources: DeduplicatedSource[] = [];
  const sourcesPath = join(runDir, 'sources.json');
  if (existsSync(sourcesPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(sourcesPath, 'utf-8'));
      if (Array.isArray(parsed)) sources = parsed as DeduplicatedSource[];
    } catch {
      // Corrupt sources.json degrades to an empty sources section.
    }
  }

  const html = generateHtmlReport({
    manifest: entry.manifest,
    providerContents,
    sources,
  });
  const reportPath = join(runDir, 'report.html');
  safeWriteFile(reportPath, html);
  return reportPath;
}
