#!/usr/bin/env node
/**
 * Deterministic, free driver for the README demo GIF.
 *
 * HOW IT STAYS HONEST: this imports the real built CLI (dist/cli.js) and runs a
 * real `librarium run`. The live fan-out table, provider adapters, dedupe, and
 * summary are all the genuine code path. The ONLY thing replaced is
 * `globalThis.fetch`: it returns canned, schema-valid responses per provider
 * host with plausible latencies and citation counts, and makes tavily return a
 * 401 so the real fallback-to-jina path fires. No table rows are hand-authored;
 * the CLI renders everything from these mocked responses. Output format = real,
 * API calls = mocked.
 *
 * Run via build-demo-home.mjs first to seed the isolated HOME, then:
 *   HOME=<demo-home> node demo-run.mjs
 */

import { setTimeout as delay } from 'node:timers/promises';

// Dummy keys so the real adapters consider themselves configured; the stub
// fetch never inspects them.
for (const k of [
  'PERPLEXITY_API_KEY',
  'GEMINI_API_KEY',
  'EXA_API_KEY',
  'BRAVE_API_KEY',
  'TAVILY_API_KEY',
  'JINA_AI_API_KEY',
]) {
  process.env[k] = process.env[k] || 'demo-key';
}

const ORIGIN = 'https://example.test';

function urls(provider, n, offset = 0) {
  // Overlapping host pool so dedupe has something to merge (representative of a
  // real run where providers cite some of the same canonical sources).
  const hosts = [
    'postgresql.org/docs/current/runtime-config-connection',
    'pgbouncer.org/config.html',
    'wiki.postgresql.org/wiki/Number_Of_Database_Connections',
    'aws.amazon.com/blogs/database/connection-pooling',
    'crunchydata.com/blog/pgbouncer-pooling',
    'enterprisedb.com/blog/connection-pooling',
    'pgpool.net/docs/latest/en/html',
    'percona.com/blog/postgres-pooling',
  ];
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = (offset + i) % hosts.length;
    // First few of each provider reuse the shared pool (overlap -> dedupe);
    // the rest are provider-unique so the unique count stays realistic.
    if (i < 4) out.push(`https://${hosts[idx]}`);
    else out.push(`${ORIGIN}/${provider}/${i}`);
  }
  return out;
}

const ANSWER = `# PostgreSQL connection pooling best practices

Connection pooling keeps a fixed set of database connections open and shares
them across clients, avoiding the cost of spawning a backend process per query.
Use transaction-mode pooling (e.g. PgBouncer) for the highest client density,
size the pool near (2 x cores) + effective spindle count, and measure under
load before tuning further.`;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Per-host canned responses. Latencies are applied by the stub to mimic the
// real relative speeds shown in the README transcript.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;

  // Perplexity Sonar Pro -- chat/completions, citations[] (12)
  if (url.includes('api.perplexity.ai')) {
    await delay(2100);
    return jsonResponse({
      id: 'demo',
      model: 'sonar-pro',
      choices: [{ message: { role: 'assistant', content: ANSWER } }],
      citations: urls('perplexity', 12, 0),
      usage: { prompt_tokens: 120, completion_tokens: 480, total_tokens: 600 },
    });
  }

  // Gemini grounded -- candidates[].groundingMetadata.groundingChunks (9)
  if (url.includes('generativelanguage.googleapis.com')) {
    await delay(3400);
    return jsonResponse({
      candidates: [
        {
          content: { parts: [{ text: ANSWER }] },
          groundingMetadata: {
            groundingChunks: urls('gemini', 9, 1).map((u) => ({
              web: { uri: u, title: 'PostgreSQL pooling' },
            })),
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 110,
        candidatesTokenCount: 420,
        totalTokenCount: 530,
      },
    });
  }

  // Exa -- results[] (25)
  if (url.includes('api.exa.ai')) {
    await delay(1800);
    return jsonResponse({
      requestId: 'demo',
      results: urls('exa', 25, 2).map((u, i) => ({
        url: u,
        title: `Source ${i}`,
        text: 'Connection pooling overview and tuning guidance.',
      })),
    });
  }

  // Brave web search -- web.results[] (20)
  if (url.includes('api.search.brave.com')) {
    await delay(900);
    return jsonResponse({
      web: {
        results: urls('brave', 20, 3).map((u, i) => ({
          url: u,
          title: `Result ${i}`,
          description: 'Pooling reference.',
        })),
      },
    });
  }

  // Tavily -- fail with 401 to drive the real fallback to jina-search.
  if (url.includes('api.tavily.com')) {
    await delay(400);
    return jsonResponse(
      { detail: { error: 'Unauthorized: missing or invalid API key.' } },
      401,
    );
  }

  // Jina (fallback) -- data[] (8)
  if (url.includes('s.jina.ai')) {
    await delay(700);
    return jsonResponse({
      code: 200,
      status: 200,
      data: urls('jina', 8, 4).map((u, i) => ({
        url: u,
        title: `Doc ${i}`,
        content: 'Pooling notes.',
      })),
    });
  }

  return realFetch(input, init);
};

// Drive the real CLI.
process.argv = [
  process.argv[0],
  'librarium',
  'run',
  'postgres connection pooling best practices',
  '-g',
  'demo',
];

await import('../../dist/cli.js');
