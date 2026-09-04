import { createHash } from 'node:crypto';
import { getJSON } from '../lib/http.js';
import { getDb, upsertCompany, pendingCompanyScoring, saveCompanyScore } from '../lib/db.js';
import { profile, filters, env, sources } from '../config.js';
import { getBackend, parseJson } from '../llm/index.js';
import { HardStopError } from '../llm/claude.js';
import { recordSpend } from '../lib/db.js';
import { fold, truncate } from '../lib/text.js';
import { log, c, scoreColor } from '../lib/log.js';

/**
 * Companies worth approaching without waiting for them to advertise.
 *
 * Most hiring never reaches a job board — a team decides it needs someone, asks
 * around, and fills the role before anything is posted. A speculative approach
 * lands in front of that decision instead of behind fifty other applicants, so
 * the aim here is to find employers whose work plausibly needs this profile,
 * whether or not they have an opening today.
 */

const identity = (name) => createHash('sha1').update(fold(name)).digest('hex').slice(0, 16);

/* ------------------------------------------------------------- discovery */

/**
 * Employers already proven to hire this profile.
 *
 * The strongest signal available and it costs nothing: these companies have
 * advertised roles that passed the stack filter, sometimes repeatedly. A role
 * that closed last month is evidence the team exists and grows, which is
 * exactly what makes a speculative letter worth writing.
 */
export function fromJobHistory({ minJobs = 1, minBestScore = 55, limit = 400 } = {}) {
  const rows = getDb().prepare(`
    SELECT company,
           COUNT(*)                          AS job_count,
           MAX(score)                        AS best_score,
           GROUP_CONCAT(DISTINCT location)   AS locations,
           GROUP_CONCAT(DISTINCT contract)   AS contracts
      FROM jobs
     WHERE prefilter_pass = 1
       AND company IS NOT NULL AND TRIM(company) != ''
       AND LOWER(company) NOT IN ('unknown','okänd','ukendt','non précisé','ukendt','n/a')
     GROUP BY LOWER(company)
    HAVING job_count >= ? AND COALESCE(MAX(score), 0) >= ?
     ORDER BY best_score DESC, job_count DESC
     LIMIT ?`).all(minJobs, minBestScore, limit);

  const titles = getDb().prepare(`
    SELECT title FROM jobs
     WHERE LOWER(company) = LOWER(?) AND prefilter_pass = 1
     ORDER BY COALESCE(score, 0) DESC LIMIT 4`);

  let added = 0;
  for (const r of rows) {
    const sample = titles.all(r.company).map((t) => t.title);
    const isNew = upsertCompany({
      id: identity(r.company),
      name: r.company.trim(),
      source: 'job-history',
      location: firstOf(r.locations),
      job_count: r.job_count,
      best_job_score: r.best_score,
      sample_titles: sample,
      evidence: `Advertised ${r.job_count} role${r.job_count > 1 ? 's' : ''} matching this stack` +
                (r.best_score ? `, best fit scored ${r.best_score}/100` : '') +
                (r.contracts ? ` (${[...new Set(String(r.contracts).split(','))].filter((x) => x && x !== 'unknown').join(', ')})` : ''),
    });
    if (isNew) added++;
  }
  return { seen: rows.length, added };
}

const NAF_LABELS = {
  '62.01Z': 'Computer programming',
  '62.02A': 'IT systems consulting',
  '62.02B': 'IT consulting (other)',
  '62.03Z': 'IT facilities management',
  '62.09Z': 'Other IT services',
  '63.11Z': 'Data processing and hosting',
  '63.12Z': 'Web portals',
  '58.29A': 'Systems software publishing',
  '58.29C': 'Other software publishing',
};

/**
 * Local software companies from the French business register.
 *
 * A free government API (recherche-entreprises.api.gouv.fr) that can be
 * filtered by activity code and department, which is the only practical way to
 * enumerate the employers in commuting range. It knows nothing about what a
 * company builds — only its legal activity, size and address — so entries from
 * here start with weaker evidence than the job-history ones and are scored
 * accordingly.
 */
