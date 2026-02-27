# Provider Development Guide

This guide documents the implementation-level contract for custom providers in librarium.

Use this when you are authoring a provider package or script, not just configuring one.

## Scope

Custom providers support two source types:

- `npm`: load a module from the project or runtime install context
- `script`: spawn a command per operation and exchange JSON over stdin/stdout

## Config Model

Custom providers are configured in `~/.config/librarium/config.json` and/or `.librarium.json`.

```json
{
  "customProviders": {
    "my-provider": {
      "type": "script",
      "command": "node",
      "args": ["./scripts/provider.mjs"]
    }
  },
  "trustedProviderIds": ["my-provider"],
  "providers": {
    "my-provider": {
      "enabled": true
    }
  }
}
```

Load rules:

- Provider ID must be present in `trustedProviderIds`
- Built-in IDs are reserved and cannot be overridden
- Project and global configs merge; project `customProviders` override same IDs from global

## Provider Interface Contract

Your provider must match librarium's `Provider` shape:

- Required fields:
  - `id` (must equal the config key)
  - `displayName`
  - `tier` (`deep-research`, `ai-grounded`, `raw-search`)
  - `envVar` (string, may be empty only when `requiresApiKey` is `false`)
  - `execute(query, options)`
- Optional methods:
  - `submit(query, options)`
  - `poll(handle)`
  - `retrieve(handle)`
  - `test()`
- Optional metadata:
  - `requiresApiKey` (defaults to `true`)

Notes:

- If `requiresApiKey` is `true`, empty `envVar` is rejected.
- `source` is set by librarium (`npm` or `script`).

## NPM Providers

### Resolution Order

`module` is resolved in this order:

1. Current project (`process.cwd()` context)
2. Librarium runtime install context

In standalone/Homebrew install modes, npm custom providers are skipped with a warning.

### Export Patterns

You can export either:

- A provider object
- A factory function returning a provider object

Factory function receives:

```ts
{
  id: string;
  config?: ProviderConfig;
  sourceOptions: Record<string, unknown>;
}
```

`sourceOptions` is `customProviders.<id>.options`.

## Script Providers

### Execution Model

Librarium spawns one process per operation:

- `describe`
- `execute`
- `submit`
- `poll`
- `retrieve`
- `test`

Process settings:

- stdin: one JSON request envelope
- stdout: one JSON response envelope
- stderr: optional debug/error text
- env: `process.env` merged with `customProviders.<id>.env`
- cwd:
  - if `cwd` is set, it is resolved relative to current working directory
  - otherwise uses current working directory

### Request Envelope

```json
{
  "protocolVersion": 1,
  "operation": "execute",
  "providerId": "my-provider",
  "query": "topic",
  "options": { "timeout": 30 },
  "providerConfig": { "enabled": true },
  "sourceOptions": {}
}
```

### Response Envelope

Success:

```json
{
  "ok": true,
  "data": {}
}
```

Failure:

```json
{
  "ok": false,
  "error": "message"
}
```

### `describe` Response

`describe` must return provider metadata and capabilities.

```json
{
  "ok": true,
  "data": {
    "id": "my-provider",
    "displayName": "My Provider",
    "tier": "raw-search",
    "envVar": "MY_PROVIDER_API_KEY",
    "requiresApiKey": true,
    "capabilities": {
      "execute": true,
      "submit": false,
      "poll": false,
      "retrieve": false,
      "test": true
    }
  }
}
```

Rules:

- `displayName` and `tier` are required
- `execute` is expected; if `capabilities.execute` is explicitly `false`, load fails
- If `id` is returned, it must match the configured provider ID

### Operation Data Shapes

- `execute` and `retrieve`: `ProviderResult`
  - includes `provider`, `tier`, `content`, `citations`, `durationMs`
- `submit`: `AsyncTaskHandle`
- `poll`: `AsyncPollResult`
- `test`: `{ ok: boolean; error?: string }`

All responses are validated. Invalid payloads fail the operation.

### Timeouts

- `execute`: uses `options.timeout` seconds (minimum 1s)
- `submit`: uses `options.timeout` seconds (minimum 1s)
- `describe`, `poll`, `test`: 30s default
- `retrieve`: 120s default

## Error Handling and Loading Behavior

- Untrusted provider ID: skipped with warning
- Built-in ID collision: skipped with warning
- Module resolution failure: skipped with warning
- Script startup / JSON parse / schema validation failure: skipped with warning or operation failure
- Script `ok: false`: surfaced as operation error

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `not trusted` warning | ID missing from `trustedProviderIds` | Add provider ID to trust list |
| `conflicts with a built-in` warning | Custom ID matches built-in ID | Rename custom provider ID |
| `Cannot resolve npm module` | Module not installed in project/runtime | Install package or fix `module` name |
| `describe id ... does not match` | Script reported different ID | Return matching ID or omit `id` |
| `returned invalid JSON` | Script wrote non-JSON to stdout | Write only one JSON envelope to stdout |
| `returned invalid ... payload` | Shape mismatch for operation data | Return correct schema for that operation |
| `timed out` | Operation exceeded timeout | Optimize provider or raise timeout for execute/submit |

