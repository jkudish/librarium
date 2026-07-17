# Contributing benchmark questions

Question changes are reviewed like code. Synthetic question generation is not
part of benchmark v1.

For every new question:

1. Choose a stable ID prefixed with `stable-` or `live-`.
2. Add category (`factual-lookup`, `technical-versioned`, `comparison`,
   `multi-hop`, or `freshness-sensitive`) and difficulty (`easy`, `medium`, or
   `hard`).
3. Record at least one canonical expected answer plus accepted aliases when
   wording, spelling, units, dates, or abbreviations can vary.
4. Break the answer into independently checkable required facts. Give each fact
   a stable ID, precise text, and accepted paraphrase aliases.
5. Add supporting evidence with an HTTP(S) URL, title, publisher, and the short
   evidence proposition the source supports. Prefer primary or authoritative
   sources and do not paste long copyrighted excerpts.
6. Set realistic latency and cost budgets. Unknown provider cost stays unknown;
   do not encode it as zero.
7. For live questions, add cadence, last validation, expiry, named validator,
   and exact revalidation instructions. Update expected facts and evidence when
   revalidating; do not only bump dates.
8. Run `npm run benchmark:validate`, `npm run benchmark:ci`, and the unit suite.

Pull requests need maintainer validation of the answer, aliases, required facts,
and every supporting source. The maintainer should also verify that the question
does not duplicate the corpus, leak provider-specific phrasing, or require
unsupported precision. New or materially changed questions must not be used in
a published comparison until that review is complete.

The stable track must remain between 25 and 30 questions and the live track
between 10 and 15. Preserve category/difficulty balance; replace or consolidate
questions before exceeding those bounds.
