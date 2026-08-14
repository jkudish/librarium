# Librarium terminal contract snapshots

`contracts/v1/` is the canonical offline, language-neutral **terminal**
snapshot. It publishes exactly seven values in one JSON Schema:
`ResearchResponse`, `ResearchResult`, `Citation`, `Source`,
`ResultProvenance`, `Usage`, and `ResearchError`.

This is intentionally smaller than the TypeScript runtime. It contains no
request, attempt, lifecycle event, durable handle, coordinator state,
persistence, manifest, JSONL, artifact, config, or custom-provider protocol.
Those boundaries change independently and must not be inferred from the PHP
or TypeScript terminal interchange. Every terminal response instead carries a
self-reported producer receipt: `generator` and `generator_version`.

The snapshot is generated from the Zod schemas with:

```sh
npm run contracts:generate
```

`manifest.json` describes only this snapshot and `checksums.sha256` pins every
file. A merged commit or tagged Git release is the authority for PHP vendoring:
consumers vendor the exact `contracts/v1/` directory from that reviewed Git
snapshot and verify the checksums. It is not an npm runtime contract.

All semantic objects are strict. Wire names are `snake_case`, timestamps are
RFC3339 UTC, and IDs are opaque strings. Citations embed their source. A source
`url` is a non-empty, untrusted string identifier: the shared contract does not
assert its scheme, reachability, safety to fetch, authority, or support for any
particular claim.

`provider_meta` is allowed only on `ResearchResult`, as a JSON-safe object with
multiple outer namespaces. It retains public key casing and value types, and it
has no legacy size or depth cap. It rejects obvious credentials, authorization,
password, token, secret, binary, and raw-provider-response fields. Schema
validation cannot identify semantically hidden secrets, so producers must
allowlist and redact metadata before emission.

TypeScript execution schemas and provider adapters remain outside the
PHP-vendored snapshot. PHP `run()` and `queue()` methods, Node persistence, and
every other language-specific public API are also outside it. For runtime
artifacts, use the TypeScript `ARTIFACTS_VERSION` contract (currently `1.0.0`)
and its separate artifact schemas. For custom provider execution, use the
separate strict `CUSTOM_PROVIDER_PROTOCOL_VERSION` (currently `1.0.0`). Neither
version changes the terminal snapshot by implication.
