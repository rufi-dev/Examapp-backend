const mongoose = require("mongoose");
const AppSetting = require("../models/appSettingModel");

/*
 * Which CLI is usable right now, and until when.
 *
 * The CLIs run on subscriptions, and a subscription's failure mode is a wall:
 * "You've hit your usage limit. Try again at Oct 3rd, 2026 5:19 PM." That wall
 * stands for hours or days. Discovering it on every request would mean spawning
 * a process, waiting for it to refuse, and only then doing the real work - on
 * every single AI call for as long as the limit holds.
 *
 * So the wall is remembered. When one CLI reports a limit, it is stood down
 * until its own stated reset time and the other CLI takes the work; when both
 * are down the request goes to the API. The reset time is read out of the
 * refusal itself wherever the binary states one, because a guessed cooldown is
 * either too short (and spawns for nothing) or too long (and pays the API for
 * work a reset subscription would have done free).
 *
 * The state is stored in Mongo rather than in memory because two processes run
 * this code - the web backend and the worker - and a limit one of them found is
 * true for the other. It is cached briefly so the common case (nothing is down)
 * costs no query per AI call.
 */

const KEY = "ai.cliHealth";
const KNOWN = ["claude", "codex"];
const LABEL = Object.freeze({ claude: "Claude CLI", codex: "Codex CLI" });

const CACHE_MS = Math.max(0, Number(process.env.AI_CLI_HEALTH_CACHE_MS) || 10_000);
/* Used only when the refusal names no reset time of its own. */
const DEFAULT_COOLDOWN_MS = Math.max(60_000, Number(process.env.AI_CLI_COOLDOWN_MS) || 30 * 60_000);
/* A CLI that is not logged in or not installed: an admin has to fix it, but the
 * platform should notice the fix without a restart. */
const AUTH_COOLDOWN_MS = Math.max(60_000, Number(process.env.AI_CLI_AUTH_COOLDOWN_MS) || 10 * 60_000);
/* No parse and no arithmetic may ever take a provider out for longer than this.
 * A cooldown is a memory, and a wrong memory must expire. */
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
/* How long a successful turn counts as proof the plan still has room. Long
 * enough to be useful on an admin page, short enough that "ready" never means
 * "it worked last Tuesday". */
const VERIFIED_FOR_MS = Math.max(60_000, Number(process.env.AI_CLI_VERIFIED_FOR_MS) || 30 * 60_000);

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/* The preference order, so an owner with only one CLI is not made to wait for
 * the other to fail first. */
function order() {
  const raw = String(process.env.AI_CLI_ORDER || "claude,codex")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => KNOWN.includes(s));
  const unique = raw.filter((p, i) => raw.indexOf(p) === i);
  return unique.length ? unique : KNOWN.slice();
}

/* ---------------------------------------------------------------- reset time */

function text(error) {
  return [error?.code, error?.message, error?.stderr, error?.stdout, error?.resetsAt]
    .filter((x) => x !== undefined && x !== null)
    .join(" ");
}

/*
 * What the CLI actually said, in one line an owner can act on.
 *
 * The error's own message is usually just our code ("cli_failed"), because the
 * refusal was printed on a stream rather than thrown. An admin page that says
 * "cli_failed" tells nobody anything; "You've hit your usage limit ... try again
 * at Oct 3rd, 2026 5:19 PM" tells them what to do and when. So the sentence
 * carrying the reason is pulled out of the output, and anything key-shaped in it
 * is redacted before it is stored.
 */
/*
 * Strongest wording first. A refusal often mentions the weak words in passing -
 * Codex's names "credits" in a support URL before it gets to the point - and
 * anchoring on the first match found would start the quote in the middle of the
 * wrong sentence.
 */
const REASON_PHRASES = [
  /usage limit|plan limit|limit reached|not logged in|please run \/login/i,
  /rate limit|quota|credit|unauthor|authentication/i,
];

/* Nothing key-shaped is ever stored, whatever a binary chose to print. */
const redact = (s) => String(s).replace(/\b(?:sk|oat01|pk)[-_][A-Za-z0-9_-]{6,}/gi, "***");

/*
 * The places a reason might be, cleanest first. A CLI that answers in JSON
 * states its refusal in the envelope's `result`, and that field is the refusal
 * in the CLI's own words with none of the envelope around it.
 */
function reasonCandidates(error) {
  const out = [];
  const push = (v) => {
    const s = String(v || "").replace(/\s+/g, " ").trim();
    if (s) out.push(s);
  };
  for (const stream of [error?.stdout, error?.stderr]) {
    const m = String(stream || "").match(/"result"\s*:\s*"((?:[^"\\]|\\.){0,300})"/);
    if (m) push(m[1].replace(/\\[nrt]/g, " "));
  }
  push(error?.message);
  push(error?.stderr);
  push(error?.stdout);
  return out;
}

