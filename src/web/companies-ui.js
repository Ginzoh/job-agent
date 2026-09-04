import { page } from './shell.js';

const STYLES = `
  header.filters{position:sticky;top:49px;z-index:20;background:rgba(13,17,23,.94);backdrop-filter:blur(8px);
                 border-bottom:1px solid var(--line);padding:12px 20px}
  main{max-width:1180px;margin:0 auto;padding:18px 20px 60px}
  .stats{display:flex;gap:18px;flex-wrap:wrap;color:var(--dim);font-size:12.5px;margin-bottom:16px}
  .stats b{color:var(--fg);font-variant-numeric:tabular-nums}

  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px;transition:.12s}
  .card:hover{border-color:#4b5563}
  .card.open{border-color:var(--accent)}
  .top{display:flex;gap:12px;align-items:flex-start}
  .score{flex:none;width:46px;height:46px;border-radius:9px;display:grid;place-items:center;font-weight:700;font-size:17px;font-variant-numeric:tabular-nums}
  .s80{background:rgba(63,185,80,.16);color:var(--green)}
  .s60{background:rgba(47,129,247,.16);color:var(--accent)}
  .s40{background:rgba(210,153,34,.16);color:var(--yellow)}
  .s0 {background:rgba(248,81,73,.14);color:var(--red)}
  .name{font-weight:600;font-size:15px;margin:0 0 3px}
  .summary{margin:9px 0 0;color:#c9d1d9;font-size:13.5px}
  .tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:9px}
  .tag{background:var(--panel2);border:1px solid var(--line);color:var(--dim);border-radius:20px;padding:1px 9px;font-size:11.5px}
  .badge{border-radius:5px;padding:1px 7px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.3px}
  .b-history{background:rgba(63,185,80,.16);color:var(--green)}
  .b-registry{background:rgba(163,113,247,.16);color:var(--purple)}
  .b-shortlisted{background:rgba(47,129,247,.18);color:var(--accent)}
  .b-contacted{background:rgba(63,185,80,.18);color:var(--green)}

  .detail{display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
  .card.open .detail{display:block}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:700px){.cols{grid-template-columns:1fr}}
  .cols h4{margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim)}
  .cols ul{margin:0;padding-left:18px}
  .cols li{margin-bottom:3px}
  .angle{margin-top:12px;background:var(--panel2);border-left:3px solid var(--purple);border-radius:0 7px 7px 0;padding:10px 13px;font-size:13.5px}
  .angle h4{margin:0 0 5px;font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--purple)}
  .pitch{margin-top:10px;background:var(--panel2);border-left:3px solid var(--accent);border-radius:0 7px 7px 0;padding:10px 13px;font-size:13.5px}
  .pitch h4{margin:0 0 5px;font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--accent)}
  .actions{display:flex;gap:7px;margin-top:12px;flex-wrap:wrap}
  .gen{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px dashed var(--line)}
  .gen button{border-color:#3d4c63}
  .gen button:hover{border-color:var(--accent);color:var(--accent)}
  .opts{display:none;gap:8px;flex-wrap:wrap;align-items:center;margin-top:9px;background:var(--panel2);padding:9px 11px;border-radius:8px}
  .opts.show{display:flex}
  .opts label{font-size:12px;color:var(--dim);display:flex;gap:5px;align-items:center}
  .opts input[type=number]{width:78px}
  .opts input[type=text]{flex:1;min-width:170px}
  .empty{text-align:center;color:var(--dim);padding:60px 20px}
  .empty code{background:var(--panel);padding:2px 7px;border-radius:5px;color:var(--fg)}

  .saved{display:inline-flex;gap:6px;flex-wrap:wrap;align-items:center;vertical-align:middle}
  .saved .lbl{color:var(--dim);font-size:12px}
  .chip{display:inline-flex;align-items:center;gap:5px;background:var(--panel2);border:1px solid var(--line);
        border-radius:20px;padding:2px 4px 2px 10px;font-size:12px;transition:.12s}
  .chip:hover{border-color:var(--accent)}
  .chip a{color:var(--fg);text-decoration:none}
  .chip a:hover{color:var(--accent)}
  .chip time{color:var(--dim);font-size:11px}
  .chip .del{opacity:0;width:17px;height:17px;line-height:15px;text-align:center;border-radius:50%;border:0;
             background:transparent;color:var(--dim);cursor:pointer;font-size:13px;padding:0;transition:.12s}
  .chip:hover .del{opacity:1}
  .chip.confirming .del{opacity:1;background:rgba(248,81,73,.18);color:var(--red);width:auto;border-radius:10px;padding:0 7px;font-size:11px}

  .modal{position:fixed;inset:0;background:rgba(0,0,0,.72);display:none;z-index:50;padding:24px;overflow:auto}
  .modal.show{display:block}
  .sheet{background:var(--panel);border:1px solid var(--line);border-radius:12px;max-width:900px;margin:0 auto}
  .sheet header{position:sticky;top:0;background:var(--panel);border-bottom:1px solid var(--line);padding:14px 18px;
                display:flex;gap:10px;align-items:center;border-radius:12px 12px 0 0;flex-wrap:wrap}
  .sheet h3{margin:0;font-size:15px;flex:1;min-width:180px}
  .sheet .body{padding:18px 22px}
  .doc{white-space:pre-wrap;font:13.5px/1.65 ui-monospace,Consolas,monospace;color:#d7dee6}
  .working{padding:44px;text-align:center;color:var(--dim)}
  .working .spin{width:22px;height:22px;border-width:3px;display:block;margin:0 auto 14px}
  .chg{width:100%;border-collapse:collapse;font-size:13px}
  .chg th{text-align:left;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:6px 8px;border-bottom:1px solid var(--line)}
  .chg td{padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
  .before{color:#9aa4b0;text-decoration:line-through;text-decoration-color:rgba(248,81,73,.55)}
  .after{color:#c8e6c9}
  .why{color:var(--dim);font-size:12.5px}
  .gaps{margin-top:14px;background:rgba(210,153,34,.10);border-left:3px solid var(--yellow);border-radius:0 7px 7px 0;padding:10px 13px}
  .gaps h4{margin:0 0 6px;font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--yellow)}
  .cvframe{width:100%;height:70vh;border:1px solid var(--line);border-radius:8px;background:#fff}
  .tabs{display:flex;gap:6px;margin-bottom:12px}
  .tabs button.on{background:var(--accent);border-color:var(--accent);color:#fff}
`;

