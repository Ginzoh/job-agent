import { getJSON, pool } from '../lib/http.js';
import { sources } from '../config.js';
import { stripHtml, decodeEntities, toISO, detectSalary } from '../lib/text.js';
import { log } from '../lib/log.js';

export const name = 'companyboards';
export const enabled = () => sources.company_boards?.enabled !== false;

/**
 * Polls company ATS boards directly (Greenhouse / Lever / Ashby).
 * These are the freshest listings that exist — a role shows up here the moment
 * a company publishes it, often days before any aggregator picks it up.
 */
export async function fetchJobs() {
  const cfg = sources.company_boards ?? {};
  const tasks = [
    ...(cfg.greenhouse ?? []).map((slug) => ({ board: 'greenhouse', slug })),
    ...(cfg.lever ?? []).map((slug) => ({ board: 'lever', slug })),
    ...(cfg.ashby ?? []).map((slug) => ({ board: 'ashby', slug })),
  ].filter((t) => typeof t.slug === 'string' && !t.slug.startsWith('_'));

  const batches = await pool(tasks, 6, async ({ board, slug }) => {
    try {
      return await FETCHERS[board](slug);
    } catch (err) {
      log.warn(`${board}/${slug}: ${err.message}`);
      return [];
    }
  });

  return batches.flat();
}

const FETCHERS = {
  async greenhouse(slug) {
    const data = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    return (data?.jobs ?? []).map((j) => {
      // Greenhouse returns entity-encoded HTML, so decode before stripping tags.
      const description = stripHtml(decodeEntities(j.content || ''));
      const location = j.location?.name || '';
      return {
        source: `gh:${slug}`,
        source_id: String(j.id),
        title: j.title,
        company: j.company_name || pretty(slug),
        location,
        is_remote: /remote|télétravail|teletravail/i.test(location + ' ' + j.title),
        contract: null,
        url: j.absolute_url,
        description,
        salary: detectSalary(description),
        posted_at: toISO(j.first_published || j.updated_at),
        tags: [],
      };
    });
  },

  async lever(slug) {
    const data = await getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    return (Array.isArray(data) ? data : []).map((j) => {
      const description = stripHtml(j.descriptionPlain || j.description || '');
      const cat = j.categories ?? {};
      const location = cat.location || (cat.allLocations ?? []).join(', ') || j.country || '';
      return {
        source: `lever:${slug}`,
        source_id: j.id,
        title: j.text,
        company: pretty(slug),
        location,
        is_remote: /remote/i.test(j.workplaceType || '') || /remote/i.test(location),
        contract: mapCommitment(cat.commitment),
        url: j.hostedUrl,
        apply_url: j.applyUrl,
        description,
        salary: detectSalary(description),
        posted_at: toISO(j.createdAt),
        tags: [cat.department, cat.team].filter(Boolean),
      };
    });
  },

  async ashby(slug) {
    const data = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    return (data?.jobs ?? []).filter((j) => j.isListed !== false).map((j) => {
      const description = stripHtml(j.descriptionPlain || j.descriptionHtml || '');
      const location = j.location || j.address?.postalAddress?.addressRegion || '';
      const country = j.address?.postalAddress?.addressCountry || '';
      return {
        source: `ashby:${slug}`,
        source_id: j.id,
        title: j.title,
        company: pretty(slug),
        location: [location, country].filter(Boolean).join(', '),
        is_remote: j.isRemote === true || /remote/i.test(j.workplaceType || ''),
        contract: mapEmployment(j.employmentType),
        url: j.jobUrl,
        apply_url: j.applyUrl,
        description,
        salary: detectSalary(description),
        posted_at: toISO(j.publishedAt),
        tags: [j.department, j.team].filter(Boolean),
      };
    });
  },
};

const mapCommitment = (v = '') =>
  /contract|freelance|temporary/i.test(v) ? 'freelance' : /full.?time|cdi|permanent/i.test(v) ? 'permanent' : null;

const mapEmployment = (v = '') =>
  /contract|temporary/i.test(v) ? 'freelance' : /fulltime|full.?time/i.test(v) ? 'permanent' : null;

const pretty = (slug) =>
  slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
