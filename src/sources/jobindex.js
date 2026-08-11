import { getText } from '../lib/http.js';
import { parseFeed } from '../lib/xml.js';
import { sources } from '../config.js';
import { stripHtml, decodeEntities, toISO, detectSalary, truncate } from '../lib/text.js';

export const name = 'jobindex';
export const enabled = () => sources.aggregators.jobindex?.enabled === true;
export const skipReason = 'disabled in config/sources.json (Danish market — enable only if you want Denmark)';

const FEED = 'https://www.jobindex.dk/jobsoegning.rss';

/**
 * Jobindex.dk — the dominant Danish job board.
 *
 * There is no public API: robots.txt explicitly disallows /api/, and the
 * endpoints do not exist. What Jobindex does publish is a proper RSS feed at
 * /jobsoegning.rss, which is not disallowed and which honours the `q` search
 * parameter — a feed is published precisely to be read by machines, so this is
 * the sanctioned route rather than a workaround.
 *
 * Two limits are deliberate, not oversights:
 *   - No pagination. robots.txt disallows `jobsoegning*page=`, so each query
 *     returns at most ~20 of the newest matches. Use more queries, not deeper
 *     paging.
 *   - Descriptions are the search-result snippet, not the full advert. Good
 *     enough to filter and score on; the link goes to the full posting.
 */
export async function fetchJobs() {
  const cfg = sources.aggregators.jobindex ?? {};
  const queries = cfg.queries ?? ['react'];
  const out = [];
  const seen = new Set();

  for (const q of queries) {
    const xml = await getText(`${FEED}?q=${encodeURIComponent(q)}`);
    if (!xml) continue;

    for (const item of parseFeed(xml)) {
      const link = item.link || item.guid;
      if (!link || seen.has(link)) continue;
      seen.add(link);

      const job = toJob(item, link);
      if (job) out.push(job);
    }
  }
  return out;
}

function toJob(item, link) {
  // The snippet is HTML that has been entity-encoded, so it survives one decode
  // pass in the feed reader and still needs the tags stripping afterwards.
  const description = stripHtml(decodeEntities(item.description ?? ''));
  const { title, company } = splitTitle(item.title ?? '');
  if (!title) return null;

  const blob = `${title} ${company} ${description}`;

  return {
    source: name,
    source_id: link.split('/').pop(),
    title,
    company: company || 'Ukendt',
    location: guessLocation(description) || 'Denmark',
    is_remote: /\bremote\b|hjemmearbejde|fjernarbejde|hybrid/i.test(blob),
    contract: /freelance|konsulent|kontrakt/i.test(blob) ? 'freelance' : null,
    url: link,
    description: truncate(description, 4000),
    salary: detectSalary(description),
    posted_at: toISO(item.pubDate),
    tags: item.category ?? [],
  };
}

/**
 * Jobindex titles read "Role, Company" — split on the LAST comma, since role
 * names contain commas far more often than company names do
 * ("Senior Software Engineer, React, JYSK").
 */
function splitTitle(raw) {
  const clean = decodeEntities(raw).trim();
  const cut = clean.lastIndexOf(',');
  if (cut === -1) return { title: clean, company: '' };
  return {
    title: clean.slice(0, cut).trim(),
    company: clean.slice(cut + 1).trim(),
  };
}

const DK_CITIES = [
  'København', 'Copenhagen', 'Aarhus', 'Århus', 'Odense', 'Aalborg', 'Ålborg',
  'Esbjerg', 'Randers', 'Kolding', 'Horsens', 'Vejle', 'Roskilde', 'Herning',
  'Helsingør', 'Silkeborg', 'Næstved', 'Frederiksberg', 'Lyngby', 'Ballerup',
  'Glostrup', 'Hillerød', 'Viborg', 'Holstebro', 'Slagelse', 'Sønderborg',
];

function guessLocation(text) {
  const head = text.slice(0, 600);
  const hit = DK_CITIES.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(head));
  return hit ? `${hit}, Denmark` : null;
}
