import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.js';
import { listJobs, stats } from '../lib/db.js';
import { daysAgo } from '../lib/text.js';

/** Write a Markdown briefing of the best current opportunities. */
export function writeDigest({ minScore = 60, limit = 40, days = 14 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  // Defaults to the `open` view, so a digest never re-pitches you a role you've
  // already applied to or dismissed.
  const jobs = listJobs({ minScore, since, limit, order: 'score' });

  const s = stats();
  const today = new Date().toISOString().slice(0, 10);
  const out = [];

  out.push(`# Job digest — ${today}`, '');
  out.push(`${jobs.length} opportunities scoring ${minScore}+ from the last ${days} days.`);
  out.push(`_Database: ${s.total} postings tracked, ${s.shortlisted} shortlisted, ${s.last7} new this week._`, '');

  if (!jobs.length) {
    out.push('> Nothing above threshold yet. Try lowering `minScore`, widening `config/filters.json`, or adding an Adzuna / France Travail key for far better French coverage.');
  }

  const groups = [
    ['Strong matches — apply now', jobs.filter((j) => j.score >= 80)],
    ['Good matches — worth a look', jobs.filter((j) => j.score >= 70 && j.score < 80)],
    ['Possible — skim these', jobs.filter((j) => j.score < 70)],
  ];

  for (const [heading, group] of groups) {
    if (!group.length) continue;
    out.push(`## ${heading}`, '');

    for (const j of group) {
      const age = daysAgo(j.posted_at);
      const meta = [
        j.company || 'unknown company',
        j.location || 'location not stated',
        j.is_remote ? 'remote' : null,
        j.contract && j.contract !== 'unknown' ? j.contract : null,
        j.salary,
        age != null ? `${age}d old` : null,
      ].filter(Boolean).join(' · ');

      out.push(`### ${j.score} — [${j.title}](${j.url})`);
      out.push(`_${meta}_`, '');
      if (j.fit_summary) out.push(j.fit_summary, '');
      if (j.pros?.length) out.push(...j.pros.map((p) => `- ✅ ${p}`));
      if (j.cons?.length) out.push(...j.cons.map((p) => `- ⚠️ ${p}`));
      if (j.pitch) out.push('', `> **Opening line:** ${j.pitch}`);
      out.push('');
    }
  }

  const dir = join(ROOT, 'out');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `digest-${today}.md`);
  const latest = join(dir, 'latest.md');
  const content = out.join('\n');

  writeFileSync(path, content, 'utf8');
  writeFileSync(latest, content, 'utf8');

  return { path, latest, count: jobs.length };
}
