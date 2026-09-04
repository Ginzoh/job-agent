import { env } from '../config.js';
import { getBackend, parseJson } from '../llm/index.js';
import { loadReferenceDocs } from '../lib/docs.js';
import { recordSpend, totalSpend, saveDocument } from '../lib/db.js';
import { truncate, detectLanguage } from '../lib/text.js';
import { renderCvHtml } from './cv-render.js';
import { renderCvPdfFitted, pdfAvailable } from './pdf.js';
import { resolveLanguage, writableLanguages, languageName } from './language.js';

/**
 * Application-writing tools: what to change in the CV for a given role, a
 * tailored CV, and a cover letter.
 *
 * The single most important property of all three is that they never invent
 * anything. A CV that claims experience you don't have doesn't get you a job —
 * it gets you an interview you can't survive. Every prompt below treats the
 * reference documents as the only admissible source of fact.
 */

const NEVER_INVENT = `ABSOLUTE RULE — do not invent anything.

The reference documents are the only source of truth about this candidate. You may reorder, reword, re-emphasise, expand on and select from what they contain. You may NOT add:
- employers, job titles, dates or durations that do not appear in them
- technologies, tools or frameworks the candidate has not actually used
- metrics, percentages, team sizes, user counts or revenue figures that are not already stated
- certifications, degrees, languages or clearances not listed
- claims of seniority beyond what the documents support

If the role asks for something the candidate does not have, do NOT quietly manufacture it. Say so plainly in the notes instead. A tailored document that survives an interview is the goal; an impressive one that collapses under a single follow-up question is a failure.

Do not turn a STATUS into EXPERIENCE. This is the most common way these documents drift into fiction, because the inference feels harmless. Being registered as a freelancer is not the same as having freelanced; owning a company is not having run projects through it; being available for something is not having done it; studying a technology is not having shipped with it. If the documents say someone is set up to do something but has not yet done it, write only that they are available — never that they have practice, habits, or lessons learned from it. Where a document explicitly says a thing has not happened yet, that instruction outranks anything you could infer from a job title, a company name or a status.

Rewording IS allowed and expected: "Integrated GraphQL APIs with Apollo Client" may become "Built GraphQL data-fetching layers with Apollo Client" if the posting speaks that way. Changing meaning is not.`;

const ATS_GUIDANCE = `Mirror the posting's own vocabulary wherever it is truthful to do so. If they write "React.js" use "React.js"; if they say "microservices" and the candidate genuinely worked on services, use their word. Applicant tracking systems and human screeners both match on surface terminology, and the candidate loses matches purely to wording. Never let this rule push you into claiming something untrue.`;

/* ------------------------------------------------------------------ prompts */

