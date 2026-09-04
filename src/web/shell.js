/**
 * Shared chrome for every page: the palette, the reset, and the top nav.
 *
 * Kept as a template rather than a static file so each page can inject its own
 * styles and mark its own nav entry active, without three copies of the theme
 * drifting apart.
 */

export const THEME = `
  :root{
    --bg:#0d1117; --panel:#161b22; --panel2:#1c2129; --line:#30363d;
    --fg:#e6edf3; --dim:#8b949e; --accent:#2f81f7;
    --green:#3fb950; --yellow:#d29922; --red:#f85149; --purple:#a371f7;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
  a{color:var(--accent)}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .grow{flex:1}
  input,select,button,textarea{font:inherit;background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:6px 10px}
  input:focus,select:focus,textarea:focus{outline:1px solid var(--accent);border-color:var(--accent)}
  button{cursor:pointer;transition:.12s}
  button:hover{background:var(--panel2);border-color:#4b5563}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  button.primary:hover{filter:brightness(1.12)}
  button:disabled{opacity:.5;cursor:not-allowed}
  .meta{color:var(--dim);font-size:12.5px}
  .sep{opacity:.4}

  /* --- top navigation --- */
  .topnav{position:sticky;top:0;z-index:30;background:rgba(13,17,23,.94);backdrop-filter:blur(8px);
          border-bottom:1px solid var(--line);padding:0 20px;display:flex;align-items:center;gap:4px}
  .topnav .brand{font-weight:650;letter-spacing:-.2px;margin-right:14px;padding:12px 0;white-space:nowrap}
  .topnav .brand a{color:var(--fg);text-decoration:none}
  .topnav nav{display:flex;gap:2px;flex:1}
  .topnav nav a{color:var(--dim);text-decoration:none;padding:13px 13px 11px;border-bottom:2px solid transparent;
                font-size:13.5px;white-space:nowrap;transition:.12s}
  .topnav nav a:hover{color:var(--fg)}
  .topnav nav a.on{color:var(--fg);border-bottom-color:var(--accent)}
  .topnav .right{display:flex;gap:8px;align-items:center;padding:8px 0}

  .spin{display:inline-block;width:11px;height:11px;border:2px solid var(--dim);border-top-color:transparent;
        border-radius:50%;animation:s .7s linear infinite;vertical-align:-1px}
  @keyframes s{to{transform:rotate(360deg)}}
  .toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--panel);
         border:1px solid var(--accent);border-radius:8px;padding:10px 18px;opacity:0;transition:.25s;
         pointer-events:none;z-index:60;max-width:80vw;text-align:center}
  .toast.show{opacity:1}
`;

const PAGES = [
  { href: '/', label: 'Home', key: 'home' },
  { href: '/jobs', label: 'Job listings', key: 'jobs' },
  { href: '/companies', label: 'Speculative applications', key: 'companies' },
];

export function nav(active, right = '') {
  const links = PAGES.map((p) =>
    `<a href="${p.href}"${p.key === active ? ' class="on"' : ''}>${p.label}</a>`).join('');
  return `<div class="topnav">
    <div class="brand"><a href="/">job&#8209;agent</a></div>
    <nav>${links}</nav>
    <div class="right">${right}</div>
  </div>`;
}

/** Wrap page content in the full document. */
export function page({ title, active, styles = '', body, script = '', right = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · job-agent</title>
<style>${THEME}${styles}</style>
</head>
<body>
${nav(active, right)}
${body}
<div class="toast" id="toast"></div>
<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2600);
}
function daysAgo(iso) {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + 'd ago';
}
const scoreClass = (n) => n >= 80 ? 's80' : n >= 60 ? 's60' : n >= 40 ? 's40' : 's0';
${script}
</script>
</body>
</html>`;
}