export async function fromRegistry({ departments, nafCodes, minEmployees = 3, maxPerCode = 100 } = {}) {
  const cfg = sources.companies?.registry ?? {};
  const depts = departments ?? cfg.departments ?? ['67'];
  const codes = nafCodes ?? cfg.naf_codes ?? ['62.01Z'];

  let seen = 0;
  let added = 0;

  for (const dept of depts) {
    for (const naf of codes) {
      const url = new URL('https://recherche-entreprises.api.gouv.fr/search');
      url.searchParams.set('activite_principale', naf);
      url.searchParams.set('departement', dept);
      url.searchParams.set('etat_administratif', 'A');   // still trading
      url.searchParams.set('per_page', String(Math.min(maxPerCode, 25)));
      url.searchParams.set('page', '1');

      const data = await getJSON(url.toString());
      for (const r of data?.results ?? []) {
        seen++;
        const staff = employeeCount(r.tranche_effectif_salarie);
        // A company with no employees is a one-person shell; it is not hiring.
        if (staff !== null && staff < minEmployees) continue;

        const town = r.siege?.libelle_commune ?? '';
        const name = (r.nom_complet || r.nom_raison_sociale || '').trim();
        if (!name) continue;

        const isNew = upsertCompany({
          id: identity(name),
          name,
          source: 'registry',
          location: [town, `dept ${dept}`].filter(Boolean).join(', '),
          siren: r.siren,
          naf: r.activite_principale,
          size: r.tranche_effectif_salarie ? `${r.tranche_effectif_salarie}+ employees` : null,
          description: [
            NAF_LABELS[r.activite_principale] ?? r.activite_principale,
            r.date_creation ? `founded ${String(r.date_creation).slice(0, 4)}` : null,
            r.categorie_entreprise ? `category ${r.categorie_entreprise}` : null,
          ].filter(Boolean).join(' · '),
          evidence: `Registered as ${NAF_LABELS[r.activite_principale] ?? r.activite_principale} in ${town || 'dept ' + dept}` +
                    (staff !== null ? `, around ${staff}+ staff` : ''),
        });
        if (isNew) added++;
      }
    }
  }
  return { seen, added };
}

// INSEE size brackets are the lower bound of a range, as a string.
function employeeCount(bracket) {
  if (bracket == null || bracket === '') return null;
  const n = Number(bracket);
  return Number.isFinite(n) ? n : null;
}

const firstOf = (csv) => (csv ? String(csv).split(',')[0].trim() : null);

/** Run every discovery source. */
export async function discoverCompanies(opts = {}) {
  const cfg = sources.companies ?? {};
  const results = {};

  if (cfg.job_history?.enabled !== false) {
    process.stdout.write(`  ${'job-history'.padEnd(16)} `);
    const r = fromJobHistory({
      minJobs: cfg.job_history?.min_jobs ?? 1,
      minBestScore: cfg.job_history?.min_best_score ?? 55,
      limit: cfg.job_history?.limit ?? 400,
    });
    console.log(`${String(r.seen).padStart(4)} found  ${c.green(String(r.added).padStart(3))} new`);
    results.jobHistory = r;
  }

  if (cfg.registry?.enabled !== false) {
    process.stdout.write(`  ${'registry'.padEnd(16)} `);
    const r = await fromRegistry(opts);
    console.log(`${String(r.seen).padStart(4)} found  ${c.green(String(r.added).padStart(3))} new`);
    results.registry = r;
  }

  return results;
}

/* --------------------------------------------------------------- scoring */

