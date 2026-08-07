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

## Core vs CLI Boundary (v0.2.0+)

Librarium is consumable as a library via the `librarium/core` package export (see README "Library Usage"). The boundary matters for provider development:

- **Built-in adapters** live in core: they must stay runtime-portable -- fetch-based HTTP only, no `node:*` imports, no direct `process.env` access. API keys resolve through the injected `CredentialContext` (`BaseProvider.getApiKey(apiKeyRef, credentials)`); a workerd CI suite enforces this.
- **Custom npm and script providers** are CLI-only: they depend on Node module resolution and child processes and are loaded by the CLI's `node-registry`, never by core. Library consumers who need a custom provider implement the `Provider` interface directly and call `registerProvider()` at runtime.

## Provider Interface Contract

Your provider must match librarium's `Provider` shape:

- Required fields:
  - `id` (must equal the config key)
  - `displayName`
  - `tier` (`deep-research`, `ai-grounded`, `raw-search`, `llm`)
  - `envVar` (string, may be empty only when `requiresApiKey` is `false`)
  - `execution`: either `inline` or `background`
  - `execute(query, options)`
- `test()` is optional

Execution contracts are discriminated:

- `execution: "inline"` completes work in `execute()` and must not expose
  task lifecycle hooks.
- `execution: "background"` still implements `execute()` for synchronous
  callers, and must also implement all of `submit(query, options)`,
  `poll(handle)`, and `retrieve(handle)`. Librarium never accepts a partial
  background lifecycle.
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
    "execution": "inline",
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
- `execution` must be either `inline` or `background`
- `capabilities.execute` must be `true`
- Background scripts must declare `submit`, `poll`, and `retrieve` as `true`;
  inline scripts must not declare those hooks
- If `id` is returned, it must match the configured provider ID

### Operation Data Shapes

- `execute` and `retrieve`: `ProviderResult`
  - includes `provider`, `tier`, `content`, `citations`, `durationMs`
  - optionally `model`, `tokenUsage`, and `usage` (return `usage` to report cost/tokens -- see [Metering and Cost](#metering-and-cost))
- `submit`: `AsyncTaskHandle`
- `poll`: `AsyncPollResult`
- `test`: `{ ok: boolean; error?: string }`

All responses are validated. Invalid payloads fail the operation.

### Timeouts

- `execute`: uses `options.timeout` seconds (minimum 1s)
- `submit`: uses `options.timeout` seconds (minimum 1s)
- `describe`, `poll`, `test`: 30s default
- `retrieve`: 120s default

## Metering and Cost

Librarium tracks per-provider cost through a `metering` object on every result (`kind`, an optional pre-dispatch `estimate`, and an `actual` lane). How a provider participates depends on whether it is custom or built-in.

### Custom providers

- **Report cost via `usage`.** If your `execute`/`retrieve` `ProviderResult` includes a `usage` object with `costUsd` (and/or `inputTokens`/`outputTokens`/`totalTokens`), librarium surfaces it as `metering.actual` with `source: "provider_reported"`, counts it toward the reported-cost `--max-cost` budget, and aggregates it in `librarium usage`. This is taken from your response, never estimated.
- **Custom providers are `manual_unmetered`.** Metering *kind* and the network-free pre-dispatch *estimate* are a built-in registry concept (`src/core/metering.ts`). Custom providers have no registry entry, so their `metering.kind` is always `manual_unmetered`, they produce no estimate, and they reserve `0` against `--max-estimated-cost` (never skipped by it).

### Built-in adapters

A built-in adapter declares its pricing model in its provider descriptor. The metering kinds are: `native_cost`, `native_tokens`, `request_priced`, `credit_priced`, `api_unit_priced`, `manual_unmetered`. Request- and credit-priced kinds can carry a network-free default estimate (request-priced may include a flat USD figure; plan-dependent credit/unit kinds emit unit metadata only, with a USD figure appearing only when the user configures pricing via provider `options`). Estimates never set `usage.costUsd`.

## Adding a Built-in Adapter

Built-in adapters live in core and must stay runtime-portable (fetch-only HTTP, no `node:*`, no direct `process.env`; a workerd CI suite enforces this). Each built-in has one typed runtime descriptor composed from:

- `src/core/provider-descriptor.ts`: portable metadata, aliases, credential name, tier, display/catalog copy, default model, metering, option schema, and discriminated execution capabilities
- `src/adapters/provider-descriptors.ts`: the adapter factory for each metadata definition

Runtime registration, constants, aliases, onboarding catalog, and metering are derived from these descriptors. Default groups remain explicit product policy in `src/constants.ts`, but startup validation rejects unknown IDs, duplicates, tier mistakes, or a stale `all`/`llm` roster.

To add one:

1. **Adapter** -- `src/adapters/<id>.ts`, extending `BaseProvider` for inline execution or `BackgroundBaseProvider` for a complete remote-task lifecycle. Implement `execute` in both cases; background adapters also implement `submit`/`poll`/`retrieve`. Return `usage` when the API reports cost/tokens.
2. **Descriptor definition** -- add the portable metadata entry in `src/core/provider-descriptor.ts`, including its metering declaration and an appropriate Zod schema for the supported `options`.
3. **Factory** -- add the constructor mapping in `src/adapters/provider-descriptors.ts`. `initializeProviders()` validates configured options, constructs adapters from this descriptor list, and checks the runtime adapter matches its declared ID, tier, execution mode, display name, and credential. Invalid options warn but do not unregister the adapter: Librarium blocks new `execute`, `submit`, and `test` work before HTTP while retaining `poll`/`retrieve` for existing background tasks and preserving reserved built-in IDs.
4. **Group policy** -- place the canonical ID in the intended explicit groups in `src/constants.ts`. Every non-LLM built-in must appear in `all`; every LLM built-in must appear in `llm`.
5. **Core export** -- `export * from './adapters/<id>.js'` in `src/core-entry.ts`.
6. **README** -- bump the "N built-in provider adapters" count; the README-drift test (`tests/readme-drift.test.ts`) tripwires on the provider count, tiers, and group names.

Run `npm run test` (it includes the metering lockstep and README-drift guards) and `npm run test:workers` (the runtime-portability suite) before opening a PR.

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
