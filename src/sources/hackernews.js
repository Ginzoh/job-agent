import { getJSON, pool } from '../lib/http.js';
import { sources } from '../config.js';
import { stripHtml, toISO, detectSalary, detectRemote, truncate } from '../lib/text.js';
import { log } from '../lib/log.js';

export const name = 'hackernews';
export const enabled = () => sources.aggregators.hackernews?.enabled !== false;

/**
 * Mines the monthly "Ask HN: Who is hiring?" and "Freelancer? Seeking freelancer?"
 * threads. Each top-level comment is one posting. This is one of the best
 * sources for genuinely remote-friendly and freelance work, and nobody
 * aggregates it well — which means less competition per listing.
 */
export async function fetchJobs() {
  const cfg = sources.aggregators.hackernews ?? {};
  const monthsBack = cfg.months_back ?? 3;

  const stories = await findThreads(monthsBack);
  if (!stories.length) {
    log.warn('hackernews: no hiring threads found');
    return [];
  }

  const perThread = await pool(stories, 3, async (story) => {
    const item = await getJSON(`https://hn.algolia.com/api/v1/items/${story.id}`, { timeout: 45000 });
    if (!item) return [];
    return (item.children ?? [])
      .filter((c) => c.text && !c.deleted)
      .map((c) => toJob(c, story))
      .filter(Boolean);
  });

  return perThread.flat();
}

async function findThreads(monthsBack) {
  const cutoff = Math.floor(Date.now() / 1000) - monthsBack * 31 * 86400;
  const queries = ['"Ask HN: Who is hiring?"', '"Freelancer? Seeking freelancer?"'];
  const found = [];

  for (const q of queries) {
    const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=${encodeURIComponent(q)}&hitsPerPage=6`;
    const data = await getJSON(url);
    for (const hit of data?.hits ?? []) {
      if (hit.created_at_i < cutoff) continue;
      if (!hit.num_comments) continue;
      found.push({ id: hit.objectID, title: hit.title, freelance: /freelancer/i.test(hit.title) });
    }
  }
  return found;
}

function toJob(comment, story) {
  const text = stripHtml(comment.text);
  if (text.length < 60) return null;

  const firstLine = text.split('\n')[0].trim();

  return {
    source: name,
    source_id: String(comment.id),
    title: buildTitle(firstLine, story),
    company: guessCompany(firstLine),
    location: guessLocation(text),
    is_remote: detectRemote(text),
    contract: story.freelance ? 'freelance' : null,
    url: `https://news.ycombinator.com/item?id=${comment.id}`,
    description: text,
    salary: detectSalary(text),
    posted_at: toISO(comment.created_at),
    tags: [story.freelance ? 'freelance-thread' : 'whoishiring'],
  };
}

/**
 * HN hiring posts are freeform, but the overwhelming convention is a header
 * line like "Company | Role | Location | Remote | full-time".
 */
function buildTitle(firstLine, story) {
  const parts = firstLine.split('|').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return truncate(`${parts[0]} — ${parts[1]}`, 120);
  return truncate(firstLine, 120) || (story.freelance ? 'HN freelance post' : 'HN hiring post');
}

function guessCompany(firstLine) {
  const parts = firstLine.split('|').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return truncate(parts[0], 60);
  const m = firstLine.match(/^([A-Z][\w.& -]{2,40}?)\s*(?:[-–—:(]|is hiring|\bhiring\b)/);
  return m ? m[1].trim() : 'Unknown (HN)';
}

const CITY_HINTS = ['Paris', 'Lyon', 'Bordeaux', 'Nantes', 'Lille', 'Toulouse', 'Marseille', 'Rennes', 'Montpellier', 'France', 'Berlin', 'London', 'Amsterdam', 'Barcelona', 'Madrid', 'Lisbon', 'Zurich', 'Munich', 'Dublin', 'Brussels'];

function guessLocation(text) {
  const head = text.slice(0, 400);
  const hits = CITY_HINTS.filter((c) => new RegExp(`\\b${c}\\b`, 'i').test(head));
  if (hits.length) return hits.slice(0, 3).join(', ');
  if (/\bremote\b/i.test(head)) return 'Remote';
  return '';
}