const SYSTEM = `You advise one developer on which companies are worth a speculative approach — a letter sent without any advertised vacancy.

This is a different judgement from rating a job posting. There is no role to match against, so you are asking: would this company plausibly want this person, and is an unsolicited approach likely to be read rather than binned?

What makes a good speculative target:
- The company builds software where this candidate's stack is genuinely used.
- It is big enough to hire but small enough that a letter reaches a decision-maker. Very large companies route everything through an ATS and speculative letters vanish; a two-person shell has no budget.
- Evidence it hires this kind of person — most obviously, it has advertised comparable roles before.
- Located where the candidate can actually work.

What makes a poor one:
- Recruitment agencies, ESN body-shops and staffing intermediaries. They already have a pipeline and a speculative letter adds nothing. Score these low and say why.
- Companies whose work is in a completely different technical world.
- Anything so large that an unsolicited letter has no route in.

Be decisive. Most companies are mediocre targets and should score below 55. Reserve 75+ for ones where you can name a concrete reason this specific person would be useful to them.

Output ONLY a JSON array. No prose, no markdown fences.`;

const SCHEMA = `Return a JSON array with one object per company, in the same order, each shaped:
{
  "ref": <the integer ref given>,
  "score": <0-100: how worthwhile a speculative approach is>,
  "verdict": <"strong" | "good" | "maybe" | "weak" | "reject">,
  "fit_summary": <one sentence, max 25 words, on why this score>,
  "pros": [<up to 3 short concrete reasons this is worth approaching>],
  "cons": [<up to 3 short concrete reasons it might not be>],
  "approach": <ONLY if score >= 60: one sentence on the angle to take — what to lead with, and who to aim at. Otherwise "">,
  "pitch": <ONLY if score >= 60: one or two sentences the candidate could open a speculative email with, specific to this company. Otherwise "">
}

Where the evidence is thin — a registry entry with only an activity code and a size — say so honestly in "cons" and score in the middle rather than inventing detail about what the company does.`;

