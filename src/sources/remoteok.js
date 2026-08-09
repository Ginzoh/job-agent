import { getJSON } from '../lib/http.js';
import { sources } from '../config.js';
import { stripHtml, toISO, detectSalary } from '../lib/text.js';

export const name = 'remoteok';
export const enabled = () => sources.aggregators.remoteok?.enabled !== false;

export async function fetchJobs() {
  const cfg = sources.aggregators.remoteok ?? {};
  const tags = cfg.tags ?? ['react', 'javascript'];
  const out = [];
  const seen = new Set();

  for (const tag of tags) {
    const data = await getJSON(`https://remoteok.com/api?tags=${encodeURIComponent(tag)}`);
    if (!Array.isArray(data)) continue;

    // Element 0 is RemoteOK's legal/attribution notice, not a job.
    for (const j of data.slice(1)) {
      if (!j?.id || seen.has(j.id)) continue;
      seen.add(j.id);
      const description = stripHtml(j.description);
      out.push({
        source: name,
        source_id: String(j.id),
        title: j.position,
        company: stripHtml(j.company || '').trim(),
        location: j.location || 'Remote',
        is_remote: true,
        contract: null,
        url: j.url || `https://remoteok.com/remote-jobs/${j.slug}`,
        apply_url: j.apply_url,
        description,
        salary: salaryOf(j) || detectSalary(description),
        posted_at: toISO(j.date || j.epoch),
        tags: j.tags ?? [],
      });
    }
  }
  return out;
}

function salaryOf(j) {
  if (j.salary_min && j.salary_max) return `$${j.salary_min.toLocaleString()} – $${j.salary_max.toLocaleString()}`;
  if (j.salary_min) return `from $${j.salary_min.toLocaleString()}`;
  return null;
}
