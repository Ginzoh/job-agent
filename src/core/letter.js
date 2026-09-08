/**
 * Turning a generated cover letter into something sendable.
 *
 * The model is asked for a letter and usually returns one, but often with a
 * sentence of its own in front — "658 characters, well within the limit. Here's
 * the finished letter:" — sometimes followed by a rule, a fence, or a heading
 * like "## Final Letter". That is fine in a chat transcript and wrong in an
 * application folder, so it is stripped before the letter is shown or filed.
 */

const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

// Prose *about* the letter. A real letter never opens this way — it opens with
// a name, a subject line, or a greeting.
const CHATTER = /(character|caractère|voici|here'?s|here is|below|ci-dessous|limit|finalis|final version|j'ai (écrit|rédigé)|i'?ve (written|drafted)|no stray file)/i;

// A heading that names the letter rather than belonging to it.
const LABEL_HEADING = /^#{1,6}\s*(final\s+|the\s+)?(letter|lettre|version|cover\s+letter|lettre\s+de\s+motivation)\b/i;

const RULE = /^\s*(-{3,}|_{3,}|\*{3,})\s*$/;
const FENCE = /^\s*```/;

/**
 * The letter itself, with any preamble removed.
 *
 * Deliberately conservative: it only strips when the opening line is prose
 * about the letter, so a letter that happens to begin with a horizontal rule
 * or a heading is left alone.
 */
export function letterBody(text = '') {
  let lines = String(text).trim().split('\n');

  // A wholly fenced response: unwrap it and carry on.
  if (FENCE.test(lines[0] ?? '') && FENCE.test(lines[lines.length - 1] ?? '')) {
    lines = lines.slice(1, -1);
  }

  const firstIdx = lines.findIndex((l) => l.trim());
  const first = lines[firstIdx] ?? '';
  if (!CHATTER.test(first)) return lines.join('\n').trim();

  // Everything up to the delimiter that follows the chatter is preamble. Only
  // look at the opening of the document — a rule halfway down is part of the
  // letter's own layout.
  const window = Math.min(lines.length, firstIdx + 8);
  for (let i = firstIdx + 1; i < window; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      const close = lines.findIndex((l, j) => j > i && FENCE.test(l));
      return lines.slice(i + 1, close === -1 ? undefined : close).join('\n').trim();
    }
    if (RULE.test(line)) return lines.slice(i + 1).join('\n').trim();
    if (LABEL_HEADING.test(line)) return lines.slice(i + 1).join('\n').trim();
  }

  // No delimiter — drop just the offending line and keep the rest.
  return lines.slice(firstIdx + 1).join('\n').trim();
}

/** The small slice of Markdown these letters actually use. */
function inline(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    // Links become their text: a blue underline in a printed letter is noise.
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}

function blocksToHtml(text) {
  return text
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').filter((l) => l.trim());
      if (!lines.length) return '';

      if (lines.every((l) => RULE.test(l))) return '<hr>';

      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        const items = lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('');
        return `<ul>${items}</ul>`;
      }

      const heading = lines[0].match(/^(#{1,6})\s+(.*)$/);
      if (heading && lines.length === 1) {
        const level = Math.min(heading[1].length + 1, 4);
        return `<h${level}>${inline(heading[2])}</h${level}>`;
      }

      // Single newlines are meaningful here: the letterhead is one block of
      // separate lines, and joining them into a paragraph would ruin it.
      return `<p>${lines.map((l) => inline(l.replace(/^(#{1,6})\s+/, ''))).join('<br>')}</p>`;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Lay the letter out as an A4 page.
 *
 * Matched to the ATS CV on purpose — same face, same margins — so the two
 * documents in an application folder read as a set rather than as two files
 * that happen to travel together.
 */
export function renderLetterHtml(text, { language = 'en', scale = 1 } = {}) {
  const body = blocksToHtml(letterBody(text));

  return `<!doctype html>
<html lang="${esc(language === 'fr' ? 'fr' : 'en')}">
<head>
<meta charset="utf-8">
<title>${esc(language === 'fr' ? 'Lettre de motivation' : 'Cover letter')}</title>
<style>
  @page { size: A4; margin: 20mm 22mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Arial, Helvetica, "Liberation Sans", sans-serif;
    font-size: calc(10.8pt * ${scale});
    line-height: 1.5;
    color: #000; background: #fff;
    width: 166mm; margin: 0 auto;
  }
  h2, h3, h4 { font-size: calc(12pt * ${scale}); margin-bottom: 2mm; }
  h2 { font-size: calc(14pt * ${scale}); }
  p { margin-bottom: 3.4mm; }
  ul { margin: 0 0 3.4mm 5mm; }
  li { margin-bottom: 1mm; }
  hr { border: none; border-top: 1px solid #bbb; margin: 4mm 0; }
  strong { font-weight: bold; }
  @media screen {
    body { width: 210mm; padding: 20mm 22mm; box-shadow: 0 2px 22px rgba(0,0,0,.16); margin: 18px auto; }
  }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
