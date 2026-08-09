import { log } from './log.js';

const UA = 'Mozilla/5.0 (compatible; job-agent/1.0; personal job search bot)';

/**
 * fetch with timeout, retry and backoff. Returns null on total failure rather
 * than throwing — one dead source must never take down a whole run.
 */
export async function getRaw(url, { timeout = 30000, retries = 2, headers = {}, method = 'GET', body, expectErrors = false } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        body,
        signal: ac.signal,
        headers: { 'user-agent': UA, accept: '*/*', ...headers },
      });
      clearTimeout(timer);

      // When the caller expects to inspect failures (auth probes, for example),
      // hand back the response untouched instead of logging and discarding it.
      if (expectErrors) return res;

      // 429 / 5xx are worth retrying; 4xx are not.
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          const wait = 1500 * (attempt + 1) ** 2;
          log.warn(`${res.status} from ${short(url)} — retrying in ${wait}ms`);
          await sleep(wait);
          continue;
        }
      }
      if (!res.ok) {
        log.warn(`${res.status} ${res.statusText} — ${short(url)}`);
        return null;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries) {
        await sleep(1200 * (attempt + 1));
        continue;
      }
      log.warn(`request failed — ${short(url)} (${err.name === 'AbortError' ? 'timeout' : err.message})`);
      return null;
    }
  }
  return null;
}

export async function getJSON(url, opts) {
  const res = await getRaw(url, opts);
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    log.warn(`invalid JSON from ${short(url)}`);
    return null;
  }
}

export async function getText(url, opts) {
  const res = await getRaw(url, opts);
  if (!res) return null;
  try {
    return await res.text();
  } catch {
    return null;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` over `items` with bounded concurrency, collecting all results. */
export async function pool(items, concurrency, fn) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      try {
        const r = await fn(items[i], i);
        if (r !== undefined) results.push(r);
      } catch (err) {
        log.warn(`task failed: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

const short = (u) => (u.length > 78 ? u.slice(0, 75) + '…' : u);
