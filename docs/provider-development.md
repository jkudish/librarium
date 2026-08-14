# Provider development for Librarium v2

Librarium v2 selects a public **profile**, not an adapter class. A profile key
is `provider_id/profile_id`; the Node adapter binding that executes it is
private. Start by deciding the evidence and execution facts that a result can
truthfully carry. Do not add a marketing capability that the adapter cannot
prove.

## Declare a profile

Add a catalog entry in `src/core/provider-profiles.ts`. An implemented profile
needs one exact binding in `src/core/profile-bindings.ts`; tests reject a
missing, duplicate, or orphan binding.

The declaration records only stable capability facts:

- identity: provider ID, profile ID, and selected/provider-managed target;
- result kind, corpus, retrieval method, access and observation modes;
- operator and, for collected consumer surfaces, collector, surface, and
  unknown context;
- `inline` or `background` invocation and `none`, `process_local`, or
  `durable` resumability;
- optional proven features such as web search, JSON-schema output, or exact
  profile remote cancellation.

It must not claim runtime success, citations, correctness, a cost, independent
corroboration, a timestamp, or a particular account’s consumer experience.
Those facts belong in a result’s provenance and usage records after execution.

## Execution contract

An inline profile executes once and has `resumability: "none"`.

A `background/durable` profile has a cross-process durable handle. A
`background/process-local` profile may submit and finish only while its local
owner survives. More specifically, a background profile is either:

- `process_local`: it may submit and finish while its local owner survives, but
  must not be documented as a cross-process durable job; or
- `durable`: it has a `DurableHandle` containing an opaque local handle ID,
  public provider task ID, exact provider identity, timestamps, and status.

Durable work follows `submit` → `poll` → `retrieve`:

1. `submit` returns a non-terminal handle (`pending` or `running`).
2. `poll` returns progress or a terminal handle. It does not invent a result.
3. `retrieve` accepts only a successful durable handle and returns the terminal
   result.

Do not add a cancel method unless the exact profile can perform remote
cancellation. Otherwise validation and recovery must use `reconcile_only`.
The current catalog advertises exact-profile remote cancellation only for
`valyu/research`.

## Custom providers

The v2 configuration accepts an npm or script source and can include an
`execution_profile` declaration:

```json
{
  "type": "npm",
  "module": "@acme/librarium-provider",
  "execution_profile": {
    "binding_id": "acme.search.v1",
    "profile": {
      "identity": {
        "provider_id": "acme",
        "profile_id": "search",
        "target": { "primary": { "model_selection": "not_applicable" } }
      },
      "result_kind": "search_results",
      "observation_mode": "api_output",
      "corpora": ["web"],
      "retrieval_method": "search_endpoint",
      "access_mode": "direct",
      "operator_id": "acme",
      "invocation": "inline",
      "resumability": "none"
    }
  }
}
```

Custom code loads only when its public provider ID appears in
`trusted_provider_ids`. This is an allowlist, not isolation. npm modules and
scripts can execute arbitrary code with the calling process permissions and
environment. Never treat it as a sandbox or grant trust during automatic
migration.

The custom-provider wire protocol is `1.0.0`. It uses strict JSON envelopes
for `execute`, `submit`, `poll`, and `retrieve`. An inline `execute` request
requires an inline profile; `submit` requires a durable background profile;
`retrieve` requires a successful handle. Responses must preserve matching
request and attempt IDs. Validate every exchange with the exported schemas
before admitting it.

## Collection and provenance

For direct API output, set `access_mode: "direct"` and identify the API
operator. For a consumer surface obtained through another collector, use
`access_mode: "collected"`, `observation_mode: "surface_snapshot"`,
`retrieval_method: "surface_collector"`, and name both the collector and
surface. Unknown account and personalization context must remain `unknown`.

Do not describe a collected consumer observation as an official vendor API, a
logged-in-user result, or independent corroboration. Several profiles can
share one collector; their agreement is correlated evidence unless their
provenance says otherwise.

## Price, credentials, and options

Use the descriptor’s credential family. Never expose an API key, durable
resume credential, authorization value, raw response, or secret-shaped field
in public metadata. `provider_meta` is for allowlisted, public JSON-safe data;
the schema rejects obvious credential and raw-response names but cannot detect
every hidden secret.

Expose a pre-dispatch estimate only when the reviewed pricing definition makes
it exact. Unknown, token-priced, API-unit, and account-specific prices are not
zero. Validate model and option overrides before adapter construction. A bad
configuration blocks new `execute`, `submit`, and `test` work before HTTP but
must leave safe `poll` and `retrieve` available for existing durable work.

## Required checks

Run the focused catalog/config/custom-provider tests and the Worker suite. A
catalog change also needs the public documentation drift test because the
README roster and workflow facts are intentionally checked against source.

```bash
npm test -- --run tests/provider-catalog.test.ts tests/config-v2.test.ts tests/custom-providers.test.ts tests/public-documentation-drift.test.ts
npm run test:workers
```
