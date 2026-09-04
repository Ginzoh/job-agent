import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT, profileFingerprint } from '../config.js';
import { contentKey } from './text.js';

const DB_PATH = join(ROOT, 'data', 'jobs.db');

let db;

export function getDb() {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id             TEXT PRIMARY KEY,
      source         TEXT NOT NULL,
      source_id      TEXT,
      title          TEXT NOT NULL,
      company        TEXT,
      location       TEXT,
      is_remote      INTEGER DEFAULT 0,
      contract       TEXT,
      url            TEXT,
      apply_url      TEXT,
      description    TEXT,
      salary         TEXT,
      stack          TEXT,
      posted_at      TEXT,
      first_seen     TEXT NOT NULL,
      last_seen      TEXT NOT NULL,

      prefilter_pass INTEGER DEFAULT 0,
      prefilter_note TEXT,

      score          INTEGER,
      verdict        TEXT,
      fit_summary    TEXT,
      pros           TEXT,
      cons           TEXT,
      pitch          TEXT,
      scored_at      TEXT,
      scored_by      TEXT,

      status         TEXT NOT NULL DEFAULT 'new',
      notes          TEXT,
      updated_at     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status    ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_score     ON jobs(score DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_first     ON jobs(first_seen DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_prefilter ON jobs(prefilter_pass, score);

    -- Every paid call is logged here, so the budget ceiling survives restarts.
    -- The runs table only covers full pipeline runs, so a bare "yarn score"
    -- would otherwise spend untracked.
    CREATE TABLE IF NOT EXISTS spend (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      at       TEXT NOT NULL,
      cost_usd REAL NOT NULL,
      model    TEXT,
      jobs     INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_spend_at ON spend(at);

    -- Generated CVs, cover letters and advice, kept so you can reopen them
    -- without paying to regenerate.
    CREATE TABLE IF NOT EXISTS documents (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id   TEXT NOT NULL,
      kind     TEXT NOT NULL,
      content  TEXT NOT NULL,
      model    TEXT,
      cost_usd REAL,
      options  TEXT,
      at       TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_docs_job ON documents(job_id, kind, at DESC);

    -- Companies worth approaching without them having advertised anything.
    -- Deliberately separate from jobs: a company is a standing target that stays
    -- relevant for months, whereas a posting is a dated event that expires.
    CREATE TABLE IF NOT EXISTS companies (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      source         TEXT NOT NULL,
      location       TEXT,
      website        TEXT,
      siren          TEXT,
      naf            TEXT,
      size           TEXT,
      description    TEXT,
      evidence       TEXT,
      job_count      INTEGER DEFAULT 0,
      best_job_score INTEGER,
      sample_titles  TEXT,

      score          INTEGER,
      verdict        TEXT,
      fit_summary    TEXT,
      pros           TEXT,
      cons           TEXT,
      pitch          TEXT,
      approach       TEXT,
      scored_at      TEXT,
      scored_by      TEXT,
      scored_profile TEXT,

      status         TEXT NOT NULL DEFAULT 'new',
      notes          TEXT,
      first_seen     TEXT NOT NULL,
      updated_at     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_co_status ON companies(status);
    CREATE INDEX IF NOT EXISTS idx_co_score  ON companies(score DESC);

    CREATE TABLE IF NOT EXISTS runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at  TEXT,
      finished_at TEXT,
      fetched     INTEGER DEFAULT 0,
      new_jobs    INTEGER DEFAULT 0,
      passed      INTEGER DEFAULT 0,
      scored      INTEGER DEFAULT 0,
      shortlisted INTEGER DEFAULT 0,
      cost_usd    REAL DEFAULT 0,
      detail      TEXT
    );
  `);

  // Added after the first release — existing databases need the column.
  const cols = d.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  if (!cols.includes('content_key')) {
    d.exec('ALTER TABLE jobs ADD COLUMN content_key TEXT');
    d.exec('CREATE INDEX IF NOT EXISTS idx_jobs_content ON jobs(content_key)');
    dedupe(d);
  }

  // Which profile version produced each verdict. Existing scores predate this,
  // so they stay NULL and count as stale — exactly right, since they were made
  // against an older profile.
  if (!cols.includes('scored_profile')) {
    d.exec('ALTER TABLE jobs ADD COLUMN scored_profile TEXT');
    d.exec('CREATE INDEX IF NOT EXISTS idx_jobs_profile ON jobs(scored_profile)');
  }
}

/**
 * Collapse the same role cross-posted to several boards down to one visible
 * listing. Idempotent, so it can be re-run after the matching rules change.
 *
 * Only `applied` is treated as sacred. `shortlisted` looks like a decision but
 * is assigned automatically from the score, so protecting it would leave
 * duplicates of exactly the jobs you most want a clean list of.
 */
export function dedupe(handle) {
  const d = handle ?? getDb();
  const rows = d.prepare('SELECT id, company, title, location, is_remote, status, score, prefilter_pass, description FROM jobs').all();

  const setKey = d.prepare('UPDATE jobs SET content_key=? WHERE id=?');
  const groups = new Map();

  for (const r of rows) {
    const key = contentKey({ company: r.company, title: r.title, location: r.location, is_remote: !!r.is_remote });
    setKey.run(key, r.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  // Prefer a real application, then the better score, then the fuller text.
  const rank = (r) => [
    r.status === 'applied' ? 1 : 0,
    r.score ?? -1,
    (r.description || '').length,
  ];
  const better = (a, b) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
  };

  const markDup = d.prepare("UPDATE jobs SET status='duplicate', updated_at=? WHERE id=? AND status != 'applied'");
  const restore = d.prepare('UPDATE jobs SET status=?, updated_at=? WHERE id=?');
  let hidden = 0;
  let restored = 0;

  for (const group of groups.values()) {
    const keeper = group.reduce((best, r) => (better(r, best) ? r : best), group[0]);

    for (const r of group) {
      if (r === keeper) {
        // A previous run may have hidden this one; it's the survivor now.
        if (r.status === 'duplicate') {
          restore.run(r.prefilter_pass ? 'new' : 'filtered', now(), r.id);
          restored++;
        }
      } else if (r.status !== 'duplicate' && r.status !== 'applied') {
        markDup.run(now(), r.id);
        hidden++;
      }
    }
  }

  return { hidden, restored, groups: groups.size };
}

const now = () => new Date().toISOString();

/**
 * Insert a job, or refresh `last_seen` if we already have it.
 * Returns true when the job is new to us.
 */
export function upsertJob(job) {
  const d = getDb();
  const existing = d.prepare('SELECT id FROM jobs WHERE id = ?').get(job.id);

  if (existing) {
    d.prepare('UPDATE jobs SET last_seen = ? WHERE id = ?').run(now(), job.id);
    return false;
  }

  // The same role cross-posted to another board: keep it, but don't surface it
  // twice or pay to score it again.
  const key = contentKey(job);
  const twin = d.prepare("SELECT id FROM jobs WHERE content_key = ? AND status != 'duplicate' LIMIT 1").get(key);

  const status = twin ? 'duplicate' : job.prefilter_pass ? 'new' : 'filtered';
  if (twin) d.prepare('UPDATE jobs SET last_seen = ? WHERE id = ?').run(now(), twin.id);

  d.prepare(`
    INSERT INTO jobs (
      id, source, source_id, title, company, location, is_remote, contract,
      url, apply_url, description, salary, stack, posted_at,
      first_seen, last_seen, prefilter_pass, prefilter_note, status, content_key, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    job.id, job.source, job.source_id ?? null, job.title, job.company ?? null,
    job.location ?? null, job.is_remote ? 1 : 0, job.contract ?? 'unknown',
    job.url ?? null, job.apply_url ?? null, job.description ?? null,
    job.salary ?? null, JSON.stringify(job.stack ?? []), job.posted_at ?? null,
    now(), now(), job.prefilter_pass ? 1 : 0, job.prefilter_note ?? null,
    status, key, now()
  );
  return !twin;
}

/** Jobs that passed the cheap filter but haven't been through the LLM yet. */
export function pendingScoring(limit = 200) {
  return getDb().prepare(`
    SELECT * FROM jobs
    WHERE prefilter_pass = 1 AND score IS NULL AND status = 'new' AND status != 'duplicate'
    ORDER BY (posted_at IS NULL), posted_at DESC, first_seen DESC
    LIMIT ?
  `).all(limit).map(hydrate);
}

export function saveScore(id, s) {
  getDb().prepare(`
    UPDATE jobs SET score=?, verdict=?, fit_summary=?, pros=?, cons=?, pitch=?,
                    scored_at=?, scored_by=?, scored_profile=?, status=?, updated_at=?
    WHERE id=?
  `).run(
    s.score, s.verdict ?? null, s.fit_summary ?? null,
    JSON.stringify(s.pros ?? []), JSON.stringify(s.cons ?? []),
    s.pitch ?? null, now(), s.scored_by ?? null, profileFingerprint,
    s.status, now(), id
  );
}

export function setStatus(id, status, notes) {
  const d = getDb();
  if (notes === undefined) {
    d.prepare('UPDATE jobs SET status=?, updated_at=? WHERE id=?').run(status, now(), id);
  } else {
    d.prepare('UPDATE jobs SET status=?, notes=?, updated_at=? WHERE id=?').run(status, notes, now(), id);
  }
}

export function getJob(id) {
  const r = getDb().prepare('SELECT * FROM jobs WHERE id=?').get(id);
  return r ? hydrate(r) : null;
}

/**
 * Named status views. `open` is the default and the one that matters most:
 * everything still worth acting on — nothing you've applied to, dismissed or
 * archived, and none of the noise.
 */
export const STATUS_VIEWS = {
  open:    "status NOT IN ('filtered','duplicate','applied','rejected','archived')",
  active:  "status NOT IN ('filtered','duplicate')",
  decided: "status IN ('applied','rejected','archived')",
  all:     "status != 'duplicate'",
};

/** Flexible listing used by both the CLI and the web dashboard. */
export function listJobs({ status, minScore, source, contract, remote, since, search, limit = 100, offset = 0, order = 'score' } = {}) {
  const where = [];
  const args = [];

  // Besides the literal statuses, a few named views cover the questions you
  // actually ask: "what's left to do", "what have I touched", "show me all of it".
  if (!status) where.push(STATUS_VIEWS.open); // default: the actionable queue
  else if (STATUS_VIEWS[status]) where.push(STATUS_VIEWS[status]);
  else { where.push('status = ?'); args.push(status); }

  if (minScore != null) { where.push('score >= ?'); args.push(minScore); }
  if (source) { where.push('source = ?'); args.push(source); }
  if (contract) { where.push('contract = ?'); args.push(contract); }
  if (remote === true) where.push('is_remote = 1');
  if (since) { where.push('first_seen >= ?'); args.push(since); }
  if (search) {
    where.push('(title LIKE ? OR company LIKE ? OR description LIKE ?)');
    const q = `%${search}%`;
    args.push(q, q, q);
  }

  const orderSql = {
    score: 'score DESC NULLS LAST, first_seen DESC',
    date: '(posted_at IS NULL), posted_at DESC, first_seen DESC',
    seen: 'first_seen DESC',
  }[order] ?? 'score DESC NULLS LAST, first_seen DESC';

  const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderSql} LIMIT ? OFFSET ?`;
  return getDb().prepare(sql).all(...args, limit, offset).map(hydrate);
}

export function countJobs(filters = {}) {
  return listJobs({ ...filters, limit: 100000, offset: 0 }).length;
}

/**
 * Clear verdicts that were made against an OLDER profile, so they get re-judged.
 *
 * Only stale ones are cleared, which makes this safe to run repeatedly — each
 * pass chips away at the backlog instead of redoing work already done under the
 * current profile.
 *
 * `applied` and `archived` are protected because you chose them. `shortlisted`
 * is NOT protected: it's assigned automatically from the score, so leaving it
 * out would permanently freeze your best matches at an old profile's judgement.
 */
export function resetScores() {
  const info = getDb().prepare(`
    UPDATE jobs
       SET score=NULL, verdict=NULL, fit_summary=NULL, pros=NULL, cons=NULL,
           pitch=NULL, scored_at=NULL, scored_by=NULL, scored_profile=NULL,
           status='new', updated_at=?
     WHERE prefilter_pass = 1
       AND score IS NOT NULL
       AND status NOT IN ('applied','archived')
       AND (scored_profile IS NULL OR scored_profile != ?)
  `).run(now(), profileFingerprint);
  return info.changes;
}

/** How much work an up-to-date picture would still need. */
export function scoringBacklog() {
  const d = getDb();
  const one = (sql, ...a) => d.prepare(sql).get(...a).n;
  return {
    stale: one(
      `SELECT COUNT(*) n FROM jobs WHERE prefilter_pass=1 AND score IS NOT NULL
         AND status NOT IN ('applied','archived')
         AND (scored_profile IS NULL OR scored_profile != ?)`, profileFingerprint),
    unscored: one("SELECT COUNT(*) n FROM jobs WHERE prefilter_pass=1 AND score IS NULL AND status='new'"),
    current: one('SELECT COUNT(*) n FROM jobs WHERE scored_profile = ?', profileFingerprint),
  };
}

/** Every stored job, for re-running the prefilter after a config change. */
export function allJobs() {
  return getDb().prepare('SELECT * FROM jobs').all().map(hydrate);
}

/**
 * Update a job's prefilter verdict in place.
 * Statuses you set by hand (shortlisted/applied/rejected/archived) are never
 * touched — re-filtering must not undo your own decisions.
 */
export function updatePrefilter(id, pass, note, currentStatus) {
  const d = getDb();
  // 'duplicate' is preserved too — it's owned by dedupe(), not by the filter,
  // and resetting it here would just make the two fight over the same rows.
  const manual = ['shortlisted', 'applied', 'rejected', 'archived', 'duplicate'].includes(currentStatus);

  let status = currentStatus;
  if (!manual) {
    if (!pass) status = 'filtered';
    else if (currentStatus === 'filtered') status = 'new';
  }

  d.prepare('UPDATE jobs SET prefilter_pass=?, prefilter_note=?, status=?, updated_at=? WHERE id=?')
    .run(pass ? 1 : 0, note, status, now(), id);

  return status !== currentStatus;
}

export function stats() {
  const d = getDb();
  const one = (sql, ...a) => d.prepare(sql).get(...a);
  return {
    total: one('SELECT COUNT(*) n FROM jobs').n,
    filtered: one("SELECT COUNT(*) n FROM jobs WHERE status='filtered'").n,
    duplicates: one("SELECT COUNT(*) n FROM jobs WHERE status='duplicate'").n,
    relevant: one("SELECT COUNT(*) n FROM jobs WHERE status NOT IN ('filtered','duplicate')").n,
    unscored: one("SELECT COUNT(*) n FROM jobs WHERE prefilter_pass=1 AND score IS NULL AND status='new'").n,
    shortlisted: one("SELECT COUNT(*) n FROM jobs WHERE status='shortlisted'").n,
    applied: one("SELECT COUNT(*) n FROM jobs WHERE status='applied'").n,
    rejected: one("SELECT COUNT(*) n FROM jobs WHERE status='rejected'").n,
    last7: one("SELECT COUNT(*) n FROM jobs WHERE first_seen >= ?", new Date(Date.now() - 7 * 864e5).toISOString()).n,
    bySource: d.prepare('SELECT source, COUNT(*) n FROM jobs GROUP BY source ORDER BY n DESC').all(),
    avgScore: one('SELECT ROUND(AVG(score),1) a FROM jobs WHERE score IS NOT NULL').a,
    totalCost: one('SELECT ROUND(SUM(cost_usd),4) c FROM runs').c ?? 0,
  };
}

export function saveDocument({ jobId, kind, content, model, cost, options }) {
  const at = now();
  const info = getDb().prepare(
    'INSERT INTO documents (job_id, kind, content, model, cost_usd, options, at) VALUES (?,?,?,?,?,?,?)'
  ).run(jobId, kind, content, model ?? null, cost ?? 0, JSON.stringify(options ?? {}), at);
  return { id: Number(info.lastInsertRowid), at };
}

/** Most recent document of each kind for a job, newest first. */
export function listDocuments(jobId) {
  return getDb().prepare('SELECT id, job_id, kind, model, cost_usd, options, at FROM documents WHERE job_id=? ORDER BY at DESC').all(jobId);
}

export function getDocument(id) {
  return getDb().prepare('SELECT * FROM documents WHERE id=?').get(id);
}

export function deleteDocument(id) {
  getDb().prepare('DELETE FROM documents WHERE id=?').run(id);
}

export function recordSpend({ cost, model, jobs }) {
  if (!cost || cost <= 0) return;
  getDb().prepare('INSERT INTO spend (at, cost_usd, model, jobs) VALUES (?,?,?,?)')
    .run(now(), cost, model ?? null, jobs ?? null);
}

/** Lifetime spend as reported by the CLI. Used to enforce the budget ceiling. */
export function totalSpend() {
  return getDb().prepare('SELECT COALESCE(SUM(cost_usd), 0) s FROM spend').get().s;
}

export function spendSince(iso) {
  return getDb().prepare('SELECT COALESCE(SUM(cost_usd), 0) s FROM spend WHERE at >= ?').get(iso).s;
}

export function recordRun(r) {
  getDb().prepare(`
    INSERT INTO runs (started_at, finished_at, fetched, new_jobs, passed, scored, shortlisted, cost_usd, detail)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(r.started_at, r.finished_at, r.fetched, r.new_jobs, r.passed, r.scored, r.shortlisted, r.cost_usd ?? 0, JSON.stringify(r.detail ?? {}));
}

export function lastRuns(n = 10) {
  return getDb().prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(n);
}

/** Turn stored JSON columns back into real values. */
function hydrate(row) {
  const parse = (v, fallback) => {
    try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  };
  return {
    ...row,
    is_remote: !!row.is_remote,
    prefilter_pass: !!row.prefilter_pass,
    stack: parse(row.stack, []),
    pros: parse(row.pros, []),
    cons: parse(row.cons, []),
  };
}


/* ------------------------------------------------------------- companies */

/**
 * Insert a company, or merge fresh evidence into one already known.
 *
 * Discovery runs from several angles and they overlap: the registry knows a
 * company's legal size and address, the jobs table knows it actually hires this
 * profile. Neither alone is the full picture, so a second sighting fills gaps
 * rather than overwriting what the first found.
 */
export function upsertCompany(co) {
  const d = getDb();
  const existing = d.prepare('SELECT id FROM companies WHERE id = ?').get(co.id);

  if (existing) {
    d.prepare(`
      UPDATE companies SET
        location       = COALESCE(NULLIF(?, ''), location),
        website        = COALESCE(NULLIF(?, ''), website),
        siren          = COALESCE(NULLIF(?, ''), siren),
        naf            = COALESCE(NULLIF(?, ''), naf),
        size           = COALESCE(NULLIF(?, ''), size),
        description    = COALESCE(NULLIF(?, ''), description),
        evidence       = COALESCE(NULLIF(?, ''), evidence),
        job_count      = MAX(COALESCE(job_count, 0), ?),
        best_job_score = MAX(COALESCE(best_job_score, 0), COALESCE(?, 0)),
        sample_titles  = COALESCE(NULLIF(?, '[]'), sample_titles),
        source         = CASE WHEN instr(source, ?) > 0 THEN source ELSE source || '+' || ? END,
        updated_at     = ?
      WHERE id = ?`).run(
      co.location ?? '', co.website ?? '', co.siren ?? '', co.naf ?? '',
      co.size ?? '', co.description ?? '', co.evidence ?? '',
      co.job_count ?? 0, co.best_job_score ?? null,
      JSON.stringify(co.sample_titles ?? []),
      co.source, co.source, now(), co.id);
    return false;
  }

  d.prepare(`
    INSERT INTO companies (id, name, source, location, website, siren, naf, size,
      description, evidence, job_count, best_job_score, sample_titles, status, first_seen, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'new',?,?)`).run(
    co.id, co.name, co.source, co.location ?? null, co.website ?? null, co.siren ?? null,
    co.naf ?? null, co.size ?? null, co.description ?? null, co.evidence ?? null,
    co.job_count ?? 0, co.best_job_score ?? null, JSON.stringify(co.sample_titles ?? []),
    now(), now());
  return true;
}

/** Best-evidence companies first: proven hirers before speculative ones. */
export function pendingCompanyScoring(limit = 100) {
  return getDb().prepare(`
    SELECT * FROM companies
    WHERE score IS NULL AND status = 'new'
    ORDER BY COALESCE(best_job_score, 0) DESC, job_count DESC, first_seen DESC
    LIMIT ?`).all(limit).map(hydrateCompany);
}

export function saveCompanyScore(id, s) {
  getDb().prepare(`
    UPDATE companies SET score=?, verdict=?, fit_summary=?, pros=?, cons=?, pitch=?,
      approach=?, scored_at=?, scored_by=?, scored_profile=?, status=?, updated_at=?
    WHERE id=?`).run(
    s.score, s.verdict ?? null, s.fit_summary ?? null,
    JSON.stringify(s.pros ?? []), JSON.stringify(s.cons ?? []),
    s.pitch ?? null, s.approach ?? null, now(), s.scored_by ?? null,
    profileFingerprint, s.status, now(), id);
}

export function listCompanies({ status, minScore, source, search, limit = 100, offset = 0, order = 'score' } = {}) {
  const where = [];
  const args = [];

  if (!status) where.push("status NOT IN ('rejected','archived')");
  else if (status !== 'all') { where.push('status = ?'); args.push(status); }

  if (minScore != null) { where.push('score >= ?'); args.push(minScore); }
  if (source) { where.push('source LIKE ?'); args.push('%' + source + '%'); }
  if (search) {
    where.push('(name LIKE ? OR description LIKE ? OR sample_titles LIKE ?)');
    const q = '%' + search + '%';
    args.push(q, q, q);
  }

  const orderSql = {
    score: 'score DESC NULLS LAST, job_count DESC',
    jobs: 'job_count DESC, score DESC NULLS LAST',
    name: 'name COLLATE NOCASE ASC',
  }[order] ?? 'score DESC NULLS LAST, job_count DESC';

  const sql = 'SELECT * FROM companies ' + (where.length ? 'WHERE ' + where.join(' AND ') : '') +
              ' ORDER BY ' + orderSql + ' LIMIT ? OFFSET ?';
  return getDb().prepare(sql).all(...args, limit, offset).map(hydrateCompany);
}

export function getCompany(id) {
  const r = getDb().prepare('SELECT * FROM companies WHERE id=?').get(id);
  return r ? hydrateCompany(r) : null;
}

export function setCompanyStatus(id, status, notes) {
  const d = getDb();
  if (notes === undefined) d.prepare('UPDATE companies SET status=?, updated_at=? WHERE id=?').run(status, now(), id);
  else d.prepare('UPDATE companies SET status=?, notes=?, updated_at=? WHERE id=?').run(status, notes, now(), id);
}

export function companyStats() {
  const d = getDb();
  const one = (sql, ...a) => d.prepare(sql).get(...a).n;
  return {
    total: one('SELECT COUNT(*) n FROM companies'),
    scored: one('SELECT COUNT(*) n FROM companies WHERE score IS NOT NULL'),
    unscored: one("SELECT COUNT(*) n FROM companies WHERE score IS NULL AND status='new'"),
    shortlisted: one("SELECT COUNT(*) n FROM companies WHERE status='shortlisted'"),
    contacted: one("SELECT COUNT(*) n FROM companies WHERE status='contacted'"),
    strong: one('SELECT COUNT(*) n FROM companies WHERE score >= 70'),
  };
}

function hydrateCompany(row) {
  const parse = (v, f) => { try { return v ? JSON.parse(v) : f; } catch { return f; } };
  return {
    ...row,
    pros: parse(row.pros, []),
    cons: parse(row.cons, []),
    sample_titles: parse(row.sample_titles, []),
  };
}
