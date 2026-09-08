import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { log } from '../lib/log.js';

/**
 * HTML to PDF using the browser that is already installed.
 *
 * Every Windows machine ships with Edge, and Chrome exposes the same
 * `--print-to-pdf` flag, so this keeps the project dependency-free rather than
 * pulling in Puppeteer and a second copy of Chromium.
 */

const CANDIDATES = [
  // Windows
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  // Linux
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
];

let cached;

export function findBrowser() {
  if (cached !== undefined) return cached;
  cached = CANDIDATES.find((p) => p && existsSync(p)) ?? null;
  return cached;
}

export const pdfAvailable = () => !!findBrowser();

/**
 * Render HTML to PDF bytes. Resolves to null when no browser is available, so
 * callers can fall back to offering the printable page instead of failing.
 */
export async function htmlToPdf(html, { timeout = 30000 } = {}) {
  const browser = findBrowser();
  if (!browser) {
    log.warn('no Chrome or Edge found — cannot render PDF server-side');
    return null;
  }

  const dir = join(tmpdir(), `job-agent-pdf-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  const htmlPath = join(dir, 'cv.html');
  const pdfPath = join(dir, 'cv.pdf');

  try {
    writeFileSync(htmlPath, html, 'utf8');

    await run(browser, [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--no-pdf-header-footer',
      '--disable-extensions',
      `--print-to-pdf=${pdfPath}`,
      fileUrl(htmlPath),
    ], timeout);

    // Chrome and Edge exit BEFORE the PDF has finished landing on disk — the
    // process closes with status 0 and the file appears a moment later. Checking
    // once on close is a race, and it is one this code lost as soon as a browser
    // was already running and startup got faster.
    const bytes = await waitForPdf(pdfPath);
    if (!bytes) {
      log.warn('browser exited without producing a usable PDF');
      return null;
    }
    return bytes;
  } catch (err) {
    log.warn(`PDF render failed: ${err.message}`);
    return null;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Number of pages in a PDF, read straight from the object structure.
 *
 * The page tree's /Count is authoritative; counting `/Type /Page` objects is a
 * fallback for producers that lay the tree out unusually. Taking the max of the
 * two avoids under-reporting, which is the failure that would matter here.
 */
export function pdfPageCount(bytes) {
  const raw = Buffer.from(bytes).toString('latin1');
  const byType = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const counts = (raw.match(/\/Count\s+(\d+)/g) || []).map((m) => Number(m.match(/\d+/)[0]));
  const byCount = counts.length ? Math.max(...counts) : 0;
  return Math.max(byType, byCount, 1);
}

/**
 * Progressively drop the least valuable content from a CV.
 *
 * Ordered by what a recruiter would miss least. Roles are never removed and the
 * most recent role keeps its bullets longest, because chronology and current
 * work are the two things a CV cannot be without.
 */
export function trimCv(cv, level) {
  const c = structuredClone(cv);
  const cap = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : arr);

  // Interests go first: pleasant to read, never decisive.
  if (level >= 1) { c.interests = []; c.personalSkills = cap(c.personalSkills, 3); }

  // Then personal skills. Self-declared traits carry far less weight than
  // evidence of something built, so they are spent before projects are touched.
  if (level >= 2) c.personalSkills = [];

  // Projects only now. With two years of employment behind them, a shipped
  // project is often the strongest evidence on the page.
  if (level >= 3) c.projects = [];

  if (level >= 4) {
    c.skills = cap(c.skills, 5)?.map((g) => ({ ...g, items: cap(g.items, 5) }));
    c.education = c.education?.map((e) => ({ ...e, bullets: cap(e.bullets, 1) }));
  }

  if (level >= 5) {
    c.skills = cap(c.skills, 4)?.map((g) => ({ ...g, items: cap(g.items, 4) }));
    // Trim older roles first; the most recent keeps one bullet more.
    c.experience = c.experience?.map((e, i) => ({ ...e, bullets: cap(e.bullets, i === 0 ? 4 : 3) }));
  }

  if (level >= 6) {
    c.experience = c.experience?.map((e, i) => ({ ...e, bullets: cap(e.bullets, i === 0 ? 3 : 2) }));
    c.education = c.education?.map((e) => ({ ...e, bullets: [] }));
  }

  return c;
}

/**
 * Render a CV to a PDF that fits on `maxPages`.
 *
 * Two levers, used in the right order. Mild scaling absorbs a CV that overruns
 * by a few lines — that is a formatting problem. Below about 0.86 the text
 * stops looking deliberate and starts looking squeezed, so past that point the
 * fix is to remove content instead, cheapest material first.
 *
 * The scale rungs are deliberately close together. A coarse ladder makes the
 * fitter overshoot: a CV that would have fitted at 0.91 gets rendered at 0.86
 * simply because nothing in between was tried, and the reader sees needlessly
 * small type.
 *
 * Each attempt is a genuine render: producing the PDF is the only way to know
 * the true page count.
 */
export async function renderCvPdfFitted(cv, renderHtml, { maxPages = 1, scales = [1, 0.96, 0.93, 0.91, 0.89, 0.86], maxTrim = 6, deadlineMs = 150000 } = {}) {
  let last = null;
  const startedAt = Date.now();

  for (let level = 0; level <= maxTrim; level++) {
    const candidate = level === 0 ? cv : trimCv(cv, level);

    for (const scale of scales) {
      // Every attempt is a real browser render. Without an overall budget the
      // worst case is 18 renders x their individual timeout, which is minutes of
      // apparent hang for a document that is already good enough to hand back.
      if (Date.now() - startedAt > deadlineMs) {
        log.warn(`CV fitting hit its ${Math.round(deadlineMs / 1000)}s budget — returning the best version so far`);
        return last ?? { bytes: null, pages: 0, scale, trim: level, cv: candidate, fitted: false };
      }

      const bytes = await htmlToPdf(renderHtml(candidate, { scale }));
      if (!bytes) return { bytes: null, pages: 0, scale, trim: level, cv: candidate, fitted: false };

      const pages = pdfPageCount(bytes);
      last = { bytes, pages, scale, trim: level, cv: candidate, fitted: pages <= maxPages };
      if (last.fitted) return last;
    }
  }

  log.warn(`CV still ${last.pages} pages after trimming and scaling — unusually long content`);
  return last;
}

/**
 * Wait for a rendered PDF to appear and finish being written.
 *
 * Two things have to be true, not one: the file must exist, and its size must
 * stop changing. A large document is written incrementally, so reading the
 * moment it appears can yield a truncated file that still starts with %PDF and
 * would be served to the user as a broken download.
 */
async function waitForPdf(pdfPath, { timeout = 15000, settleMs = 150 } = {}) {
  const deadline = Date.now() + timeout;
  let lastSize = -1;

  while (Date.now() < deadline) {
    if (existsSync(pdfPath)) {
      const size = statSync(pdfPath).size;
      if (size > 0 && size === lastSize) {
        const bytes = readFileSync(pdfPath);
        // A truncated or empty render is worse than an honest failure.
        if (bytes.length < 1000 || bytes.subarray(0, 4).toString('ascii') !== '%PDF') {
          log.warn('rendered file was not a valid PDF');
          return null;
        }
        return bytes;
      }
      lastSize = size;
    }
    await new Promise((r) => setTimeout(r, settleMs));
  }
  return null;
}

const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '');

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Headless Chrome/Edge fans out into a tree of renderer and GPU
      // processes. Killing only the launcher leaves them running and holding
      // the temp directory open, which is a slow leak and a source of hangs.
      if (process.platform === "win32" && child.pid) {
        try {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } catch { try { child.kill(); } catch { /* already gone */ } }
      } else {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
      reject(new Error(`timed out after ${Math.round(timeout / 1000)}s`));
    }, timeout);

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });

    // Headless Chrome sometimes reports a non-zero code even on success, so the
    // real check is whether the PDF file exists — done by the caller.
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}
