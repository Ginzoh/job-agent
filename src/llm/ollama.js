import { env } from '../config.js';

export const id = 'ollama';

/**
 * Local model backend. Free and rate-limit-free, which makes it the right
 * choice for large backlogs or for running the agent unattended for months.
 * A 14B instruct model on a 12GB+ GPU handles this triage task comfortably.
 */
export async function complete({ system, prompt, timeout = env.llmTimeoutMs }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);

  try {
    const res = await fetch(`${env.ollamaHost}/api/chat`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.ollamaModel,
        stream: false,
        format: 'json',
        options: { temperature: 0.2, num_ctx: 16384 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!res.ok) throw new Error(`ollama responded ${res.status} ${res.statusText}`);
    const data = await res.json();
    return { text: data?.message?.content ?? '', cost: 0, model: env.ollamaModel };
  } finally {
    clearTimeout(timer);
  }
}

export async function available() {
  try {
    const res = await fetch(`${env.ollamaHost}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const models = (data.models ?? []).map((m) => m.name);
    const want = env.ollamaModel;
    const has = models.some((m) => m === want || m.split(':')[0] === want.split(':')[0]);
    if (!has) {
      return { ok: false, reason: `Ollama is running but "${want}" isn't pulled. Run: ollama pull ${want}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Ollama not reachable at ${env.ollamaHost} (${err.message}). Start it, or set LLM_BACKEND=claude.` };
  }
}
