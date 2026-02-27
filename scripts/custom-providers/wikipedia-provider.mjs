#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const PROTOCOL_VERSION = 1;

function printError(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }));
}

function printData(data) {
  process.stdout.write(JSON.stringify({ ok: true, data }));
}

function buildMarkdown(query, items) {
  const lines = [`# Wikipedia Results`, '', `Query: ${query}`, ''];
  if (items.length === 0) {
    lines.push('No matching Wikipedia entries found.');
    return lines.join('\n');
  }

  lines.push('## Top Matches', '');
  for (const item of items) {
    lines.push(`- [${item.title}](${item.url})`);
    if (item.snippet) {
      lines.push(`  - ${item.snippet}`);
    }
  }
  return lines.join('\n');
}

async function execute(providerId, query) {
  const started = Date.now();
  const url =
    'https://en.wikipedia.org/w/api.php?action=opensearch&limit=5&namespace=0&format=json&search=' +
    encodeURIComponent(query);
  const response = await fetch(url, {
    headers: { 'user-agent': 'librarium-wikipedia-provider/1.0' },
  });
  if (!response.ok) {
    throw new Error(`Wikipedia API returned ${response.status}`);
  }

  const payload = await response.json();
  const titles = Array.isArray(payload?.[1]) ? payload[1] : [];
  const snippets = Array.isArray(payload?.[2]) ? payload[2] : [];
  const links = Array.isArray(payload?.[3]) ? payload[3] : [];
  const rows = [];
  for (let i = 0; i < Math.min(titles.length, links.length); i++) {
    rows.push({
      title: String(titles[i]),
      snippet: snippets[i] ? String(snippets[i]) : undefined,
      url: String(links[i]),
    });
  }

  return {
    provider: providerId,
    tier: 'raw-search',
    content: buildMarkdown(query, rows),
    citations: rows.map((row) => ({
      url: row.url,
      title: row.title,
      snippet: row.snippet,
      provider: providerId,
    })),
    durationMs: Date.now() - started,
    model: 'wikipedia-opensearch',
  };
}

async function main() {
  const raw = readFileSync(0, 'utf-8');
  const request = JSON.parse(raw || '{}');

  if (request.protocolVersion !== PROTOCOL_VERSION) {
    printError(`Unsupported protocolVersion: ${request.protocolVersion}`);
    return;
  }

  const providerId = String(request.providerId || 'wikipedia-script');
  const operation = request.operation;

  if (operation === 'describe') {
    printData({
      id: providerId,
      displayName: 'Wikipedia Script Provider',
      tier: 'raw-search',
      envVar: '',
      requiresApiKey: false,
      capabilities: {
        execute: true,
        test: true,
      },
    });
    return;
  }

  if (operation === 'test') {
    try {
      await execute(providerId, 'OpenAI');
      printData({ ok: true });
    } catch (error) {
      printData({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (operation === 'execute') {
    const query = String(request.query || '').trim();
    if (!query) {
      printError('Missing query');
      return;
    }
    const result = await execute(providerId, query);
    printData(result);
    return;
  }

  printError(`Unsupported operation: ${operation}`);
}

main().catch((error) => {
  printError(error instanceof Error ? error.message : String(error));
});
