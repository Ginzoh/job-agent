#!/usr/bin/env node
import { runPipeline, fetchAll } from './core/pipeline.js';
import { scoreAll } from './core/score.js';
import { writeDigest } from './core/digest.js';
import { startWeb } from './web/server.js';
import { listJobs, stats, setStatus, getJob, lastRuns, allJobs, updatePrefilter, resetScores, dedupe, totalSpend, spendSince, scoringBacklog } from './lib/db.js';
import { prefilter } from './core/prefilter.js';
import { getBackend } from './llm/index.js';
import { ALL_SOURCES } from './sources/index.js';
import { discoverCompanies, scoreCompanies } from './core/companies.js';
import { companyStats, listCompanies } from './lib/db.js';
import { testCredentials as testFranceTravail } from './sources/francetravail.js';
import { env, profile, filters, hasAdzuna, hasFranceTravail } from './config.js';
import { log, c, scoreColor } from './lib/log.js';
import { daysAgo, truncate } from './lib/text.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

/**
 * Which identifying profile fields still hold the example's text.
 *
 * Compared against config/profile.example.json rather than a hardcoded list,
 * so the check cannot drift out of date when the example changes.
 */
function uneditedProfileFields() {
  let example;
  try {
    example = JSON.parse(readFileSync(join(ROOT, 'config', 'profile.example.json'), 'utf8'));
  } catch {
    return []; // No example to compare against; say nothing rather than guess.
  }
  return ['name', 'headline', 'summary']
    .filter((k) => example[k] && profile[k] === example[k]);
}

const [, , command = 'help', ...rest] = process.argv;
const flags = parseFlags(rest);

const COMMANDS = {
  run: cmdRun,
  fetch: cmdFetch,
  score: cmdScore,
  refilter: cmdRefilter,
  companies: cmdCompanies,
  'companies:score': cmdCompaniesScore,
  list: cmdList,
  show: cmdShow,
  mark: cmdMark,
  digest: cmdDigest,
  web: cmdWeb,
  watch: cmdWatch,
  doctor: cmdDoctor,
  stats: cmdStats,
  help: cmdHelp,
};

const fn = COMMANDS[command];
if (!fn) {
  log.error(`unknown command "${command}"`);
  cmdHelp();
  process.exit(1);
}

try {
  await fn();
} catch (err) {
  log.error(err.message);
  if (flags.debug) console.error(err.stack);
  process.exit(1);
}

// ---------------------------------------------------------------- commands

async function cmdRun() {
  const t0 = Date.now();
  const r = await runPipeline({ skipScore: flags['no-score'] });

  log.step('Summary');
  log.plain(`  ${c.bold(String(r.newJobs))} new postings found (${r.fetched} seen across all sources)`);
  log.plain(`  ${c.bold(String(r.passed))} passed the relevance filter`);
  log.plain(`  ${c.bold(String(r.scored))} scored, ${c.green(String(r.shortlisted))} shortlisted`);
  if (r.cost > 0) log.plain(`  ${c.grey(`~$${r.cost.toFixed(3)} of model usage (covered by your Claude plan)`)}`);
  log.plain(`  ${c.grey(`took ${((Date.now() - t0) / 1000).toFixed(0)}s`)}`);

  const top = listJobs({ minScore: 70, limit: 8, order: 'score' });

  if (top.length) {
    log.step('Best matches right now');
    for (const j of top) printJob(j);
    log.plain(`\n  ${c.grey('Full detail:')} yarn web  ${c.grey('→')} http://localhost:${env.webPort}`);
  } else {
    log.plain(`\n  ${c.yellow('No strong matches yet.')} Add an Adzuna or France Travail key for much better French coverage — see .env.example`);
  }
}

async function cmdFetch() {
  log.step('Fetching sources');
  const r = await fetchAll();
  log.ok(`${r.newJobs} new postings (${r.passed} relevant) out of ${r.fetched} seen`);
}

