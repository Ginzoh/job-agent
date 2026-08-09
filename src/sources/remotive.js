import { getJSON } from '../lib/http.js';
import { sources } from '../config.js';
import { stripHtml, toISO, detectSalary } from '../lib/text.js';

export const name = 'remotive';
export const enabled = () => sources.aggregators.remotive?.enabled !== false;

export async function fetchJobs() {
  const cfg = sources.aggregators.remotive ?? {};
  const queries = cfg.queries ?? ['react', 'frontend'];
  const out = [];
  const seen = new Set();

  for (const q of queries) {
    const data = await getJSON(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}&limit=100`);
    for (const j of data?.jobs ?? []) {
      if (seen.has(j.id)) continue;
      seen.add(j.id);
      const description = stripHtml(j.description);
      out.push({
        source: name,
        source_id: String(j.id),
        title: j.title,
        company: (j.company_name || '').trim(),
        location: j.candidate_required_location || 'Remote',
        is_remote: true,
        contract: /freelance|contract/i.test(j.job_type || '') ? 'freelance' : null,
        url: j.url,
        description,
        salary: j.salary || detectSalary(description),
        posted_at: toISO(j.publication_date),
        tags: j.tags ?? [],
      });
    }
  }
  return out;
}
