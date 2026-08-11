import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { ROOT } from '../config.js';
import { log } from './log.js';
import { detectLanguage } from './text.js';

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

  const variants = [];
  const shared = [];

  for (const f of readable) {
    try {
      const raw = stripHtmlComments(readFileSync(join(dir, f), 'utf8')).trim();
      if (!raw) continue;

      // A leading underscore marks shared context: facts that hold regardless of
      // which language version is used. These are appended to whichever variant
      // is chosen, never selected as a variant themselves — so things like a
      // side project or your freelance status only need writing down once.
      if (basename(f).startsWith('_')) shared.push({ file: basename(f), text: raw });
      else variants.push({ file: basename(f), text: raw, lang: detectLanguage(raw) });
    } catch (err) {
      log.warn(`could not read ${f}: ${err.message}`);
    }
  }

  if (!variants.length) {
    // Shared context alone is not a CV, but it shouldn't be silently discarded.
    if (shared.length) return { text: '', files: shared.map((s) => s.file), variants: [], shared, problem: `${label} has shared context but no actual CV — add a .md or .txt without a leading underscore.` };
    return { text: '', files: [], variants: [], shared, problem: `${label} has no readable content.` };
  }

  return {
    variants,
    shared,
    files: [...variants, ...shared].map((v) => v.file),
    problem: null,
    ...pick(variants, null, shared),
  };
}

/**
 * Choose the variant written in `lang`.
 *
 * Documents are matched on their detected language rather than on filenames, so
 * you can call your files whatever you like — a French CV is used for French
 * postings because it reads as French, not because it's named that way.
 *
 * Falls back to a language-neutral variant, then to the first one, so a single
 * CV keeps working exactly as before.
 */
function pick(variants, lang, shared = []) {
  const exact = lang && variants.find((v) => v.lang === lang);
  const neutral = variants.find((v) => v.lang === null);
  const chosen = exact || (lang ? variants.find((v) => v.lang !== lang && variants.length === 1) : null) || neutral || variants[0];

  const sharedText = shared.map((s) => s.text).join('\n\n');

  return {
    text: sharedText ? `${chosen.text}\n\n${sharedText}` : chosen.text,
    file: chosen.file,
    lang: chosen.lang,
    matchedLanguage: !!exact,
    sharedFiles: shared.map((s) => s.file),
  };
}

// Comment blocks that are real content rather than notes to yourself. Matched
// in several languages, because marking one "CONTEXTE SUPPLÉMENTAIRE" and
// having it silently deleted is a nasty way to lose half your profile.
const CONTEXT_MARKER = /ADDITIONAL CONTEXT|CONTEXTE SUPPL[EÉ]MENTAIRE|EXTRA CONTEXT|CONTEXTE ADDITIONNEL/i;

/**
 * HTML comments are notes to whoever maintains the file, except a block marked
 * as additional context — that is deliberately factual content for the model.
 * Keep those, drop the rest.
 */
function stripHtmlComments(text) {
  return text.replace(/<!--([\s\S]*?)-->/g, (_match, inner) =>
    CONTEXT_MARKER.test(inner) ? inner.replace(new RegExp(`^\\s*(?:${CONTEXT_MARKER.source})[^\\n]*\\n`, 'i'), '') : ''
  );
}

export function loadCv(lang = null) {
  const loaded = loadDir(CV_DIR, 'CV_example/');
  if (!loaded.variants?.length) return loaded;
  return { ...loaded, ...pick(loaded.variants, lang, loaded.shared) };
}

export function loadCoverLetter(lang = null) {
  const loaded = loadDir(LETTER_DIR, 'cover_letter_example/');
  if (!loaded.variants?.length) return loaded;
  return { ...loaded, ...pick(loaded.variants, lang, loaded.shared) };
}

/**
 * Everything the writer needs, in the requested language where a matching
 * document exists.
 */
export function loadReferenceDocs(lang = null) {
  const cv = loadCv(lang);
  const letter = loadCoverLetter(lang);
  return {
    cv,
    letter,
    problems: [cv.problem, letter.problem].filter(Boolean),
  };
}
