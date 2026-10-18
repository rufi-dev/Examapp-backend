/*
 * TikTok Events API — the server's half of the TikTok Pixel (owner, 2026-10-18:
 * "Implement Events API… set this up").
 *
 * The browser pixel (Frontend utils/tiktokPixel.js) misses visitors with an ad
 * blocker, a strict browser, or a page closed before it loaded. The server sees
 * every sign-up and every class and exam, so it reports the same moments itself:
 *
 *   CompleteRegistration  — an account was made (form or Google), id reg-<userId>
 *   TeacherActivated      — a teacher made a class (class-<classId>) or saved
 *                           questions into an exam (exam-<examId>)
 *
 * Each event carries the SAME event_id the browser pixel sends, so TikTok counts
 * a moment once when both see it (and once when only one does). Repeated saves
 * of one exam share an id: one activation per exam.
 *
 * Matching: email, phone and the account id are SHA-256 hashed here (TikTok's
 * rule; nothing readable leaves the server), plus the request's IP and browser,
 * the pixel's own _ttp cookie when it reaches the API, and the ad-click id
 * (ttclid) the sign-up came with.
 *
 * Off unless TIKTOK_PIXEL_ID and TIKTOK_EVENTS_TOKEN are set (server .env, never
 * git). TIKTOK_TEST_EVENT_CODE routes events to Events Manager → Test events
 * instead of the real data. Never awaited by a request, never throws, and logs
 * only the event name and TikTok's answer — no email, phone or id.
 */
const crypto = require("crypto");

const ENDPOINT = "https://business-api.tiktok.com/open_api/v1.3/event/track/";
const FRONTEND = (process.env.FRONTEND_URL || "https://examopia.com").replace(/\/$/, "");

const enabled = () => Boolean(process.env.TIKTOK_PIXEL_ID && process.env.TIKTOK_EVENTS_TOKEN) && process.env.NODE_ENV !== "test";

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

// An Azerbaijani number as E.164 ("+994501234567"), however it was stored.
function e164(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("994") && d.length === 12) return `+${d}`;
  if (d.length === 9) return `+994${d}`;
  if (d.length === 10 && d.startsWith("0")) return `+994${d.slice(1)}`;
  return `+${d}`;
}

// Who it was, as TikTok can match it: hashed identifiers + this request's context.
function userOf(user, req) {
  const out = {};
  const email = String(user?.email || "").trim().toLowerCase();
  if (email) out.email = sha256(email);
  const phone = e164(user?.phone);
  if (phone) out.phone = sha256(phone);
  if (user?._id) out.external_id = sha256(String(user._id));
  const ttclid = user?.acquisition?.ttclid;
  if (ttclid) out.ttclid = String(ttclid).slice(0, 300);
  if (req) {
    if (req.ip) out.ip = String(req.ip).replace(/^::ffff:/, "");
    const ua = req.get ? req.get("user-agent") : req.headers?.["user-agent"];
    if (ua) out.user_agent = String(ua).slice(0, 500);
    const ttp = req.cookies?._ttp;
    if (ttp) out.ttp = String(ttp).slice(0, 300);
  }
  out.locale = "az_AZ";
  return out;
}

function buildPayload(event, { eventId, user, req, path = "/", properties = {}, now = Date.now() } = {}) {
  const body = {
    event_source: "web",
    event_source_id: process.env.TIKTOK_PIXEL_ID,
    data: [
      {
        event,
        event_time: Math.floor(now / 1000),
        ...(eventId ? { event_id: String(eventId) } : {}),
        user: userOf(user, req),
        properties,
        page: { url: `${FRONTEND}${path}` },
      },
    ],
  };
  if (process.env.TIKTOK_TEST_EVENT_CODE) body.test_event_code = process.env.TIKTOK_TEST_EVENT_CODE;
  return body;
}

async function post(body, fetchImpl = globalThis.fetch) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Access-Token": process.env.TIKTOK_EVENTS_TOKEN },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, code: json.code, message: json.message };
  } finally {
    clearTimeout(t);
  }
}

/*
 * Report one moment. Fire-and-forget: callers do not await it, and a slow or
 * failing TikTok never delays or breaks a sign-up, a class or a save.
 */
function tiktokEvent(event, opts = {}, fetchImpl) {
  if (!enabled()) return Promise.resolve(null);
  let body;
  try {
    body = buildPayload(event, opts);
  } catch {
    return Promise.resolve(null);
  }
  return post(body, fetchImpl)
    .then((r) => {
      if (r.code === 0) console.log(`[TIKTOK] ${event} sent`);
      else console.warn(`[TIKTOK] ${event} not accepted: ${r.status} ${r.code} ${String(r.message || "").slice(0, 160)}`);
      return r;
    })
    .catch((e) => {
      console.warn(`[TIKTOK] ${event} failed: ${e?.name === "AbortError" ? "timeout" : e?.message}`);
      return null;
    });
}

module.exports = { tiktokEvent, buildPayload, userOf, e164, enabled, post, ENDPOINT };
