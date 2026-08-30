import { sources, env } from '../config.js';
import { getBackend } from '../llm/index.js';
import { parseJson } from '../llm/index.js';
import { fromUrl } from '../core/import.js';
import { pool } from '../lib/http.js';
import { jobHash, detectStack, detectContract, detectRemote, canonicalUrl, detectSalary, truncate, fold } from '../lib/text.js';
import { log, c } from '../lib/log.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT } from '../config.js';

export const name = 'websearch';
export const enabled = () => sources.aggregators.websearch?.enabled === true;
export const skipReason = 'disabled in config/sources.json (costs ~$0.55 per run — see the comment there)';

const SYSTEM = `You find job postings on the web and return them as data.

Search thoroughly, then return ONLY a JSON array — no prose, no markdown fences. Each element:
{"title": "...", "company": "...", "location": "...", "url": "the direct posting URL", "source": "the site it is on"}

Rules:
- Return the URL of the individual posting, never a search-results or category page.
- Only include postings you actually found in search results. Never construct, guess or complete a URL from a pattern.
- Prefer postings published in the last few weeks.
- Skip anything that is an internship, apprenticeship, alternance or stage.
- If you find nothing for a query, return fewer results. An empty array is a valid and useful answer.`;

/**
 * Job discovery via web search, using the claude CLI's own search tool.
 *
 * The important design constraint: the model is used ONLY to discover candidate
 * URLs. Every field that ends up in the database is read from the real page
 * afterwards. A language model asked for job data will produce plausible job
 * data whether or not the posting exists — and it does: in testing, both
 * LinkedIn URLs it returned were dead, one 404 and one silently redirected to a
 * generic listing page, while the non-LinkedIn results were genuine.
 *
 * So every URL is fetched and parsed before it is trusted. Anything that fails
 * to resolve, or that resolves to something which is not recognisably the
 * advertised posting, is dropped. Nothing invented reaches the database.
 */
export async function fetchJobs() {
  const cfg = sources.aggregators.websearch ?? {};
  const queries = cfg.queries ?? [];
  if (!queries.length) return [];

  const backend = getBackend();
  if (!backend || backend.id !== 'claude') {
    log.warn('websearch needs LLM_BACKEND=claude (it uses the CLI\'s web search tool)');
    return [];
  }

  // This is by far the most expensive source — roughly a dollar a run against
  // fractions of a cent for everything else. The scheduler fires twice a day,
  // so without a floor it would pay twice for near-identical results.
  const minHours = cfg.min_hours_between_runs ?? 20;
  const since = hoursSinceLastRun();
  if (since !== null && since < minHours) {
    log.info(c.grey(`  websearch: last ran ${since.toFixed(1)}h ago, min interval ${minHours}h — skipping`));
    return [];
  }
  markRun();

  const candidates = await discover(backend, queries, cfg);
  if (!candidates.length) return [];

  log.info(c.grey(`  websearch: ${candidates.length} candidate URLs, verifying each against the live page`));

  const verified = await pool(candidates, 4, (cand) => verify(cand));
  const kept = verified.filter(Boolean);

  const dropped = candidates.length - kept.length;
  if (dropped) log.info(c.grey(`  websearch: dropped ${dropped} that were dead, blocked, or not the advertised posting`));

  return kept;
}

async function discover(backend, queries, cfg) {
  const prompt = [
    'Search for current job postings matching each of these, and return the combined results:',
    '',
    ...queries.map((q) => `- ${q}`),
    '',
    `Return at most ${cfg.max_results ?? 15} postings in total, as the JSON array described.`,
  ].join('\n');

  try {
    const { text } = await backend.complete({
      system: SYSTEM,
      prompt,
      model: cfg.model || 'sonnet',
      tools: ['WebSearch'],
      timeout: Math.max(env.llmTimeoutMs, 420000),
    });

    let parsed = parseJson(text);
    if (!Array.isArray(parsed)) parsed = Object.values(parsed).find(Array.isArray) ?? [];

    return parsed
      .filter((r) => r && typeof r.url === 'string' && /^https?:\/\//.test(r.url))
      .map((r) => ({
        url: r.url.trim(),
        claimedTitle: String(r.title ?? '').trim(),
        claimedCompany: String(r.company ?? '').trim(),
        claimedLocation: String(r.location ?? '').trim(),
        site: String(r.source ?? '').trim(),
      }));
  } catch (err) {
    log.warn(`websearch discovery failed: ${err.message}`);
    return [];
  }
}

// Pages a dead or expired posting typically redirects to.
const NOT_A_POSTING = /\b(\d+\s+(offres|jobs|emplois|résultats)|search results|page not found|404|sign in|log in|inscrivez-vous)\b/i;

/**
 * Fetch the candidate and decide whether it is really the posting claimed.
 * Returns a job, or null if it cannot be trusted.
 */
async function verify(cand) {
  let parsed;
  try {
    parsed = await fromUrl(cand.url);
  } catch {
    return null;
  }

  const description = parsed?.description ?? '';
  if (description.length < 200) return null; // blocked, empty, or a stub

  // A stale posting often 200s but serves a generic listing page. If the page's
  // own title reads like one, the URL is not the job it was advertised as.
  const pageTitle = parsed.title ?? '';
  if (NOT_A_POSTING.test(pageTitle)) return null;

  // The page must have something to do with the posting we were promised.
  // Without this, a redirect to an unrelated advert would sail through.
  if (cand.claimedTitle && pageTitle && !overlaps(cand.claimedTitle, pageTitle) && !overlaps(cand.claimedTitle, description.slice(0, 1500))) {
    return null;
  }

  const title = (parsed.title || cand.claimedTitle || '').trim().slice(0, 200);
  const company = (parsed.company || cand.claimedCompany || 'Unknown').trim().slice(0, 120);
  const location = (parsed.location || cand.claimedLocation || '').trim();
  if (!title) return null;

  const blob = `${title}\n${company}\n${location}\n${description}`;

  return {
    source: name,
    source_id: canonicalUrl(cand.url).slice(-80),
    title,
    company,
    location,
    is_remote: parsed.is_remote ?? detectRemote(blob),
    contract: parsed.contract || detectContract(blob),
    url: cand.url,
    description: truncate(description, 9000),
    salary: parsed.salary || detectSalary(description),
    posted_at: parsed.posted_at ?? null,
    tags: ['websearch', cand.site].filter(Boolean),
  };
}

/** Do two strings share enough distinctive words to be the same posting? */
function overlaps(a, b) {
  const words = (s) => new Set(fold(s).split(/\s+/).filter((w) => w.length > 3));
  const A = words(a);
  const B = words(b);
  if (!A.size) return true;
  let hits = 0;
  for (const w of A) if (B.has(w)) hits++;
  return hits / A.size >= 0.34;
}


// --- run throttle -----------------------------------------------------------
// A timestamp file rather than a table: this is scheduling state, not data, and
// losing it costs one extra search rather than corrupting anything.
const STAMP = join(ROOT, "data", ".websearch-last-run");

function hoursSinceLastRun() {
  try {
    const t = Number(readFileSync(STAMP, "utf8").trim());
    if (!Number.isFinite(t)) return null;
    return (Date.now() - t) / 3600000;
  } catch {
    return null;
  }
}

function markRun() {
  try {
    mkdirSync(dirname(STAMP), { recursive: true });
    writeFileSync(STAMP, String(Date.now()));
  } catch { /* throttling is best-effort */ }
}
