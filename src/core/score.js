import { profile, filters, env } from '../config.js';
import { getBackend, parseJson } from '../llm/index.js';
import { HardStopError } from '../llm/claude.js';
import { pendingScoring, saveScore, recordSpend, totalSpend } from '../lib/db.js';
import { truncate } from '../lib/text.js';
import { log, c, scoreColor } from '../lib/log.js';

const SYSTEM = `You are a hard-nosed technical recruiter working exclusively for one developer. You screen job postings and rate how well each one fits that specific person.

You are paid to be discriminating, not encouraging. Most postings are a poor fit and should score below 50. Reserve scores above 80 for genuinely strong matches — right stack, right location, real company, real work. A posting that is vague, is obvious recruiter spam, hides the company name, or describes a stack the candidate does not work in is a bad fit no matter how nicely it is written.

Being discriminating is about the QUALITY of the match, not about gatekeeping the candidate. Your job is to find work they can realistically get and would want — not to filter them out of roles they could do. A stretch role they'd probably be interviewed for is a good result; missing it is a worse failure than including one borderline listing.

Judge against the candidate profile you are given, not against some generic ideal candidate.

Judge each posting entirely on its own merits. Several jobs are given to you at once purely for efficiency — they are not a ranked set and are not competing with each other. Never compare one to another, never reference another job's number, and never write things like "same as job 3" or "better than the previous role". Someone reading a single result will have no idea what the others were.

Output ONLY a JSON array. No prose, no markdown fences, no explanation before or after.`;

const SCHEMA = `Return a JSON array with exactly one object per job, in the same order, each shaped:
{
  "ref": <the integer ref of the job>,
  "score": <integer 0-100, how well this fits THIS candidate>,
  "verdict": <"strong" | "good" | "maybe" | "weak" | "reject">,
  "fit_summary": <one sentence, max 25 words, plain and concrete: why this score. Must stand alone — no reference to any other job in this batch>,
  "pros": [<up to 3 short specific strings>],
  "cons": [<up to 3 short specific strings; include any dealbreaker you spotted>],
  "pitch": <ONLY if score >= 70: one or two sentences the candidate could open an application or cold email with, referencing something specific about THIS role. Otherwise "">
}

Scoring guidance:
- 85-100: stack, seniority and location all match well; genuine opportunity worth applying to today.
- 70-84:  good match with a minor gap (one unfamiliar technology, hybrid when they prefer remote, etc).
- 50-69:  plausible but with real friction — adjacent stack, unclear scope, or seniority slightly off.
- 30-49:  weak. Mostly wrong stack or wrong kind of role.
- 0-29:   reject. Wrong discipline, wrong location, a dealbreaker, or content-free recruiter spam.

HOW TO TREAT YEARS OF EXPERIENCE

Score on the likelihood of actually being hired, not on how impressive the posting sounds. A perfect stack match the candidate will never be shortlisted for is worth less to them than a decent match they are genuinely competitive for.

Stated year requirements are soft — employers ask for more than they need, and "3-5 ans d'expérience" is close to boilerplate in France. But soft does not mean ignorable: a one-year gap and a five-year gap are not the same thing, and scoring them alike sends the candidate chasing roles they will not get while burying the ones they would.

Work from the gap between the candidate's real experience and the posting's stated minimum. Where a RANGE is given, use the LOWER bound: "3-5 ans" for a candidate with 2 years is a gap of 1, not 3.

- Gap of 0-1 years — no deduction. Do not even raise it as a con unless something else compounds it.
- Gap of 2 years — real but crossable. Cap the score at about 72 unless the stack match is exceptional. Note it in "cons".
- Gap of 3 years — unlikely to be shortlisted without something outstanding elsewhere. Cap at about 62.
- Gap of 4 or more years — cap at 45. A flawless stack match does not fix this; these roles go to people who have the years.

Where NO figure is given, do not invent one. Judge on the described responsibilities and the seniority word in the title.

Independently of the number: a role that is explicitly senior/lead/staff/principal WITH team-leading, architecture-ownership or line-management duties is a poor fit regardless of how the years are phrased.

ROLES WHERE THIS CANDIDATE IS THE EXPECTED APPLICANT — score these UP

This side matters just as much, and is easy to under-weight. A posting written for someone at exactly this stage deserves to outrank a generic good-stack match, because the candidate is competitive rather than hopeful. Add real weight, and say so in "pros", when a posting shows:

- A QUALIFICATION requirement instead of a years requirement — "Bac+5", "Master en informatique", "diplôme d'ingénieur", "MSc in Computer Science", "formation supérieure en informatique". These filter on a credential the candidate holds rather than on time served, and are among the strongest positive signals available.
- Explicit openness to early-career applicants: "junior", "débutant accepté", "jeune diplômé", "première expérience", "1-3 ans", "profil junior ou confirmé", "graduate", "entry level", "0-2 years". (Student-only formats — stage, alternance, apprentissage — are excluded elsewhere and are not this.)
- Language about training, mentoring, onboarding, pair programming or a progression path: a team that expects to develop someone rather than buy finished expertise.
- Responsibilities framed as building features and owning delivery, rather than defining architecture, setting technical direction or leading others.

Concretely: a role asking Bac+5 with 0-2 years on a React/Node stack should score HIGHER than a role asking 5 years on an identical stack. The first is a job the candidate can get; the second is one they will be filtered out of.

Penalise heavily: an explicit dealbreaker from the profile, a core required stack the candidate does not have at all, or a location they cannot work from.
Reward: an explicitly stated salary or TJM, a named product company, modern TypeScript tooling, and a clearly described mission.`;

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