const PROMPTS = {
  advice: {
    model: () => env.claudeModelWrite,
    system: `You are a blunt, experienced technical recruiter reviewing one candidate's CV against one specific job posting. You have screened thousands of developer CVs and you know exactly what gets a callback and what gets discarded in six seconds.

Your job is to say what to change. Be concrete and specific — "add metrics" is useless advice, "your Idemoov bullet says 'engineered full-stack features', but this posting is entirely about design systems, so lead with the MaterialUI component work from DeltaCE instead" is useful advice.

Be honest about gaps. If the candidate is genuinely underqualified, say so and say whether it is worth applying anyway. Do not be encouraging for its own sake.

${NEVER_INVENT}

Output GitHub-flavoured Markdown, using exactly these sections:

## Verdict
One short paragraph: is this worth applying to, and what is the single biggest thing standing between this CV and an interview here?

## Lead with these
The 3-5 things already on the CV that matter most for THIS role, and where to move them so a screener sees them in the first six seconds.

## Rewrite these lines
A table with columns: Current | Change it to | Why. Quote the CV's actual wording in "Current". Every suggestion must stay truthful.

## Keywords you are missing
Terms in the posting that the candidate genuinely has experience with but has not written down. Separately, list terms from the posting they do NOT have — clearly marked as gaps, never as things to add.

## Cut or shrink
What is taking up space without earning it for this specific role.

## Gaps and how to handle them
Real mismatches. For each: is it fatal, and what is the honest way to address it in the application or interview?`,
  },

  cv: {
    model: () => env.claudeModelWrite,
    json: true,
    system: `You are an expert technical CV writer. You rewrite an existing developer CV so it targets one specific job posting as precisely as possible, without ever misrepresenting the candidate.

${NEVER_INVENT}

${ATS_GUIDANCE}

How to tailor:
- Keep the structure of the source CV. It works; do not redesign it.
- Reorder experience bullets so the most relevant to THIS posting come first within each role. Never reorder the roles themselves — chronology must stay intact.
- Rewrite the summary so it speaks directly to this role.
- Select which technical skills to show and in what order. Drop groups that are irrelevant here to make room; never add ones the candidate lacks.
- Where the posting emphasises something the candidate genuinely did, expand that bullet with real detail from the reference documents — including facts that appear in a shared-context section but not on the one-page CV. Those are true and usable.
- Preserve the candidate's real contact details exactly as given.

THE CV MUST FIT ON ONE A4 PAGE. This is a hard constraint, not a preference. A two-page CV for a candidate with two years of experience reads as padding, and recruiters skim the first page only. Stay inside this budget:

- summary: 45 words maximum, 2-3 sentences
- experience: every role from the source CV, but at most 4 bullets each, and at most 22 words per bullet
- education: at most 2 entries, at most 2 bullets each
- projects: at most 1, and only if it genuinely strengthens the application for THIS role. Drop it entirely if experience already covers the same ground — it is the first thing to cut
- skills: at most 5 groups, at most 6 items per group
- personalSkills: at most 4, and only genuinely differentiating ones. Cut generic traits ("team player", "rigorous")
- interests: at most 3 short items, or omit the section

Being under budget is good. Selecting hard is the job: a focused one-page CV beats a complete two-page one every time. If you cannot fit everything, cut the content least relevant to this posting — never the most recent role, and never contact details.
- Write every field in the target language. If the CV is in French, section labels must be French too.

Output ONLY a JSON object, no prose and no markdown fences:

{
  "language": "fr" | "en",
  "name": "...",
  "title": "job title to present as, tuned to the posting",
  "contact": { "email": "...", "phone": "...", "location": "...", "github": "...", "linkedin": "..." },
  "summary": "2-3 sentence profile aimed at this role",
  "labels": { "experience": "...", "education": "...", "projects": "...", "skills": "...", "personalSkills": "...", "languages": "...", "interests": "..." },
  "experience": [ { "role": "...", "company": "...", "location": "...", "period": "Month Year – Month Year", "bullets": ["..."] } ],
  "education": [ { "degree": "...", "school": "...", "period": "...", "bullets": ["..."] } ],
  "projects":  [ { "name": "...", "period": "...", "context": "...", "tech": ["..."], "achievements": ["..."] } ],
  "skills":    [ { "group": "Main languages", "items": ["..."] } ],
  "personalSkills": ["..."],
  "languages": [ { "lang": "...", "level": "..." } ],
  "interests": ["..."],
  "changes": [ { "section": "which part of the CV", "before": "the original wording, quoted from the source CV, or 'not present'", "after": "the new wording", "why": "one short sentence tying it to this posting" } ],
  "gaps": ["something the posting asks for that the candidate genuinely does not have"]
}

"changes" is important and must be complete: list every substantive edit — rewritten summary, reordered or reworded bullets, skills added or dropped, a changed job title. The reader uses this to review the CV at a glance instead of re-reading it line by line. Keep "before" and "after" short enough to scan (one line each). Do not list trivial punctuation changes.`,
  },

  cover: {
    model: () => env.claudeModelWrite,
    system: `You are an expert cover-letter writer for software engineering roles.

You are given the candidate's own cover-letter template. Take from it their VOCABULARY and REGISTER — how formal they are, how long their sentences run, their preference for a concrete detail over an adjective. Do NOT copy its structure, its anecdotes, or above all its opening device.

${NEVER_INVENT}

## THE OPENING — this is where these letters go wrong

Start plainly and get to the point. The first sentence says which role this is about and the single most relevant thing about the candidate. The second gives one concrete piece of evidence. Three lines in, the reader should already know why the letter is worth finishing.

DO NOT open with a scene, an aphorism, a rhetorical question, a philosophical observation, or a general truth about the industry. Specifically forbidden:
- "There is a particular moment in every project when…"
- "Reliable real-time information has no margin for error: either…"
- "What makes a good developer?"
- "In an industry where everything changes every six months…"
- Any sentence whose purpose is to set a mood before the letter actually starts.

This kind of opening reads as writing-about-writing. A screener reading forty letters skips it and looks for the first concrete fact. Give them that fact immediately.

Good openings:
  "I'm writing about the Full Stack Developer role in Nantes. I've spent the last two years building React front-ends on Node.js and NestJS backends, most recently a badging system at Idemoov where I owned everything from the data model through to deployment."
  "Your posting asks for someone who can take a feature from API design to the rendered component. That's the part of the job I've actually been doing for two years."

"I am writing to apply for the position of X" is dull but honest, and is still far better than a manufactured hook. If in doubt, be plain.

## The rest of the letter

- Name something real about THIS company or product, drawn from the posting. If the posting says nothing specific, engage with the technical problem the role implies rather than inventing a fact about the company.
- Show, don't claim. "I built an RFID badging system where the API had to stay reliable whether or not the hardware behaved" beats "I am a reliable problem-solver."
- Address the biggest objection a screener would have, briefly and without apology.
- Close with a clear, unfussy statement of availability and interest.
- Do not restate the CV line by line. The letter earns its place by saying what a CV cannot.
- Four or five short paragraphs. Every sentence must carry information; if one only sets up the next, delete it.

Banned: "passionate about", "team player", "think outside the box", "fast-paced environment", "wear many hats", "I believe I would be a great fit", "I was excited to see", "perfect opportunity", and rhetorical questions anywhere in the letter.

Output the finished letter as GitHub-flavoured Markdown, ready to send. Use the placeholder [Hiring Manager] only if the posting genuinely names nobody. Do not add commentary before or after the letter.`,
  },
};

