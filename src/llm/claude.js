import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { env } from '../config.js';

let resolvedBinary;

/**
 * An error that must stop the whole run rather than just failing one batch.
 * Retrying into a spent balance or an exhausted quota is pointless at best.
 */
export class HardStopError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'HardStopError';
    this.kind = kind; // 'billing' | 'limit' | 'auth'
  }
}

const PATTERNS = [
  ['billing', /credit balance|insufficient (?:credit|fund|balance)|out of credit|payment required|billing|\b402\b|purchase more|add funds|spend(?:ing)? limit/i],
  ['limit',   /rate[ _-]?limit|\b429\b|usage limit|quota (?:exceeded|reached)|too many requests|limit (?:reached|exceeded)|try again (?:later|at)|resets? at/i],
  ['auth',    /\b401\b|unauthorized|not (?:logged in|authenticated)|invalid (?:api )?key|authentication (?:failed|required)|signed out|please run .?claude.? to log in/i],
];

/** Decide whether a CLI failure is fatal to the run or just a bad batch. */
export function classifyError(text = '') {
  for (const [kind, re] of PATTERNS) {
    if (re.test(text)) return kind;
  }
  return null;
}

function raiseIfHardStop(text) {
  const kind = classifyError(text);
  if (!kind) return;

  const detail = String(text).replace(/\s+/g, ' ').trim().slice(0, 220);
  const advice = {
    billing: 'Your credit balance is exhausted. Nothing further will be attempted. To be certain you are never charged beyond your credits, disable auto-reload and set a spend limit in the Anthropic Console.',
    limit: 'You have hit a usage limit. Scoring stops here; unscored jobs are kept and retried on the next run.',
    auth: 'The claude CLI is not authenticated. Run `claude` once interactively to log in.',
  }[kind];

  throw new HardStopError(kind, `${advice}\n    CLI said: ${detail}`);
}

/**
 * Find the real claude executable on PATH.
 *
 * Spawning with `shell: true` would let Windows resolve it via PATHEXT, but the
 * shell then concatenates arguments instead of passing them as a vector — which
 * Node warns about (DEP0190) and which would mangle our multi-line system
 * prompt. Resolving the binary ourselves means no shell is involved at all.
 */
function findBinary() {
  if (resolvedBinary) return resolvedBinary;

  const names = process.platform === 'win32'
    ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude']
    : ['claude'];

  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const full = join(dir, name);
      if (existsSync(full)) {
        resolvedBinary = full;
        return full;
      }
    }
  }
  return null;
}

export const id = 'claude';

/**
 * Drives the `claude` CLI in headless mode. This reuses the login you already
 * have, so a Claude Pro/Max subscription covers it and no API key is needed.
 *
 * The flags matter: `--system-prompt` replaces Claude Code's default prompt and
 * `--exclude-dynamic-system-prompt-sections` + `--setting-sources ''` drop the
 * tool schemas and project context. Together they cut ~19k tokens of overhead
 * per call down to almost nothing, which is the difference between burning
 * through your rate limit in one run and barely touching it.
 */
export async function complete({ system, prompt, timeout = env.llmTimeoutMs, model, tools }) {
  const args = [
    '-p',
    '--model', model || env.claudeModel,
    '--output-format', 'json',
    '--system-prompt', system,
    '--exclude-dynamic-system-prompt-sections',
    '--setting-sources', '',
    '--strict-mcp-config',
  ];

  // Tools stay off unless a caller explicitly asks. Scoring and CV writing want
  // a sealed prompt with no ability to wander off; only job discovery needs the
  // web, and it pays for that in both latency and tokens.
  if (Array.isArray(tools) && tools.length) args.push('--allowedTools', ...tools);

  const raw = await runWithRetry(args, prompt, timeout);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // A limit or auth failure often arrives as plain text on stdout, not JSON.
    raiseIfHardStop(raw);
    throw new Error(`claude CLI returned non-JSON output: ${raw.slice(0, 300)}`);
  }

  if (payload.is_error || payload.subtype !== 'success') {
    const detail = [payload.result, payload.subtype, payload.api_error_status].filter(Boolean).join(' ');
    raiseIfHardStop(detail);
    throw new Error(`claude CLI error: ${detail || 'unknown'}`);
  }

  return {
    text: payload.result ?? '',
    cost: payload.total_cost_usd ?? 0,
    model: Object.keys(payload.modelUsage ?? {}).join(', ') || model || env.claudeModel,
  };
}

