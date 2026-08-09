import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Tiny .env reader — avoids a dependency for ~15 lines of parsing. */
function loadEnv() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim().replace(/\s+#.*$/, '');
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    if (process.env[key] === undefined && val !== '') process.env[key] = val;
  }
}
loadEnv();

function readJson(name) {
  const path = join(ROOT, 'config', name);

  if (!existsSync(path)) {
    // profile.json is gitignored, so this is the first thing a fresh clone
    // hits. Say exactly how to fix it rather than just naming the missing file.
    const example = name.replace(/\.json$/, '.example.json');
    const hasExample = existsSync(join(ROOT, 'config', example));
    throw new Error(
      `Missing config/${name}.` +
      (hasExample
        ? `\n\n  This file holds personal details and is deliberately not in the repository.\n  Create it from the template:\n\n    copy config\\${example} config\\${name}\n\n  Then edit it so it describes you — scoring quality depends on it.`
        : '')
    );
  }

  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`config/${name} is not valid JSON — ${err.message}`);
  }
}

export const profile = readJson('profile.json');
export const filters = readJson('filters.json');
export const sources = readJson('sources.json');

/**
 * Short fingerprint of everything that affects a verdict: who you are, and the
 * thresholds a score is turned into a status with.
 *
 * Stored alongside each score so `--rescore` can tell "judged against the
 * current profile" from "judged against an older one". Without it, rescoring
 * repeatedly just re-pays for work it already did.
 */
export const profileFingerprint = createHash('sha1')
  .update(JSON.stringify(profile) + JSON.stringify(filters.scoring ?? {}))
  .digest('hex')
  .slice(0, 12);

const num = (v, d) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

export const env = {
  llmBackend: (process.env.LLM_BACKEND || 'claude').toLowerCase(),
  claudeModel: process.env.CLAUDE_MODEL || 'haiku',
  // Writing a CV or cover letter is worth a stronger model than triage scoring:
  // it runs a handful of times a week, not hundreds of times a run.
  claudeModelWrite: process.env.CLAUDE_MODEL_WRITE || 'sonnet',
  ollamaHost: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:14b-instruct',

  scoreBatchSize: num(process.env.SCORE_BATCH_SIZE, 6),
  scoreMaxPerRun: num(process.env.SCORE_MAX_PER_RUN, 120),
  scoreConcurrency: num(process.env.SCORE_CONCURRENCY, 4),
  llmTimeoutMs: num(process.env.LLM_TIMEOUT_MS, 300000),
  // Safe by default: stop well inside a $100 credit grant. 0 disables the cap.
  maxSpendUsd: num(process.env.MAX_SPEND_USD, 90),

  adzunaId: process.env.ADZUNA_APP_ID || '',
  adzunaKey: process.env.ADZUNA_APP_KEY || '',
  ftId: process.env.FRANCE_TRAVAIL_CLIENT_ID || '',
  ftSecret: process.env.FRANCE_TRAVAIL_CLIENT_SECRET || '',

  webPort: num(process.env.WEB_PORT, 7788),
  webHost: process.env.WEB_HOST || '127.0.0.1',
  webPassword: process.env.WEB_PASSWORD || '',

  watchMinutes: num(process.env.WATCH_INTERVAL_MINUTES, 360),
};

export const hasAdzuna = () => !!(env.adzunaId && env.adzunaKey);
export const hasFranceTravail = () => !!(env.ftId && env.ftSecret);