/* -------------------------------------------------------------- user prompt */

function jobBlock(job) {
  return [
    '# THE JOB POSTING',
    '',
    `Title: ${job.title}`,
    `Company: ${job.company || 'not stated'}`,
    `Location: ${job.location || 'not stated'}${job.is_remote ? ' (remote-friendly)' : ''}`,
    job.contract && job.contract !== 'unknown' ? `Contract: ${job.contract}` : null,
    job.salary ? `Compensation: ${job.salary}` : null,
    job.stack?.length ? `Technologies mentioned: ${job.stack.join(', ')}` : null,
    job.url ? `URL: ${job.url}` : null,
    '',
    'Full description:',
    truncate(job.description || '(no description available)', 9000),
  ].filter((l) => l !== null).join('\n');
}

function buildUserPrompt(kind, job, docs, options) {
  const parts = [];

  parts.push('# REFERENCE DOCUMENTS (the only source of truth about this candidate)');
  parts.push('');
  parts.push('## Current CV');
  parts.push(docs.cv.text || '(none provided)');

  if (kind === 'cover') {
    parts.push('');
    parts.push("## The candidate's own cover-letter template — match this voice");
    parts.push(docs.letter.text || '(none provided)');
  }

  parts.push('');
  parts.push(jobBlock(job));
  parts.push('');

  const req = [];

  // The language is resolved before we get here, against what the candidate can
  // actually write. Never tell the model to "match the posting" — that is how a
  // Swedish advert produced a Swedish CV for someone who does not read Swedish.
  if (options.language) {
    const lang = languageName(options.language);
    req.push(
      `Write EVERYTHING in ${lang} — summary, bullets, section labels, all of it. ` +
      `Use natural professional ${lang}, not translated English. ` +
      `Do this even if the job posting is written in a different language: the candidate needs a document they can read, check and defend in an interview.`
    );
  } else {
    req.push('Write in the same language as the job posting.');
  }

  if (kind === 'cover') {
    if (options.maxChars) {
      req.push(`Hard limit: no more than ${options.maxChars} characters in the body of the letter, excluding the header block and signature. Being comfortably under is better than being at the limit.`);
    }
    if (options.tone) req.push(`Tone: ${TONES[options.tone] ?? options.tone}.`);
  }

  if (kind === 'cv' && options.maxChars) {
    req.push(`Keep the CV body under roughly ${options.maxChars} characters.`);
  }

  if (options.notes?.trim()) {
    req.push(`Additional instructions from the candidate — follow these closely: ${options.notes.trim()}`);
  }

  parts.push('# YOUR TASK');
  parts.push('');
  parts.push(TASKS[kind]);
  if (req.length) {
    parts.push('');
    parts.push('Requirements:');
    parts.push(req.map((r) => `- ${r}`).join('\n'));
  }

  return parts.join('\n');
}

const TASKS = {
  advice: 'Review this CV against this posting and tell the candidate exactly what to change.',
  cv: 'Produce a tailored version of this CV targeting this specific posting.',
  cover: 'Write a cover letter for this specific posting, in the candidate\'s own voice.',
};

// Plain-English description of what each trim level removed, so the change
// table says what was cut rather than just that something was.
const TRIM_SUMMARY = {
  1: 'Dropped interests and trimmed personal skills',
  2: 'Dropped interests, personal skills and the projects section',
  3: 'Also capped skill groups and shortened education detail',
  4: 'Also reduced experience to the four strongest bullets per role',
  5: 'Reduced to the essentials only — three bullets per role, no education detail',
};

