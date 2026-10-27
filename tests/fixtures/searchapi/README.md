# SearchAPI Google AI Overview fixtures

Copied from `jkudish/laravel-ai-librarium` `tests/Fixtures/SearchApi`
(commit `ea92b5c`, PR #54) so the TypeScript and PHP packages read the same
shapes. Only the JSON indentation differs.

Sanitized shapes observed from SearchAPI on 2026-10-04 (140 retained Google
AI Overview responses). Keys, nesting and link formats match the observed
responses; all answer text, titles, tokens and sites are synthetic.

- `google-inline-ai-overview.json`: the first `google` response carries the
  overview inline (10 of 140 observed). No second request is needed.
- `google-page-token.json`: the first response carries only `page_token`
  beside a misleading "not available" `error` (122 of 140); the second
  `google_ai_overview` request (`google-ai-overview-page.json`) loads it.
- `google-no-ai-overview.json`: no `ai_overview` key (5 of 140).

Every observed `reference_links[].link` was a Google redirect: `goto?url=`
with an opaque encrypted token (869 of 927 links), shopping/search links, or
a plain publisher URL. The publisher origin is available in the `favicon`
URL's `url` parameter.
