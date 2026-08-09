# Librarium contract snapshots

`contracts/v1/` is the TypeScript Librarium repository's canonical, offline
contract snapshot. It contains four deliberately separate schema bundles:
domain leaves, TypeScript artifacts, the trusted custom-provider protocol, and
the narrow TypeScript/PHP interchange. `ResearchResponse` and `ResearchResult`
form its shared terminal envelope, including their approved nested domain leaves
such as citations, normalized sources, usage, errors, and provenance. Every
response carries its actual producer receipt (`generator` and
`generator_version`) and has only `succeeded`, `partial`, or `failed` status.

The snapshot is generated from the Zod 4 schemas under `src/contracts/` with:

```sh
npm run contracts:generate
```

The generator is deterministic. `manifest.json` identifies every schema and
semantic fixture, while `checksums.sha256` pins their exact bytes. JSON Schema
captures structural validation. The manifest's semantic rules and the shared
valid/invalid fixture corpus are also normative because ordering, bounded
extensions, cross-reference integrity, and preflight compatibility require
validation beyond JSON Schema alone.

## Ownership and the PHP boundary

TypeScript Librarium owns the upstream snapshot. PHP vendors an exact copy as a
development-only conformance dependency, records the upstream version and
checksum, and validates it without network access. PHP has no runtime dependency
on this package, its CLI artifacts, or Node. Updates are explicit reviewed
vendor changes; they are never regenerated silently in the PHP repository.

Versioned Git tags and GitHub releases are the canonical distribution channel
for this snapshot. Consumers vendor `contracts/v1/` from the matching repository
revision and verify `checksums.sha256`. The snapshot is intentionally excluded
from the npm package: npm remains the distribution channel for Librarium's
compiled TypeScript runtime, not the cross-language contract corpus.

Each implementation maps idiomatic runtime types losslessly to the wire
contract. Laravel DTOs, enums, events, exceptions, queues, and persistence stay
inside the PHP implementation. TypeScript runtime APIs and provider-native
payloads stay inside TypeScript and its adapters. Requests, slots, attempts,
durable handles, replacement chains, lifecycle events, and coordinator state
are TypeScript execution-only validation, never PHP parity payloads. Neither
language recursively case-converts `extensions`.

## Strictness and extensions

Semantic objects reject unknown fields. Wire fields and enum values use
`snake_case`; timestamps are RFC 3339 UTC strings; identifiers are opaque
strings. Provider-specific data is allowed only in bounded, namespaced,
JSON-safe `extensions`. Credentials, task secrets, headers, stack traces, binary
payloads, and unrestricted raw provider responses are forbidden.
Extension-key filtering catches obvious sensitive names, but producers remain
responsible for never placing secrets or raw payloads behind benign names.

HTTP(S) locators use an intentionally strict, language-neutral wire subset.
The scheme is literally lowercase `http://` or `https://`; the hostname is one
or more ASCII DNS-style labels without userinfo, IPv6, or IPvFuture syntax; and
an optional canonical decimal port is between 1 and 65535 with no leading zero.
An optional path, query, or fragment contains printable ASCII only and never a
backslash. Unicode hostnames use their ASCII form, and non-ASCII path data must
be percent-encoded before it crosses the contract boundary.
Validated citation and source URLs are untrusted identifiers only; validation
never authorizes fetching them.

Producer receipts are descriptive, self-reported package facts, not
cryptographic authentication. Trust-sensitive consumers compare them with
authenticated or out-of-band expectations. An `effective_target` reports
provider runtime resolution or routing; its kind matches the declared target
kind, but its ID need not equal a configured alias or target ID.

Surface context is descriptive and non-blocking by default. When a request adds
a `surface_context_constraint`, the profile must declare context and every
explicitly constrained field must match. Unconstrained unknown fields do not
affect eligibility or fallback compatibility.

Every surface observation identifies its measured `surface_id`. A
`surface_snapshot` is collected evidence and therefore uses a named
`surface_collector`; its fallbacks preserve the observation mode, collector
lane, and measured surface. Explicitly labelled first-party API proxy profiles
may instead use `api_output`, `model_only`, and `direct`. They are a separate
visibility comparison lane and cannot replace a snapshot slot.

The contract records evidence, source, correlation, and provenance facts. It
does not define a universal `verified` boolean, truth threshold, or source
independence rule.

Search-result profiles and requirements omit answer-grounding policy, and
search-results-only facts omit grounding outcome. Grounding fields remain
required for result kinds where those semantics apply.

Run manifests are storage-neutral envelopes containing only artifact identity,
generation time, producer identity and version, the complete normalized request
and response, and optional extensions. Lifecycle is a separate ordered event
stream keyed by `request_id`; the same event objects can be emitted as JSONL.
Attempts may carry usage and exact-decimal cost even when paid work fails,
times out, or is cancelled without returning a result.

For durable custom-provider work, `submitted` and `progress` responses carry
only nonterminal `pending` or `running` handles. A `poll` exchange reports task
completion with a small `status` response carrying a terminal `succeeded`,
`failed`, or `cancelled` handle; it does not carry the result itself. `retrieve`
remains the durable result-fetch exchange and accepts only a `succeeded` handle.
Optimistic retrieval is outside contract v1. Response request and attempt IDs
must match their request, and progress/status handles must preserve the polled
handle ID, public provider task ID, and provider identity.

Fallback attempts replace only failed or timed-out attempts whose structured
error explicitly permits fallback. Each fallback reserve candidate and provider
profile is consumed at most once across a run. Source artifacts require unique
source and citation identities, unique citation references within each source,
and references that resolve to an included citation.

`request_completed` lifecycle events use `succeeded`, `partial`, or
`unsuccessful`, matching the corresponding response status. Pure request
failure and cancellation remain distinct `request_failed` and
`request_cancelled` terminal events.

## Independent version policy

The domain, artifacts, custom-provider protocol, and interchange contract
families version independently, each beginning at `1.0.0`. A wire field, enum,
or semantic-validation change that can alter acceptance for an existing
consumer requires a major version. A backward-compatible addition may use a
minor version. Documentation, fixture coverage, or generator corrections that
preserve payload compatibility and meaning may use a patch version.

## Shared terminal boundary and TypeScript-internal types

`ResearchResponse` and `ResearchResult`, including their approved nested domain
leaves, are the shared runtime boundary. The table below is explicitly
TypeScript-internal migration guidance for adapter and execution schemas; it is
not a PHP parity map.

| Existing TypeScript name | TypeScript-internal schema destination |
| --- | --- |
| `Citation` | `Citation` |
| `ProviderUsage`, `ProviderMetering` | explicit mappers to `Usage`, `CostRecord` |
| `AsyncTaskHandle` | `DurableHandle` |
| `ProgressEvent` | `LifecycleEvent` |
| `ProviderResult` | `InterchangeResult` through an internal adapter mapper |
| `ProviderDispatchResult` | `Attempt` + `SlotOutcome` + `InterchangeResult` internally |
| `RunManifest`, `ProviderReport`, `DeduplicatedSource` | independently versioned artifact types |
| `ProviderTier` | no direct alias; replace with orthogonal `ExecutionProfile` facts |

Existing v1 adapter types and parsers remain authoritative until their explicit
migration. The contract foundation does not recursively transform
provider-native payloads or expose execution records across the shared
boundary.
