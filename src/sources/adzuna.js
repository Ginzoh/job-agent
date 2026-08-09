import { getJSON } from '../lib/http.js';
import { sources, env, hasAdzuna } from '../config.js';
import { stripHtml, toISO, detectSalary } from '../lib/text.js';

export const name = 'adzuna';
export const enabled = () => sources.aggregators.adzuna?.enabled !== false && hasAdzuna();
export const skipReason = 'no ADZUNA_APP_ID / ADZUNA_APP_KEY in .env';

/** Adzuna aggregates most French job boards — the widest FR coverage available. */
export async function fetchJobs() {
  const cfg = sources.aggregators.adzuna ?? {};
  const country = cfg.country ?? 'fr';
  const maxPages = cfg.max_pages ?? 3;
  const queries = cfg.queries ?? ['développeur react'];
  const out = [];
  const seen = new Set();

  for (const q of queries) {
    for (let page = 1; page <= maxPages; page++) {
      const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`);
      url.searchParams.set('app_id', env.adzunaId);
      url.searchParams.set('app_key', env.adzunaKey);
      url.searchParams.set('results_per_page', '50');
      url.searchParams.set('what', q);
      url.searchParams.set('content-type', 'application/json');
      url.searchParams.set('max_days_old', '45');

      const data = await getJSON(url.toString());
      const rows = data?.results ?? [];
      if (!rows.length) break;

      for (const j of rows) {
        if (seen.has(j.id)) continue;
        seen.add(j.id);
        const description = stripHtml(j.description || '');
        out.push({
          source: name,
          source_id: String(j.id),
          title: j.title ? stripHtml(j.title) : '',
          company: j.company?.display_name || '',
          location: j.location?.display_name || '',
          is_remote: /remote|télétravail|teletravail/i.test(`${j.title} ${j.location?.display_name} ${description}`),
          contract: mapContract(j),
          url: j.redirect_url,
          description,
          salary: salaryOf(j) || detectSalary(description),
          posted_at: toISO(j.created),
          tags: [j.category?.label].filter(Boolean),
        });
      }
    }
  }
  return out;
}

function mapContract(j) {
  if (j.contract_type === 'contract') return 'contract';
  if (j.contract_type === 'permanent') return 'permanent';
  if (j.contract_time === 'part_time') return null;
  return null;
}

function salaryOf(j) {
  if (j.salary_min && j.salary_max) {
    if (j.salary_min === j.salary_max) return `${Math.round(j.salary_min).toLocaleString('fr-FR')} €`;
    return `${Math.round(j.salary_min).toLocaleString('fr-FR')} – ${Math.round(j.salary_max).toLocaleString('fr-FR')} €`;
  }
  return null;
}