const TONES = {
  professional: 'measured and professional, the default register of the template',
  warm: 'warmer and more personable, while still precise',
  direct: 'direct and economical — short sentences, no throat-clearing',
  enthusiastic: 'genuinely enthusiastic about the specific work, without gushing or cliché',
};

/* -------------------------------------------------------------------- entry */

export const KINDS = Object.keys(PROMPTS);

/**
 * Generate one document for one job. Respects the same spend ceiling as
 * scoring, and persists the result so it can be reopened later.
 */
export async function tailor(job, kind, options = {}) {
  const spec = PROMPTS[kind];
  if (!spec) throw new Error(`unknown document type "${kind}" (expected one of: ${KINDS.join(', ')})`);

  const backend = getBackend();
  if (!backend) throw new Error('LLM_BACKEND is "none" — set it to claude or ollama to generate documents');

  // Which language are we working in? An explicit choice wins, then the offer's
  // own language if the candidate writes it, then English as the fallback.
  const jobLang = detectLanguage(`${job.title}\n${job.description ?? ''}`);
  const writable = writableLanguages();
  const { language: targetLang, reason: languageReason } = resolveLanguage({
    requested: options.language,
    jobLang,
    writable,
  });

  const docs = loadReferenceDocs(targetLang);
  if (!docs.cv.text) {
    throw new Error(docs.cv.problem || 'no readable CV found in CV_example/');
  }
  if (kind === 'cover' && !docs.letter.text) {
    throw new Error(docs.letter.problem || 'no readable cover letter found in cover_letter_example/');
  }

  const budget = env.maxSpendUsd;
  const spent = totalSpend();
  if (budget > 0 && spent >= budget) {
    throw new Error(`budget ceiling reached ($${spent.toFixed(2)} of $${budget.toFixed(2)}). Raise MAX_SPEND_USD in .env or switch to LLM_BACKEND=ollama.`);
  }

  const model = spec.model();
  const result = await backend.complete({
    system: spec.system,
    prompt: buildUserPrompt(kind, job, docs, { ...options, language: targetLang }),
    model,
    timeout: Math.max(env.llmTimeoutMs, 420000),
  });

  recordSpend({ cost: result.cost, model: result.model, jobs: 1 });

  // The CV comes back as structured data so it can be laid out as a real
  // document; everything else is prose and stays as Markdown.
  let content = cleanOutput(result.text);
  let structured = null;

  if (spec.json) {
    try {
      structured = parseJson(content);
    } catch (err) {
      throw new Error(`the model did not return valid CV data (${err.message}). Try again, or switch CLAUDE_MODEL_WRITE to a stronger model.`);
    }

    // Find the scale that makes this fit one page, once, at generation time.
    // Storing it means the preview, the printable page and the PDF all agree,
    // and reopening a saved CV costs nothing.
    if (pdfAvailable()) {
      const fit = await renderCvPdfFitted(structured, renderCvHtml);
      const changes = structured.changes ?? [];

      // Adopt the version that actually fits, keeping the review metadata from
      // the original so the change table still reflects the tailoring.
      structured = { ...fit.cv, changes, gaps: structured.gaps ?? [] };
      structured.scale = fit.scale;
      structured.pages = fit.pages;
      structured.fitsOnePage = fit.fitted;
      structured.trimLevel = fit.trim;

      if (fit.trim > 0) {
        structured.changes = [...changes, {
          section: 'Length',
          before: 'Ran onto a second page',
          after: TRIM_SUMMARY[Math.min(fit.trim, 5)],
          why: 'a CV has to fit one page — cut the least relevant material for this role first',
        }];
      }

      if (!fit.fitted) {
        structured.gaps = [
          ...structured.gaps,
          `⚠ Still ${fit.pages} pages after trimming. Regenerate with "make it much shorter" in the notes.`,
        ];
      }
    }

    content = JSON.stringify(structured, null, 2);
  }

  const sources = {
    jobLanguage: jobLang,
    language: targetLang,
    languageReason,
    writableLanguages: writable,
    cvFile: docs.cv.file,
    cvMatchedLanguage: docs.cv.matchedLanguage,
    letterFile: kind === 'cover' ? docs.letter.file : undefined,
  };

  const saved = saveDocument({
    jobId: job.id,
    kind,
    content,
    model: result.model,
    cost: result.cost,
    options: { ...options, ...sources },
  });

  return { kind, content, structured, model: result.model, cost: result.cost, id: saved.id, createdAt: saved.at, ...sources };
}

/** Models sometimes wrap a whole document in a fence; unwrap it if so. */
function cleanOutput(text = '') {
  const trimmed = text.trim();
  const whole = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*)\n```$/);
  return (whole ? whole[1] : trimmed).trim();
}
