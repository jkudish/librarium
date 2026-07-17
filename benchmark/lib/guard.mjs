import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const secretEnvironmentVariables = [
  'ANTHROPIC_API_KEY',
  'BRAVE_API_KEY',
  'EXA_API_KEY',
  'FIRECRAWL_API_KEY',
  'GEMINI_API_KEY',
  'JINA_AI_API_KEY',
  'KAGI_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'PERPLEXITY_API_KEY',
  'SEARCHAPI_API_KEY',
  'SERPAPI_API_KEY',
  'TAVILY_API_KEY',
  'YOU_COM_API_KEY',
];

export function isCi(env = process.env) {
  return ['1', 'true', 'yes'].includes(String(env.CI ?? '').toLowerCase());
}

export function assertOfflineCi({ fixture, env = process.env }) {
  if (!isCi(env)) return;
  if (!fixture) {
    throw new Error(
      'Live benchmark execution is structurally disabled in CI; provide an offline fixture pack.',
    );
  }
  const present = secretEnvironmentVariables.filter((key) => Boolean(env[key]));
  if (present.length > 0) {
    throw new Error(
      `Benchmark CI must not receive provider or judge secrets: ${present.join(', ')}`,
    );
  }
}

export function installNetworkGuard() {
  const previousFetch = globalThis.fetch;
  const previous = {
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
  };
  const blocked = () => {
    throw new Error(
      'Network access is disabled during benchmark fixture replay',
    );
  };
  globalThis.fetch = async () => {
    throw new Error(
      'Network access is disabled during benchmark fixture replay',
    );
  };
  http.request = blocked;
  http.get = blocked;
  https.request = blocked;
  https.get = blocked;
  net.connect = blocked;
  net.createConnection = blocked;
  return () => {
    globalThis.fetch = previousFetch;
    http.request = previous.httpRequest;
    http.get = previous.httpGet;
    https.request = previous.httpsRequest;
    https.get = previous.httpsGet;
    net.connect = previous.netConnect;
    net.createConnection = previous.netCreateConnection;
  };
}