function reasonFrom(error) {
  const candidates = reasonCandidates(error);
  for (const phrase of REASON_PHRASES) {
    for (const candidate of candidates) {
      const at = candidate.search(phrase);
      if (at < 0) continue;
      /* Begin where the sentence carrying the reason begins, not 60 characters
       * into whatever came before it. */
      const lookBehind = candidate.slice(Math.max(0, at - 90), at);
      const stop = Math.max(lookBehind.lastIndexOf(". "), lookBehind.lastIndexOf("! "));
      const start = stop >= 0 ? at - (lookBehind.length - stop - 2) : Math.max(0, at - 60);
      let window = candidate.slice(start, at + 160).trim();
      if (start > 0 && stop < 0) window = window.replace(/^\S*\s/, ""); // never begin mid-word
      return redact(window).slice(0, 180);
    }
  }
  return redact(String(error?.message || error?.code || "limit")).slice(0, 180);
}

/*
 * What kind of wall is this, which decides the cooldown when the binary does
 * not name a reset time.
 */
function kindOf(error) {
  const t = text(error).toLowerCase();
  const status = Number(error?.status || error?.statusCode || 0);
  if (/not logged in|logged out|unauthor|authentication|credentials|run .?login/.test(t)) return "auth";
  if (/enoent|spawn|not found|command not found|cli_spawn_failed|cli_unavailable/.test(t)) return "missing";
  if (status === 429 || status === 402) return "quota";
  return "quota";
}

/*
 * The reset time the refusal itself states, in whatever shape the binary chose
 * to state it. Returns null when it states none.
 */
function parseResetAt(error, now = Date.now()) {
  const t = text(error);
  if (!t) return null;

  /* Claude Code's machine-readable form: "...usage limit reached|1759507140". */
  const piped = t.match(/\|\s*(\d{10}|\d{13})(?!\d)/);
  if (piped) {
    const n = Number(piped[1]);
    return piped[1].length === 13 ? n : n * 1000;
  }

  /* An explicit epoch or duration handed over by a caller. */
  if (Number.isFinite(Number(error?.retryAfter))) return now + Number(error.retryAfter) * 1000;

  /* ISO-8601, which needs no interpretation. */
  const iso = t.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/);
  if (iso) {
    const at = Date.parse(iso[0].replace(" ", "T"));
    if (Number.isFinite(at)) return at;
  }

  /*
   * Codex's prose form: "Try again at Oct 3rd, 2026 5:19 PM."
   *
   * Built by hand rather than handed to Date.parse, because the ordinal suffix
   * ("3rd") makes that parse engine-dependent - and a date that parses on one
   * Node build and returns NaN on another would silently become a default
   * cooldown nobody could explain.
   */
  const named = t.match(
    /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:,?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]?\.?)?/
  );
  if (named) {
    const month = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase());
    if (month >= 0) {
      let hour = named[4] === undefined ? 0 : Number(named[4]);
      const minute = named[5] === undefined ? 0 : Number(named[5]);
      const half = (named[6] || "").toLowerCase();
      if (half === "p" && hour < 12) hour += 12;
      if (half === "a" && hour === 12) hour = 0;
      const at = new Date(Number(named[3]), month, Number(named[2]), hour, minute, 0, 0).getTime();
      if (Number.isFinite(at)) return at;
    }
  }

  /* "try again in 42 minutes", "retry in 2 hours". */
  const rel = t.match(/\bin\s+(\d+)\s*(second|sec|minute|min|hour|hr|day)s?\b/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit.startsWith("sec") ? 1000 : unit.startsWith("min") ? 60_000 : unit.startsWith("h") ? 3_600_000 : 86_400_000;
    return now + n * ms;
  }

  /* Claude's short form: "5-hour limit reached - resets 3am" / "resets at 15:00". */
  const clock = t.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([AaPp])?\.?[Mm]?\.?(?!\d)/);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = clock[2] === undefined ? 0 : Number(clock[2]);
    const half = (clock[3] || "").toLowerCase();
    if (half === "p" && hour < 12) hour += 12;
    if (half === "a" && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59) {
      const d = new Date(now);
      d.setHours(hour, minute, 0, 0);
      let at = d.getTime();
      if (at <= now) at += 86_400_000; // the stated hour has passed: it means tomorrow
      return at;
    }
  }
  return null;
}

/*
 * When the provider may be tried again: what it said, bounded by what is sane.
 * A stated time in the past means the limit has already lifted, so it is given
 * a minute rather than treated as a wall.
 */