const SCRIPT = `
let companies = [];
let openId = null;
let modalText = '';
let openDocId = null;

const KIND_LABEL = { advice: 'CV advice', cv: 'Tailored CV', cover: 'Cover letter' };

async function load() {
  const p = new URLSearchParams();
  for (const [el, key] of Object.entries({ status:'status', minScore:'minScore', source:'source', order:'order' })) {
    const v = $('#' + el).value; if (v) p.set(key, v);
  }
  if ($('#q').value.trim()) p.set('q', $('#q').value.trim());
  p.set('limit', '150');

  const r = await fetch('/api/companies?' + p);
  if (r.status === 401) return location.reload();
  companies = (await r.json()).companies;
  render();
  loadStats();
}

async function loadStats() {
  const s = await (await fetch('/api/companies/stats')).json();
  $('#stats').innerHTML = [
    ['found', s.total], ['scored', s.scored], ['strong fit', s.strong],
    ['shortlisted', s.shortlisted], ['contacted', s.contacted], ['to score', s.unscored],
  ].map(([k,v]) => k + ' <b>' + v + '</b>').join('<span class="sep">·</span> ');
}

function render() {
  if (!companies.length) {
    $('#list').innerHTML = '<div class="empty"><p><b>No companies match these filters.</b></p>' +
      '<p>Run <code>yarn companies</code> to discover more, then <code>yarn companies:score</code> to judge them.</p></div>';
    return;
  }

  $('#list').innerHTML = companies.map((co) => {
    const src = co.source.includes('job-history')
      ? '<span class="badge b-history">proven hirer</span>'
      : '<span class="badge b-registry">local register</span>';
    const st = ['shortlisted','contacted'].includes(co.status)
      ? '<span class="badge b-' + co.status + '">' + esc(co.status) + '</span>' : '';

    const meta = [
      esc(co.location || 'location unknown'),
      co.size ? esc(co.size) : '',
      co.job_count ? co.job_count + ' past posting' + (co.job_count > 1 ? 's' : '') : '',
      co.best_job_score ? 'best role scored ' + co.best_job_score : '',
    ].filter(Boolean).join(' <span class="sep">·</span> ');

    return '<div class="card ' + (openId === co.id ? 'open' : '') + '" data-id="' + co.id + '">' +
      '<div class="top">' +
        '<div class="score ' + scoreClass(co.score) + '">' + (co.score ?? '?') + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<p class="name">' + esc(co.name) + '</p>' +
          '<div class="meta">' + meta + ' ' + src + ' ' + st + '</div>' +
          (co.fit_summary ? '<p class="summary">' + esc(co.fit_summary) + '</p>' : '') +
          (co.sample_titles?.length ? '<div class="tags">' + co.sample_titles.slice(0,4).map((t) => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>' : '') +
        '</div>' +
        '<button class="toggle">' + (openId === co.id ? 'Less' : 'More') + '</button>' +
      '</div>' +
      '<div class="detail">' + (openId === co.id ? detailHtml(co) : '') + '</div>' +
    '</div>';
  }).join('');
}

function detailHtml(co) {
  const list = (arr, icon) => (arr ?? []).map((x) => '<li>' + icon + ' ' + esc(x) + '</li>').join('');
  return '' +
    (co.evidence ? '<p class="meta">' + esc(co.evidence) + '</p>' : '') +
    '<div class="cols" style="margin-top:10px">' +
      '<div><h4>Worth approaching because</h4><ul>' + (list(co.pros,'✅') || '<li class="meta">nothing noted</li>') + '</ul></div>' +
      '<div><h4>Reasons for doubt</h4><ul>' + (list(co.cons,'⚠️') || '<li class="meta">nothing noted</li>') + '</ul></div>' +
    '</div>' +
    (co.approach ? '<div class="angle"><h4>How to approach them</h4>' + esc(co.approach) + '</div>' : '') +
    (co.pitch ? '<div class="pitch"><h4>Suggested opening</h4>' + esc(co.pitch) + '</div>' : '') +
    '<div class="actions">' +
      (co.website ? '<a href="' + esc(co.website) + '" target="_blank" rel="noopener"><button class="primary">Website ↗</button></a>' : '') +
      '<a href="https://www.google.com/search?q=' + encodeURIComponent(co.name + ' ' + (co.location||'') + ' recrutement') + '" target="_blank" rel="noopener"><button>Search them ↗</button></a>' +
      (co.siren ? '<a href="https://annuaire-entreprises.data.gouv.fr/entreprise/' + esc(co.siren) + '" target="_blank" rel="noopener"><button>Company record ↗</button></a>' : '') +
      '<button data-act="shortlisted">★ Shortlist</button>' +
      '<button data-act="contacted">✔ Mark contacted</button>' +
      '<button data-act="rejected">✕ Not interested</button>' +
    '</div>' +
    '<div class="gen">' +
      '<button data-gen="advice" title="What to change in your CV before writing to them">📝 CV advice</button>' +
      '<button data-gen="cv" title="Tailored CV for a speculative approach">📄 Tailor my CV</button>' +
      '<button data-gen="cover" title="Speculative cover letter">✉️ Cover letter</button>' +
      '<button data-optstoggle>⚙︎ Options</button>' +
      '<span id="docs-' + co.id + '" class="meta"></span>' +
    '</div>' +
    '<div class="opts">' +
      '<label>Language <select data-opt="language"><option value="">auto (your languages)</option><option value="fr">Français</option><option value="en">English</option></select></label>' +
      '<label>Max characters <input type="number" data-opt="maxChars" placeholder="2200" min="300" step="100"></label>' +
      '<label>Tone <select data-opt="tone"><option value="professional">Professional</option><option value="warm">Warm</option><option value="direct">Direct</option><option value="enthusiastic">Enthusiastic</option></select></label>' +
      '<input type="text" data-opt="notes" placeholder="Anything else? e.g. \\'mention I can start immediately\\'">' +
    '</div>';
}

$('#list').addEventListener('click', async (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;

  if (e.target.classList.contains('toggle')) {
    openId = openId === id ? null : id;
    render();
    if (openId) showDocs(openId);
    return;
  }
  if (e.target.hasAttribute('data-optstoggle')) { card.querySelector('.opts')?.classList.toggle('show'); return; }

  const kind = e.target.dataset.gen;
  if (kind) return generate(card, id, kind);

  const act = e.target.dataset.act;
  if (act) {
    await fetch('/api/company/' + id, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ status: act }) });
    toast('Marked as ' + act);
    openId = null;
    load();
  }
});

function readOptions(card) {
  const o = {};
  for (const el of card.querySelectorAll('[data-opt]')) {
    const v = el.value.trim();
    if (v) o[el.dataset.opt] = el.dataset.opt === 'maxChars' ? Number(v) : v;
  }
  return o;
}

async function generate(card, id, kind) {
  const co = companies.find((x) => x.id === id);
  openModal(KIND_LABEL[kind] + ' — ' + (co ? co.name : ''), null);
  try {
    const r = await fetch('/api/tailor', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companyId: id, kind, options: readOptions(card) }),
    });
    const data = await r.json();
    if (!r.ok) return openModal(KIND_LABEL[kind] + " — couldn't generate", data.error || 'unknown error');
    const src = [
      data.cvFile ? (data.cvMatchedLanguage ? '✓ ' : '⚠ ') + data.cvFile : '',
      data.language ? 'written in ' + data.language.toUpperCase() : '',
      data.languageReason && data.languageReason !== 'matched the offer' ? '(' + data.languageReason + ')' : '',
    ].filter(Boolean).join(' · ');
    const meta = [data.model + ' · $' + (data.cost||0).toFixed(3), src].filter(Boolean).join(' · ');
    if (kind === 'cv' && data.structured) openCv(data.id, data.structured, meta);
    else openModal(KIND_LABEL[kind] + ' — ' + (co ? co.name : ''), data.content, meta);
    showDocs(id);
  } catch (err) { openModal(KIND_LABEL[kind] + ' — failed', String(err)); }
}

async function showDocs(id) {
  const slot = document.getElementById('docs-' + id);
  if (!slot) return;
  const { documents } = await (await fetch('/api/documents?jobId=' + encodeURIComponent('company:' + id))).json();
  if (!documents?.length) { slot.innerHTML = ''; return; }
  slot.innerHTML = '<span class="saved"><span class="lbl">saved:</span>' + documents.map((d) =>
    '<span class="chip" data-chip="' + d.id + '"><a href="#" data-doc="' + d.id + '">' + (KIND_LABEL[d.kind]||d.kind) + '</a>' +
    '<time>' + shortWhen(d.at) + '</time><button class="del" data-del="' + d.id + '" title="Delete">×</button></span>').join('') + '</span>';
}

function shortWhen(iso) {
  const d = new Date(iso);
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
    : d.toLocaleDateString([], { day:'2-digit', month:'short' });
}

document.addEventListener('click', async (e) => {
  const docId = e.target.dataset?.doc;
  if (docId) {
    e.preventDefault();
    const d = await (await fetch('/api/documents/' + docId)).json();
    const meta = d.model + ' · ' + new Date(d.at).toLocaleString();
    if (d.kind === 'cv') { try { return openCv(d.id, JSON.parse(d.content), meta); } catch {} }
    openModal(KIND_LABEL[d.kind] || d.kind, d.content, meta);
    openDocId = Number(docId);
    return;
  }

  const btn = e.target.closest?.('[data-del]');
  if (!btn) {
    for (const c of document.querySelectorAll('.chip.confirming')) { c.classList.remove('confirming'); c.querySelector('.del').textContent = '×'; }
    return;
  }
  e.preventDefault(); e.stopPropagation();
  const chip = btn.closest('.chip');
  if (!chip.classList.contains('confirming')) {
    for (const c of document.querySelectorAll('.chip.confirming')) { c.classList.remove('confirming'); c.querySelector('.del').textContent = '×'; }
    chip.classList.add('confirming'); btn.textContent = 'delete?'; return;
  }
  const id = btn.dataset.del;
  const res = await fetch('/api/documents/' + id, { method: 'DELETE' });
  if (!res.ok) return toast('Could not delete');
  if (openDocId === Number(id)) $('#modal').classList.remove('show');
  toast('Deleted');
  const card = chip.closest('.card');
  if (card) showDocs(card.dataset.id);
});

function openModal(title, content, meta) {
  openDocId = null;
  $('#modalTitle').textContent = title;
  const count = content ? content.length.toLocaleString() + ' chars' : '';
  $('#modalMeta').textContent = [meta, count].filter(Boolean).join(' · ');
  modalText = content || '';
  $('#modalBody').innerHTML = content === null
    ? '<div class="working"><span class="spin"></span>Writing… this takes 30-90 seconds.</div>'
    : '<div class="doc">' + esc(content) + '</div>';
  $('#modal').classList.add('show');
}

function openCv(docId, cv, meta) {
  openDocId = Number(docId);
  $('#modalTitle').textContent = 'Tailored CV — ' + (cv.title || cv.name || '');
  const fit = cv.pages ? (cv.fitsOnePage
      ? '<span style="color:var(--green)">1 page' + (cv.scale && cv.scale < 1 ? ' · scaled to ' + Math.round(cv.scale*100) + '%' : '') + '</span>'
      : '<span style="color:var(--yellow)">⚠ ' + cv.pages + ' pages</span>') : '';
  $('#modalMeta').innerHTML = esc(meta || '') + (fit ? ' · ' + fit : '');
  modalText = null;

  const changes = (cv.changes || []).map((c) =>
    '<tr><td style="color:var(--accent);font-weight:600;white-space:nowrap">' + esc(c.section||'') + '</td><td>' +
    (c.before && !/^not present$/i.test(c.before) ? '<div class="before">' + esc(c.before) + '</div>' : '<div class="why">(new)</div>') +
    '<div class="after">' + esc(c.after||'') + '</div></td><td class="why">' + esc(c.why||'') + '</td></tr>').join('');
  const gaps = (cv.gaps||[]).length
    ? '<div class="gaps"><h4>Asked for, but you don\\'t have it</h4><ul>' + cv.gaps.map((g)=>'<li>'+esc(g)+'</li>').join('') + '</ul></div>' : '';

  $('#modalBody').innerHTML =
    '<div class="tabs">' +
      '<button data-tab="changes" class="on">What changed (' + (cv.changes||[]).length + ')</button>' +
      '<button data-tab="preview">Preview the CV</button>' +
      '<a href="/cv/' + docId + '/pdf" download><button class="primary">⬇ Download PDF</button></a>' +
      '<a href="/cv/' + docId + '" target="_blank" rel="noopener"><button>Open printable ↗</button></a>' +
    '</div>' +
    '<div data-panel="changes">' +
      (changes ? '<table class="chg"><thead><tr><th>Section</th><th>Change</th><th>Why</th></tr></thead><tbody>' + changes + '</tbody></table>'
               : '<p class="meta">No changes were reported.</p>') + gaps +
    '</div>' +
    '<div data-panel="preview" style="display:none"><iframe class="cvframe" src="/cv/' + docId + '"></iframe></div>';
  $('#modal').classList.add('show');
}

$('#modalBody').addEventListener('click', (e) => {
  const tab = e.target.dataset?.tab;
  if (!tab) return;
  for (const b of $('#modalBody').querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const p of $('#modalBody').querySelectorAll('[data-panel]')) p.style.display = p.dataset.panel === tab ? '' : 'none';
});
$('#modalClose').onclick = () => $('#modal').classList.remove('show');
$('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').classList.remove('show'); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modal').classList.remove('show'); });
$('#modalCopy').onclick = async () => { if (!modalText) return; await navigator.clipboard.writeText(modalText); toast('Copied'); };

$('#discover').onclick = async (e) => {
  e.target.disabled = true; e.target.innerHTML = '<span class="spin"></span> Finding…';
  const r = await fetch('/api/companies/discover', { method: 'POST' });
  const d = await r.json();
  toast(r.ok ? 'Found ' + (d.added ?? 0) + ' new companies' : (d.error || 'failed'));
  e.target.disabled = false; e.target.textContent = 'Find more';
  load();
};

let debounce;
for (const el of ['q','status','minScore','source','order']) {
  $('#' + el).addEventListener(el === 'q' ? 'input' : 'change', () => {
    clearTimeout(debounce); debounce = setTimeout(load, el === 'q' ? 300 : 0);
  });
}
load();
`;

