import type { Citation } from '../types.js';

/** The shared answer envelope returned by SearchAPI consumer AI engines. */
export interface SearchApiAiResponse {
  markdown?: unknown;
  text_blocks?: unknown;
  reference_links?: unknown;
  response_metadata?: {
    model?: unknown;
  };
  error?: unknown;
}

export interface NormalizedSearchApiAiAnswer {
  content: string;
  citations: Citation[];
}

/**
 * Normalize the documented SearchAPI answer fields without retaining the raw
 * response. Markdown is preferred when usable; structured text blocks provide
 * a deterministic fallback for incomplete or malformed Markdown.
 */
export function normalizeSearchApiAiAnswer(
  response: unknown,
  provider: string,
): NormalizedSearchApiAiAnswer {
  const data = isRecord(response) ? response : {};
  const markdown = usableMarkdown(data.markdown);
  return {
    content: markdown ?? renderSearchApiTextBlocks(data.text_blocks),
    citations: normalizeSearchApiReferenceLinks(data.reference_links, provider),
  };
}

export function searchApiAiResponseError(response: unknown): unknown {
  return isRecord(response) ? response.error : undefined;
}

export function searchApiAiResponseModel(
  response: unknown,
): string | undefined {
  if (!isRecord(response) || !isRecord(response.response_metadata)) {
    return undefined;
  }
  return text(response.response_metadata.model);
}

export function renderSearchApiTextBlocks(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .flatMap((block) => renderBlock(block))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function normalizeSearchApiReferenceLinks(
  value: unknown,
  provider: string,
): Citation[] {
  if (!Array.isArray(value)) return [];

  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const url = validExternalUrl(item.url ?? item.link ?? item.href);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    citations.push({
      url,
      title: text(item.title ?? item.name),
      snippet: text(item.snippet ?? item.description),
      provider,
    });
  }
  return citations;
}

function usableMarkdown(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const markdown = value.trim();
  if (!markdown || containsDisallowedControlCharacter(markdown)) {
    return undefined;
  }
  return hasCompleteMarkdownLinks(markdown) ? markdown : undefined;
}

function containsDisallowedControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127
    ) {
      return true;
    }
  }
  return false;
}

function hasCompleteMarkdownLinks(markdown: string): boolean {
  for (let cursor = 0; cursor < markdown.length; cursor += 1) {
    if (markdown[cursor] !== '[' || markdown[cursor - 1] === '\\') continue;
    const labelEnd = markdown.indexOf('](', cursor + 1);
    if (labelEnd === -1) continue;

    let depth = 1;
    let closed = false;
    for (let index = labelEnd + 2; index < markdown.length; index += 1) {
      if (markdown[index] === '\\') {
        index += 1;
      } else if (markdown[index] === '(') {
        depth += 1;
      } else if (markdown[index] === ')' && --depth === 0) {
        closed = true;
        cursor = index;
        break;
      }
    }
    if (!closed) return false;
  }
  return true;
}

function renderBlock(value: unknown, depth = 0): string[] {
  if (!isRecord(value) || typeof value.type !== 'string') return [];
  const blockType = value.type;
  const body = text(value.text ?? value.content) ?? '';
  const children = childBlocks(value);

  switch (blockType) {
    case 'text':
    case 'paragraph':
      return appendChildren(body ? [body] : [], children, depth);
    case 'heading': {
      const level = boundedHeadingLevel(value.level);
      return appendChildren(
        body ? [`${'#'.repeat(level)} ${body}`] : [],
        children,
        depth,
      );
    }
    case 'quote':
      return appendChildren(body ? [`> ${body}`] : [], children, depth);
    case 'code':
      return appendChildren(
        body ? [`\`\`\`\n${body}\n\`\`\``] : [],
        children,
        depth,
      );
    case 'list':
    case 'ordered_list': {
      const ordered = blockType === 'ordered_list';
      const items = children.flatMap((child, index) =>
        renderListItem(child, depth, ordered ? index + 1 : undefined),
      );
      return items;
    }
    case 'list_item':
    case 'item':
      return renderListItem(value, depth);
    default:
      return [];
  }
}

function appendChildren(
  rendered: string[],
  children: unknown[],
  depth: number,
): string[] {
  return [
    ...rendered,
    ...children.flatMap((child) => renderBlock(child, depth + 1)),
  ];
}

function renderListItem(
  value: unknown,
  depth: number,
  index?: number,
): string[] {
  if (!isRecord(value)) return [];
  const body = text(value.text ?? value.content) ?? '';
  const prefix = `${'  '.repeat(depth)}${index === undefined ? '-' : `${index}.`} `;
  const rendered = body ? [`${prefix}${body}`] : [];
  return appendChildren(rendered, childBlocks(value), depth + 1);
}

function childBlocks(value: Record<string, unknown>): unknown[] {
  const children = value.children ?? value.blocks ?? value.items;
  return Array.isArray(children) ? children : [];
}

function boundedHeadingLevel(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(Math.max(value, 1), 6)
    : 2;
}

function validExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
