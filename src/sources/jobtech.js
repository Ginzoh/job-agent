import { getJSON } from '../lib/http.js';
import { sources } from '../config.js';
import { stripHtml, toISO, detectSalary, truncate } from '../lib/text.js';

export const name = 'jobtech';
export const enabled = () => sources.aggregators.jobtech?.enabled !== false;

const API = 'https://jobsearch.api.jobtechdev.se/search';
const MAX_LIMIT = 100; // the API rejects anything larger

/**
 * JobTech Search — Sweden's national job bank (Platsbanken), published as open
 * data by Arbetsförmedlingen, the public employment service.
 *
 * This is the best public job API in Europe: no key, no registration, no rate
 * limit worth worrying about, and genuinely structured records — employer,
 * municipality with coordinates, employment type, contract duration, salary
 * description, and explicit must-have / nice-to-have skill lists.
 *
 * Query in Swedish where you can. "fullstack utvecklare" returns 119 matches
 * against 6 for "frontend developer" — the postings are written in Swedish, and
 * the search matches the advert text.
 */
export async function fetchJobs() {
  const cfg = sources.aggregators.jobtech ?? {};
  const queries = cfg.queries ?? ['react'];
  const perPage = Math.min(cfg.items_per_page ?? 100, MAX_LIMIT);
  const maxPages = cfg.max_pages ?? 2;

  const out = [];
  const seen = new Set();

  for (const q of queries) {
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(API);
      url.searchParams.set('q', q);
      url.searchParams.set('limit', String(perPage));
      url.searchParams.set('offset', String(page * perPage));

      const data = await getJSON(url.toString(), { headers: { accept: 'application/json' } });
      const hits = data?.hits ?? [];
      if (!hits.length) break;

      for (const h of hits) {
        if (!h?.id || seen.has(h.id)) continue;
        seen.add(h.id);
        out.push(toJob(h));
      }

      const total = data.total?.value ?? 0;
      if ((page + 1) * perPage >= total) break;
    }
  }
  return out;
}

function toJob(h) {
  const addr = h.workplace_address ?? {};
  const location = [addr.city || addr.municipality, addr.region, addr.country]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(', ');

  // description.text is already plain; text_formatted is the HTML twin.
  const body = h.description?.text || stripHtml(h.description?.text_formatted || '');
  const blob = `${h.headline} ${body}`;

  const skills = [
    ...(h.must_have?.skills ?? []).map((s) => s?.label),
    ...(h.nice_to_have?.skills ?? []).map((s) => s?.label),
    h.occupation?.label,
    h.occupation_field?.label,
  ].filter(Boolean);

  return {
    source: name,
    source_id: String(h.id),
    title: h.headline,
    company: h.employer?.name || h.employer?.workplace || 'Okänd',
    location: location || 'Sweden',
    is_remote: isRemote(blob),
    contract: mapContract(h, blob),
    url: h.webpage_url || h.application_details?.url,
    apply_url: h.application_details?.url ?? null,
    description: buildDescription(h, body),
    salary: h.salary_description || detectSalary(body),
    posted_at: toISO(h.publication_date),
    tags: skills,
  };
}

/**
 * Prepend the facts the API states explicitly. They are reliable here — unlike
 * most sources, which bury them in prose — so putting them up front means the
 * scorer sees them even when the description gets truncated.
 */
function buildDescription(h, body) {
  const lines = [
    h.employment_type?.label ? `Anställningsform / employment type: ${h.employment_type.label}` : null,
    h.duration?.label ? `Varaktighet / duration: ${h.duration.label}` : null,
    h.working_hours_type?.label ? `Omfattning / hours: ${h.working_hours_type.label}` : null,
    h.experience_required === false ? 'Ingen erfarenhet krävs / no prior experience required' : null,
    h.application_deadline ? `Sista ansökningsdag / apply before: ${String(h.application_deadline).slice(0, 10)}` : null,
  ].filter(Boolean);

  return [lines.join('\n'), truncate(body, 5000)].filter(Boolean).join('\n\n');
}

const REMOTE_SV = /\b(distans|distansarbete|hemifrån|hemarbete|remote|hybrid)\b/i;
const isRemote = (text) => REMOTE_SV.test(text);

/**
 * Swedish employment vocabulary doesn't map cleanly onto the freelance /
 * permanent / fixed-term split, so use the structured field first and fall back
 * to the wording of the advert.
 */
function mapContract(h, blob) {
  const type = h.employment_type?.label ?? '';
  const duration = h.duration?.label ?? '';

  if (/konsultuppdrag|konsult |uppdrag|frilans|freelance/i.test(blob)) return 'freelance';
  if (/behovsanställning|vikariat|sommarjobb|tidsbegränsad/i.test(`${type} ${duration}`)) return 'contract';
  if (/tills vidare/i.test(duration)) return 'permanent';
  if (/vanlig anställning/i.test(type)) return 'permanent';
  return 'unknown';
}
