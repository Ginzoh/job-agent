# job-agent

An autonomous scout for developer work — permanent roles and freelance missions — filtered to *your* stack, *your* locations, and *your* dealbreakers.

It polls 9 job sources, throws out the noise with cheap rules, then has an LLM read what survives and rate each posting against your actual CV. You get a ranked shortlist with reasons, plus a drafted opening line for the good ones.

**Zero dependencies.** Node 24 ships SQLite, `fetch`, and an HTTP server. `yarn install` writes a lockfile and installs nothing, because there is nothing to install.

---

## TL;DR — what it does

```text
9 sources  →  dedupe  →  rule filter  →  LLM scoring  →  ranked shortlist
 ~3800/run    hash+role   ~85% dropped    0-100 + why      dashboard + digest
```

1. **Fetches** from company career pages, French public job APIs, remote boards, and Hacker News hiring threads.
2. **Deduplicates** — the same posting from three sources is stored once, and re-runs never create duplicates.
3. **Filters** on stack keywords, location, seniority and freshness. This drops ~85% of postings for free, so you don't pay an LLM to read "Senior SAP Consultant, Ohio".
4. **Scores** each survivor 0–100 against your profile using Claude (or a local model), with pros, cons, and a dealbreaker check.
5. **Presents** results in a web dashboard, a Markdown digest, or the terminal. Mark things shortlisted / applied / not-interested and it remembers.

### What makes it useful rather than just another scraper

- It reads your **actual profile** — `config/profile.json` holds your skills, rates, locations and dealbreakers, and the model judges against *that*, not a generic ideal candidate.
- It is **deliberately harsh**. Most postings score under 50. Real output from a test run:
  > `35` — *"Perfect tech stack but NYC on-site violates France-based relocation dealbreaker."*
  > `48` — *"Strong location (Paris) and company, but management role doesn't align with IC career track."*
  > `20` — *"C#/.NET stack outside expertise; 5+ years requirement exceeds 4-year experience."*
- It polls **company ATS boards directly** (Greenhouse/Lever/Ashby for 35 French tech companies). Roles appear there days before they reach aggregators, and far fewer people are looking.
- It mines **HN "Who is hiring?"** threads, which nobody aggregates well — less competition per listing.

---

## Setup

```powershell
cd job-agent
copy .env.example .env
copy config\profile.example.json config\profile.json
yarn install            # no packages to fetch; just writes the lockfile
yarn doctor             # verifies Node, database, LLM backend, sources
```

Then add your own documents — none of these are in the repository, by design:

| You provide | Where | Template |
|---|---|---|
| Your profile | `config/profile.json` | `config/profile.example.json` |
| Your CV (`.md`/`.txt`) | `CV_example/` | `docs/examples/CV_TEMPLATE.md` |
| A cover letter you'd send | `cover_letter_example/` | `docs/examples/cover-letter-TEMPLATE.txt` |
| API keys (optional) | `.env` | `.env.example` |

`profile.json`, `CV_example/` and `cover_letter_example/` are gitignored deliberately: they hold your salary floor, TJM range, phone number and address. **Git history is permanent**, so keeping them out from the first commit is what makes it safe to share or open-source this later.

> **Two script names are shadowed by Yarn.** `yarn run` prints the script list rather than running the pipeline, and `yarn list` is Yarn's dependency lister. Use **`yarn start`** and **`yarn jobs`** instead — or spell them out as `yarn run run` / `yarn run list`.

Then **edit `config/profile.json`** so it describes you rather than the placeholder. This is the single highest-leverage thing you can do — scoring quality is downstream of it. Be honest about years of experience and dealbreakers; that's what makes the rejections accurate.

```powershell
yarn start              # fetch + score. First run takes a while, see below.
yarn web                # browse results at http://localhost:7788
```

### Why there's nothing from LinkedIn or Indeed

Neither offers a usable public job-search API any more, and this is worth understanding rather than working around:

