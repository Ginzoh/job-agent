import { ALL_SOURCES } from '../sources/index.js';
import { prefilter } from './prefilter.js';
import { scoreAll } from './score.js';
import { upsertJob, recordRun, stats } from '../lib/db.js';
import { jobHash, detectStack, detectContract, detectRemote, canonicalUrl, toArray } from '../lib/text.js';
import { log, c } from '../lib/log.js';

/** Poll every enabled source and store anything we haven't seen before. */
export async function fetchAll() {
  const detail = {};
  let fetched = 0;
  let newJobs = 0;
  let passed = 0;

  for (const source of ALL_SOURCES) {
    if (!source.enabled()) {
      const why = source.skipReason ? c.grey(`(${source.skipReason})`) : c.grey('(disabled)');
      log.info(`${c.grey('skip')} ${source.name} ${why}`);
      detail[source.name] = 'skipped';
      continue;
    }

    const started = Date.now();
    process.stdout.write(`  ${source.name.padEnd(16)} `);

    try {
      const raw = await source.fetchJobs();
      let added = 0;
      let kept = 0;

      for (const r of raw) {
        const job = normalizeJob(r, source.name);
        if (!job) continue;

        const verdict = prefilter(job);
        job.prefilter_pass = verdict.pass;
        job.prefilter_note = verdict.note;

        if (upsertJob(job)) {
          added++;
          if (verdict.pass) kept++;
        }
      }

      fetched += raw.length;
      newJobs += added;
      passed += kept;
      detail[source.name] = { seen: raw.length, new: added, passed: kept };

      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `${String(raw.length).padStart(4)} seen  ${c.green(String(added).padStart(3))} new  ${c.cyan(String(kept).padStart(3))} relevant  ${c.grey(secs + 's')}`
      );
    } catch (err) {
      console.log(c.red(`failed — ${err.message}`));
      detail[source.name] = { error: err.message };
    }
  }

  return { fetched, newJobs, passed, detail };
}

/** Turn a source-specific record into the shape the database expects. */
function normalizeJob(raw, sourceName) {
  const title = (raw.title || '').trim();
  const url = (raw.url || raw.apply_url || '').trim();
  if (!title || !url) return null;

  const company = (raw.company || '').trim();
  const tags = toArray(raw.tags);
  const blob = `${title}\n${company}\n${raw.location || ''}\n${raw.description || ''}`;

  return {
    id: jobHash({ company, title, url }),
    source: raw.source || sourceName,
    source_id: raw.source_id ?? null,
    title,
    company,
    location: (raw.location || '').trim(),
    is_remote: raw.is_remote ?? detectRemote(blob),
    contract: raw.contract || detectContract(blob),
    url: canonicalUrl(url),
    apply_url: raw.apply_url ?? null,
    description: raw.description || '',
    salary: raw.salary ?? null,
    stack: detectStack(blob),
    posted_at: raw.posted_at ?? null,
    tags,
  };
}

/** fetch → filter → score, with a run recorded for the stats view. */
export async function runPipeline({ skipScore = false } = {}) {
  const started_at = new Date().toISOString();

  log.step('Fetching sources');
  const f = await fetchAll();

  let scored = 0;
  let shortlisted = 0;
  let cost = 0;

  if (!skipScore) {
    log.step('Scoring new opportunities');
    const s = await scoreAll();
    scored = s.scored;
    shortlisted = s.shortlisted;
    cost = s.cost;
    if (!scored) log.info('nothing new to score');
  }

  recordRun({
    started_at,
    finished_at: new Date().toISOString(),
    fetched: f.fetched,
    new_jobs: f.newJobs,
    passed: f.passed,
    scored,
    shortlisted,
    cost_usd: cost,
    detail: f.detail,
  });

  return { ...f, scored, shortlisted, cost, stats: stats() };
}