/** Score companies for whether a speculative approach is worth making. */
export async function scoreCompanies({ limit = 60, batchSize = 8 } = {}) {
  const backend = getBackend();
  const pending = pendingCompanyScoring(limit);
  if (!pending.length) return { scored: 0, strong: 0, cost: 0 };

  if (!backend) {
    log.warn('LLM_BACKEND=none — cannot judge companies');
    return { scored: 0, strong: 0, cost: 0 };
  }

  const batches = chunk(pending, batchSize);
  const concurrency = Math.max(1, Math.min(env.scoreConcurrency, batches.length));
  log.info(`judging ${c.bold(String(pending.length))} companies in ${batches.length} batches ${c.grey(`(${concurrency} at a time)`)}`);

  let scored = 0;
  let strong = 0;
  let cost = 0;
  let done = 0;
  let stopped = null;
  let next = 0;

  async function worker() {
    while (next < batches.length && !stopped) {
      const batch = batches[next++];
      try {
        const { text, cost: batchCost, model } = await backend.complete({
          system: SYSTEM,
          prompt: buildPrompt(batch),
        });
        cost += batchCost;
        recordSpend({ cost: batchCost, model, jobs: batch.length });

        let parsed = parseJson(text);
        if (!Array.isArray(parsed)) parsed = Object.values(parsed).find(Array.isArray) ?? [];

        const byRef = new Map();
        for (const v of parsed) if (v && Number.isFinite(Number(v.ref))) byRef.set(Number(v.ref), v);

        let top = 0;
        batch.forEach((co, i) => {
          const v = normalize(byRef.get(i + 1) ?? parsed[i] ?? {});
          const status = v.score >= 70 ? 'shortlisted' : v.score < 35 ? 'rejected' : 'reviewed';
          saveCompanyScore(co.id, { ...v, status, scored_by: `${backend.id}:${model}` });
          scored++;
          if (v.score >= 70) strong++;
          if (v.score > top) top = v.score;
        });

        done++;
        log.plain(`  ${String(done).padStart(3)}/${batches.length} ${c.green('ok')} ${c.grey('top')} ${scoreColor(top)}`);
      } catch (err) {
        done++;
        if (err instanceof HardStopError) {
          stopped = err.kind;
          log.error(err.message);
          return;
        }
        log.plain(`  ${String(done).padStart(3)}/${batches.length} ${c.red('failed')} ${c.grey(err.message.slice(0, 80))}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { scored, strong, cost, stopped };
}

function buildPrompt(batch) {
  const blocks = batch.map((co, i) => [
    `### COMPANY ${i + 1}`,
    `ref: ${i + 1}`,
    `name: ${co.name}`,
    co.location ? `location: ${co.location}` : null,
    co.size ? `size: ${co.size}` : null,
    co.naf ? `registered activity: ${NAF_LABELS[co.naf] ?? co.naf}` : null,
    co.description ? `about: ${co.description}` : null,
    co.evidence ? `evidence: ${co.evidence}` : null,
    co.sample_titles?.length ? `roles they have advertised: ${co.sample_titles.join(' | ')}` : null,
    `how we found them: ${co.source}`,
  ].filter(Boolean).join('\n')).join('\n\n---\n\n');

  return `# CANDIDATE PROFILE

${JSON.stringify(stripComments(profile), null, 1)}

# TASK

For each company below, judge whether a speculative application is worth the candidate's time.

${SCHEMA}

# COMPANIES

${blocks}

Now output the JSON array of ${batch.length} objects.`;
}

function normalize(v) {
  const n = Math.round(Number(v.score));
  return {
    score: Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0,
    verdict: typeof v.verdict === 'string' ? v.verdict.toLowerCase().slice(0, 20) : 'unknown',
    fit_summary: typeof v.fit_summary === 'string' ? truncate(v.fit_summary, 220) : '',
    pros: toList(v.pros),
    cons: toList(v.cons),
    approach: typeof v.approach === 'string' ? truncate(v.approach, 400) : '',
    pitch: typeof v.pitch === 'string' ? truncate(v.pitch, 600) : '',
  };
}

const toList = (v) =>
  (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : [])
    .filter((s) => typeof s === 'string' && s.trim())
    .slice(0, 4)
    .map((s) => truncate(s, 160));

function stripComments(obj) {
  if (Array.isArray(obj)) return obj.filter((v) => !(typeof v === 'string' && v.startsWith('_comment'))).map(stripComments);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, stripComments(v)]));
  }
  return obj;
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/**
 * Present a company to the document writer as if it were a posting.
 *
 * The CV and cover-letter tools take a job. A speculative target has no job, so
 * one is synthesised from what is known about the company — which keeps a
 * single implementation of all three tools rather than a parallel set that
 * would drift.
 */
export function asPseudoJob(co) {
  const roleHint = co.sample_titles?.[0] || `${profile.headline || 'Developer'}`;
  return {
    id: `company:${co.id}`,
    title: `Speculative application — ${roleHint}`,
    company: co.name,
    location: co.location || '',
    is_remote: false,
    contract: 'unknown',
    salary: null,
    stack: [],
    url: co.website || '',
    posted_at: null,
    description: [
      'THIS IS A SPECULATIVE APPLICATION. The company has not advertised this role.',
      'There is no job posting to answer; write to the company about what they do and what the candidate could bring.',
      '',
      `Company: ${co.name}`,
      co.location ? `Location: ${co.location}` : null,
      co.size ? `Size: ${co.size}` : null,
      co.description ? `Activity: ${co.description}` : null,
      co.evidence ? `Why they are a target: ${co.evidence}` : null,
      co.sample_titles?.length ? `Roles they have advertised before: ${co.sample_titles.join(' | ')}` : null,
      co.approach ? `Suggested angle: ${co.approach}` : null,
      co.fit_summary ? `Assessment: ${co.fit_summary}` : null,
      (co.pros ?? []).length ? `In favour: ${co.pros.join('; ')}` : null,
      (co.cons ?? []).length ? `Against: ${co.cons.join('; ')}` : null,
    ].filter(Boolean).join('\n'),
  };
}