export function renderCompanies() {
  return page({
    title: 'Speculative applications',
    active: 'companies',
    styles: STYLES,
    right: '<button id="discover">Find more</button>',
    body: `
<header class="filters">
  <div class="row">
    <input id="q" placeholder="Search name, activity, past roles…" style="width:230px">
    <select id="status">
      <option value="">Still to approach</option>
      <option value="shortlisted">★ Shortlisted</option>
      <option value="contacted">✔ Contacted</option>
      <option value="reviewed">Reviewed</option>
      <option value="new">Unjudged</option>
      <option value="rejected">Not interested</option>
      <option value="all">Everything</option>
    </select>
    <select id="minScore">
      <option value="">Any score</option>
      <option value="80">80+</option>
      <option value="70" selected>70+</option>
      <option value="60">60+</option>
      <option value="40">40+</option>
    </select>
    <select id="source">
      <option value="">Any source</option>
      <option value="job-history">Proven hirers</option>
      <option value="registry">Local register</option>
    </select>
    <select id="order">
      <option value="score">By score</option>
      <option value="jobs">By past postings</option>
      <option value="name">By name</option>
    </select>
  </div>
  <div class="stats" id="stats"></div>
</header>

<main><div id="list"></div></main>

<div class="modal" id="modal">
  <div class="sheet">
    <header>
      <h3 id="modalTitle">…</h3>
      <span id="modalMeta" class="meta"></span>
      <button id="modalCopy">Copy</button>
      <button id="modalClose">Close</button>
    </header>
    <div class="body" id="modalBody"></div>
  </div>
</div>`,
    script: SCRIPT,
  });
}
