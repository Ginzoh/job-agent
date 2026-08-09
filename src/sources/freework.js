import { getJSON } from '../lib/http.js';
import { sources } from '../config.js';
import { stripHtml, toISO } from '../lib/text.js';

export const name = 'freework';
export const enabled = () => sources.aggregators.freework?.enabled !== false;

const API = 'https://www.free-work.com/api/job_postings';

/**
 * Free-Work (ex Carrière Info) — the main French freelance/IT job board, with
 * ~10k live postings. This is the single best source for French *missions*:
 * unlike almost every aggregator, it publishes the TJM (daily rate) as a real
 * number rather than burying it in prose, and it separates contractor work from
 * CDI properly.
 *
 * It speaks JSON-LD/Hydra, so results live under `hydra:member`.
 */
export async function fetchJobs() {
  const cfg = sources.aggregators.freework ?? {};
  const queries = cfg.queries ?? ['react'];
  const contracts = (cfg.contracts ?? ['contractor', 'permanent']).join(',');
  const perPage = cfg.items_per_page ?? 100;
  const maxPages = cfg.max_pages ?? 3;

  const out = [];
  const seen = new Set();

  for (const q of queries) {
    for (let page = 1; page <= maxPages; page++) {
      const url = new URL(API);
      url.searchParams.set('searchKeywords', q);
      url.searchParams.set('contracts', contracts);
      url.searchParams.set('itemsPerPage', String(perPage));
      url.searchParams.set('page', String(page));

      const data = await getJSON(url.toString(), { headers: { accept: 'application/ld+json' } });
      const rows = data?.['hydra:member'] ?? [];
      if (!rows.length) break;

      for (const j of rows) {
        if (!j?.slug || seen.has(j.slug)) continue;
        seen.add(j.slug);
        out.push(toJob(j));
      }

      // Stop early once we've walked the whole result set.
      const total = data['hydra:totalItems'] ?? 0;
      if (page * perPage >= total) break;
    }
  }
  return out;
}

function toJob(j) {
  // The body is split across three HTML fields. `candidateProfile` is where the
  // real stack requirements live, so it matters most. `companyDescription` is
  // marketing boilerplate ("Bienvenue chez ...") — it adds tokens and no signal,
  // so it's deliberately dropped.
  const description = [j.description, j.candidateProfile]
    .filter(Boolean)
    .map(stripHtml)
    .join('\n\n');

  const loc = j.location ?? {};
  const location = loc.label || [loc.locality, loc.adminLevel1, loc.country].filter(Boolean).join(', ');

  return {
    source: name,
    source_id: j.slug,
    title: j.title,
    company: j.company?.name || 'Non précisé',
    location: location || 'France',
    is_remote: j.remoteMode === 'full',
    contract: mapContract(j.contracts),
    url: publicUrl(j),
    description: [experienceLine(j), remoteLine(j), description].filter(Boolean).join('\n'),
    salary: salaryOf(j),
    posted_at: toISO(j.publishedAt || j.createdAt),
    tags: [
      ...(j.skills ?? []).map((s) => s?.name).filter(Boolean),
      j.job?.name,
      j.experienceLevel,
    ].filter(Boolean),
  };
}

/** Free-Work's public pages live under the job category, not at the API path. */
function publicUrl(j) {
  const category = j.job?.slug;
  return category
    ? `https://www.free-work.com/fr/tech-it/job-mission/${category}/${j.slug}`
    : `https://www.free-work.com/fr/tech-it/job-mission/${j.slug}`;
}

const mapContract = (contracts = []) => {
  const c = (contracts ?? [])[0];
  if (c === 'contractor') return 'freelance';
  if (c === 'permanent') return 'permanent';
  if (c === 'fixed-term') return 'contract';
  return 'unknown';
};

/**
 * A stated TJM is one of the strongest quality signals a French mission can
 * carry, so surface it as the salary field rather than leaving it in the body.
 */
function salaryOf(j) {
  const fmt = (n) => Number(n).toLocaleString('fr-FR');
  const cur = j.currency === 'USD' ? '$' : '€';

  if (j.minDailySalary || j.maxDailySalary) {
    const lo = j.minDailySalary;
    const hi = j.maxDailySalary;
    if (lo && hi && lo !== hi) return `TJM ${fmt(lo)}–${fmt(hi)} ${cur}/j`;
    return `TJM ${fmt(lo || hi)} ${cur}/j`;
  }
  if (j.minAnnualSalary || j.maxAnnualSalary) {
    const lo = j.minAnnualSalary;
    const hi = j.maxAnnualSalary;
    if (lo && hi && lo !== hi) return `${fmt(lo)}–${fmt(hi)} ${cur}/an`;
    return `${fmt(lo || hi)} ${cur}/an`;
  }
  return null;
}

const EXPERIENCE = {
  junior: 'Experience level: junior (0-2 years)',
  intermediate: 'Experience level: intermediate / confirmé (2-7 years)',
  senior: 'Experience level: senior (7+ years)',
  expert: 'Experience level: expert (10+ years)',
};
const experienceLine = (j) => EXPERIENCE[j.experienceLevel] ?? null;

const REMOTE = {
  full: 'Remote: full remote (télétravail complet)',
  partial: 'Remote: hybrid / partial (télétravail partiel)',
  none: 'Remote: on-site only (présentiel)',
};
const remoteLine = (j) => REMOTE[j.remoteMode] ?? null;
