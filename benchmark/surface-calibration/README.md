# SearchAPI ↔ Firecrawl consumer-surface calibration

This is a small, versioned calibration lane for PlanMode #2593. It compares the
SearchAPI ChatGPT collector with Firecrawl's anonymous ChatGPT web interaction
through the shipped PHP `Librarium` facade. The Node benchmark invokes those PHP
paths as trusted script providers; it does not copy driver internals or call the
provider APIs directly.

The lane is deliberately scoped to one comparable surface pair and three
identity/structure-sensitive prompts. It is not a generic benchmark corpus, a
collector selector, a scheduler, or production policy.

## Immutable dependencies and context

- `jkudish/laravel-ai-librarium` at
  `cd390f2c1d6c6d9913d6043c2ee8f05a14653aca`
- `jkudish/laravel-ai-librarium-firecrawl` at
  `6b7b390282107c1c21816e5bdc505fd713d14621`
- SearchAPI profile: `searchapi-chatgpt`
- Firecrawl profile: `firecrawl-chatgpt`, anonymous `interact` against
  `https://chatgpt.com/`, desktop/en-CA/CA, signed out, personalization unknown

SearchAPI's account, personalization, locale, country, and device context remain
unknown; this lane does not infer that its collected consumer surface is signed
out or unpersonalized.

`composer.lock` is authoritative for the transitive PHP dependency graph.
Install it with PHP 8.3+ and Composer 2 before running either PHP target. The
two `jkudish` packages require GitHub access; provide Composer GitHub OAuth via
the operator's credential manager without writing a token into this directory:

```sh
COMPOSER_AUTH="$(jq -nc --arg token "$(gh auth token)" '{"github-oauth":{"github.com":$token}}')" \
  composer install --working-dir benchmark/surface-calibration --no-interaction
```

## Offline verification

Strict synthetic fixtures prove orchestration, normalized artifact retention,
hard failures, individual measures, overlap, and role-policy reporting. Fixture
mode validates the exact corpus matrix before creating output and has no live
fallback. Fixtures are not current provider evidence:

```sh
npm run benchmark:surface:fixture
npm run test -- tests/surface-calibration.test.ts
php benchmark/surface-calibration/provider.php <<<'{"protocolVersion":1,"operation":"describe","providerId":"php-searchapi-chatgpt","sourceOptions":{"collector":"searchapi","surface":"chatgpt"}}'
```

## Paid-call gate

Do not run without fresh approval. The dry run is network-free and prints the
exact corpus, immutable PHP revisions, credentials by name/availability, call
counts, timeouts, zero-retry rule, mixed-unit worst-case spend, and stop
conditions:

```sh
npm run build
npm run benchmark:surface -- --dry-run
```

After explicit approval, an operator with `SEARCHAPI_API_KEY`,
`FIRECRAWL_API_KEY`, and `OPENAI_API_KEY` may run:

```sh
npm run benchmark:surface
```

The command is sequential and requires an interactive `RUN` confirmation. It
stops on the first provider/interface failure, hard output failure, blocking
challenge/login wall, or judge/artifact validation failure. There are no
retries or fallbacks. A live run writes a fingerprinted confirmation receipt
before dispatch and persists each bounded normalized collector observation as
soon as it succeeds, so a later collector hard stop does not erase completed
reference evidence. Firecrawl operation receipts and credits are retained only
after strict enum and integer allowlisting; the reusable benchmark's
intermediate run directory is removed after parsing.

## Measures and recommendation

Every case retains usable completion, hard failures, entity correctness,
structural correctness, material semantic divergence, exact URL overlap,
source-host overlap, latency, USD/credit cost, and challenge/login-wall
behavior. Collector, requested/effective profile, surface, declared context,
bounded output, citations, and safe receipts remain attached.

No aggregate score is produced. If the candidate has no hard failures and no
material divergence, the report marks Firecrawl only as **eligible for manual
review** for the routine role in this exact context; SearchAPI remains the
reference role. Recalibrate after provider/interface/surface changes,
challenge/login-wall changes, quality or structure failures, citation drift,
disputes, or an operator request. Scheduling and promotion remain outside this
repository.
