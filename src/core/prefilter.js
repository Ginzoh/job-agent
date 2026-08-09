import { filters } from '../config.js';
import { fold, hasTerm, countTerms, daysAgo } from '../lib/text.js';

/**
 * Cheap, deterministic gate that runs before the LLM.
 *
 * Its only job is to throw out things that are unambiguously not worth paying
 * for judgement on: wrong role, wrong continent, wrong decade. Anything
 * debatable is allowed through — the LLM is far better at nuance than a
 * keyword list, and tokens are cheaper than missed opportunities.
 */
export function prefilter(job) {
  const title = fold(job.title || '');
  const haystack = fold([job.title, job.description, (job.tags ?? []).join(' ')].filter(Boolean).join(' \n '));
  const locationText = fold([job.location, job.is_remote ? 'remote' : ''].filter(Boolean).join(' '));

  // 1. Title blacklist — wrong role or wrong seniority entirely.
  const badTitle = (filters.title?.reject ?? []).find((t) => !t.startsWith('_') && title.includes(fold(t)));
  if (badTitle) return fail(`title matches excluded term "${badTitle}"`);

  // 2. Age.
  const maxAge = filters.freshness?.max_age_days ?? 60;
  const age = daysAgo(job.posted_at);
  if (age != null && age > maxAge) return fail(`posted ${age} days ago (limit ${maxAge})`);

  // 3. Stack — must mention something we actually do.
  const required = (filters.stack?.required_any ?? []).filter((t) => !t.startsWith('_'));
  const hits = countTerms(haystack, required);
  const minHits = filters.stack?.min_required_hits ?? 1;
  if (hits.length < minHits) return fail(`no relevant stack keyword found`);

  // 4. Excluded ecosystems — only fatal when nothing of ours is present.
  const excluded = (filters.stack?.excluded ?? []).filter((t) => !t.startsWith('_'));
  const excludedHits = countTerms(haystack, excluded);
  if (excludedHits.length > 0 && hits.length === 0) {
    return fail(`looks like a ${excludedHits[0]} role`);
  }

  // 5. Location — hard geographic rejections first.
  const rejectLoc = (filters.location?.reject ?? []).filter((t) => !t.startsWith('_'));
  const badLoc = rejectLoc.find((t) => haystack.includes(fold(t)));
  if (badLoc) return fail(`location restriction: "${badLoc}"`);

  // Word-boundary matching, not substring: a bare "eu" in the accept list would
  // otherwise match "Seoul" and wave through the entire planet.
  const acceptLoc = (filters.location?.accept ?? []).filter((t) => !t.startsWith('_'));
  const locOk =
    (filters.location?.accept_remote !== false && job.is_remote) ||
    acceptLoc.some((t) => hasTerm(locationText, t)) ||
    !job.location; // unknown location is not a reason to discard

  if (!locOk) return fail(`location "${job.location}" is outside your accepted areas`);

  // Everything below is signal for ranking, not for rejection.
  const nice = countTerms(haystack, (filters.stack?.nice_to_have ?? []).filter((t) => !t.startsWith('_')));

  return {
    pass: true,
    note: `stack: ${hits.slice(0, 5).join(', ')}${nice.length ? ` (+${nice.length} bonus)` : ''}`,
    hits,
    nice,
  };
}

const fail = (note) => ({ pass: false, note, hits: [], nice: [] });