async function cmdScore() {
  if (flags.rescore) {
    const n = resetScores();
    log.info(n
      ? `cleared ${n} verdicts made against an older profile — they'll be re-judged`
      : 'every verdict is already up to date with the current profile');
  }

  log.step('Scoring');
  const r = await scoreAll({ limit: flags.limit ? Number(flags.limit) : undefined });
  log.ok(`scored ${r.scored}, shortlisted ${r.shortlisted}${r.cost ? c.grey(` (~$${r.cost.toFixed(3)})`) : ''}`);

  // Say plainly whether another pass is needed — the per-run cap means one
  // invocation rarely finishes a large backlog.
  const b = scoringBacklog();
  const left = b.stale + b.unscored;
  if (left > 0) {
    const runs = Math.ceil(left / env.scoreMaxPerRun);
    log.plain(`\n  ${c.yellow(String(left))} still to go ${c.grey(`(${b.unscored} never scored, ${b.stale} judged on an older profile)`)}`);
    log.plain(`  ${c.cyan(`run \`yarn rescore\` ${runs} more time${runs > 1 ? 's' : ''}`)} ${c.grey(`— ${env.scoreMaxPerRun} per run, or raise SCORE_MAX_PER_RUN in .env`)}`);
    log.plain(`  ${c.grey('safe to repeat: it only re-judges what is actually out of date')}`);
  } else {
    log.plain(`\n  ${c.green('everything is scored and current')} ${c.grey(`(${b.current} jobs)`)}`);
  }
}

/**
 * Re-applies config/filters.json to everything already stored. Run this after
 * editing the filters — otherwise old postings keep the verdict they got when
 * they were first inserted, and a widened filter never reaches them.
 */
async function cmdRefilter() {
  const jobs = allJobs();
  log.step(`Re-filtering ${jobs.length} stored postings`);

  let opened = 0;
  let closed = 0;
  let changed = 0;

  for (const job of jobs) {
    const before = job.prefilter_pass;
    const v = prefilter(job);
    if (updatePrefilter(job.id, v.pass, v.note, job.status)) changed++;
    if (!before && v.pass) opened++;
    if (before && !v.pass) closed++;
  }

  log.ok(`${c.green(String(opened))} postings newly relevant, ${c.grey(String(closed) + ' newly filtered out')}`);
  if (changed) log.plain(`  ${c.grey(`${changed} status changes — your shortlisted/applied marks were left alone`)}`);

  const dd = dedupe();
  if (dd.hidden || dd.restored) {
    log.ok(`${dd.hidden} cross-posted duplicates hidden${dd.restored ? `, ${dd.restored} restored` : ''}`);
  }

  const s = stats();
  if (s.unscored) log.plain(`  ${c.cyan(`${s.unscored} now awaiting scoring — run \`yarn score\``)}`);
}

/**
 * Find companies worth approaching speculatively. Cheap: the job-history angle
 * is a query against data already collected, and the register is a free API.
 */
async function cmdCompanies() {
  log.step('Discovering companies');
  const r = await discoverCompanies();

  const added = Object.values(r).reduce((n, x) => n + (x?.added ?? 0), 0);
  const s = companyStats();
  log.ok(`${added} new, ${s.total} tracked in total`);
  if (s.unscored) {
    log.plain(`  ${c.cyan(`${s.unscored} awaiting judgement — run \`yarn companies:score\``)}`);
  }
}

async function cmdCompaniesScore() {
  log.step('Judging companies');
  const r = await scoreCompanies({ limit: flags.limit ? Number(flags.limit) : 60 });
  log.ok(`judged ${r.scored}, ${c.green(String(r.strong))} worth approaching${r.cost ? c.grey(` (~${r.cost.toFixed(3)})`) : ''}`);

  const s = companyStats();
  if (s.unscored) {
    log.plain(`\n  ${c.yellow(String(s.unscored))} still unjudged ${c.grey('— run it again; each pass takes the next batch')}`);
  } else {
    log.plain(`\n  ${c.green('every company judged')} ${c.grey(`(${s.strong} worth approaching)`)}`);
  }

  const top = listCompanies({ minScore: 70, limit: 6 });
  if (top.length) {
    log.step('Best speculative targets');
    for (const co of top) {
      log.plain('');
      log.plain(`  ${scoreColor(co.score)}  ${c.bold(truncate(co.name, 60))}`);
      log.plain(`       ${c.grey([co.location, co.size, co.job_count ? `${co.job_count} past postings` : null].filter(Boolean).join(' · '))}`);
      if (co.fit_summary) log.plain(`       ${truncate(co.fit_summary, 96)}`);
      if (co.approach) log.plain(`       ${c.cyan('Angle:')} ${truncate(co.approach, 90)}`);
    }
    log.plain('');
  }
}

async function cmdList() {
  const jobs = listJobs({
    status: flags.status,
    minScore: flags.min ? Number(flags.min) : 60,
    contract: flags.contract,
    remote: flags.remote ? true : undefined,
    search: flags.q,
    limit: Number(flags.limit) || 25,
    order: flags.order || 'score',
  });

  if (!jobs.length) return log.warn('nothing matches — try --min 40, or run `yarn start` first');

  log.step(`${jobs.length} opportunities`);
  for (const j of jobs) printJob(j);
  log.plain('');
}

async function cmdShow() {
  const id = rest.find((a) => !a.startsWith('-'));
  if (!id) return log.error('usage: node src/cli.js show <job-id>');
  const j = getJob(id);
  if (!j) return log.error('no job with that id');

  log.plain('');
  log.plain(`  ${c.bold(j.title)}  ${scoreColor(j.score ?? 0)}`);
  log.plain(`  ${c.grey(`${j.company} · ${j.location} · ${j.contract} · ${j.source}`)}`);
  log.plain(`  ${c.cyan(j.url)}`);
  if (j.fit_summary) log.plain(`\n  ${j.fit_summary}`);
  if (j.pros?.length) log.plain(`\n  ${c.green('For:')}\n${j.pros.map((p) => `    ✅ ${p}`).join('\n')}`);
  if (j.cons?.length) log.plain(`\n  ${c.yellow('Against:')}\n${j.cons.map((p) => `    ⚠️  ${p}`).join('\n')}`);
  if (j.pitch) log.plain(`\n  ${c.cyan('Opening line:')}\n    ${j.pitch}`);
  log.plain(`\n${c.grey('─'.repeat(72))}\n${truncate(j.description, 2500)}\n`);
}

async function cmdMark() {
  const [id, status] = rest.filter((a) => !a.startsWith('-'));
  if (!id || !status) return log.error('usage: node src/cli.js mark <job-id> <shortlisted|applied|rejected|archived>');
  if (!getJob(id)) return log.error('no job with that id');
  setStatus(id, status);
  log.ok(`marked ${id} as ${status}`);
}

async function cmdDigest() {
  const r = writeDigest({
    minScore: flags.min ? Number(flags.min) : 60,
    days: flags.days ? Number(flags.days) : 14,
  });
  log.ok(`wrote ${r.count} opportunities to ${c.cyan(r.path)}`);
  log.plain(`  ${c.grey('always-current copy:')} ${r.latest}`);
}

async function cmdWeb() {
  startWeb();
}

async function cmdWatch() {
  const minutes = flags.every ? Number(flags.every) : env.watchMinutes;
  log.ok(`watch mode — running now, then every ${minutes} minutes. Ctrl+C to stop.`);

  const tick = async () => {
    try {
      const r = await runPipeline();
      log.ok(`${r.newJobs} new · ${r.scored} scored · ${c.green(r.shortlisted + ' shortlisted')}`);
      if (r.shortlisted > 0) {
        writeDigest();
        log.info(`digest updated → out/latest.md`);
        process.stdout.write('\x07'); // terminal bell on a good match
      }
    } catch (err) {
      log.error(`run failed: ${err.message}`);
    }
    log.info(c.grey(`next run at ${new Date(Date.now() + minutes * 60000).toLocaleTimeString()}`));
  };

  await tick();
  setInterval(tick, minutes * 60000);

  if (flags.web) {
    startWeb();
  }
}

async function cmdStats() {
  const s = stats();
  log.step('Database');
  log.plain(`  tracked        ${c.bold(String(s.total))}`);
  log.plain(`  relevant       ${c.bold(String(s.relevant))}  ${c.grey(`(${s.filtered} filtered as noise, ${s.duplicates} cross-posted duplicates)`)}`);
  log.plain(`  shortlisted    ${c.green(String(s.shortlisted))}`);
  log.plain(`  applied        ${c.bold(String(s.applied))}`);
  log.plain(`  not interested ${c.grey(String(s.rejected))}`);
  log.plain(`  awaiting score ${c.bold(String(s.unscored))}`);
  log.plain(`  new this week  ${c.bold(String(s.last7))}`);
  log.plain(`  average score  ${c.bold(String(s.avgScore ?? '—'))}`);

  const spent = totalSpend();
  const budget = env.maxSpendUsd;
  const today = spendSince(new Date().toISOString().slice(0, 10));
  log.step('Model spend');
  log.plain(`  today          $${today.toFixed(3)}`);
  log.plain(`  lifetime       $${spent.toFixed(2)}${budget > 0 ? c.grey(`  of $${budget.toFixed(2)} ceiling`) : c.grey('  (no ceiling set)')}`);
  if (budget > 0) {
    const pct = Math.min(100, Math.round((spent / budget) * 100));
    const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '░');
    const paint = pct >= 90 ? c.red : pct >= 70 ? c.yellow : c.green;
    log.plain(`  ${paint(bar)} ${pct}%`);
  }
  log.plain(`  ${c.grey('This is what the CLI reports. Your account settings are the real limit — see README.')}`);

  log.step('By source');
  for (const r of s.bySource.slice(0, 20)) {
    log.plain(`  ${r.source.padEnd(24)} ${String(r.n).padStart(5)}`);
  }

  const runs = lastRuns(5);
  if (runs.length) {
    log.step('Recent runs');
    for (const r of runs) {
      log.plain(`  ${r.started_at.slice(0, 16).replace('T', ' ')}  ${String(r.new_jobs).padStart(4)} new  ${String(r.scored).padStart(4)} scored  ${c.green(String(r.shortlisted).padStart(3))} shortlisted`);
    }
  }
  log.plain('');
}

async function cmdDoctor() {
  log.step('Environment');
  const [maj] = process.versions.node.split('.').map(Number);
  check(maj >= 22, `Node ${process.versions.node}`, 'Node 22.5+ required for the built-in SQLite module');

  try {
    await import('node:sqlite');
    check(true, 'node:sqlite available');
  } catch {
    check(false, 'node:sqlite missing', 'upgrade Node to 22.5 or newer');
  }

  log.step('Configuration');
  check(!!profile.name, `profile: ${profile.name} — ${profile.headline}`, 'set your name in config/profile.json');
  check((profile.skills?.expert ?? []).length > 0, `expert skills: ${(profile.skills?.expert ?? []).join(', ')}`);
  check(true, `accepting: ${(profile.seeking?.contract_types ?? []).join(', ')}`);
  check(true, `locations: ${(filters.location?.accept ?? []).slice(0, 6).join(', ')}…`);
  // Only say this when it is true. An unconditional warning is noise for
  // anyone who has already edited their profile, and it teaches them to skim
  // past the warnings that do matter.
  const placeholders = uneditedProfileFields();
  if (placeholders.length) {
    log.plain(`  ${c.grey(`⚠ config/profile.json still has the example text for: ${placeholders.join(', ')} — edit it so scoring reflects YOUR CV`)}`);
  }

  log.step('LLM backend');
  if (env.llmBackend === 'none') {
    log.warn('LLM_BACKEND=none — you will get keyword scores only, no real judgement');
  } else {
    const backend = getBackend();
    const status = await backend.available();
    check(status.ok, `${backend.id} (${backend.id === 'claude' ? env.claudeModel : env.ollamaModel})`, status.reason);
  }

  log.step('Sources');
  for (const s of ALL_SOURCES) {
    const on = s.enabled();
    log.plain(`  ${on ? c.green('on ') : c.grey('off')} ${s.name.padEnd(16)} ${on ? '' : c.grey(s.skipReason ?? 'disabled in config/sources.json')}`);
  }

  log.step('Optional keys');
  check(hasAdzuna(), 'Adzuna', 'strongly recommended for France — free key at https://developer.adzuna.com/signup');

  // Presence of the keys says nothing about whether they work, so actually
  // exchange them for a token and report exactly what went wrong.
  if (!hasFranceTravail()) {
    check(false, 'France Travail', 'the official French job API — free key at https://francetravail.io');
  } else {
    process.stdout.write(`  ${c.grey('…')} France Travail — testing credentials`);
    const r = await testFranceTravail();
    process.stdout.write('\r' + ' '.repeat(52) + '\r');
    check(r.ok, `France Travail${r.ok && r.scope?.startsWith('application_') ? c.grey(' (legacy scope)') : ''}`, r.reason);
  }

  const s = stats();
  log.step('Data');
  log.plain(`  ${s.total} postings tracked, ${s.shortlisted} shortlisted`);
  log.plain(s.total === 0 ? `  ${c.cyan('→ run `yarn start` to do your first fetch')}` : '');
  log.plain('');
}

function cmdHelp() {
  log.plain(`
${c.bold('job-agent')} — finds contract and permanent work matching your stack.

${c.bold('Usage:')} node src/cli.js <command> [options]

  ${c.cyan('run')}       fetch every source, filter, and score the new results   ${c.grey('← the main one')}
  ${c.cyan('watch')}     keep running on a schedule  ${c.grey('[--every 360] [--web]')}
  ${c.cyan('web')}       start the dashboard at http://localhost:${env.webPort}
  ${c.cyan('list')}      print matches  ${c.grey('[--min 70] [--remote] [--contract freelance] [--q react] [--limit 25]')}
            ${c.grey('--status open (default: not applied/rejected) | shortlisted | applied | decided | all')}
  ${c.cyan('show')}      full detail for one posting  ${c.grey('<job-id>')}
  ${c.cyan('mark')}      set status  ${c.grey('<job-id> <shortlisted|applied|rejected|archived>')}
  ${c.cyan('digest')}    write a Markdown briefing to out/  ${c.grey('[--min 60] [--days 14]')}
  ${c.cyan('fetch')}     fetch only, no scoring
  ${c.cyan('score')}     score whatever is pending  ${c.grey('[--limit 50] [--rescore]')}
  ${c.cyan('companies')}       find companies worth writing to with no vacancy advertised
  ${c.cyan('companies:score')} judge those companies  ${c.grey('[--limit 60]')}
  ${c.cyan('refilter')}  re-apply filters.json to everything already stored  ${c.grey('← after editing filters')}

${c.grey('  After editing config/profile.json:  node src/cli.js score --rescore')}
${c.grey('  After editing config/filters.json:  node src/cli.js refilter')}
  ${c.cyan('stats')}     what's in the database
  ${c.cyan('doctor')}    check your setup   ${c.grey('← start here')}

${c.bold('First run:')}
  yarn doctor             ${c.grey('verify everything is wired up')}
  ${c.grey('edit')} config/profile.json  ${c.grey('so scoring matches your real CV')}
  yarn start              ${c.grey('fetch + score')}
  yarn web                ${c.grey('browse the results')}

${c.grey('Yarn shadows two of these names with its own built-ins, so the shortcuts are:')}
${c.grey('  yarn start   = the run command      (yarn run  just lists scripts)')}
${c.grey('  yarn jobs    = the list command     (yarn list shows dependencies)')}
`);
}

// ----------------------------------------------------------------- helpers

function printJob(j) {
  const age = daysAgo(j.posted_at);
  const bits = [
    j.company || 'unknown',
    j.location || '—',
    j.is_remote ? c.magenta('remote') : null,
    j.contract && j.contract !== 'unknown' ? j.contract : null,
    j.salary,
    age != null ? `${age}d` : null,
  ].filter(Boolean).join(c.grey(' · '));

  log.plain('');
  log.plain(`  ${scoreColor(j.score ?? 0).padStart(3)}  ${c.bold(truncate(j.title, 74))}`);
  log.plain(`       ${c.grey(bits)}`);
  if (j.fit_summary) log.plain(`       ${truncate(j.fit_summary, 96)}`);
  log.plain(`       ${c.cyan(truncate(j.url, 92))}`);
  log.plain(`       ${c.grey('id ' + j.id)}`);
}

function check(ok, label, hint) {
  if (ok) log.plain(`  ${c.green('✓')} ${label}`);
  else {
    log.plain(`  ${c.yellow('○')} ${label}`);
    if (hint) log.plain(`      ${c.grey(hint)}`);
  }
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}
