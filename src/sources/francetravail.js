import { getJSON, getRaw } from '../lib/http.js';
import { sources, env, hasFranceTravail } from '../config.js';
import { stripHtml, toISO, detectSalary } from '../lib/text.js';
import { log } from '../lib/log.js';

export const name = 'francetravail';
export const enabled = () => sources.aggregators.francetravail?.enabled !== false && hasFranceTravail();
export const skipReason = 'no FRANCE_TRAVAIL_CLIENT_ID / _SECRET in .env';

const TOKEN_URL = 'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire';
const SEARCH_URL = 'https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search';

let cachedToken = null;

/** The official French public employment API — the single best source for CDI/CDD in France. */
export async function fetchJobs() {
  const token = await getToken();
  if (!token) return [];

  const cfg = sources.aggregators.francetravail ?? {};
  const queries = cfg.queries ?? ['développeur react'];
  const out = [];
  const seen = new Set();

  for (const q of queries) {
    // The API pages via a Range header, capped at 150 results per call.
    for (const range of ['0-149', '150-299']) {
      const url = new URL(SEARCH_URL);
      url.searchParams.set('motsCles', q);
      url.searchParams.set('publieeDepuis', '31');
      if ((cfg.departments ?? []).length) url.searchParams.set('departement', cfg.departments.join(','));

      const res = await getRaw(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', Range: `offres ${range}` },
      });
      if (!res) break;
      if (res.status === 204) break; // no more results

      let data;
      try { data = await res.json(); } catch { break; }
      const rows = data?.resultats ?? [];
      if (!rows.length) break;

      for (const j of rows) {
        if (seen.has(j.id)) continue;
        seen.add(j.id);
        const description = stripHtml(j.description || '');
        out.push({
          source: name,
          source_id: j.id,
          title: j.intitule,
          company: j.entreprise?.nom || j.nomCommercial || 'Non précisé',
          location: j.lieuTravail?.libelle || 'France',
          is_remote: /télétravail|teletravail|remote/i.test(`${j.intitule} ${description}`) || j.dureeTravailLibelleConverti === 'Télétravail',
          contract: mapContract(j.typeContrat),
          url: j.origineOffre?.urlOrigine || `https://candidat.francetravail.fr/offres/recherche/detail/${j.id}`,
          description,
          salary: j.salaire?.libelle || detectSalary(description),
          posted_at: toISO(j.dateCreation),
          tags: (j.competences ?? []).map((c) => c.libelle).filter(Boolean).slice(0, 12),
        });
      }
      if (rows.length < 150) break;
    }
  }
  return out;
}

/**
 * France Travail changed its required scope format over the years: older apps
 * need an `application_<client_id>` component, newer ones reject it. Rather
 * than make you guess which era your app belongs to, try both and keep whichever
 * the server accepts.
 */
function scopeVariants(clientId) {
  return [
    'api_offresdemploiv2 o2dsoffre',
    `application_${clientId} api_offresdemploiv2 o2dsoffre`,
  ];
}

async function requestToken(scope) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.ftId,
    client_secret: env.ftSecret,
    scope,
  });

  const res = await getRaw(TOKEN_URL, {
    method: 'POST',
    body: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    retries: 0,
    expectErrors: true, // a 400 here is data, not a failure — it says why
  });

  if (!res) return { ok: false, error: 'no response from the token endpoint' };

  let data;
  try { data = await res.json(); } catch { data = null; }

  if (data?.access_token) {
    return { ok: true, token: data.access_token, expiresIn: data.expires_in ?? 1200 };
  }
  return { ok: false, error: data?.error ?? `HTTP ${res.status}`, description: data?.error_description };
}

/** Verify credentials and return a human-readable diagnosis. Used by `doctor`. */
export async function testCredentials() {
  if (!env.ftId || !env.ftSecret) {
    return { ok: false, reason: 'FRANCE_TRAVAIL_CLIENT_ID / _SECRET are not set in .env' };
  }

  const failures = [];
  for (const scope of scopeVariants(env.ftId)) {
    const r = await requestToken(scope);
    if (r.ok) return { ok: true, scope };
    failures.push(r);
  }

  const f = failures[0];
  if (f.error === 'invalid_client') {
    return { ok: false, reason: 'credentials rejected (invalid_client) — re-copy the Identifiant client and Clé secrète from francetravail.io; they are easy to truncate' };
  }
  if (String(f.error).includes('scope')) {
    return { ok: false, reason: 'credentials are valid but the scope was refused — open your app on francetravail.io and subscribe it to "Offres d\'emploi v2"' };
  }
  return { ok: false, reason: `${f.error}${f.description ? ` — ${f.description}` : ''}` };
}

async function getToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 30000) return cachedToken.value;

  const failures = [];
  for (const scope of scopeVariants(env.ftId)) {
    const r = await requestToken(scope);
    if (r.ok) {
      cachedToken = { value: r.token, expires: Date.now() + r.expiresIn * 1000 };
      return r.token;
    }
    failures.push(r);
  }

  const f = failures[0];
  log.warn(`francetravail: no access token (${f.error}${f.description ? `: ${f.description}` : ''}) — run \`yarn doctor\` for a diagnosis`);
  return null;
}

const mapContract = (t) =>
  t === 'CDI' ? 'permanent' :
  t === 'CDD' ? 'contract' :
  t === 'MIS' || t === 'LIB' ? 'freelance' : 'unknown';
