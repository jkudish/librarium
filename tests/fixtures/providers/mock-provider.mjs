#!/usr/bin/env node
/**
 * Deterministic mock script provider for the PTY smoke suite.
 *
 * Implements librarium's script-provider protocol (see src/adapters/custom.ts):
 * a single JSON request envelope arrives on stdin, a single JSON response
 * envelope (`{ ok: true, data }` | `{ ok: false, error }`) is written to
 * stdout. One script serves as many distinct providers by reading its
 * behaviour from the `sourceOptions` block of the envelope, which librarium
 * forwards verbatim from `customProviders.<id>.options` in config.json.
 *
 * Supported sourceOptions:
 *   displayName : string  — provider display name (defaults to provider id)
 *   tier        : 'deep-research' | 'ai-grounded' | 'raw-search'
 *   content     : string  — markdown body returned by execute (default lorem)
 *   citations   : number  — how many synthetic citations to attach (default 2)
 *   delayMs     : number  — artificial latency before execute responds
 *   fail        : boolean — execute returns a structured error (drives fallback)
 *   error       : string  — the error message when fail is true
 *
 * Everything is synchronous and offline: no network, no clock dependence
 * beyond the optional fixed delay, so output is byte-stable across runs.
 */

import process from 'node:process';

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw));
  });
}

function respond(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCitations(providerId, count) {
  const citations = [];
  for (let i = 0; i < count; i += 1) {
    citations.push({
      url: `https://example.test/${providerId}/${i}`,
      title: `${providerId} source ${i}`,
      snippet: `Synthetic snippet ${i} from ${providerId}.`,
      provider: providerId,
    });
  }
  return citations;
}

async function main() {
  const raw = await readStdin();
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (error) {
    respond({ ok: false, error: `bad envelope: ${String(error)}` });
    return;
  }

  const { operation, providerId } = envelope;
  const options = envelope.sourceOptions ?? {};
  const tier = options.tier ?? 'ai-grounded';
  const displayName = options.displayName ?? providerId;

  if (operation === 'describe') {
    respond({
      ok: true,
      data: {
        id: providerId,
        displayName,
        tier,
        execution: 'inline',
        // Keyless: the mock never needs a credential, so canonical execution runs
        // it without any environment setup.
        requiresApiKey: false,
        capabilities: { execute: true, test: true },
      },
    });
    return;
  }

  if (operation === 'test') {
    respond({ ok: true, data: { ok: true } });
    return;
  }

  if (operation === 'execute') {
    if (options.delayMs) {
      await sleep(Number(options.delayMs));
    }

    if (options.fail) {
      // A structured error result (not a thrown exception) is what triggers
      // librarium's fallback path — mirrors a provider returning HTTP 401.
      respond({
        ok: true,
        data: {
          provider: providerId,
          tier,
          content: '',
          citations: [],
          durationMs: Number(options.delayMs ?? 0),
          error: options.error ?? 'mock provider failure',
        },
      });
      return;
    }

    const citationCount = Number(options.citations ?? 2);
    const content =
      options.content ??
      `# ${displayName}\n\nDeterministic mock answer from ${providerId}.\n\n` +
        Array.from(
          { length: 40 },
          (_, i) => `Paragraph line ${i} for ${providerId}.`,
        ).join('\n');

    respond({
      ok: true,
      data: {
        provider: providerId,
        tier,
        content,
        citations: buildCitations(providerId, citationCount),
        durationMs: Number(options.delayMs ?? 0),
        model: 'mock-model-1',
        tokenUsage: { input: 100, output: 200 },
      },
    });
    return;
  }

  respond({ ok: false, error: `unsupported operation: ${operation}` });
}

main().catch((error) => {
  respond({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
});
