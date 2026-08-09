import { getJSON } from '../lib/http.js';
import { sources } from '../config.js';
import { stripHtml, toISO, detectSalary, toArray } from '../lib/text.js';

export const name = 'arbeitnow';
export const enabled = () => sources.aggregators.arbeitnow?.enabled !== false;

/** Arbeitnow is Europe-wide (heavily DE, but plenty of FR/remote EU listings). */
export async function fetchJobs() {
  const cfg = sources.aggregators.arbeitnow ?? {};
  const maxPages = cfg.max_pages ?? 3;
  const out = [];

  for (let page = 1; page <= maxPages; page++) {
    const data = await getJSON(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
    const rows = data?.data ?? [];
    if (!rows.length) break;

    for (const j of rows) {
      const description = stripHtml(j.description);
      const jobTypes = toArray(j.job_types);
      out.push({
        source: name,
        source_id: j.slug,
        title: j.title,
        company: j.company_name,
        location: j.location || (j.remote ? 'Remote' : ''),
        is_remote: !!j.remote,
        contract: jobTypes.some((t) => /freelance|contract/i.test(t)) ? 'freelance' : null,
        url: j.url,
        description,
        salary: detectSalary(description),
        posted_at: toISO(j.created_at),
        tags: [...toArray(j.tags), ...jobTypes],
      });
    }
  }
  return out;
}
