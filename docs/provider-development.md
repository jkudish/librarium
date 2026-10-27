# Custom sources and RunStores

The public client speaks in source names and depths. Existing provider
adapters, pricing and coordinator code are private implementation details.
Do not expose selector identities or task handles in the public Run. The
website covers the same API in
[custom sources and RunStores](https://librarium.si/docs/custom-providers).

## Add a source to a client

Pass trusted provider instances to `createLibrarium({ customSources })`.
Each entry declares `id`, optional `name`, and `quick` and/or `deep`.
`engine: true` makes it named-only. Names must not conflict with built-ins.
Instances belong to the client, not a global registry.

An inline quick provider declares `execution: 'inline'` and implements `execute`.
Quick providers can also declare `execution: 'background'` and implement
`submit`, `poll`, and `retrieve` for durable work.
A deep provider declares `execution: 'background'` and implements `submit`,
`poll`, and `retrieve`; `execute` is its convenience wait path. The provider
must return normalized answers, citations, duration and any reported usage.
Unknown reported cost must remain absent. Never derive reported cost from a
price table. Declare `requiresApiKey: false` for a credential-free source.

Custom provider code is trusted executable code, not a sandbox. Do not load
an unreviewed module, spawn unreviewed scripts, or grant it access to secrets.
For built-ins, update `librarium-spec/sources.json` first and then map to the
existing exact adapter binding. Deep variants must have durable handles.

## Implement a RunStore

```ts
import type { RunStore, StoredRun, RunSummary } from 'librarium/core';
import { RunStoreConflict } from 'librarium/core';

class MyStore implements RunStore {
  async get(id: string): Promise<StoredRun | null> { /* ... */ return null; }
  async save(doc: StoredRun, expectedVersion: number | null): Promise<number> {
    // Atomically require the current version to equal expectedVersion.
    // null means the id must not exist; success returns the incremented version.
    throw new RunStoreConflict();
  }
  async list(opts?: { limit?: number; before?: string }): Promise<RunSummary[]> {
    // Newest first; before is a Run id for cursor paging.
    return [];
  }
  async delete(id: string): Promise<void> { /* idempotent */ }
}
```

Stores own atomic version checks, not credential redaction. Librarium redacts
evidence before calling `save`; use schema validation at your store boundary.
Return independent snapshots so callers cannot mutate stored data without a
versioned save.

```ts
import { createLibrarium } from 'librarium/core';
import { runStoreContract } from 'librarium/testing';

await runStoreContract(new MyStore()); // empty disposable store only
const client = createLibrarium({ config: { version: 3 }, store: new MyStore() });
```

CLI/MCP can load a module whose default export returns a store:

```json
{ "runs": { "store": { "module": "./stores/redis.js" } } }
```

The module executes with the process's permissions. Relative module paths
resolve from the config file's directory. It receives `runs` configuration.

## Filesystem interoperability

```text
<path>/<run_id>/run.json                  public Run only
<path>/<run_id>/state.json                { "version": N, "state": { ... } }
<path>/<run_id>/answers/<source>.md       Markdown
<path>/<run_id>/evidence/<source>.json    redacted evidence
```

Write `state.json` last. A missing version is invalid, not a legacy format.
The JS filesystem store locks reads and writes and performs atomic per-file
replacement. Concurrent mutations use CAS, and stale saves throw
`RunStoreConflict`. Cross-language readers share the public Run and files;
private execution state is language-owned.

For a runtime-neutral client with a persistent custom store, preserve its
`handleKey` (32 random bytes) outside the store across restarts. Node keeps its
key beside the config, in `run-signing.key`; it never goes into a StoredRun.
Tampered execution state fails before retrieval. Do not remove a lock file
until you have established that its owner has died.

## Verify offline

Run `npm run test:conformance`, `npm run test:workers`, and
`npm run test:declarations`. Built-in stores run the shared
contract and the filesystem store reads the normative shared fixture folder.
Provider transports must be injected in tests; live requests require separate
spending authorization.
