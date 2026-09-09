import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { env, profile } from '../config.js';
import { listJobs, getJob, setStatus, stats, lastRuns, listDocuments, getDocument, deleteDocument, getDb } from '../lib/db.js';
import { runPipeline } from '../core/pipeline.js';
import { writeDigest } from '../core/digest.js';
import { tailor, KINDS } from '../core/tailor.js';
import { importJob } from '../core/import.js';
import { loadReferenceDocs } from '../lib/docs.js';
import { renderCvHtml, renderCvText } from '../core/cv-render.js';
import { renderHome } from './home.js';
import { renderCompanies } from './companies-ui.js';
import { listCompanies, getCompany, setCompanyStatus, companyStats } from '../lib/db.js';
import { discoverCompanies, scoreCompanies, asPseudoJob } from '../core/companies.js';
import { htmlToPdf, pdfAvailable, renderCvPdfFitted, trimCv } from '../core/pdf.js';
import { zipSync, safeName } from '../core/zip.js';
import { renderLetterHtml } from '../core/letter.js';
import { log, c } from '../lib/log.js';

/**
 * Where a generated document belongs on disk, for someone keeping one folder
 * per application.
 *
 * Documents are keyed by job id, and a speculative application carries the
 * synthetic id "company:<n>" — so both cases have to resolve back to a real
 * title and company name.
 */
function applicationFolder(doc) {
  const jobId = String(doc.job_id ?? '');

  if (jobId.startsWith('company:')) {
    // Company ids are opaque hex strings, not numbers — coercing loses them.
    const co = getCompany(jobId.slice('company:'.length));
    // Nothing was advertised, so there is no role to name the folder after.
    return safeName(co ? `Speculative ${co.name}` : `Speculative application ${jobId}`);
  }

  const job = getJob(jobId);
  if (!job) return safeName(`Application ${jobId}`);

  // "job_company" — the shape an existing archive of sent applications uses.
  const parts = [safeName(job.title, { max: 60 }), safeName(job.company, { max: 40 })].filter(Boolean);
  return parts.join('_') || safeName(`Application ${jobId}`);
}

/** The language a document was written in, per the options stored with it. */
function docLanguage(doc) {
  try {
    return JSON.parse(doc?.options ?? '{}').language || 'en';
  } catch {
    return 'en'; // options are advisory; the document still renders.
  }
}

/** A cover letter as a PDF, named in the language it is written in. */
async function letterPdf(doc, person) {
  if (!doc?.content?.trim()) return null;
  const language = docLanguage(doc);
  const data = await htmlToPdf(renderLetterHtml(doc.content, { language }));
  if (!data) return null;

  const stem = language === 'fr' ? 'Lettre_de_motivation' : 'Cover_letter';
  return { name: `${stem}_${person}.pdf`, data };
}

/**
 * The name to put on a generated file.
 *
 * The full name lives in a CV's structured data — the letter's Markdown does
 * not carry it separately, and `profile.name` is often just a first name, which
 * would produce "Cover_letter_Mickael.pdf" next to "CV_Mickael_KRAUTH.pdf".
 * Prefers this application's own CV, then any other CV, then the profile.
 */
function candidateName(cvRef) {
  const refs = [cvRef, latestCvRef()].filter(Boolean);
  for (const ref of refs) {
    try {
      const name = JSON.parse(getDocument(ref.id).content)?.name;
      if (name) return name;
    } catch { /* not structured, or unreadable — try the next */ }
  }
  return profile.name || 'Application';
}

function latestCvRef() {
  try {
    return getDb().prepare("SELECT id FROM documents WHERE kind='cv' ORDER BY id DESC LIMIT 1").get() ?? null;
  } catch {
    return null;
  }
}

/**
 * Everything written for one application, as files for its folder.
 *
 * Built from the job rather than from whichever document was clicked, so the
 * folder is the same set of files whether it is downloaded from the CV or from
 * the cover letter. A missing piece is simply absent — an application is
 * perfectly valid as a CV alone, or as a letter alone.
 *
 * `cvPdf` is passed in because the CV route has already rendered it, at the
 * scale and trim level stored on that document; re-rendering here would risk
 * producing a different file from the one just previewed.
 */
