import type {
  HttpStreamClient,
  HttpStreamResponse,
} from '../../src/core/http-client.js';

const encoder = new TextEncoder();

export const PRO_SEARCH_CONTENT = 'Split Pro Search content 😀.';

export const PRO_SEARCH_USAGE = {
  prompt_tokens: 11,
  completion_tokens: 7,
  total_tokens: 18,
  cost: {
    input_tokens_cost: 0.000033,
    output_tokens_cost: 0.000105,
    request_cost: 0.014,
    total_cost: 0.014138,
  },
};

export function event(payload: unknown, type?: string): string {
  return `${type ? `event: ${type}\n` : ''}data: ${
    typeof payload === 'string' ? payload : JSON.stringify(payload)
  }\n\n`;
}

export function completeProSearchEvents(): string[] {
  return [
    event({
      id: 'synthetic-pro-search',
      model: 'sonar-pro',
      object: 'chat.reasoning',
      metadata: { search_type: 'pro' },
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: { reasoning_steps: [{ type: 'web_search' }] },
        },
      ],
    }),
    event({
      id: 'synthetic-pro-search',
      model: 'sonar-pro',
      object: 'chat.reasoning.done',
      search_type: 'pro',
      choices: [
        {
          index: 0,
          finish_reason: null,
          message: { role: 'assistant', content: '' },
          delta: { role: 'assistant', content: '' },
        },
      ],
      // Partial metadata is deliberately present here. The adapter must use
      // terminal metadata once instead of accumulating this intermediate copy.
      search_results: [
        {
          title: 'Intermediate duplicate',
          url: 'https://example.test/ignored-intermediate',
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 0, total_tokens: 11 },
    }),
    event({
      id: 'synthetic-pro-search',
      model: 'sonar-pro',
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: { role: 'assistant', content: 'Split Pro ' },
        },
      ],
    }),
    event({
      id: 'synthetic-pro-search',
      model: 'sonar-pro',
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: { content: 'Search content 😀.' },
        },
      ],
    }),
    event({
      id: 'synthetic-pro-search',
      model: 'sonar-pro',
      object: 'chat.completion.done',
      search_type: 'pro',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: PRO_SEARCH_CONTENT },
          delta: { role: 'assistant', content: '' },
        },
      ],
      search_results: [
        {
          title: 'Primary source',
          url: 'https://example.test/primary',
          snippet: 'Synthetic primary evidence.',
        },
        {
          title: 'Malformed source',
          url: 'javascript:alert(1)',
        },
      ],
      citations: [
        'https://example.test/primary',
        'https://example.test/citation-only',
      ],
      usage: PRO_SEARCH_USAGE,
    }),
    event('[DONE]'),
  ];
}

export function streamFromStrings(
  chunks: string[],
): ReadableStream<Uint8Array> {
  return streamFromBytes(chunks.map((chunk) => encoder.encode(chunk)));
}

export function streamFromBytes(
  chunks: Uint8Array[],
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

export function splitEveryByte(
  events: string[] = completeProSearchEvents(),
): ReadableStream<Uint8Array> {
  return streamFromBytes(
    Array.from(encoder.encode(events.join('')), (byte) => Uint8Array.of(byte)),
  );
}

export function streamResponse(
  body: ReadableStream<Uint8Array>,
  options: {
    status?: number;
    headers?: Record<string, string>;
  } = {},
): HttpStreamResponse {
  return {
    status: options.status ?? 200,
    statusText: options.status === 400 ? 'Bad Request' : 'OK',
    headers: options.headers ?? { 'content-type': 'text/event-stream' },
    body,
    durationMs: 1,
  };
}

export function injectedStreamClient(
  response: HttpStreamResponse,
): HttpStreamClient {
  return async () => response;
}
