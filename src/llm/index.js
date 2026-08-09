import * as claude from './claude.js';
import * as ollama from './ollama.js';
import { env } from '../config.js';

const BACKENDS = { claude, ollama };

export function getBackend(name = env.llmBackend) {
  if (name === 'none') return null;
  const b = BACKENDS[name];
  if (!b) throw new Error(`Unknown LLM_BACKEND "${name}". Use one of: claude, ollama, none.`);
  return b;
}

/**
 * Extract a JSON value from a model response. Models wrap JSON in prose or
 * markdown fences often enough that this needs to be forgiving.
 */
export function parseJson(text) {
  if (!text) throw new Error('empty response');

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text, sliceBalanced(text, '['), sliceBalanced(text, '{')].filter(Boolean);

  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch { /* try the next candidate */ }
  }
  throw new Error(`could not parse JSON from response: ${text.slice(0, 200)}`);
}

/** Grab the first balanced [...] or {...} block, ignoring brackets inside strings. */
function sliceBalanced(text, open) {
  const close = open === '[' ? ']' : '}';
  const start = text.indexOf(open);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}
