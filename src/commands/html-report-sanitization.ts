import { Marked } from 'marked';

/** Escape untrusted text before placing it in report HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Only allow link schemes that cannot execute code when the report is opened
 * from file:// (provider output and citation URLs are untrusted).
 */
export function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (
    !trimmed ||
    Array.from(trimmed).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 || character === '\\';
    })
  )
    return null;
  if (/^\/\//.test(trimmed)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'mailto:'
      ? trimmed
      : null;
  } catch {
    return null;
  }
}

/**
 * Markdown renderer that never passes raw HTML through (provider output is
 * untrusted), rejects unsafe link schemes, and adds rel="noopener" to
 * external links.
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
      const body = (this as any).parser.parseInline(token.tokens);
      const href = safeUrl(token.href);
      if (href === null) return `<span${title}>${body}</span>`;
      return `<a href="${escapeHtml(href)}"${title} rel="noopener" target="_blank">${body}</a>`;
    },
  },
});

export function renderMarkdown(content: string): string {
  return markdown.parse(content, { async: false }) as string;
}

/**
 * Strip answer.md's echoed heading and Sources appendix. The returned markdown
 * stays untrusted and must still flow through renderMarkdown().
 */
export function answerBody(content: string): string {
  let body = content.replace(/\r\n/g, '\n');
  body = body.replace(/^\s*#[^\S\n]+[^\n]*\n+/, '');
  body = body.replace(/\n#{1,6}[^\S\n]+Sources\b[\s\S]*$/i, '\n');
  return body.trim();
}