export async function available() {
  if (!findBinary()) {
    return { ok: false, reason: 'the `claude` CLI was not found on PATH. Install it and run `claude` once to log in.' };
  }
  try {
    await run(['--version'], null, 20000);
  } catch (err) {
    return { ok: false, reason: `\`claude\` CLI not runnable (${err.message}). Run \`claude\` once to log in.` };
  }

  // --version answers from a signed-out CLI just as happily as from a signed-in
  // one, so it proves nothing about whether a run will work. A one-word
  // completion is the cheapest thing that actually exercises the login, and it
  // is what turns "everything looks fine" into a real answer.
  try {
    await complete({ system: 'Reply with the single word: ok', prompt: 'ping', timeout: 60000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// Failures worth one more attempt: the transport gave out mid-call. Timeouts
// are excluded — retrying one doubles the wait for something already slow —
// and so is an empty turn, which in practice means the CLI is logged out and
// will answer the same way every time.
const TRANSIENT = /error during execution|overloaded|API status 5\d\d|econnreset|socket hang up|premature close/i;

/**
 * Run the CLI, retrying once on a transient failure.
 *
 * A dropped connection costs nothing and usually succeeds immediately
 * afterwards, so failing a whole CV generation on one wastes the user's time.
 */
async function runWithRetry(args, stdin, timeout) {
  try {
    return await run(args, stdin, timeout);
  } catch (err) {
    if (err instanceof HardStopError || !TRANSIENT.test(err.message)) throw err;
    await new Promise((r) => setTimeout(r, 1500));
    return run(args, stdin, timeout);
  }
}

/**
 * Turn the CLI's own output into something worth reading.
 *
 * On failure the CLI still prints its result envelope, which carries the
 * reason — a subtype, an API status, sometimes a message in `result`. Passed
 * through raw it becomes 300 characters of zeroed token counters cut off
 * mid-key, which says nothing and looks like a crash in this project.
 *
 * Falls back to the raw text when the output is not an envelope, since a plain
 * error line from the CLI is already the message.
 */
function describeFailure(stdout = '') {
  const text = String(stdout).trim();
  if (!text.startsWith('{')) return text;

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }

  const usage = payload.usage ?? {};
  const said = typeof payload.result === 'string' ? payload.result.trim() : '';

  // An envelope with nothing in it at all — no output, no cost, no API status,
  // no message — is what a logged-out CLI returns. It never reached the API,
  // which is why every counter reads zero. Saying "empty response" would send
  // someone looking for a bug in the prompt; the fix is to log in.
  const nothingHappened =
    !said &&
    !payload.api_error_status &&
    (usage.output_tokens ?? 0) === 0 &&
    (usage.input_tokens ?? 0) === 0 &&
    (payload.total_cost_usd ?? 0) === 0;

  if (nothingHappened) {
    return 'the claude CLI produced nothing and never called the API — it is most likely signed out. '
      + 'Run `claude` once in a terminal to log in, then try again.';
  }

  const parts = [
    payload.subtype && payload.subtype !== 'success' ? payload.subtype.replace(/_/g, ' ') : null,
    payload.api_error_status ? `API status ${payload.api_error_status}` : null,
    said || null,
    payload.stop_reason ? `(stop reason: ${payload.stop_reason})` : null,
  ].filter(Boolean);

  return parts.join(' — ') || text;
}

/**
 * Terminate a spawned process AND anything it started.
 *
 * child.kill() only signals the direct child. On Windows that leaves any
 * grandchildren alive holding the stdio pipes open, so Node never sees the
 * streams close and the whole run hangs indefinitely — the timeout fires, the
 * promise rejects, and the process still refuses to exit. taskkill /T walks the
 * tree. Nothing here is user input: the only interpolation is a numeric pid.
 */
function killTree(child) {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        .on("error", () => { try { child.kill(); } catch { /* already gone */ } });
      return;
    } catch { /* fall through to the plain kill below */ }
  }

  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}

function run(args, stdin, timeout) {
  return new Promise((resolve, reject) => {
    const bin = findBinary();
    if (!bin) return reject(new Error('`claude` CLI not found on PATH'));

    // No shell: arguments are passed as a vector, so the multi-line system
    // prompt survives intact and nothing is re-parsed by cmd.exe. A .cmd/.bat
    // shim is the one case Windows cannot launch directly, so it still needs one.
    const needsShell = /\.(cmd|bat)$/i.test(bin);

    const child = spawn(bin, args, {
      shell: needsShell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child);
      reject(new Error(`timed out after ${Math.round(timeout / 1000)}s`));
    }, timeout);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        // A failing CLI still prints its JSON envelope on stdout, and that
        // envelope says why. Dumping the first 300 raw characters instead
        // shows the user a wall of token counters truncated mid-key.
        const message = (err + '\n' + describeFailure(out)).trim();
        try {
          raiseIfHardStop(message);
        } catch (hard) {
          return reject(hard);
        }
        return reject(new Error(message.slice(0, 300) || `exit code ${code}`));
      }
      resolve(out.trim());
    });

    if (stdin != null) child.stdin.write(stdin);
    child.stdin.end();
  });
}