function cooldownUntil(error, now = Date.now()) {
  const stated = parseResetAt(error, now);
  if (stated !== null && Number.isFinite(stated)) {
    if (stated <= now) return now + 60_000;
    return Math.min(stated, now + MAX_COOLDOWN_MS);
  }
  const kind = kindOf(error);
  return now + (kind === "auth" ? AUTH_COOLDOWN_MS : DEFAULT_COOLDOWN_MS);
}

/* ------------------------------------------------------------------- storage */

let cache = null;
let cachedAt = 0;

function blank() {
  return {};
}

function usable() {
  return mongoose.connection?.readyState === 1;
}

async function read() {
  const now = Date.now();
  if (cache && now - cachedAt < CACHE_MS) return cache;
  if (!usable()) {
    // No database (a test, or a reconnect in progress). Whatever this process
    // has learned is still better than nothing, and nothing is still safe.
    cache = cache || blank();
    cachedAt = now;
    return cache;
  }
  try {
    const row = await AppSetting.findOne({ key: KEY }).lean();
    const value = row?.value && typeof row.value === "object" ? row.value : {};
    const clean = {};
    for (const p of KNOWN) {
      const entry = value[p];
      if (!entry || typeof entry !== "object") continue;
      const until = Number(entry.until) || 0;
      clean[p] = {
        until,
        reason: String(entry.reason || ""),
        code: String(entry.code || ""),
        at: Number(entry.at) || 0,
        okAt: Number(entry.okAt) || 0,
      };
    }
    cache = clean;
    cachedAt = now;
    return cache;
  } catch (e) {
    console.warn("[AI] cli health read failed:", e?.message);
    cache = cache || blank();
    cachedAt = now;
    return cache;
  }
}

async function write(state) {
  cache = state;
  cachedAt = Date.now();
  if (!usable()) return state;
  try {
    await AppSetting.updateOne({ key: KEY }, { $set: { value: state } }, { upsert: true });
  } catch (e) {
    console.warn("[AI] cli health write failed:", e?.message);
  }
  return state;
}

/* --------------------------------------------------------------- the pieces */

/*
 * This provider has hit a wall. Stand it down until it says it is back.
 *
 * Re-writing a cooldown that is effectively the same one is skipped: in CLI-only
 * mode an exhausted provider is still attempted as a last resort, and without
 * this that would be a database write per request.
 */
async function markExhausted(provider, error, now = Date.now()) {
  if (!KNOWN.includes(provider)) return null;
  const state = { ...(await read()) };
  const until = cooldownUntil(error, now);
  const had = state[provider]?.until || 0;
  const entry = {
    until,
    reason: reasonFrom(error),
    code: String(error?.code || kindOf(error)),
    at: now,
  };
  if (had > now && Math.abs(had - until) < 60_000) {
    cache = { ...state, [provider]: { ...state[provider], at: now } };
    cachedAt = now;
    return cache[provider];
  }
  state[provider] = entry;
  await write(state);
  console.warn(
    `[AI] ${LABEL[provider]} stood down until ${new Date(until).toISOString()} (${entry.code}); other routes will take the work`
  );
  return entry;
}

/* It worked. Anything remembered about it being down is now wrong. */
async function markRecovered(provider, now = Date.now()) {
  if (!KNOWN.includes(provider)) return;
  const state = await read();
  const entry = state[provider];
  const wasResting = (entry?.until || 0) > now;

  /*
   * A success is the only thing that can honestly be called "ready", so it is
   * recorded — but not on every single turn. Refreshing a timestamp that is
   * already minutes old buys nothing and would put a database write behind
   * every AI request the platform serves.
   */
  const fresh = (entry?.okAt || 0) > now - VERIFIED_FOR_MS / 2;
  if (!wasResting && fresh) return;

  const next = { ...state, [provider]: { until: 0, reason: "", code: "", at: now, okAt: now } };
  await write(next);
  if (wasResting) {
    console.log(`[AI] ${LABEL[provider]} is working again (${new Date(now).toISOString()})`);
  }
}

/* An admin pressing "check again" - the cooldown is a guess and this clears it. */
async function clear(provider) {
  const state = await read();
  if (provider && !KNOWN.includes(provider)) return state;
  if (!provider) return write(blank());
  const rest = { ...state };
  delete rest[provider];
  return write(rest);
}

/*
 * The CLIs to try, in order, and the ones being rested.
 *
 * `prefer` is the provider the teacher's own model choice implies, so a request
 * for a GPT model tries Codex first when Codex is up.
 */
