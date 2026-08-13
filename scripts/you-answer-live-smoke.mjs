const enabled = process.env.LIBRARIUM_YOU_ANSWER_LIVE_SMOKE === '1';

if (!enabled) {
  console.error(
    'Refusing a paid You.com Answer smoke request. Set LIBRARIUM_YOU_ANSWER_LIVE_SMOKE=1 to opt in.',
  );
  process.exitCode = 1;
} else {
  const apiKey = process.env.YOU_COM_API_KEY;
  const query =
    process.env.YOU_ANSWER_SMOKE_QUERY ?? 'What is the capital of Canada?';

  if (!apiKey) {
    throw new Error('YOU_COM_API_KEY is required for the opted-in smoke request.');
  }
  if (!/\S/.test(query) || query.length > 400) {
    throw new Error('YOU_ANSWER_SMOKE_QUERY must be nonblank and at most 400 characters.');
  }

  const startedAt = performance.now();
  const response = await fetch('https://api.you.com/v1/answer', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({ query }),
  });
  const data = await response.json().catch(() => undefined);
  const answer = typeof data?.answer === 'string' ? data.answer : '';

  if (!response.ok || !/\S/.test(answer)) {
    // Do not print a provider body: it can contain request or account details.
    throw new Error(`You.com Answer smoke request failed with HTTP ${response.status}.`);
  }

  const citations = Array.isArray(data.citations) ? data.citations : [];
  const considered = Array.isArray(data.results?.web) ? data.results.web : [];
  const inlineReferences = Array.from(answer.matchAll(/\[\[([\d\s,]+)\]\]/g))
    .map((match) => match[1].split(',').filter((value) => value.trim()).length)
    .reduce((total, count) => total + count, 0);

  console.log(
    JSON.stringify({
      provider: 'you-answer',
      status: response.status,
      duration_ms: Math.round(performance.now() - startedAt),
      answer_length: answer.length,
      citation_count: citations.length,
      considered_web_result_count: considered.length,
      inline_citation_count: inlineReferences,
    }),
  );
}
