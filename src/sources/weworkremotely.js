import { getText } from '../lib/http.js';
import { parseFeed } from '../lib/xml.js';
import { sources } from '../config.js';
import { stripHtml, toISO, detectSalary } from '../lib/text.js';

export const name = 'weworkremotely';
export const enabled = () => sources.aggregators.weworkremotely?.enabled !== false;

export async function fetchJobs() {
  const cfg = sources.aggregators.weworkremotely ?? {};
  const out = [];
  const seen = new Set();

  for (const feedUrl of cfg.feeds ?? []) {
    const xml = await getText(feedUrl);
    if (!xml) continue;

    for (const item of parseFeed(xml)) {
      const link = item.link || item.guid;
      if (!link || seen.has(link)) continue;
      seen.add(link);

      // WWR titles look like "Company Name: Job Title".
      const [companyPart, ...titleParts] = (item.title || '').split(':');
      const title = titleParts.join(':').trim() || item.title;
      const description = stripHtml(item.description);

      out.push({
        source: name,
        source_id: link,
        title,
        company: item.company || companyPart.trim(),
        location: item.region || 'Remote',
        is_remote: true,
        contract: /contract/i.test(item.type || '') || /contract/i.test(feedUrl) ? 'freelance' : null,
        url: link,
        description,
        salary: detectSalary(description),
        posted_at: toISO(item.pubDate),
        tags: item.category ?? [],
      });
    }
  }
  return out;
}
