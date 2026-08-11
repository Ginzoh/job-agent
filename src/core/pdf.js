import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
export async function htmlToPdf(html, { timeout = 60000 } = {}) {
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

    if (!existsSync(pdfPath)) {
      log.warn('browser exited without producing a PDF');
      return null;
    }

    const bytes = readFileSync(pdfPath);
    // A truncated or empty render is worse than an honest failure.
    if (bytes.length < 1000 || bytes.subarray(0, 4).toString('ascii') !== '%PDF') {
      log.warn('rendered file was not a valid PDF');
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

  if (level >= 1) c.interests = [];
  if (level >= 1) c.personalSkills = cap(c.personalSkills, 3);

  if (level >= 2) c.projects = [];
  if (level >= 2) c.personalSkills = [];

  if (level >= 3) {
    c.skills = cap(c.skills, 5)?.map((g) => ({ ...g, items: cap(g.items, 5) }));
    c.education = c.education?.map((e) => ({ ...e, bullets: cap(e.bullets, 1) }));
  }

  if (level >= 4) {
    c.skills = cap(c.skills, 4)?.map((g) => ({ ...g, items: cap(g.items, 4) }));
    // Trim older roles first; the most recent keeps one bullet more.
    c.experience = c.experience?.map((e, i) => ({ ...e, bullets: cap(e.bullets, i === 0 ? 4 : 3) }));
  }

  if (level >= 5) {
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
 * Each attempt is a genuine render: producing the PDF is the only way to know
 * the true page count.
 */
export async function renderCvPdfFitted(cv, renderHtml, { maxPages = 1, scales = [1, 0.93, 0.86], maxTrim = 5 } = {}) {
  let last = null;

  for (let level = 0; level <= maxTrim; level++) {
    const candidate = level === 0 ? cv : trimCv(cv, level);

    for (const scale of scales) {
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

const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '');

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
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
