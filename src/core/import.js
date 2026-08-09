import { getText } from '../lib/http.js';
import { upsertJob, getJob } from '../lib/db.js';
import { stripHtml, decodeEntities, jobHash, detectStack, detectContract, detectRemote, canonicalUrl, toISO, detectSalary, truncate } from '../lib/text.js';
import { prefilter } from './prefilter.js';

/**
 * Bring in a job you found yourself — by URL or by pasting the text.
 *
 * Imported jobs become ordinary rows in the same table, so scoring, the
 * dashboard, and the CV/cover-letter tools all work on them unchanged.
 */
export async function importJob({ url, text, title, company }) {
  const parsed = url ? await fromUrl(url) : fromText(text);

  if (!parsed.description || parsed.description.length < 40) {
    throw new Error(
      url
        ? "couldn't read a job description from that page — many job sites block automated access. Copy the posting text and paste it instead."
        : 'that text is too short to be a job posting.'
    );
  }

  const finalTitle = (title || parsed.title || 'Untitled posting').trim().slice(0, 200);
  const finalCompany = (company || parsed.company || 'Unknown').trim().slice(0, 120);
  const finalUrl = url ? canonicalUrl(url) : `manual://${jobHash({ company: finalCompany, title: finalTitle, url: parsed.description.slice(0, 200) })}`;

  const blob = `${finalTitle}\n${finalCompany}\n${parsed.location || ''}\n${parsed.description}`;

  const job = {
    id: jobHash({ company: finalCompany, title: finalTitle, url: finalUrl }),
    source: 'manual',
    source_id: null,
    title: finalTitle,
    company: finalCompany,
    location: (parsed.location || '').trim(),
    is_remote: parsed.is_remote ?? detectRemote(blob),
    contract: parsed.contract || detectContract(blob),
    url: finalUrl,
    apply_url: url || null,
    description: parsed.description,
    salary: parsed.salary || detectSalary(parsed.description),
    stack: detectStack(blob),
    posted_at: parsed.posted_at ?? new Date().toISOString(),
    tags: ['manual-import'],
  };

  // Run the filter for information, but never drop something added by hand —
  // an explicit import is a stronger signal of intent than any keyword rule.
  const verdict = prefilter(job);
  job.prefilter_pass = true;
  job.prefilter_note = verdict.pass ? verdict.note : `imported manually (filter would have said: ${verdict.note})`;

  const isNew = upsertJob(job);
  return { job: getJob(job.id), isNew };
}

async function fromUrl(url) {
  const html = await getText(url, { timeout: 25000, retries: 1 });
  if (!html) return { description: '' };

  // Most serious job boards embed schema.org JobPosting JSON-LD. When it's
  // there it's far cleaner than anything scraped out of the rendered page.
  const structured = fromJsonLd(html);
  if (structured?.description) return structured;

  return {
    title: pickTitle(html),
    company: pickMeta(html, 'og:site_name'),
    description: bodyText(html),
  };
}

function fromJsonLd(html) {
  const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];

  for (const block of blocks) {
    const inner = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    let data;
    try {
      data = JSON.parse(inner.trim());
    } catch {
      continue;
    }

    for (const node of flatten(data)) {
      const type = node?.['@type'];
      const isPosting = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
      if (!isPosting) continue;

      const loc = node.jobLocation;
      const addr = (Array.isArray(loc) ? loc[0] : loc)?.address;

      return {
        title: node.title ? stripHtml(String(node.title)) : null,
        company: node.hiringOrganization?.name ?? null,
        location: [addr?.addressLocality, addr?.addressRegion, addr?.addressCountry]
          .filter((v) => typeof v === 'string').join(', ') || null,
        description: stripHtml(decodeEntities(String(node.description ?? ''))),
        contract: mapEmploymentType(node.employmentType),
        is_remote: node.jobLocationType === 'TELECOMMUTE' || undefined,
        salary: salaryFromLd(node.baseSalary),
        posted_at: toISO(node.datePosted),
      };
    }
  }
  return null;
}

/** Walk arrays and @graph containers looking for the posting node. */
function* flatten(node) {
  if (Array.isArray(node)) {
    for (const n of node) yield* flatten(n);
    return;
  }
  if (node && typeof node === 'object') {
    yield node;
    if (node['@graph']) yield* flatten(node['@graph']);
  }
}

function mapEmploymentType(v) {
  const s = (Array.isArray(v) ? v.join(' ') : String(v ?? '')).toUpperCase();
  if (/CONTRACTOR|TEMPORARY/.test(s)) return 'freelance';
  if (/FULL_TIME|FULLTIME/.test(s)) return 'permanent';
  if (/PART_TIME|INTERN/.test(s)) return null;
  return null;
}

function salaryFromLd(base) {
  const v = base?.value;
  if (!v) return null;
  const cur = base.currency === 'USD' ? '$' : base.currency === 'GBP' ? '£' : '€';
  const unit = { HOUR: '/h', DAY: '/j', MONTH: '/mois', YEAR: '/an' }[v.unitText] ?? '';
  if (v.minValue && v.maxValue) return `${Number(v.minValue).toLocaleString('fr-FR')}–${Number(v.maxValue).toLocaleString('fr-FR')} ${cur}${unit}`;
  const single = v.value ?? v.minValue ?? v.maxValue;
  return single ? `${Number(single).toLocaleString('fr-FR')} ${cur}${unit}` : null;
}

function pickTitle(html) {
  const og = pickMeta(html, 'og:title');
  if (og) return og;
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).trim().slice(0, 200) : null;
}

function pickMeta(html, property) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i');
  const m = html.match(re);
  return m ? decodeEntities(m[1]).trim() : null;
}

/** Last resort: strip the page and hope the posting is the bulk of it. */
function bodyText(html) {
  const body = html.match(/<body[\s\S]*?>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const cleaned = body
    .replace(/<(nav|header|footer|aside|script|style|noscript|svg|form)[\s\S]*?<\/\1>/gi, ' ');
  return truncate(stripHtml(cleaned), 12000);
}

/**
 * Pasted text. The first non-empty line is almost always the job title, and a
 * "Company — Title" or "Title at Company" line is common enough to be worth
 * recognising.
 */
function fromText(text) {
  const clean = String(text ?? '').trim();
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? '';

  let title = first.slice(0, 200);
  let company = null;

  const at = first.match(/^(.+?)\s+(?:at|chez|@|—|–|\|)\s+(.+)$/i);
  if (at) {
    title = at[1].trim();
    company = at[2].trim();
  }

  return { title, company, description: clean };
}
