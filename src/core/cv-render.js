/**
 * Renders a tailored CV into a print-ready HTML page.
 *
 * The layout deliberately mirrors the two-column CV in CV_example/ — dark
 * header band, experience on the left, skills on the right — so the generated
 * document looks like a variant of your CV rather than a different document
 * that happens to contain the same facts.
 */

const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

const list = (items, cls = '') =>
  (items ?? []).length ? `<ul${cls ? ` class="${cls}"` : ''}>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '';

/**
 * @param cv        structured CV data
 * @param options   { scale } 1 = natural size. Lower values shrink everything
 *                  proportionally so a slightly-too-long CV still fits one page.
 *                  Defaults to whatever the auto-fit pass stored on the CV.
 */
export function renderCvHtml(cv = {}, { scale = cv.scale ?? 1 } = {}) {
  const c = cv.contact ?? {};

  const contactLine = [
    c.email && `<span>${esc(c.email)}</span>`,
    c.phone && `<span>${esc(c.phone)}</span>`,
    c.location && `<span>${esc(c.location)}</span>`,
    c.github && `<span>${esc(stripScheme(c.github))}</span>`,
    c.linkedin && `<span>${esc(stripScheme(c.linkedin))}</span>`,
  ].filter(Boolean).join('');

  const experience = (cv.experience ?? []).map((e) => `
    <div class="entry">
      <h3>${esc(e.role)}</h3>
      <div class="org">${esc([e.company, e.location].filter(Boolean).join(', '))}${period(e) ? ` <span class="period">| ${esc(period(e))}</span>` : ''}</div>
      ${list(e.bullets)}
    </div>`).join('');

  const education = (cv.education ?? []).map((e) => `
    <div class="entry">
      <h3>${esc(e.degree)}</h3>
      <div class="org">${esc(e.school)}${e.period ? ` <span class="period">| ${esc(e.period)}</span>` : ''}</div>
      ${list(e.bullets)}
    </div>`).join('');

  // Inline labels have to follow the CV's language too — an otherwise perfect
  // French CV saying "Context:" gives the game away immediately.
  const fr = cv.language === 'fr';
  const ctxLabel = cv.labels?.context || (fr ? 'Contexte' : 'Context');
  const techLabel = cv.labels?.tech || (fr ? 'Technologies' : 'Tech');

  const projects = (cv.projects ?? []).map((p) => `
    <div class="entry">
      <h3>${esc(p.name)}${p.period ? ` <span class="period">| ${esc(p.period)}</span>` : ''}</h3>
      ${p.context ? `<p class="ctx"><strong>${esc(ctxLabel)} :</strong> ${esc(p.context)}</p>`.replace(' :', fr ? ' :' : ':') : ''}
      ${(p.tech ?? []).length ? `<p class="ctx"><strong>${esc(techLabel)} :</strong> ${esc(p.tech.join(' · '))}</p>`.replace(' :', fr ? ' :' : ':') : ''}
      ${list(p.achievements)}
    </div>`).join('');

  const skills = (cv.skills ?? []).map((g) => `
    <div class="skillgroup">
      <div class="skilllabel">${esc(g.group)}</div>
      ${list(g.items)}
    </div>`).join('');

  const languages = (cv.languages ?? []).map((l) => `<li><strong>${esc(l.lang)}:</strong> ${esc(l.level)}</li>`).join('');

  const section = (title, body) => (body && body.trim() ? `<section><h2>${esc(title)}</h2>${body}</section>` : '');

  return `<!doctype html>