async function applicationFiles(jobId, { cvPdf = null, person = 'CV' } = {}) {
  const entries = [];
  if (cvPdf) entries.push({ name: `CV_${person}.pdf`, data: cvPdf });

  const ref = listDocuments(jobId).find((d) => d.kind === 'cover');
  if (ref) {
    const letter = await letterPdf(getDocument(ref.id), person);
    if (letter) entries.push(letter);
  }
  return entries;
}

/**
 * A Content-Disposition value that survives a non-ASCII name.
 *
 * Header values are not UTF-8: an accent would be misread and an em dash — the
 * kind of thing a French job title carries routinely — makes Node reject the
 * header outright. RFC 6266 covers this with two filenames, a plain ASCII one
 * for old clients and an encoded one that every current browser prefers.
 */
function attachment(name) {
  const ascii = [...name].map((ch) => (ch.codePointAt(0) < 128 && ch !== '"' ? ch : '_')).join('');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const sessions = new Set();
let pipelineBusy = false;
let discoverBusy = false;
let scoreBusy = false;

export function startWeb() {
  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      log.error(err.message);
      send(res, 500, { error: err.message });
    }
  });

  server.listen(env.webPort, env.webHost, () => {
    log.ok(`dashboard on ${c.cyan(`http://${env.webHost}:${env.webPort}`)}`);
    if (env.webPassword) log.info('password protection is ON');
    else if (env.webHost !== '127.0.0.1' && env.webHost !== 'localhost') {
      log.warn('bound to a public interface with NO password — set WEB_PASSWORD in .env');
    }
  });

  return server;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  // --- auth -----------------------------------------------------------
  if (env.webPassword) {
    if (path === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (constantEquals(body.password ?? '', env.webPassword)) {
        const token = randomBytes(24).toString('hex');
        sessions.add(token);
        res.setHeader('Set-Cookie', `ja_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`);
        return send(res, 200, { ok: true });
      }
      return send(res, 401, { error: 'wrong password' });
    }
    if (!path.startsWith('/login') && !isAuthed(req)) {
      if (path.startsWith('/api/')) return send(res, 401, { error: 'unauthorized' });
      return sendHtml(res, 200, loginPage());
    }
  }

  // --- pages ----------------------------------------------------------
  if (path === '/' || path === '/index.html') {
    return sendHtml(res, 200, renderHome());
  }

  // The job dashboard moved off the root when the app grew a second workflow.
  if (path === '/jobs') {
    return sendHtml(res, 200, readFileSync(join(HERE, 'ui.html'), 'utf8'));
  }

  if (path === '/companies') {
    return sendHtml(res, 200, renderCompanies());
  }

  // --- api ------------------------------------------------------------
  if (path === '/api/jobs') {
    const q = url.searchParams;
    const jobs = listJobs({
      status: q.get('status') || undefined,
      minScore: q.get('minScore') ? Number(q.get('minScore')) : undefined,
      source: q.get('source') || undefined,
      contract: q.get('contract') || undefined,
      remote: q.get('remote') === '1' ? true : undefined,
      search: q.get('q') || undefined,
      order: q.get('order') || 'score',
      limit: Math.min(Number(q.get('limit')) || 60, 300),
      offset: Number(q.get('offset')) || 0,
    });
    return send(res, 200, { jobs: jobs.map(slim) });
  }

  if (path.startsWith('/api/job/')) {
    const id = path.split('/').pop();
    if (req.method === 'GET') {
      const job = getJob(id);
      return job ? send(res, 200, job) : send(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!VALID_STATUS.has(body.status)) return send(res, 400, { error: 'invalid status' });
      setStatus(id, body.status, body.notes);
      return send(res, 200, { ok: true });
    }
  }

  // --- CV / cover-letter generation -----------------------------------
  if (path === '/api/tailor' && req.method === 'POST') {
    const body = await readBody(req);

    // A speculative target has no posting, so one is synthesised from what is
    // known about the company. That keeps a single implementation of all three
    // writing tools rather than a parallel set that would drift apart.
    let job;
    if (body.companyId) {
      const co = getCompany(body.companyId);
      if (!co) return send(res, 404, { error: 'no such company' });
      job = asPseudoJob(co);
    } else {
      job = getJob(body.jobId);
    }
    if (!job) return send(res, 404, { error: 'no such job' });
    if (!KINDS.includes(body.kind)) return send(res, 400, { error: `kind must be one of: ${KINDS.join(', ')}` });

    try {
      const doc = await tailor(job, body.kind, body.options ?? {});
      return send(res, 200, doc);
    } catch (err) {
      return send(res, 422, { error: err.message });
    }
  }

  // A generated CV is stored as structured data; these render it as a real
  // document — an A4 page in the browser, or a PDF to send.
  if (path.startsWith('/cv/')) {
    const [, , rawId, format] = path.split('/');
    const doc = getDocument(Number(rawId));
    if (!doc || doc.kind !== 'cv') return send(res, 404, { error: 'no CV with that id' });

    let cv;
    try {
      cv = JSON.parse(doc.content);
    } catch {
      return send(res, 422, { error: 'stored CV is not valid structured data — regenerate it' });
    }

    // ATS by default: this is the file that goes into an application form, and
    // the designed one is for a human. ?style=designed asks for the other.
    const ats = url.searchParams.get('style') !== 'designed';
    const render = (c, o = {}) => renderCvHtml(c, { ...o, ats });

    // Fitting the ATS layout can involve dropping content as well as scaling,
    // so the stored trim level has to be reapplied here. Only the serving path
    // does this: the fitter trims its own candidates and must not be given a
    // document that has already been trimmed once.
    const base = ats && cv.atsTrim ? trimCv(cv, cv.atsTrim) : cv;
    const html = render(base);

    // A document holding a scale but no trim level predates that fix, and its
    // scale alone will not fit. Treat it as unfitted and redo the work.
    const storedScale = ats ? (cv.atsTrim === undefined ? null : cv.atsScale) : cv.scale;
    const filename = `CV_${(cv.name || 'cv').replace(/[^\w]+/g, '_')}_${(cv.title || '').replace(/[^\w]+/g, '_').slice(0, 40)}${ats ? '_ATS' : ''}`.replace(/_+$/, '');

    // 'pdf' hands back the file on its own; 'zip' wraps it in a folder named
    // after the application, which is the only way a browser can deliver a
    // directory rather than a loose file.
    if (format === 'pdf' || format === 'zip') {
      // Documents generated before this layout existed carry no scale for it,
      // so fit them now rather than serving something that overflows.
      const bytes = storedScale
        ? await htmlToPdf(html)
        : (await renderCvPdfFitted(cv, render)).bytes;

      if (!bytes) {
        return send(res, 503, { error: 'no Chrome or Edge available to render a PDF. Open the printable page and use Ctrl+P → Save as PDF instead.' });
      }

      if (format === 'zip') {
        // Inside the folder the files are named after the candidate, not the
        // role: the folder already says which application it is, and a
        // recruiter opening a file wants to see whose it is.
        const folder = applicationFolder(doc);
        const person = safeName(cv.name || 'CV').replace(/ /g, '_');
        const files = await applicationFiles(doc.job_id, { cvPdf: bytes, person });
        const archive = zipSync(files.map((f) => ({ ...f, name: `${folder}/${f.name}` })), { at: new Date(doc.at) });

        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': attachment(`${folder}.zip`),
          'content-length': archive.length,
          'cache-control': 'no-store',
        });
        return res.end(archive);
      }

      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${filename}.pdf"`,
        'content-length': bytes.length,
        'cache-control': 'no-store',
      });
      return res.end(bytes);
    }

    if (format === 'txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(renderCvText(cv));
    }

    return sendHtml(res, 200, html);
  }

  // The letter gets the same three ways out as the CV. Without them the only
  // route to a PDF or to the application folder was through the CV panel, which
  // is the wrong place to look for a cover letter.
  if (path.startsWith('/letter/')) {
    const [, , rawId, format] = path.split('/');
    const doc = getDocument(Number(rawId));
    if (!doc || doc.kind !== 'cover') return send(res, 404, { error: 'no cover letter with that id' });

    const language = docLanguage(doc);
    const folder = applicationFolder(doc);

    if (format === 'pdf' || format === 'zip') {
      const cvRef = listDocuments(doc.job_id).find((d) => d.kind === 'cv');
      const person = safeName(candidateName(cvRef)).replace(/ /g, '_');

      if (format === 'pdf') {
        const file = await letterPdf(doc, person);
        if (!file) {
          return send(res, 503, { error: 'no Chrome or Edge available to render a PDF. Open the printable page and use Ctrl+P → Save as PDF instead.' });
        }
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-disposition': attachment(file.name),
          'content-length': file.data.length,
          'cache-control': 'no-store',
        });
        return res.end(file.data);
      }

      // The whole application, identical to what the CV panel hands back — the
      // CV included, re-fitted here because this route never rendered one.
      let cvPdf = null;
      if (cvRef) {
        try {
          const cv = JSON.parse(getDocument(cvRef.id).content);
          const render = (c, o = {}) => renderCvHtml(c, { ...o, ats: true });
          const base = cv.atsTrim ? trimCv(cv, cv.atsTrim) : cv;
          cvPdf = cv.atsTrim === undefined
            ? (await renderCvPdfFitted(cv, render)).bytes
            : await htmlToPdf(render(base, { scale: cv.atsScale }));
        } catch { /* a broken CV should not cost the letter its folder */ }
      }

      const files = await applicationFiles(doc.job_id, { cvPdf, person });
      if (!files.length) {
        return send(res, 503, { error: 'nothing could be rendered — no Chrome or Edge available for PDFs.' });
      }

      const archive = zipSync(files.map((f) => ({ ...f, name: `${folder}/${f.name}` })), { at: new Date(doc.at) });
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': attachment(`${folder}.zip`),
        'content-length': archive.length,
        'cache-control': 'no-store',
      });
      return res.end(archive);
    }

    return sendHtml(res, 200, renderLetterHtml(doc.content, { language }));
  }

  if (path === '/api/pdf-support') {
    return send(res, 200, { available: pdfAvailable() });
  }

  if (path.startsWith('/api/documents/')) {
    const id = Number(path.split('/').pop());
    if (req.method === 'GET') {
      const doc = getDocument(id);
      return doc ? send(res, 200, doc) : send(res, 404, { error: 'not found' });
    }
    if (req.method === 'DELETE') {
      deleteDocument(id);
      return send(res, 200, { ok: true });
    }
  }

  if (path === '/api/documents') {
    const jobId = url.searchParams.get('jobId');
    if (!jobId) return send(res, 400, { error: 'jobId required' });
    return send(res, 200, { documents: listDocuments(jobId) });
  }

  // --- import an offer you found yourself ------------------------------
  if (path === '/api/import' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.url && !body.text) return send(res, 400, { error: 'provide a url or the posting text' });
    try {
      const { job, isNew } = await importJob(body);
      return send(res, 200, { job, isNew });
    } catch (err) {
      return send(res, 422, { error: err.message });
    }
  }

  if (path === '/api/setup') {
    const docs = loadReferenceDocs();
    return send(res, 200, {
      cvFiles: docs.cv.files,
      letterFiles: docs.letter.files,
      problems: docs.problems,
      writeModel: env.claudeModelWrite,
    });
  }

  // --- companies ------------------------------------------------------
  if (path === '/api/companies') {
    const q = url.searchParams;
    return send(res, 200, {
      companies: listCompanies({
        status: q.get('status') || undefined,
        minScore: q.get('minScore') ? Number(q.get('minScore')) : undefined,
        source: q.get('source') || undefined,
        search: q.get('q') || undefined,
        order: q.get('order') || 'score',
        limit: Math.min(Number(q.get('limit')) || 100, 300),
      }),
    });
  }

  if (path === '/api/companies/stats') return send(res, 200, companyStats());

  if (path === '/api/companies/discover' && req.method === 'POST') {
    if (discoverBusy) return send(res, 409, { error: 'discovery already running' });
    discoverBusy = true;
    try {
      const r = await discoverCompanies();
      const added = Object.values(r).reduce((n, x) => n + (x?.added ?? 0), 0);
      return send(res, 200, { ok: true, added, detail: r });
    } catch (err) {
      return send(res, 500, { error: err.message });
    } finally {
      discoverBusy = false;
    }
  }

  if (path === '/api/companies/score' && req.method === 'POST') {
    if (scoreBusy) return send(res, 409, { error: 'scoring already running' });
    scoreBusy = true;
    send(res, 202, { ok: true, started: true });
    scoreCompanies({ limit: 60 })
      .then((r) => log.ok(`companies scored: ${r.scored}, ${r.strong} strong`))
      .catch((e) => log.error(e.message))
      .finally(() => { scoreBusy = false; });
    return;
  }

  if (path.startsWith('/api/company/')) {
    const id = path.split('/').pop();
    const co = getCompany(id);
    if (!co) return send(res, 404, { error: 'no such company' });
    if (req.method === 'GET') return send(res, 200, co);
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!VALID_COMPANY_STATUS.has(body.status)) return send(res, 400, { error: 'invalid status' });
      setCompanyStatus(id, body.status, body.notes);
      return send(res, 200, { ok: true });
    }
  }

  if (path === '/api/stats') return send(res, 200, { ...stats(), runs: lastRuns(8) });

  if (path === '/api/run' && req.method === 'POST') {
    if (pipelineBusy) return send(res, 409, { error: 'a run is already in progress' });
    pipelineBusy = true;
    // Respond immediately; the run continues in the background.
    send(res, 202, { ok: true, started: true });
    runPipeline()
      .then((r) => log.ok(`web-triggered run: ${r.newJobs} new, ${r.scored} scored, ${r.shortlisted} shortlisted`))
      .catch((e) => log.error(`run failed: ${e.message}`))
      .finally(() => { pipelineBusy = false; });
    return;
  }

  if (path === '/api/busy') return send(res, 200, { busy: pipelineBusy });

  if (path === '/api/digest' && req.method === 'POST') {
    const r = writeDigest();
    return send(res, 200, r);
  }

  return send(res, 404, { error: 'not found' });
}

