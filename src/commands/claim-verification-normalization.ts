import { stripControlChars } from './answer-synthesis.js';

export function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

export function untrusted(value: string): string {
  return stripControlChars(value).trim();
}
