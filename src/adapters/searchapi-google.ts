import type { Citation } from '../types.js';

export interface SearchApiGoogleOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
}

export interface SearchApiGoogleReferenceLink {
  index?: number;
  title?: string;
  name?: string;
  link?: string;
  snippet?: string;
  source?: string;
}

export interface SearchApiGoogleTextBlock {
  type?: string;
  answer?: string;
  items?: SearchApiGoogleTextBlock[];
}

export interface SearchApiGoogleAiOverview {
  /** A short-lived token reserved for the dedicated AI Overview provider. */
  page_token?: string;
  markdown?: string;
  text_blocks?: SearchApiGoogleTextBlock[];
  reference_links?: SearchApiGoogleReferenceLink[];
}

export interface SearchApiGoogleResult {
  title?: string;
  link?: string;
  snippet?: string;
  source?: string;
  date?: string;
  posts?: string;
  channel?: string;
  author?: string;
  length?: string;
}

export interface SearchApiGoogleKnowledgeGraph {
  source?: SearchApiGoogleReferenceLink;
  sources?: SearchApiGoogleReferenceLink[];
}

/** Reusable response shape for the one-call Google SearchAPI endpoint. */
export interface SearchApiGoogleResponse {
  organic_results?: SearchApiGoogleOrganicResult[];
  ai_overview?: SearchApiGoogleAiOverview;
  top_stories?: SearchApiGoogleResult[];
  discussions_and_forums?: SearchApiGoogleResult[];
  inline_videos?: SearchApiGoogleResult[];
  knowledge_graph?: SearchApiGoogleKnowledgeGraph;
  search_information?: { total_results?: number };
  error?: unknown;
}

export interface SearchApiGoogleSection {
  content: string;
  citations: Citation[];
}

/** Extract a usable opaque token without normalizing or mutating it. */
export function extractSearchApiGoogleAiOverviewPageToken(
  overview: unknown,
): string | undefined {
  const token = string(object(overview)?.page_token);
  return token && token.trim() === token ? token : undefined;
}

interface SearchApiGoogleLinkItem {
  title?: string;
  name?: string;
  link?: string;
  snippet?: string;
  source?: string;
  date?: string;
  posts?: string;
  channel?: string;
  author?: string;
  length?: string;
}

/**
 * Preserve the historic organic renderer, then append evidence-bearing Google
 * blocks in stable response order. The general provider deliberately only
 * parses ai_overview.page_token; it never makes a second request with it.
 */
export function renderSearchApiGoogleResponse(
  data: SearchApiGoogleResponse,
  provider: string,
): SearchApiGoogleSection {
  const organicResults = records(data.organic_results);
  const organic = renderOrganicResults(organicResults);
  const sections = [
    extractSearchApiGoogleAiOverview(data.ai_overview, provider),
    extractSearchApiGoogleTopStories(data.top_stories, provider),
    extractSearchApiGoogleDiscussions(data.discussions_and_forums, provider),
    extractSearchApiGoogleInlineVideos(data.inline_videos, provider),
    extractSearchApiGoogleKnowledgeGraphSources(data.knowledge_graph, provider),
  ].filter((section) => section.content.length > 0);

  if (sections.length === 0) {
    return {
      content: organic,
      citations: deduplicateCitations(
        organicResults.map((result) => citationFrom(result, provider)),
      ),
    };
  }

  return {
    content:
      organicResults.length === 0
        ? sections.map((section) => section.content).join('\n\n')
        : `${organic}\n${sections.map((section) => section.content).join('\n\n')}`,
    citations: deduplicateCitations([
      ...organicResults.map((result) => citationFrom(result, provider)),
      ...sections.flatMap((section) => section.citations),
    ]),
  };
}

export function extractSearchApiGoogleAiOverview(
  overview: unknown,
  provider: string,
): SearchApiGoogleSection {
  const record = object(overview);
  if (!record) return emptySection();

  const markdown = string(record.markdown)?.trim();
  const text = markdown || renderTextBlocks(record.text_blocks);
  if (!text) return emptySection();

  return {
    content: `## AI Overview\n\n${text}`,
    citations: deduplicateCitations(
      records(record.reference_links).map((link) =>
        citationFrom(link, provider),
      ),
    ),
  };
}

export function extractSearchApiGoogleTopStories(
  stories: unknown,
  provider: string,
): SearchApiGoogleSection {
  return extractLinkedSection('Top Stories', stories, provider, (item) =>
    metadata(item.source, item.date),
  );
}

export function extractSearchApiGoogleDiscussions(
  discussions: unknown,
  provider: string,
): SearchApiGoogleSection {
  return extractLinkedSection(
    'Discussions & Forums',
    discussions,
    provider,
    (item) => metadata(item.source, item.date, item.posts),
  );
}

