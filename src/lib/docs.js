import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { ROOT } from '../config.js';
import { log } from './log.js';

const CV_DIR = join(ROOT, 'CV_example');
const LETTER_DIR = join(ROOT, 'cover_letter_example');

const READABLE = new Set(['.md', '.txt', '.markdown', '.text']);

/**
 * Load your reference documents.
 *
 * Only plain text and Markdown are read. Node ships no PDF parser and this
 * project has no dependencies, so a PDF-only folder is reported as a problem
 * rather than silently producing generic output — a CV generator working from
 * nothing is worse than no CV generator.
 */
function loadDir(dir, label) {
  if (!existsSync(dir)) {
    return { text: '', files: [], problem: `folder ${label} not found` };
  }

  const entries = readdirSync(dir).filter((f) => !f.startsWith('.'));
  const readable = entries.filter((f) => READABLE.has(extname(f).toLowerCase()));
  const pdfs = entries.filter((f) => extname(f).toLowerCase() === '.pdf');

  if (!readable.length) {
    const hint = pdfs.length
      ? `${label} only contains PDFs (${pdfs.join(', ')}). Add a .md or .txt version alongside it — that's what gets read.`
      : `${label} has no .md or .txt file in it.`;
    return { text: '', files: [], problem: hint };
  }

  const parts = [];
  for (const f of readable) {
    try {
      const raw = readFileSync(join(dir, f), 'utf8');
      parts.push(`--- ${basename(f)} ---\n${stripHtmlComments(raw).trim()}`);
    } catch (err) {
      log.warn(`could not read ${f}: ${err.message}`);
    }
  }

  return { text: parts.join('\n\n'), files: readable, problem: null };
}

/**
 * HTML comments in the source docs are notes to the human maintaining them,
 * except the "ADDITIONAL CONTEXT" block, which is deliberately factual content
 * meant for the model. Keep that one, drop the rest.
 */
function stripHtmlComments(text) {
  return text.replace(/<!--([\s\S]*?)-->/g, (match, inner) =>
    /ADDITIONAL CONTEXT/i.test(inner) ? inner.replace(/^\s*ADDITIONAL CONTEXT[^\n]*\n/i, '') : ''
  );
}

export function loadCv() {
  return loadDir(CV_DIR, 'CV_example/');
}

export function loadCoverLetter() {
  return loadDir(LETTER_DIR, 'cover_letter_example/');
}

/** Everything the writer needs, plus any setup problems worth surfacing. */
export function loadReferenceDocs() {
  const cv = loadCv();
  const letter = loadCoverLetter();
  return {
    cv,
    letter,
    problems: [cv.problem, letter.problem].filter(Boolean),
  };
}
