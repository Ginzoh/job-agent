import { createHash } from 'node:crypto';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–',
  mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ecirc: 'ê', ocirc: 'ô',
  ugrave: 'ù', icirc: 'î', euro: '€', bull: '•', middot: '·',
};

export function decodeEntities(s = '') {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

const safeChar = (code) => {
  try { return String.fromCodePoint(code); } catch { return ''; }
};

/** Strip HTML to readable plain text, preserving paragraph and list breaks. */
export function stripHtml(html = '') {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
      .replace(/<\s*li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/gm, '')
    .trim();
}

/** Lowercase, strip accents & punctuation — for robust matching. */
export function fold(s = '') {
  return String(s)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word-boundary-ish containment test that tolerates dots (node.js, c#, .net). */
export function hasTerm(haystackFolded, term) {
  const t = fold(term);
  if (!t) return false;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, 'u').test(haystackFolded);
}

export function countTerms(haystackFolded, terms) {
  const hits = [];
  for (const t of terms) {
    if (typeof t !== 'string' || t.startsWith('_comment')) continue;
    if (hasTerm(haystackFolded, t)) hits.push(t);
  }
  return hits;
}

const STACK_TERMS = [
  'React', 'Next.js', 'Vue', 'Svelte', 'Angular', 'Remix', 'Astro', 'Nuxt',
  'TypeScript', 'JavaScript', 'Node.js', 'Deno', 'Bun', 'Express', 'NestJS', 'Fastify',
  'GraphQL', 'REST', 'tRPC', 'Prisma', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis',
  'Tailwind', 'CSS', 'SASS', 'Styled Components', 'Redux', 'Zustand', 'MobX',
  'Vite', 'Webpack', 'Turborepo', 'Storybook', 'Jest', 'Vitest', 'Cypress', 'Playwright',
  'Docker', 'Kubernetes', 'AWS', 'GCP', 'Azure', 'Vercel', 'Netlify', 'Terraform',
  'Python', 'Go', 'Rust', 'Java', 'PHP', 'Ruby', 'Elixir', 'C#', '.NET', 'Symfony', 'Laravel',
  'React Native', 'Flutter', 'Electron', 'WebGL', 'Three.js', 'D3',
];

/** Detect which technologies a posting mentions. */
export function detectStack(text) {
  const f = fold(text);
  return STACK_TERMS.filter((t) => hasTerm(f, t));
}

const FREELANCE_HINTS = ['freelance', 'freelancer', 'contractor', 'contract role', 'mission', 'prestation', 'tjm', 'independant', 'independent contractor', 'b2b', 'portage', 'consultant', 'sous-traitance', 'daily rate', 'per diem'];
const PERMANENT_HINTS = ['cdi', 'permanent', 'full-time employee', 'full time permanent', 'salarie', 'poste en cdi'];
const FIXED_HINTS = ['cdd', 'fixed-term', 'fixed term', 'temporary contract', 'interim'];

/** Guess the contract type from title + description. */
export function detectContract(text) {
  const f = fold(text);
  const free = countTerms(f, FREELANCE_HINTS).length;
  const perm = countTerms(f, PERMANENT_HINTS).length;
  const fixed = countTerms(f, FIXED_HINTS).length;
  if (free > perm && free > fixed) return 'freelance';
  if (fixed > perm && fixed > free) return 'contract';
  if (perm > 0) return 'permanent';
  return 'unknown';
}

const REMOTE_HINTS = ['remote', 'télétravail', 'teletravail', 'distanciel', 'anywhere', 'work from home', 'full remote', 'wfh', 'distributed team'];

export function detectRemote(text) {
  return countTerms(fold(text), REMOTE_HINTS).length > 0;
}

/** Pull a salary / TJM string out of free text, if one is stated. */
export function detectSalary(text = '') {
  const patterns = [
    /(?:tjm|taux journalier)[^\d]{0,20}(\d{2,4})\s*(?:[-–à]\s*(\d{2,4}))?\s*(?:€|eur)?/i,
    /(\d{2,3})\s*[-–à]\s*(\d{2,3})\s*k\s*€/i,
    /(\d{2,3})\s*k\s*€\s*(?:[-–à]\s*(\d{2,3})\s*k\s*€)?/i,
    /€\s?(\d{2,3}[\s,.]?\d{0,3})\s*[-–]\s*€?\s?(\d{2,3}[\s,.]?\d{0,3})/,
    /\$\s?(\d{2,3}[,.]?\d{0,3})\s*[-–]\s*\$?\s?(\d{2,3}[,.]?\d{0,3})/,
    /(\d{2,3}[\s,.]\d{3})\s*(?:€|eur|euros)\b/i,
  ];
  for (const re of patterns) {
    const m = String(text).match(re);
    if (m) return m[0].replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  return null;
}

// Function words are the giveaway: they appear constantly in prose and almost
// never in the shared technical vocabulary that makes job posts in different
// languages look alike ("React", "TypeScript", "CI/CD" tell you nothing).
//
// Every language the sources actually reach needs an entry, not just the two
// that can be written in. A two-way French/English test has nowhere to put a
// Swedish posting, so it assigns one of the two — and Swedish "du" ("you"),
// which is also French "du", is enough on its own to make a Göteborg advert
// look French. Being able to answer "neither" is the whole point.
const MARKERS = {
  en: ['the', 'and', 'of', 'to', 'in', 'for', 'with', 'you', 'we', 'our', 'is', 'are', 'will', 'have', 'has', 'this', 'that', 'as', 'at', 'be', 'your', 'their', 'from', 'team', 'experience', 'skills', 'role', 'company', 'work', 'years', 'about', 'who', 'what'],
  fr: ['le', 'la', 'les', 'des', 'une', 'un', 'du', 'et', 'est', 'pour', 'vous', 'nous', 'avec', 'dans', 'sur', 'au', 'aux', 'par', 'plus', 'que', 'qui', 'ce', 'sont', 'chez', 'notre', 'votre', 'ses', 'leur', 'être', 'avoir', 'sera', 'poste', 'équipe', 'entreprise', 'développement', 'expérience', 'compétences', 'missions', 'profil', 'recherche', 'ans'],
  sv: ['och', 'att', 'som', 'med', 'av', 'till', 'den', 'det', 'vi', 'är', 'ett', 'på', 'du', 'din', 'ditt', 'har', 'kan', 'inom', 'eller', 'men', 'vill', 'söker', 'arbeta', 'utveckling', 'erfarenhet', 'tjänsten', 'anställning', 'oss', 'våra', 'hos', 'kommer', 'även'],
  da: ['og', 'at', 'som', 'med', 'af', 'til', 'den', 'det', 'vi', 'er', 'et', 'på', 'du', 'din', 'dit', 'har', 'kan', 'eller', 'men', 'vil', 'søger', 'arbejde', 'udvikling', 'erfaring', 'stillingen', 'vores', 'hos', 'dig', 'ikke', 'både'],
  de: ['und', 'der', 'die', 'das', 'mit', 'für', 'von', 'ist', 'sind', 'wir', 'sie', 'ihre', 'eine', 'einen', 'dem', 'den', 'im', 'bei', 'auf', 'als', 'oder', 'nicht', 'auch', 'erfahrung', 'entwicklung', 'kenntnisse', 'unser', 'unsere', 'werden', 'wird'],
  nl: ['het', 'een', 'van', 'voor', 'met', 'zijn', 'wij', 'je', 'jouw', 'onze', 'bij', 'naar', 'ook', 'niet', 'maar', 'ervaring', 'ontwikkeling', 'werken', 'binnen', 'wordt', 'worden', 'aan', 'op', 'te'],
  // The remote boards carry the occasional Latin-American posting. Without
  // these two, their accents fall through to French and a Brazilian sales role
  // comes back as a French CV.
  es: ['de', 'que', 'para', 'con', 'los', 'las', 'una', 'por', 'como', 'más', 'nuestro', 'nuestra', 'tu', 'experiencia', 'desarrollo', 'trabajo', 'empresa', 'equipo', 'buscamos', 'tienes', 'sobre', 'pero', 'también', 'ser'],
  pt: ['de', 'que', 'para', 'com', 'uma', 'por', 'como', 'mais', 'nossa', 'nosso', 'você', 'experiência', 'desenvolvimento', 'trabalho', 'empresa', 'equipe', 'sobre', 'não', 'ou', 'em', 'na', 'no', 'dos', 'das'],
};

// Markers are matched against folded text, so they have to be folded too —
// otherwise "för" and "är" could never match, having lost their diacritics.
const FOLDED = Object.fromEntries(
  Object.entries(MARKERS).map(([code, words]) => [code, new Set(words.map((w) => fold(w)))]),
);

// Letters that only some of these languages use. Weaker evidence than function
// words — a single name can carry one — so they are capped low.
const LETTERS = [
  [/[éèêëàâçîïôùû]/gi, 'fr'],
  [/[åäö]/gi, 'sv'],
  [/[æø]/gi, 'da'],
  [/ß/gi, 'de'],
  [/[ñ¿¡]/gi, 'es'],
  [/[ãõ]/gi, 'pt'],
];

// Phrases that are decisively French in a job posting.
const FR_PHRASES = ['h f', 'f h', 'cdi', 'cdd', 'tjm', 'teletravail', 'developpeur', 'poste est'];

/**
 * Guess which language a block of text is written in.
 *
 * Returns an ISO code, or null when no language is clearly ahead — null
 * matters, because guessing wrong is worse than falling back to a default.
 * A code outside what the candidate writes is a useful answer too: it lets
 * the caller say "this advert is Swedish, so write in English" rather than
 * silently producing a French CV for a Göteborg role.
 */
export function detectLanguage(text = '') {
  const raw = String(text).slice(0, 6000);
  const sample = fold(raw);
  if (sample.length < 40) return null;

  const scores = Object.fromEntries(Object.keys(MARKERS).map((c) => [c, 0]));

  for (const word of sample.split(/\s+/)) {
    for (const [code, set] of Object.entries(FOLDED)) {
      if (set.has(word)) scores[code]++;
    }
  }

  for (const [re, code] of LETTERS) {
    scores[code] += Math.min((raw.match(re) || []).length / 4, 12);
  }

  for (const phrase of FR_PHRASES) {
    if (sample.includes(phrase)) scores.fr += 3;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [winner, top] = ranked[0];
  const runnerUp = ranked[1][1];

  // Enough evidence, and clearly more of it than for any other language.
  if (top < 6) return null;
  if (top < runnerUp * 1.35) return null;
  return winner;
}

/** Stable identity for a posting, so re-runs don't create duplicates. */
export function jobHash({ company, title, url }) {
  const key = [fold(company).slice(0, 60), fold(title).slice(0, 90), canonicalUrl(url)].join('|');
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/**
 * Identity of the *role* rather than of the listing.
 *
 * The same job cross-posted to WeWorkRemotely and RemoteOK has two different
 * URLs, so `jobHash` sees two records. Company + title + location catches that,
 * while still keeping genuinely distinct roles apart — "Software Engineer" in
 * Paris and in New York stay separate, because location is part of the key.
 * Remote postings collapse to a single "remote" bucket, since "Remote",
 * "Anywhere in the World" and "Remote (EMEA)" describe the same opening.
 */
export function contentKey({ company, title, location, is_remote }) {
  const place = is_remote ? 'remote' : fold(location || '').slice(0, 40);
  const key = [fold(company).slice(0, 60), normalizeTitle(title), place].join('|');
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/** Strip the decoration companies bolt onto job titles before comparing them. */
function normalizeTitle(title = '') {
  return fold(title)
    .replace(/\b(h\/f|f\/h|m\/f|m\/w|x\/f\/m|m\/f\/d|w\/m\/d|h f|f m)\b/g, ' ')
    .replace(/\b(remote|hybrid|cdi|cdd|freelance|full.?time|part.?time|contract)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

/** Drop tracking params so the same posting always hashes the same way. */
export function canonicalUrl(url = '') {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|ref|source|src|gh_src|campaign|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
    }
    u.hash = '';
    return u.origin.toLowerCase() + u.pathname.replace(/\/+$/, '') + (u.search || '');
  } catch {
    return String(url).trim().toLowerCase();
  }
}

/**
 * Coerce a field into a string array. Some APIs are inconsistent about this —
 * Arbeitnow, for example, returns `job_types` as an array most of the time but
 * occasionally as an object like {"1":"entry"}.
 */
export function toArray(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (v && typeof v === 'object') return Object.values(v).filter((x) => typeof x === 'string');
  if (typeof v === 'string' && v) return [v];
  return [];
}

export function truncate(s = '', n = 200) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/** Parse anything date-ish into an ISO string, or null. */
export function toISO(v) {
  if (!v) return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function daysAgo(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