export function extractSearchApiGoogleInlineVideos(
  videos: unknown,
  provider: string,
): SearchApiGoogleSection {
  return extractLinkedSection('Inline Videos', videos, provider, (item) =>
    metadata(item.source, item.channel ?? item.author, item.date, item.length),
  );
}

export function extractSearchApiGoogleKnowledgeGraphSources(
  knowledgeGraph: unknown,
  provider: string,
): SearchApiGoogleSection {
  const record = object(knowledgeGraph);
  if (!record) return emptySection();

  const sources = [...records(record.source), ...records(record.sources)];
  return extractLinkedSection(
    'Knowledge Graph Sources',
    sources,
    provider,
    () => '',
  );
}

function renderOrganicResults(results: Record<string, unknown>[]): string {
  if (results.length === 0) return 'No results found.';

  const parts: string[] = [];
  for (const result of results) {
    const title = string(result.title) ?? 'Untitled';
    const link = string(result.link) ?? '';
    parts.push(`### [${title}](${link})`);
    const snippet = string(result.snippet);
    if (snippet) parts.push(snippet);
    parts.push('');
  }
  return parts.join('\n');
}

function extractLinkedSection(
  heading: string,
  items: unknown,
  provider: string,
  describe: (item: SearchApiGoogleLinkItem) => string,
): SearchApiGoogleSection {
  const entries = records(items)
    .map((item) => {
      const citation = citationFrom(item, provider);
      if (!citation) return undefined;
      const itemShape: SearchApiGoogleLinkItem = {
        title: string(item.title),
        name: string(item.name),
        link: citation.url,
        snippet: string(item.snippet),
        source: string(item.source),
        date: string(item.date),
        posts: string(item.posts),
        channel: string(item.channel),
        author: string(item.author),
        length: string(item.length),
      };
      const title = itemShape.title ?? itemShape.name ?? 'Untitled';
      const suffix = describe(itemShape);
      return {
        line: `- [${title}](${citation.url})${suffix ? ` — ${suffix}` : ''}`,
        citation,
      };
    })
    .filter(
      (entry): entry is { line: string; citation: Citation } =>
        entry !== undefined,
    );

  if (entries.length === 0) return emptySection();
  return {
    content: `## ${heading}\n\n${entries.map((entry) => entry.line).join('\n')}`,
    citations: deduplicateCitations(entries.map((entry) => entry.citation)),
  };
}

function renderTextBlocks(blocks: unknown): string {
  const rendered = records(blocks)
    .map((block) => renderTextBlock(block))
    .filter(
      (block): block is string => typeof block === 'string' && block.length > 0,
    );
  return rendered.join('\n\n');
}

function renderTextBlock(block: Record<string, unknown>): string | undefined {
  const answer = string(block.answer)?.trim();
  const items = records(block.items);
  const type = string(block.type);

  if (type === 'header' && answer) return `### ${answer}`;
  if (type === 'unordered_list' || type === 'ordered_list') {
    const renderedItems = items
      .map((item) => renderTextBlock(item))
      .filter((item): item is string => Boolean(item))
      .map((item, index) =>
        type === 'ordered_list' ? `${index + 1}. ${item}` : `- ${item}`,
      );
    return renderedItems.join('\n') || answer;
  }
  return answer;
}

function citationFrom(
  item: Record<string, unknown>,
  provider: string,
): Citation | undefined {
  const url = validEvidenceUrl(string(item.link));
  if (!url) return undefined;
  return {
    url,
    title: string(item.title) ?? string(item.name),
    snippet: string(item.snippet),
    provider,
  };
}

function validEvidenceUrl(value: string | undefined): string | undefined {
  if (!value || value.trim() !== value) return undefined;
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      isProviderOrNavigationHost(url.hostname)
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function isProviderOrNavigationHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'searchapi.io' ||
    host.endsWith('.searchapi.io') ||
    host === 'googleusercontent.com' ||
    host.endsWith('.googleusercontent.com') ||
    /(^|\.)google\.[a-z.]+$/.test(host)
  );
}

function deduplicateCitations(
  citations: Array<Citation | undefined>,
): Citation[] {
  const seen = new Set<string>();
  return citations.filter((citation): citation is Citation => {
    if (!citation) return false;
    const key = new URL(citation.url).href;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function metadata(...values: Array<string | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).join(' · ');
}

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value))
    return value.flatMap((item) => (object(item) ? [item] : []));
  const record = object(value);
  return record ? [record] : [];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function emptySection(): SearchApiGoogleSection {
  return { content: '', citations: [] };
}
