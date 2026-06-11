---
title: Library usage
description: Use librarium/core as an embeddable library in Workers, edge runtimes, and Node.js.
order: 6
---

## librarium/core

Everything the CLI does with providers is importable. The `librarium/core` entry exposes the adapters, registry, dispatcher, normalizer, and types. It returns results in memory. Writing `run.json` and report files is a CLI concern; the core has no opinion about persistence.

The core entry has zero Node-only dependencies: no `node:fs`, no `process.env` access, fetch-based HTTP only. It is tested in workerd (Cloudflare's runtime) on every CI run.

```bash
npm install librarium
```

```ts
import { dispatch, initializeProviders, type Config } from 'librarium/core';

// Credentials are injected -- core never reads process.env itself.
// Pass an env map (Workers: pass your `env` binding) or a resolveCredential fn.
const credentials = { env: { GEMINI_API_KEY: '...', OPENROUTER_API_KEY: '...' } };

await initializeProviders({ credentials });

const config: Config = {
  version: 1,
  defaults: { outputDir: '', maxParallel: 4, timeout: 60, asyncTimeout: 600, asyncPollInterval: 5, mode: 'sync' },
  providers: {
    'gemini-grounded': { enabled: true },
    'openrouter-online': { enabled: true },
  },
  customProviders: {},
  trustedProviderIds: [],
  groups: {},
};

const { results, asyncTasks } = await dispatch({
  config,
  providerIds: ['gemini-grounded', 'openrouter-online'],
  query: 'What is the best wholesale produce supplier in London?',
  mode: 'sync',
  credentials,
});

for (const r of results) {
  // { provider, tier, status, text, sourceUrls, citations, durationMs,
  //   model, tokenUsage, error, fallbackFor }
  console.log(r.provider, r.status, r.sourceUrls);
}
```

## Key notes

**Credential injection.** `CredentialContext` is `{ env?: Record<string, string | undefined>, resolveCredential?: (value: string) => string | undefined }`. `$ENV_VAR` references in provider config resolve against the injected `env`; literal keys pass through. In the CLI, this is backed by `process.env`. In a Worker, pass your env binding.

**Custom providers are CLI-only.** npm and script-based custom providers require Node (module resolution, child processes) and live behind the CLI boundary. The core registry contains the built-in adapters. You can add your own at runtime with `registerProvider()`.

**Async deep-research from the library.** `dispatch` with `mode: 'async'` or `'mixed'` returns `asyncTasks` handles. Polling and retrieval are the caller's responsibility. In the CLI, `librarium status` handles this.

**Bring your own persistence.** Core returns data. Where it goes (D1, R2, files, or nowhere) is up to you.
