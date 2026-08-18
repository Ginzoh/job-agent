import { profile } from '../config.js';

/**
 * Decide which language to write an application in.
 *
 * Matching the posting is only right when you can actually write that language.
 * A Swedish CV generated for a Swedish advert is worse than useless: you cannot
 * check it, and you certainly cannot defend it in an interview.
 */

const CODES = {
  fr: ['french', 'français', 'francais', 'fr'],
  en: ['english', 'anglais', 'engelska', 'en'],
  de: ['german', 'allemand', 'deutsch', 'de'],
  nl: ['dutch', 'néerlandais', 'neerlandais', 'nederlands', 'flemish', 'flamand', 'nl'],
  sv: ['swedish', 'suédois', 'suedois', 'svenska', 'sv'],
  da: ['danish', 'danois', 'dansk', 'da'],
  es: ['spanish', 'espagnol', 'español', 'espanol', 'es'],
  it: ['italian', 'italien', 'italiano', 'it'],
  pt: ['portuguese', 'portugais', 'português', 'pt'],
};

/** Map a language name in any of several spellings to an ISO code. */
export function toCode(name = '') {
  const n = String(name).trim().toLowerCase();
  if (!n) return null;
  for (const [code, aliases] of Object.entries(CODES)) {
    if (aliases.some((a) => n === a || n.startsWith(a))) return code;
  }
  return null;
}

// A level line is free text, so read it for signals rather than exact values.
const NOT_SPOKEN = /\bnot spoken|not stated|none\b|aucun|basic|beginner|notions?\b|élémentaire|elementaire|a1|a2\b/i;
const FLUENT = /native|bilingual|bilingue|fluent|courant|professional|professionnel|maternelle|working|c1|c2|b2/i;

/**
 * Languages the candidate can genuinely write an application in.
 *
 * An explicit `application_languages` list wins. Otherwise it is derived from
 * `languages[]`, keeping only entries whose level reads as fluent — so an entry
 * like "not stated on CV — treat as not spoken" is correctly excluded.
 *
 * Returns [] when the profile says nothing useful, which the caller treats as
 * "no preference" and falls back to the old match-the-posting behaviour.
 */
export function writableLanguages(p = profile) {
  const explicit = p.application_languages ?? p.seeking?.application_languages;
  if (Array.isArray(explicit) && explicit.length) {
    return [...new Set(explicit.map(toCode).filter(Boolean))];
  }

  const derived = (p.languages ?? [])
    .filter((l) => {
      const level = String(l?.level ?? '');
      if (NOT_SPOKEN.test(level)) return false;
      return FLUENT.test(level) || level.trim() === '';
    })
    .map((l) => toCode(l?.lang))
    .filter(Boolean);

  return [...new Set(derived)];
}

/**
 * Resolve the language to write in.
 *
 * @param requested  explicit choice from the UI — always wins
 * @param jobLang    detected language of the posting, or null
 * @param writable   languages the candidate can write (see above)
 *
 * Returns { language, reason } so the interface can explain itself. Silently
 * writing in an unexpected language would look like a bug.
 */
export function resolveLanguage({ requested, jobLang, writable = writableLanguages() } = {}) {
  const req = toCode(requested) ?? (requested || null);
  if (req) return { language: req, reason: 'you chose this language' };

  // No stated preference: keep the original behaviour.
  if (!writable.length) {
    return jobLang
      ? { language: jobLang, reason: 'matched the offer' }
      : { language: null, reason: 'could not tell the offer\'s language' };
  }

  if (jobLang && writable.includes(jobLang)) {
    return { language: jobLang, reason: 'matched the offer' };
  }

  if (writable.includes('en')) {
    return {
      language: 'en',
      reason: jobLang
        ? `the offer is in ${jobLang.toUpperCase()}, which you don't write — used English`
        : "couldn't identify the offer's language — used English",
    };
  }

  return {
    language: writable[0],
    reason: `the offer is in ${jobLang ? jobLang.toUpperCase() : 'an unknown language'}; you don't write English either, so used ${writable[0].toUpperCase()}`,
  };
}

const NAMES = { fr: 'French', en: 'English', de: 'German', nl: 'Dutch', sv: 'Swedish', da: 'Danish', es: 'Spanish', it: 'Italian', pt: 'Portuguese' };
export const languageName = (code) => NAMES[code] ?? code;