function planFrom(state, { prefer, now = Date.now() } = {}) {
  const all = order();
  const ordered = prefer && all.includes(prefer) ? [prefer, ...all.filter((p) => p !== prefer)] : all;
  const down = (p) => (state[p]?.until || 0) > now;
  return {
    ready: ordered.filter((p) => !down(p)),
    /* Soonest to come back first: if every CLI is resting and there is nothing
     * else left to try, that is the one worth the attempt. */
    resting: ordered.filter(down).sort((a, b) => (state[a].until || 0) - (state[b].until || 0)),
  };
}

async function plan({ prefer, now = Date.now() } = {}) {
  return planFrom(await read(), { prefer, now });
}

/* What the admin page shows. */
/*
 * Say exactly what is known, and no more.
 *
 * "Hazırdır" used to mean "nothing has told us otherwise", which is how this
 * page came to report a Codex plan that had been out of quota for days as
 * ready. There are three genuinely different states and they deserve three
 * different words:
 *
 *   resting   — it refused, and said when it will be back. Known, and dated.
 *   unusable  — not installed, or not signed in. Free to establish, since the
 *               binary answers that itself without contacting anyone.
 *   unknown   — signed in, nothing refused recently. Whether the subscription
 *               has allowance left CANNOT be known without spending some of it,
 *               so this is honest rather than optimistic.
 *   ready     — it actually worked, recently. Earned, not assumed.
 *
 * The login half is checked on every read because it costs nothing. The quota
 * half is checked only when an admin asks, because asking is spending.
 */
async function snapshot(now = Date.now(), { withLogin = true } = {}) {
  const state = await read();
  const { cliStatus } = require("./cliAi");
  const ids = order();
  const logins = withLogin
    ? await Promise.all(ids.map((id) => cliStatus(id).catch(() => null)))
    : ids.map(() => null);

  return ids.map((id, i) => {
    const entry = state[id];
    const until = entry?.until || 0;
    const resting = until > now;
    const login = logins[i];
    const okAt = entry?.okAt || 0;
    /* A success is evidence of allowance only while it is fresh. */
    const verified = okAt > 0 && now - okAt < VERIFIED_FOR_MS;

    let stateName = "unknown";
    if (resting) stateName = "resting";
    else if (login && (!login.installed || !login.loggedIn)) stateName = "unusable";
    else if (verified) stateName = "ready";

    return {
      id,
      label: LABEL[id],
      state: stateName,
      until: resting ? new Date(until).toISOString() : null,
      minutes: resting ? Math.max(1, Math.round((until - now) / 60_000)) : 0,
      reason: resting ? entry.reason : "",
      code: resting ? entry.code : "",
      since: entry?.at ? new Date(entry.at).toISOString() : null,
      // What the free check established, whatever the quota turns out to be.
      login: login ? { installed: login.installed, loggedIn: login.loggedIn, method: login.method, detail: login.detail } : null,
      lastOkAt: okAt ? new Date(okAt).toISOString() : null,
    };
  });
}

/*
 * When the platform expects to have a CLI again, and how to say that to a
 * teacher.
 *
 * "Try again later" is not an answer anyone can act on. The binaries state a
 * real reset time in their refusal and we already store it, so the teacher can
 * be told the hour - in their own timezone, because a UTC time is four hours
 * wrong for everyone reading it in Baku.
 */
const AZ_MONTHS = [
  "yanvar", "fevral", "mart", "aprel", "may", "iyun",
  "iyul", "avqust", "sentyabr", "oktyabr", "noyabr", "dekabr",
];

function azWhen(ms, tz = process.env.APP_TZ || "Asia/Baku") {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      day: "numeric",
      month: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date(ms))
      .reduce((acc, p) => Object.assign(acc, { [p.type]: p.value }), {});
    const month = AZ_MONTHS[Number(parts.month) - 1];
    if (!month) return "";
    return `${Number(parts.day)} ${month}, saat ${parts.hour}:${parts.minute}`;
  } catch {
    return "";
  }
}

/* The first moment any CLI is expected back, or null if one is usable now. */
async function soonestReturn(now = Date.now()) {
  const state = await read();
  const times = order()
    .map((p) => state[p]?.until || 0)
    .filter((t) => t > now);
  if (times.length !== order().length) return null; // at least one is usable
  return Math.min(...times);
}

/* Tests drive this without a database. */
function _reset() {
  cache = blank();
  cachedAt = Date.now();
}
function _set(state) {
  cache = state;
  cachedAt = Date.now();
}

module.exports = {
  KEY,
  KNOWN,
  LABEL,
  DEFAULT_COOLDOWN_MS,
  AUTH_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  order,
  kindOf,
  reasonFrom,
  parseResetAt,
  azWhen,
  soonestReturn,
  cooldownUntil,
  markExhausted,
  markRecovered,
  clear,
  plan,
  planFrom,
  snapshot,
  _reset,
  _set,
};
