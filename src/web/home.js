import { page } from './shell.js';
import { stats, companyStats, lastRuns, totalSpend, spendSince } from '../lib/db.js';
import { env } from '../config.js';

const STYLES = `
  main{max-width:1000px;margin:0 auto;padding:34px 20px 60px}
  h1{font-size:24px;margin:0 0 6px;letter-spacing:-.4px}
  .lede{color:var(--dim);margin:0 0 30px;max-width:620px}

  .cards{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:30px}
  @media(max-width:760px){.cards{grid-template-columns:1fr}}
  .card{display:block;background:var(--panel);border:1px solid var(--line);border-radius:12px;
        padding:20px 22px;text-decoration:none;color:inherit;transition:.14s}
  .card:hover{border-color:var(--accent);transform:translateY(-1px)}
  .card h2{margin:0 0 6px;font-size:16.5px;display:flex;align-items:center;gap:9px}
  .card p{margin:0 0 16px;color:var(--dim);font-size:13.5px;line-height:1.5}
  .card .figs{display:flex;gap:22px;flex-wrap:wrap}
  .fig b{display:block;font-size:21px;font-variant-numeric:tabular-nums;line-height:1.15}
  .fig span{font-size:11.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.4px}
  .fig.good b{color:var(--green)}
  .fig.warn b{color:var(--yellow)}

  .panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 22px;margin-bottom:16px}
  .panel h3{margin:0 0 12px;font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  td{padding:5px 0;border-bottom:1px solid var(--line)}
  tr:last-child td{border-bottom:0}
  td.n{text-align:right;font-variant-numeric:tabular-nums;color:var(--dim);white-space:nowrap}
  .todo{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}
  .todo code{background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:3px 9px;font-size:12.5px}
`;

export function renderHome() {
  const j = stats();
  const co = companyStats();
  const runs = lastRuns(5);
  const spent = totalSpend();
  const today = spendSince(new Date().toISOString().slice(0, 10));

  const runRows = runs.length
    ? runs.map((r) => `<tr>
        <td>${r.started_at.slice(0, 16).replace('T', ' ')}</td>
        <td class="n">${r.new_jobs} new</td>
        <td class="n">${r.scored} scored</td>
        <td class="n" style="color:var(--green)">${r.shortlisted} shortlisted</td>
      </tr>`).join('')
    : '<tr><td class="meta">No pipeline runs recorded yet.</td></tr>';

  // Only surface work that is actually outstanding — an empty list is a result.
  const todo = [];
  if (j.unscored) todo.push(`<code>yarn score</code> ${j.unscored} jobs awaiting judgement`);
  if (co.unscored) todo.push(`<code>yarn companies:score</code> ${co.unscored} companies awaiting judgement`);
  if (!j.total) todo.push('<code>yarn start</code> to do your first fetch');

  return page({
    title: 'Home',
    active: 'home',
    styles: STYLES,
    body: `<main>
  <h1>Two ways in</h1>
  <p class="lede">Advertised roles are one route, and a crowded one. The other is writing to companies whose work needs you before they get round to posting anything.</p>

  <div class="cards">
    <a class="card" href="/jobs">
      <h2>📋 Job listings</h2>
      <p>Postings gathered from twelve sources, filtered and scored against your profile. Tailor a CV or draft a cover letter for any of them.</p>
      <div class="figs">
        <div class="fig"><b>${j.relevant.toLocaleString()}</b><span>relevant</span></div>
        <div class="fig good"><b>${j.shortlisted.toLocaleString()}</b><span>shortlisted</span></div>
        <div class="fig"><b>${j.applied}</b><span>applied</span></div>
        <div class="fig${j.unscored ? ' warn' : ''}"><b>${j.unscored}</b><span>to score</span></div>
      </div>
    </a>

    <a class="card" href="/companies">
      <h2>✉️ Speculative applications</h2>
      <p>Companies worth approaching with no vacancy advertised — found from employers who already hire your stack, and from the local business register.</p>
      <div class="figs">
        <div class="fig"><b>${co.total.toLocaleString()}</b><span>found</span></div>
        <div class="fig good"><b>${co.strong}</b><span>strong fit</span></div>
        <div class="fig"><b>${co.contacted}</b><span>contacted</span></div>
        <div class="fig${co.unscored ? ' warn' : ''}"><b>${co.unscored}</b><span>to score</span></div>
      </div>
    </a>
  </div>

  ${todo.length ? `<div class="panel"><h3>Outstanding</h3><div class="todo">${todo.map((t) => `<span>${t}</span>`).join('')}</div></div>` : ''}

  <div class="panel">
    <h3>Recent pipeline runs</h3>
    <table>${runRows}</table>
  </div>

  <div class="panel">
    <h3>Model spend</h3>
    <table>
      <tr><td>Today</td><td class="n">$${today.toFixed(2)}</td></tr>
      <tr><td>Lifetime</td><td class="n">$${spent.toFixed(2)}</td></tr>
      <tr><td>Ceiling</td><td class="n">${env.maxSpendUsd > 0 ? '$' + env.maxSpendUsd.toFixed(2) : 'none set'}</td></tr>
    </table>
    <p class="meta" style="margin:10px 0 0">Figures come from what the CLI reports back — a good estimate, not an invoice.</p>
  </div>
</main>`,
  });
}
