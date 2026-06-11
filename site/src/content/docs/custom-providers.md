---
title: Custom providers
description: Build and register custom npm or script providers for librarium.
order: 7
---

## Overview

Librarium supports external providers without changing core code. Add definitions to your config and trust them explicitly. Custom providers support two source types: `npm` (load a module from the project or runtime install context) and `script` (spawn a command per operation and exchange JSON over stdin/stdout).

## Trust model

- Custom providers load only when their ID appears in `trustedProviderIds`.
- Trust lists from global and project config are unioned and deduped.
- Built-in IDs are reserved. Custom providers cannot override built-ins.

## Core vs CLI boundary

Built-in adapters live in core: they must stay runtime-portable. Fetch-based HTTP only, no `node:*` imports, no direct `process.env` access.

Custom npm and script providers are CLI-only. They depend on Node module resolution and child processes and are loaded by the CLI's node-registry, never by core. Library consumers who need a custom provider implement the `Provider` interface directly and call `registerProvider()` at runtime.

## Provider interface contract

Your provider must match librarium's `Provider` shape.

Required fields:

- `id` (must equal the config key)
- `displayName`
- `tier` (`deep-research`, `ai-grounded`, or `raw-search`)
- `envVar` (string; may be empty only when `requiresApiKey` is `false`)
- `execute(query, options)`

Optional methods:

- `submit(query, options)`
- `poll(handle)`
- `retrieve(handle)`
- `test()`

Optional metadata:

- `requiresApiKey` (defaults to `true`)

If `requiresApiKey` is `true`, empty `envVar` is rejected. `source` is set by librarium (`npm` or `script`).

## NPM providers

### Config example

```json
{
  "customProviders": {
    "my-npm-provider": {
      "type": "npm",
      "module": "librarium-provider-myteam",
      "export": "createProvider",
      "options": { "preset": "fast" }
    }
  },
  "trustedProviderIds": ["my-npm-provider"],
  "providers": {
    "my-npm-provider": {
      "enabled": true,
      "apiKey": "$MY_PROVIDER_API_KEY"
    }
  }
}
```

### Module resolution order

1. Current project (`process.cwd()` context)
2. Librarium runtime install context

In standalone and Homebrew binary installs, npm custom providers are skipped with a warning.

### Export patterns

You can export either a provider object or a factory function returning a provider object. The factory function receives:

```ts
{
  id: string;
  config?: ProviderConfig;
  sourceOptions: Record<string, unknown>;
}
```

`sourceOptions` is `customProviders.<id>.options`.

## Script providers

### Config example

```json
{
  "customProviders": {
    "my-script-provider": {
      "type": "script",
      "command": "node",
      "args": ["./scripts/librarium-provider.mjs"],
      "cwd": ".",
      "env": { "LOG_LEVEL": "warn" },
      "options": { "flavor": "deep" }
    }
  },
  "trustedProviderIds": ["my-script-provider"],
  "providers": {
    "my-script-provider": {
      "enabled": true
    }
  }
}
```

### Execution model

Librarium spawns one process per operation: `describe`, `execute`, `submit`, `poll`, `retrieve`, `test`.

Process settings:

- stdin: one JSON request envelope
- stdout: one JSON response envelope
- stderr: optional debug/error text
- env: `process.env` merged with `customProviders.<id>.env`
- cwd: resolved relative to current working directory if set; otherwise uses current working directory

### Request envelope

```json
{
  "protocolVersion": 1,
  "operation": "execute",
  "providerId": "my-script-provider",
  "query": "research topic",
  "options": { "timeout": 30 },
  "providerConfig": { "enabled": true },
  "sourceOptions": { "flavor": "deep" }
}
```

### Response envelopes

Success:

```json
{
  "ok": true,
  "data": {
    "provider": "my-script-provider",
    "tier": "ai-grounded",
    "content": "# Result",
    "citations": [],
    "durationMs": 1200
  }
}
```

Error:

```json
{
  "ok": false,
  "error": "upstream timeout"
}
```

### `describe` response

`describe` must return provider metadata and capabilities:

```json
{
  "ok": true,
  "data": {
    "id": "my-script-provider",
    "displayName": "My Script Provider",
    "tier": "deep-research",
    "envVar": "MY_PROVIDER_API_KEY",
    "requiresApiKey": true,
    "capabilities": {
      "execute": true,
      "submit": true,
      "poll": true,
      "retrieve": true,
      "test": true
    }
  }
}
```

Rules:

- `displayName` and `tier` are required.
- `execute` is expected. If `capabilities.execute` is explicitly `false`, load fails.
- If `id` is returned, it must match the configured provider ID.

### Operation data shapes

- `execute` and `retrieve`: `ProviderResult` (includes `provider`, `tier`, `content`, `citations`, `durationMs`).
- `submit`: `AsyncTaskHandle`.
- `poll`: `AsyncPollResult`.
- `test`: `{ ok: boolean; error?: string }`.

All responses are validated. Invalid payloads fail the operation.

### Timeouts

- `execute`: uses `options.timeout` seconds (minimum 1s).
- `submit`: uses `options.timeout` seconds (minimum 1s).
- `describe`, `poll`, `test`: 30s default.
- `retrieve`: 120s default.

## Error handling

| Symptom | Cause | Fix |
|---|---|---|
| `not trusted` warning | ID missing from `trustedProviderIds` | Add provider ID to trust list |
| `conflicts with a built-in` warning | Custom ID matches built-in ID | Rename custom provider ID |
| `Cannot resolve npm module` | Module not installed in project/runtime | Install package or fix `module` name |
| `describe id ... does not match` | Script reported different ID | Return matching ID or omit `id` |
| `returned invalid JSON` | Script wrote non-JSON to stdout | Write only one JSON envelope to stdout |
| `returned invalid ... payload` | Shape mismatch for operation data | Return correct schema for that operation |
| `timed out` | Operation exceeded timeout | Optimize provider or raise timeout for execute/submit |
