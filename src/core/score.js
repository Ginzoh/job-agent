import { profile, filters, env } from '../config.js';
import { getBackend, parseJson } from '../llm/index.js';
import { HardStopError } from '../llm/claude.js';
import { pendingScoring, saveScore, recordSpend, totalSpend } from '../lib/db.js';
import { truncate } from '../lib/text.js';
import { log, c, scoreColor } from '../lib/log.js';
import { SYSTEM, SCHEMA } from './scoring-prompt.js';

/** Score every pending job through the configured LLM backend. */
export async function scoreAll({ limit = env.scoreMaxPerRun, batchSize = env.scoreBatchSize } = {}) {
  const backend = getBackend();
  const jobs = pendingScoring(limit);

  if (!jobs.length) return { scored: 0, shortlisted: 0, cost: 0 };

  if (!backend) {
    log.warn('LLM_BACKEND=none — assigning heuristic scores instead of AI judgement');
    return heuristicOnly(jobs);
  }

  const batches = chunk(jobs, batchSize);
  const concurrency = Math.max(1, Math.min(env.scoreConcurrency, batches.length));

  // Budget ceiling. Costs are what the CLI reports, so this is a safety net,
  // not an authoritative billing control — the real limit belongs in your
  // Anthropic account settings. It still guarantees this program stops.
  const budget = env.maxSpendUsd;
  const alreadySpent = totalSpend();

  if (budget > 0 && alreadySpent >= budget) {
    log.error(`budget ceiling reached: $${alreadySpent.toFixed(2)} of $${budget.toFixed(2)} MAX_SPEND_USD already spent`);
    log.plain(`  ${c.grey('Nothing was sent. Raise MAX_SPEND_USD in .env, or set LLM_BACKEND=ollama to score for free.')}`);
    return { scored: 0, shortlisted: 0, cost: 0, stopped: 'budget' };
  }

  log.info(`scoring ${c.bold(String(jobs.length))} jobs in ${batches.length} batches via ${c.cyan(backend.id)} ${c.grey(`(${concurrency} at a time)`)}`);
  if (budget > 0) {
    log.info(c.grey(`budget: $${alreadySpent.toFixed(2)} spent of $${budget.toFixed(2)} ceiling`));
  }

  let scored = 0;
  let shortlisted = 0;
  let cost = 0;
  let done = 0;
  let stopped = null;

  // Each batch is a separate process/request, so running several at once turns
  // a ~90s serial round trip into real throughput. Results are written as they
  // land; a failed batch is simply left unscored and retried on the next run.
  let next = 0;
  async function worker() {
    while (next < batches.length && !stopped) {
      const batch = batches[next++];
      try {
        const result = await scoreBatch(backend, batch);
        cost += result.cost;
        recordSpend({ cost: result.cost, model: result.model, jobs: batch.length });

        let top = 0;
        for (const { job, verdict } of result.pairs) {
          const status = decideStatus(verdict.score);
          saveScore(job.id, { ...verdict, status, scored_by: `${backend.id}:${result.model}` });
          scored++;
          if (status === 'shortlisted') shortlisted++;
          if (verdict.score > top) top = verdict.score;
        }
        done++;
        log.plain(`  ${String(done).padStart(3)}/${batches.length} ${c.green('ok')} ${c.grey('top score')} ${scoreColor(top)}`);

        // Stop before starting anything new once the ceiling is crossed.
        if (budget > 0 && alreadySpent + cost >= budget) stopped = 'budget';
      } catch (err) {
        done++;

        // Limits, billing and auth are fatal — every other batch would fail the
        // same way, so stop immediately instead of burning through the queue.
        if (err instanceof HardStopError) {
          stopped = err.kind;
          log.plain(`  ${String(done).padStart(3)}/${batches.length} ${c.red('STOPPED')}`);
          log.error(err.message);
          return;
        }
        log.plain(`  ${String(done).padStart(3)}/${batches.length} ${c.red('failed')} ${c.grey(err.message.slice(0, 90))}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  if (stopped === 'budget') {
    log.warn(`stopped at the $${budget.toFixed(2)} MAX_SPEND_USD ceiling — ${jobs.length - scored} jobs left unscored, and they'll be retried next run`);
  } else if (stopped) {
    log.warn(`stopped early (${stopped}) — ${jobs.length - scored} jobs left unscored; nothing is lost, they're retried next run`);
  }

  return { scored, shortlisted, cost, stopped };
}

async function scoreBatch(backend, batch) {
  const prompt = buildPrompt(batch);
  const { text, cost, model } = await backend.complete({ system: SYSTEM, prompt });

  let parsed = parseJson(text);
  // Some models wrap the array in an object; unwrap the first array we find.
  if (!Array.isArray(parsed)) {
    parsed = Object.values(parsed).find(Array.isArray) ?? [];
  }

  const byRef = new Map();
  for (const v of parsed) {
    if (v && Number.isFinite(Number(v.ref))) byRef.set(Number(v.ref), v);
  }

  const pairs = batch.map((job, i) => {
    const v = byRef.get(i + 1) ?? parsed[i] ?? {};
    return { job, verdict: normalize(v) };
  });

  return { pairs, cost, model };
}

function buildPrompt(batch) {
  const jobs = batch.map((j, i) => {
    const lines = [
      `### JOB ${i + 1}`,
      `ref: ${i + 1}`,
      `title: ${j.title}`,
      `company: ${j.company || 'not stated'}`,
      `location: ${j.location || 'not stated'}${j.is_remote ? ' (remote-friendly)' : ''}`,
      `contract: ${j.contract || 'not stated'}`,
      j.salary ? `compensation: ${j.salary}` : null,
      j.stack?.length ? `technologies mentioned: ${j.stack.join(', ')}` : null,
      j.posted_at ? `posted: ${j.posted_at.slice(0, 10)}` : null,
      `source: ${j.source}`,
      '',
      'description:',
      truncate(j.description || '(no description provided)', 2600),
    ];
    return lines.filter((l) => l !== null).join('\n');
  }).join('\n\n---\n\n');

  return `# CANDIDATE PROFILE

${JSON.stringify(stripComments(profile), null, 1)}

# TASK

Rate each of the ${batch.length} job postings below for how well it fits this candidate.

${SCHEMA}

# JOB POSTINGS

${jobs}

Now output the JSON array of ${batch.length} objects.`;
}

function normalize(v) {
  const score = clamp(Math.round(Number(v.score)), 0, 100);
  return {
    score: Number.isFinite(score) ? score : 0,
    verdict: typeof v.verdict === 'string' ? v.verdict.toLowerCase().slice(0, 20) : 'unknown',
    fit_summary: typeof v.fit_summary === 'string' ? truncate(v.fit_summary, 220) : '',
    pros: toList(v.pros),
    cons: toList(v.cons),
    pitch: typeof v.pitch === 'string' ? truncate(v.pitch, 600) : '',
  };
}

const toList = (v) =>
  (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : [])
    .filter((s) => typeof s === 'string' && s.trim())
    .slice(0, 4)
    .map((s) => truncate(s, 160));

function decideStatus(score) {
  const { shortlist_at = 70, reject_below = 40 } = filters.scoring ?? {};
  if (score >= shortlist_at) return 'shortlisted';
  if (score < reject_below) return 'rejected';
  return 'reviewed';
}

/** Fallback when no LLM is configured: rank by keyword density alone. */
function heuristicOnly(jobs) {
  let scored = 0;
  let shortlisted = 0;
  for (const job of jobs) {
    const stackHits = (job.stack ?? []).length;
    const base = Math.min(30 + stackHits * 6, 78);
    const bonus = (job.salary ? 6 : 0) + (job.is_remote ? 4 : 0);
    const score = Math.min(base + bonus, 85);
    const status = decideStatus(score);
    saveScore(job.id, {
      score,
      verdict: 'heuristic',
      fit_summary: `Keyword match only — ${stackHits} known technologies mentioned. No AI judgement (LLM_BACKEND=none).`,
      pros: (job.stack ?? []).slice(0, 3),
      cons: [],
      pitch: '',
      status,
      scored_by: 'heuristic',
    });
    scored++;
    if (status === 'shortlisted') shortlisted++;
  }
  return { scored, shortlisted, cost: 0 };
}

/** The `_comment` keys are documentation for the human, noise for the model. */
function stripComments(obj) {
  if (Array.isArray(obj)) return obj.filter((v) => !(typeof v === 'string' && v.startsWith('_comment'))).map(stripComments);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, stripComments(v)])
    );
  }
  return obj;
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