<html lang="${esc(cv.language === 'fr' ? 'fr' : 'en')}">
<head>
<meta charset="utf-8">
<title>${esc(cv.name || 'CV')}${cv.title ? ' — ' + esc(cv.title) : ''}</title>
<style>
  /* --s scales every size at once, so the whole CV can be squeezed to fit a
     single page without changing the layout or reflowing anything by hand. */
  :root { --s: ${scale}; }

  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-size: calc(10.2pt * var(--s));
    line-height: 1.42;
    font-family: "Segoe UI", -apple-system, system-ui, "Helvetica Neue", Arial, sans-serif;
    color: #2b2b2b; background: #fff;
    width: 210mm; margin: 0 auto;
  }

  header { background: #2f2f2f; color: #fff; padding: calc(11mm * var(--s)) 12mm calc(8mm * var(--s)); display: flex; gap: 8mm; align-items: flex-start; }
  header .who { flex: 1; min-width: 0; }
  header h1 { font-size: calc(21pt * var(--s)); font-weight: 600; letter-spacing: .2px; line-height: 1.1; }
  header .role { color: #6cc4d6; font-size: calc(14pt * var(--s)); font-style: italic; font-family: Georgia, "Times New Roman", serif; margin-top: 1mm; }
  header .summary { margin-top: calc(3.5mm * var(--s)); font-size: calc(9pt * var(--s)); line-height: 1.48; color: #d8d8d8; max-width: 118mm; }
  header .contact { text-align: right; font-size: calc(8.6pt * var(--s)); color: #e2e2e2; white-space: nowrap; }
  header .contact span { display: block; margin-bottom: calc(1.1mm * var(--s)); }

  main { display: flex; gap: calc(7mm * var(--s)); padding: calc(7mm * var(--s)) 12mm calc(8mm * var(--s)); align-items: flex-start; }
  .col-left { flex: 1.32; min-width: 0; }
  .col-right { flex: 1; min-width: 0; }

  section { margin-bottom: calc(5.8mm * var(--s)); break-inside: avoid; }
  h2 {
    font-size: calc(11.5pt * var(--s)); font-weight: 600; color: #3aa8bf; text-transform: uppercase; letter-spacing: .6px;
    padding-bottom: calc(1.2mm * var(--s)); margin-bottom: calc(2.8mm * var(--s)); border-bottom: 2px solid #cfe9ef;
  }

  .entry { margin-bottom: calc(4.2mm * var(--s)); break-inside: avoid; }
  .entry h3 { font-size: calc(10.2pt * var(--s)); font-weight: 600; }
  .entry .org { font-size: calc(9.4pt * var(--s)); font-weight: 600; color: #3f3f3f; margin-bottom: calc(1.3mm * var(--s)); }
  .entry .period { font-weight: 400; color: #6b6b6b; }
  .entry .ctx { font-size: calc(9.2pt * var(--s)); margin-bottom: calc(1.1mm * var(--s)); }

  ul { list-style: none; }
  li { font-size: calc(9.3pt * var(--s)); line-height: 1.42; padding-left: calc(3.6mm * var(--s)); position: relative; margin-bottom: calc(1mm * var(--s)); }
  li::before { content: "•"; position: absolute; left: 0; color: #3aa8bf; }

  .skillgroup { margin-bottom: calc(3mm * var(--s)); }
  .skilllabel { font-size: calc(9.2pt * var(--s)); color: #5c5c5c; margin-bottom: calc(.8mm * var(--s)); }
  .skillgroup li { margin-bottom: calc(.45mm * var(--s)); }

  @media screen {
    body { box-shadow: 0 2px 22px rgba(0,0,0,.16); margin: 18px auto; }
  }
</style>
</head>
<body>
  <header>
    <div class="who">
      <h1>${esc(cv.name)}</h1>
      ${cv.title ? `<div class="role">${esc(cv.title)}</div>` : ''}
      ${cv.summary ? `<p class="summary">${esc(cv.summary)}</p>` : ''}
    </div>
    ${contactLine ? `<div class="contact">${contactLine}</div>` : ''}
  </header>

  <main>
    <div class="col-left">
      ${section(cv.labels?.experience || 'Experience', experience)}
      ${section(cv.labels?.education || 'Education', education)}
      ${section(cv.labels?.projects || 'Projects', projects)}
    </div>
    <div class="col-right">
      ${section(cv.labels?.skills || 'Technical Skills', skills)}
      ${section(cv.labels?.personalSkills || 'Personal Skills', list(cv.personalSkills))}
      ${section(cv.labels?.languages || 'Languages', languages ? `<ul>${languages}</ul>` : '')}
      ${section(cv.labels?.interests || 'Interests', list(cv.interests))}
    </div>
  </main>
</body>
</html>`;
}

function period(e) {
  if (e.period) return e.period;
  return [e.start, e.end].filter(Boolean).join(' – ');
}

const stripScheme = (u = '') => String(u).replace(/^https?:\/\//, '');

/** Plain-text fallback, for copying into a form or an email. */
export function renderCvText(cv = {}) {
  const out = [];
  const c = cv.contact ?? {};
  out.push(cv.name ?? '', cv.title ?? '');
  out.push([c.location, c.email, c.phone].filter(Boolean).join(' · '));
  out.push([c.github, c.linkedin].filter(Boolean).join(' · '), '');
  if (cv.summary) out.push(cv.summary, '');

  const block = (title, rows) => {
    if (!rows.length) return;
    out.push(title.toUpperCase(), '='.repeat(title.length), '');
    out.push(...rows, '');
  };

  block('Experience', (cv.experience ?? []).flatMap((e) => [
    `${e.role} — ${[e.company, e.location].filter(Boolean).join(', ')}${period(e) ? ` (${period(e)})` : ''}`,
    ...(e.bullets ?? []).map((b) => `  - ${b}`), '',
  ]));

  block('Education', (cv.education ?? []).flatMap((e) => [
    `${e.degree} — ${e.school}${e.period ? ` (${e.period})` : ''}`,
    ...(e.bullets ?? []).map((b) => `  - ${b}`), '',
  ]));

  block('Projects', (cv.projects ?? []).flatMap((p) => [
    `${p.name}${p.period ? ` (${p.period})` : ''}`,
    p.context ? `  ${p.context}` : '',
    (p.tech ?? []).length ? `  Tech: ${p.tech.join(', ')}` : '',
    ...(p.achievements ?? []).map((a) => `  - ${a}`), '',
  ].filter(Boolean)));

  block('Technical Skills', (cv.skills ?? []).map((g) => `${g.group}: ${(g.items ?? []).join(', ')}`));
  block('Languages', (cv.languages ?? []).map((l) => `${l.lang}: ${l.level}`));
  block('Interests', cv.interests ?? []);

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