const VALID_STATUS = new Set(['new', 'reviewed', 'shortlisted', 'applied', 'rejected', 'archived']);
const VALID_COMPANY_STATUS = new Set(['new', 'reviewed', 'shortlisted', 'contacted', 'rejected', 'archived']);

/** Trim the heavy description field out of list responses. */
function slim(j) {
  const { description, ...rest } = j;
  return { ...rest, excerpt: (description || '').slice(0, 260) };
}

function isAuthed(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/ja_session=([a-f0-9]+)/);
  return !!m && sessions.has(m[1]);
}

function constantEquals(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1e6) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function sendHtml(res, code, html) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

const loginPage = () => `<!doctype html><meta charset="utf-8"><title>job-agent</title>
<style>
body{background:#0d1117;color:#e6edf3;font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}
form{background:#161b22;border:1px solid #30363d;padding:28px;border-radius:12px;width:280px}
h1{font-size:16px;margin:0 0 16px}
input{width:100%;padding:9px;border-radius:6px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;box-sizing:border-box}
button{width:100%;margin-top:12px;padding:9px;border-radius:6px;border:0;background:#2f81f7;color:#fff;font-weight:600;cursor:pointer}
p{color:#f85149;font-size:13px;min-height:18px;margin:8px 0 0}
</style>
<form onsubmit="go(event)">
  <h1>job-agent</h1>
  <input type="password" id="p" placeholder="Password" autofocus>
  <button>Unlock</button>
  <p id="e"></p>
</form>
<script>
async function go(e){e.preventDefault();
  const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});
  if(r.ok) location.reload(); else document.getElementById('e').textContent='Incorrect password';
}
</script>`;
