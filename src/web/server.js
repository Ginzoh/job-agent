import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { env } from '../config.js';
import { listJobs, getJob, setStatus, stats, lastRuns, listDocuments, getDocument, deleteDocument } from '../lib/db.js';
import { runPipeline } from '../core/pipeline.js';
import { writeDigest } from '../core/digest.js';
import { tailor, KINDS } from '../core/tailor.js';
import { importJob } from '../core/import.js';
import { loadReferenceDocs } from '../lib/docs.js';
import { log, c } from '../lib/log.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const sessions = new Set();
let pipelineBusy = false;

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
    return sendHtml(res, 200, readFileSync(join(HERE, 'ui.html'), 'utf8'));
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
    const job = getJob(body.jobId);
    if (!job) return send(res, 404, { error: 'no such job' });
    if (!KINDS.includes(body.kind)) return send(res, 400, { error: `kind must be one of: ${KINDS.join(', ')}` });

    try {
      const doc = await tailor(job, body.kind, body.options ?? {});
      return send(res, 200, doc);
    } catch (err) {
      return send(res, 422, { error: err.message });
    }
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
