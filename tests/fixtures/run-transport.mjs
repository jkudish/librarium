// Test-only provider responses. No socket is opened; all other requests fail.
import { readFileSync, writeFileSync } from 'node:fs';
import { installNetworkGuard } from '../../benchmark/lib/guard.mjs';

installNetworkGuard();
globalThis.fetch = async (url, options) => {
  const uri = String(url);
  const marker = `${process.env.HOME}/calls.json`;
  let calls = [];
  try {
    calls = JSON.parse(readFileSync(marker, 'utf8'));
  } catch {}
  calls.push({ url: uri, method: options?.method ?? 'GET' });
  writeFileSync(marker, JSON.stringify(calls));
  await new Promise((resolve) =>
    setTimeout(resolve, Number(process.env.FIXTURE_DELAY ?? 0)),
  );
  if (uri === 'https://kagi.com/api/v0/fastgpt')
    return Response.json({
      data: {
        output:
          process.env.FIXTURE_ANSWER ??
          'Canberra is the capital city of Australia.',
        references: [{ url: 'https://example.org/capital', title: 'Capital' }],
      },
    });
  if (uri.startsWith('https://api.exa.ai/agent/runs')) {
    const done =
      options?.method !== 'POST' && process.env.FIXTURE_COMPLETE === 'true';
    return Response.json({
      id: 'agent_run_offline',
      object: 'agent_run',
      status: done ? 'completed' : 'running',
      createdAt: new Date().toISOString(),
      completedAt: done ? new Date().toISOString() : null,
      output: {
        text: done ? 'Durable offline findings' : '',
        structured: null,
        grounding: [
          {
            citations: [
              { url: 'https://example.org/deep', title: 'Deep evidence' },
            ],
          },
        ],
      },
      usage: {},
      ...(done && { costDollars: { total: 0.74184 } }),
    });
  }
  throw new Error(`Unexpected offline request: ${uri}`);
};