- **Indeed** retired its public Publisher/Job Search API. The old `api.indeed.com/ads/apisearch` endpoint no longer even resolves in DNS, and the legacy RSS feeds return 404. What remains is partner-only. The site itself is behind bot protection, and scraping it breaks their terms.
- **LinkedIn** gates job search behind authentication; the Jobs API is restricted to Talent Solutions partners. There is a well-known undocumented `jobs-guest` endpoint that still answers unauthenticated requests, but building on it violates the User Agreement, breaks without warning, and reliably gets IPs blocked. This project doesn't use it.

**The practical loss is smaller than it looks.** Both are largely *syndication layers* — most of what they list originates from a company's own ATS (this polls 35 of those directly), from Free-Work, France Travail or Adzuna. You're mostly reaching the same postings at the source, earlier, without the recruiter-spam layer on top.

For the genuine gap, use them the way they're designed: set up a **saved search with email alerts** on both. That takes two minutes, is entirely within their terms, and covers what an API would have.

### Free API keys worth 10 minutes of your time

Seven sources work with no key at all — including **Free-Work**, the main French freelance/IT board (~10k live postings, and the rare source that states real TJMs). Two more need a free signup and add the best remaining French coverage:

| Source | Why | Where |
|---|---|---|
| **Adzuna** | Aggregates most French job boards. Widest FR reach. | [developer.adzuna.com/signup](https://developer.adzuna.com/signup) |
| **France Travail** | The official French public job API (ex-Pôle Emploi). | [francetravail.io](https://francetravail.io) — create an app, subscribe to *Offres d'emploi v2* |

Paste the credentials into `.env` and they light up automatically.

#### France Travail, step by step

The one step people miss is #4 — creating the app is *not* the same as subscribing it to the API, and an app without a subscription fails authentication with a misleading error.

1. Sign up at **[francetravail.io](https://francetravail.io/)** (free, no card). Confirm the email.
2. Open **Mes applications** → **Créer une application**. Name it anything (`job-agent`).

   It asks for *« URL de votre site utilisant les données des API »*. **It rejects `localhost` and any local IP** (*"Vous ne pouvez pas saisir d'adresse IP locale"*). The field is declarative — `client_credentials` never redirects anywhere — so give it a real public URL you own: your **GitHub profile** or **LinkedIn** is ideal. Avoid `example.com`-style placeholders.
3. Copy the **Identifiant client** and the **Clé secrète**. The secret is shown once; if you lose it, regenerate it.
4. **Subscribe the app to the API.** In the app, open the API catalogue and add **« Offres d'emploi v2 »**. Without this the credentials authenticate but every scope is refused.
5. Put both values in `.env`:

   ```ini
   FRANCE_TRAVAIL_CLIENT_ID=your_identifiant_client
   FRANCE_TRAVAIL_CLIENT_SECRET=your_cle_secrete
   ```

6. Verify: `yarn doctor`. It exchanges the credentials for a real token and tells you precisely what's wrong if anything is:

   | What doctor says | Meaning |
   |---|---|
   | `✓ France Travail` | working |
   | `credentials rejected (invalid_client)` | ID or secret is wrong or truncated — re-copy both |
   | `the scope was refused` | step 4 was skipped; subscribe the app to *Offres d'emploi v2* |

7. `yarn start` — France Travail now appears in the source list instead of being skipped.

A newly created subscription can take a few minutes to activate, so if step 6 fails immediately, wait and retry before changing anything.

> The required OAuth scope changed format over the years — older apps need an `application_<client_id>` component, newer ones reject it. The client tries both automatically, so you don't need to care which era your app belongs to.

---

## Daily use

```powershell
yarn start                               # the main one: fetch + score
yarn web                                 # dashboard — filter, shortlist, mark applied
yarn digest                              # writes out/latest.md, a readable briefing
yarn stats                               # what's in the database

yarn jobs --min 70 --remote --contract freelance
node src/cli.js show <job-id>            # full posting + full reasoning
node src/cli.js mark <job-id> applied
```

### Writing applications

Expand any job in the dashboard and there are three buttons:

| Button | What it does |
|---|---|
| **📝 CV advice** | A blunt screener's read of your CV against *this* posting: what to lead with, exact line-by-line rewrites, missing keywords you genuinely have, and the gaps you can't paper over. |
| **📄 Tailor my CV** | A rewritten CV targeting the posting, laid out like your real one and **downloadable as a PDF** — plus a table of exactly what changed. |
| **✉️ Cover letter** | A letter in *your* voice, learned from `cover_letter_example/`. |

**⚙︎ Options** sets language (auto / French / English), a character limit, tone, and free-text instructions like *"lead with React Native"* or *"mention I can start immediately"*.

Results open in a panel with **Copy** and **Download .md**, and every generated document is saved — reopen it from the `saved:` links on the job rather than paying to regenerate.

#### The tailored CV is a real document

The CV isn't returned as Markdown — reading a wall of text to work out what moved is useless. Instead the model returns structured data, which gets laid out as an A4 page matching your own CV's design (dark header band, two columns, teal section headings) and rendered to PDF.

The panel opens on **What changed**: a table of section / before → after / why, so you review nine edits in ten seconds instead of re-reading the whole CV. Anything the posting wanted that you don't have is listed separately underneath, never quietly added.

| Button | |
|---|---|
| **⬇ Download folder** | A zip that expands to `Job title_Company/CV_Your_Name.pdf`, for keeping one folder per application |
| **PDF only** | The bare file, for dropping straight into an upload box |
| **Open printable ↗** | The A4 page in a tab — `Ctrl+P` if you want the browser's own PDF settings |
| **Plain text** | For pasting into an application form |

PDF rendering uses the Chrome or Edge already on your machine via `--print-to-pdf`, so there's still nothing to install (Edge ships with Windows). If no browser is found, the printable page still works and the download button explains why. Section labels follow the CV's language — a French posting produces *Expérience*, *Compétences techniques*, *Contexte*, not English headings on French text.

**It always fits on one page.** Three mechanisms, in order:

1. **A hard content budget in the prompt** — 45-word summary, 4 bullets per role, 5 skill groups. This does most of the work.
2. **Mild scaling** — a CV overrunning by a few lines is a formatting problem, so the whole document scales down slightly (never below 0.86, past which it stops looking deliberate and starts looking squeezed).
3. **Deterministic trimming** — if it still overruns, content is dropped cheapest-first: interests, then personal skills, then projects, then skill caps, then the weakest bullets. Roles are never removed and the most recent one keeps its bullets longest.

The page count is measured from the real PDF rather than estimated, and whatever gets cut is reported in the change table as a **Length** row, so you always know what went. The panel header shows `1 page · scaled to 93%`, or an amber warning in the rare case content is so long it survives all of it.

#### The one rule these follow

**They never invent anything.** Every prompt treats your reference documents as the only admissible source of fact. No employers, technologies, metrics or qualifications that aren't there. If a posting wants something you don't have, it says so in the notes instead of quietly manufacturing it — a CV that survives the interview is the goal, not an impressive one that collapses at the first follow-up question.

Rewording is expected: *"Integrated GraphQL APIs with Apollo Client"* may become *"Built GraphQL data-fetching layers with Apollo Client"* to mirror a posting's vocabulary. Changing meaning is not.

#### Your reference documents

```text
CV_example/               ← your CV
cover_letter_example/     ← a letter in your voice
```

**Only `.md` and `.txt` are read.** Node has no PDF parser and this project has no dependencies, so a PDF alone won't work — keep a text twin beside it (`CV_EN_Mickael_KRAUTH.md` sits next to the PDF for exactly this reason) and update it whenever the real CV changes, or you'll be tailoring from stale facts. The dashboard warns you on load if either folder is unreadable.

An `ADDITIONAL CONTEXT` HTML comment at the end of the CV file holds true things that don't fit on a one-page PDF — freelance status, why a role ended, side projects. It's read as fact; other HTML comments are ignored as notes to yourself.

These use `CLAUDE_MODEL_WRITE` (default `sonnet`, `opus` if you want the best writing) rather than the cheap triage model, and they respect `MAX_SPEND_USD`. Expect ~$0.30–0.40 and 1–2 minutes per document.

### Offers you found yourself

**Add an offer you found somewhere else** at the top of the dashboard takes either a URL or pasted text. Imported postings become ordinary rows, so scoring, filtering and all three writing tools work on them unchanged.

URL import reads schema.org `JobPosting` JSON-LD when the site publishes it — which most serious boards do — and falls back to stripping the page. **LinkedIn and Indeed block automated fetching**, so for those, copy the posting text and paste it instead. The first line is read as the title, and `Frontend Developer at Acme` is split into title and company automatically.

Manual imports always bypass the keyword filter. Adding something by hand is a stronger signal of intent than any rule.

### Tuning what it finds

| File | Controls |
|---|---|
| `config/profile.json` | Who you are. Skills, rates, locations, dealbreakers. **Feeds the LLM.** |
| `config/filters.json` | The cheap pre-LLM gate: stack keywords, accepted locations, rejected titles, max age. |
| `config/sources.json` | Which sources run, search queries, and the list of company boards to poll. |

Getting too little? Lower `min_required_hits`, widen `location.accept`, or raise `freshness.max_age_days`.
Getting too much junk? Add terms to `title.reject`, or raise `scoring.shortlist_at`.

**After editing config, tell the agent to reconsider what it already stored** — otherwise old postings keep the verdict they were given the first time:

```powershell
yarn refilter       # after editing filters.json
yarn rescore        # after editing profile.json
```

Both leave anything you've marked **applied** untouched. `refilter` also re-runs cross-post detection.

### Duplicates

The same role gets posted to several boards, and HN reposts the same listing month after month. Postings are matched on company + normalised title + location, so cross-posts collapse into one visible entry while genuinely distinct roles stay separate — "Software Engineer" in Paris and in New York remain two jobs, because location is part of the key. Remote listings collapse together, since "Remote", "Anywhere in the World" and "Remote (EMEA)" all mean the same thing. On the reference database this folded away ~210 of 3,100 postings.

### On years of experience

The scorer treats a posting's stated years requirement as a **soft preference, not a gate** — because it is one, especially in France where "3-5 ans d'expérience" is close to boilerplate. A 2-year candidate with a good stack match still scores in the 80s against a role asking for 5; the gap gets noted in `cons` as something to be ready to address, and costs a few points rather than thirty. It only becomes serious when the role wants roughly triple the experience, or is genuinely a lead/architect position. Tune this via `experience_stance` in `profile.json`.

**Adding a company to watch:** find its careers page. If the URL contains `boards.greenhouse.io/X`, `jobs.lever.co/X`, or `jobs.ashbyhq.com/X`, add `X` to the matching list in `config/sources.json`. That's it.

---

## The LLM backend

Set `LLM_BACKEND` in `.env`:

**`claude`** (default) — drives the `claude` CLI you're already logged into, so your **Claude Pro subscription covers it** and no API key is needed. The agent passes `--system-prompt` and `--exclude-dynamic-system-prompt-sections`, which strips ~19k tokens of Claude Code's default context off every call. That's the difference between burning your rate limit in one run and barely touching it. `CLAUDE_MODEL=haiku` is the default and is plenty for triage; `sonnet` reasons better on borderline postings.

**`ollama`** — a local model. Free, no rate limit, fully private. Your RTX 4070 Ti SUPER (16GB) runs a 14B model comfortably:

```powershell
winget install Ollama.Ollama
ollama pull qwen2.5:14b-instruct
```

Then set `LLM_BACKEND=ollama` in `.env`. Slightly blunter judgement than Claude, but it can chew through unlimited backlog overnight at zero cost.

**`none`** — skips AI entirely, keyword ranking only. Fast, crude, free.

### Not getting charged

There are two layers here, and **only one of them is a real guarantee.**

**The real guarantee is your Anthropic account, not this app.** Whether a request is billed is decided upstream; no code here can prevent a charge. To make overspending genuinely impossible:

1. Open the [Anthropic Console](https://console.anthropic.com/) → **Billing**.
2. **Turn off auto-reload.** This is the important one. With auto-reload off, once your credit balance hits zero, requests simply fail with an error — there is no card to fall back on.
3. Optionally set a **monthly spend limit** as a second backstop.

With auto-reload disabled, the worst case is an error message. That is the control you actually want.

**The app-level safety net** is `MAX_SPEND_USD` in `.env` (default `90`). It tracks cumulative cost in the `spend` table across every run ever, and:

- refuses to start scoring at all once lifetime spend crosses the ceiling — verified: it bails in ~4ms having sent nothing;
- stops between batches as soon as the ceiling is crossed mid-run;
- treats **rate-limit, credit-exhausted and auth errors as fatal** and aborts the entire run rather than retrying into a wall — because every remaining batch would fail identically.

Nothing is lost when it stops. Unscored jobs stay queued and are picked up by the next run.

Check where you stand any time:

```powershell
yarn stats     # today's spend, lifetime total, and a bar against the ceiling
```

Two honest caveats. The figures come from what the CLI reports back, so treat them as a good estimate rather than an invoice. And because batches run concurrently, a run can overshoot the ceiling slightly — by at most the batches already in flight (about $0.40 at the default `SCORE_CONCURRENCY=4`). Set `SCORE_CONCURRENCY=1` if you want the tightest possible stop.

**Want it to cost nothing at all?** Set `LLM_BACKEND=ollama`. Your GPU scores locally for free, with no rate limit and no billing surface whatsoever.

### About the first run

The first run finds ~3,000 postings, of which ~440 survive filtering. Scoring all of them at once would be a rate-limit spike, so `SCORE_MAX_PER_RUN=120` caps it. The backlog drains over the next few runs; after that each run only scores the genuinely new postings — typically 10–40, a few minutes' work. Raise `SCORE_CONCURRENCY` if you're impatient, lower it to `1` if you hit limits.

---

## Where to run it: your PC or a VPS?

**Run it on your PC.** A VPS is not worth it here, for three concrete reasons:

1. **The workload is bursty, not continuous.** It works for ~3 minutes, then idles for hours. You'd be renting a machine to do nothing 99% of the time.
2. **Job postings don't expire in hours.** Twice a day is genuinely enough — the company-board sources already put you ahead of anyone waiting for aggregators. Nothing is lost by your PC being off overnight.
3. **Your Claude login lives on your PC.** On a VPS you'd have to authenticate the CLI there too, and it's a headless OAuth flow. More friction for no gain. Your GPU is also here, which is the only place the free Ollama backend makes sense.

Set it and forget it:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1
```

That registers a Windows Scheduled Task running at 08:30 and 18:30. It won't wake the machine, won't run without a network, and catches up on the next boot if your PC was off. Customise with `-At '07:00','13:00','19:00'`, remove with `-Uninstall`.

Prefer a long-running process instead? `yarn watch` re-runs every 6 hours and beeps on a new shortlist. Add `--web` to serve the dashboard alongside it.

### When a VPS *would* make sense

Only if you want it running unattended for weeks while your PC is off, or you want the dashboard reachable from your phone. In that case: any €4–5/month box (Hetzner CX22, Scaleway Stardust) is far more than enough — this is a few MB of RAM and a SQLite file. Use `LLM_BACKEND=ollama` only if the VPS has a GPU (most don't, so stick with `claude`), and **set `WEB_PASSWORD` before setting `WEB_HOST=0.0.0.0`**. The dashboard has password auth built in, but it's off by default because it assumes localhost.

---

## What you need

- **Node.js 22.5+** — you have 24.12. Nothing else to install.
- **Yarn** — 1.22 (Classic) is what this is pinned to via `packageManager`. It only runs scripts here; there are no packages.
- **The `claude` CLI, logged in** — you have it. (Or Ollama, or neither with `LLM_BACKEND=none`.)
- Optionally, the two free API keys above for proper French coverage.

## Layout

```text
config/       profile.json · filters.json · sources.json   ← you edit these
src/
  cli.js         commands
  config.js      env + config loading
  core/          prefilter · score · pipeline · digest
  sources/       one adapter per job source
  llm/           claude (CLI) · ollama · JSON repair
  lib/           db (node:sqlite) · http · text · rss
  web/           server + dashboard
data/jobs.db  SQLite — your whole history, gitignored
out/          generated Markdown digests
```

## Notes

- `data/jobs.db` is the memory. Deleting it re-fetches everything and re-scores from scratch.
- Marking things `rejected` / `applied` is persistent and survives re-runs.
- A source that breaks or rate-limits logs a warning and is skipped; it never takes down a run.
- All requests identify themselves honestly via User-Agent, and only public, documented endpoints are used.
