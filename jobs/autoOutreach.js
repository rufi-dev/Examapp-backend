const User = require("../models/userModel");
const AppSetting = require("../models/appSettingModel");
const { stuckStateForOwners } = require("../helper/stuckTeachers");
const wa = require("../helper/whatsapp");

// ─────────────────────────────────────────────────────────────────────────────
// Auto-outreach watcher — ONE unified waiting list.
//
// Every teacher who signed up but never finished setting up (empty exam, empty
// class, or nothing at all) and hasn't been contacted yet is in the queue —
// whether they registered long ago (backlog) or just now. The watcher sends ONE
// warm WhatsApp at a time (from the admin's LINKED number, first name only,
// tailored to how far they got). Order: NEW signups (registered after the
// watcher was switched on) go first, oldest-of-them first (FIFO); then the
// EXISTING backlog, newest-first (LIFO). These rules apply to EVERYONE:
//
//   • Only during working hours 09:00–21:00 (Asia/Baku). Nothing after 9pm or
//     before 9am — for new and existing alike.
//   • One real send every 10 minutes (a steady drip, ban-safe).
//   • A brand-new signup waits a short grace (default 10 min) before being
//     eligible, so we don't nag someone who is still mid-setup.
//   • Numbers not on WhatsApp are cleared quickly and don't consume a slot.
//   • Each teacher is messaged AT MOST ONCE (terminal status on the user); a
//     transient send error is retried a few times before being marked failed,
//     so nobody is silently dropped.
//
// If no admin WhatsApp is linked+ready, the sweep does nothing (never wa.me).
// Toggle is admin-controlled and persisted (AppSetting).
// ─────────────────────────────────────────────────────────────────────────────

const ENABLED_KEY = "autoOutreachEnabled";
const LAST_SENT_KEY = "autoOutreachLastSentAt";
// Boundary between "new signups" and "existing backlog": stamped once when the
// watcher is first switched on. Registered AFTER it = a new signup we started
// watching live; BEFORE it = pre-existing backlog.
const SINCE_KEY = "autoOutreachSince";
// The second wave's own switch (see "Second wave" below).
const REENGAGE_KEY = "reengageEnabled";
// The second wave's email, its own switch and its own (gentler) daily cap: the
// same mailbox delivers login codes and password resets, which must never be
// crowded out or put at risk by outreach volume.
const REENGAGE_EMAIL_KEY = "reengageEmailEnabled";
const EMAIL_DAILY_MAX = Number(process.env.OUTREACH_EMAIL_DAILY_MAX) || 100;
const EMAILS_PER_SWEEP = Number(process.env.OUTREACH_EMAILS_PER_SWEEP) || 5;
const INACTIVE_DAYS = Number(process.env.OUTREACH_INACTIVE_DAYS) || 7;

const WATCH_MINUTES = Number(process.env.OUTREACH_WATCH_MINUTES) || 10; // new-signup grace
const GAP_MIN = Number(process.env.OUTREACH_GAP_MIN) || 30; // minutes between sends (gentle, ban-safe)
const DAILY_MAX = Number(process.env.OUTREACH_DAILY_MAX) || 25; // hard cap of real sends per calendar day (Baku)
const DAY_START = Number(process.env.OUTREACH_DAY_START) || 9; // 09:00 inclusive
const DAY_END = Number(process.env.OUTREACH_DAY_END) || 21; // 21:00 exclusive (9pm)
const TZ = process.env.OUTREACH_TZ || "Asia/Baku";
// Candidates probed per sweep: enough to clear a run of dead numbers and still
// land one real send, without hammering getNumberId.
const ATTEMPTS_PER_SWEEP = Number(process.env.OUTREACH_ATTEMPTS) || 8;
const MAX_RETRIES = Number(process.env.OUTREACH_MAX_RETRIES) || 3;

// Current hour (0–23) in the target timezone.
function localHour(now) {
  try {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(now);
    return parseInt(s, 10);
  } catch {
    return (now.getUTCHours() + 4) % 24; // Baku is UTC+4 (no DST) — fallback
  }
}

const withinHours = (now) => {
  const h = localHour(now);
  return h >= DAY_START && h < DAY_END;
};

// UTC instant of the current Baku calendar day's midnight (UTC+4, no DST).
function bakuMidnight(now) {
  const d = new Date(now.getTime() + 4 * 3600 * 1000);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - 4 * 3600 * 1000);
}

// Real sends already made today (Baku), BOTH waves — for the daily cap + the
// admin status. The cap protects the numbers, so it counts every message they sent.
async function sentTodayCount(now = new Date()) {
  const since = bakuMidnight(now);
  return User.countDocuments({
    $or: [
      { outreachStatus: "sent", outreachAt: { $gte: since } },
      { reengageStatus: "sent", reengageAt: { $gte: since } },
    ],
  });
}

async function getSettings() {
  const [enabled, lastSent, since, reengage, reengageEmail] = await Promise.all([
    AppSetting.findOne({ key: ENABLED_KEY }).lean(),
    AppSetting.findOne({ key: LAST_SENT_KEY }).lean(),
    AppSetting.findOne({ key: SINCE_KEY }).lean(),
    AppSetting.findOne({ key: REENGAGE_KEY }).lean(),
    AppSetting.findOne({ key: REENGAGE_EMAIL_KEY }).lean(),
  ]);
  return {
    enabled: !!(enabled && enabled.value),
    reengageEnabled: !!(reengage && reengage.value),
    reengageEmailEnabled: !!(reengageEmail && reengageEmail.value),
    lastSentAt: lastSent && lastSent.value ? new Date(lastSent.value) : null,
    since: since && since.value ? new Date(since.value) : null,
  };
}

async function setEnabled(on, now = new Date()) {
  await AppSetting.updateOne({ key: ENABLED_KEY }, { $set: { value: !!on } }, { upsert: true });
  if (on) {
    // Stamp the new/existing boundary ONCE, on first enable, and keep it stable.
    const existing = await AppSetting.findOne({ key: SINCE_KEY }).lean();
    if (!existing || !existing.value) {
      await AppSetting.updateOne({ key: SINCE_KEY }, { $set: { value: now } }, { upsert: true });
    }
  }
  return getSettings();
}

async function setReengageEmailEnabled(on) {
  await AppSetting.updateOne({ key: REENGAGE_EMAIL_KEY }, { $set: { value: !!on } }, { upsert: true });
  return getSettings();
}

async function setReengageEnabled(on) {
  await AppSetting.updateOne({ key: REENGAGE_KEY }, { $set: { value: !!on } }, { upsert: true });
  return getSettings();
}

async function setLastSentAt(when) {
  await AppSetting.updateOne({ key: LAST_SENT_KEY }, { $set: { value: when } }, { upsert: true });
}

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

// Tailored outreach scripts — first name only, warm, asks what went wrong and
// offers to help. Mirror of the frontend manual scripts.
function outreachMessage(u, stuck) {
  const fn = firstName(u.name);
  const n = fn ? ` ${fn} müəllim` : " müəllim";
  // One unified re-engagement script for every stuck state (WhatsApp bold = *single* asterisks).
  return `Salam${n} 😊 *Examopia-da qeydiyyatdan keçdiyinizi*, amma platformadan istifadəni davam etdirmədiyinizi gördük.

Examopia müəllimlər üçün *AI ilə test və imtahan yaratmaq, şagirdləri siniflər üzrə idarə etmək, dərs materialları paylaşmaq, ev tapşırıqları vermək, canlı imtahan keçirmək, elektron lövhədən istifadə etmək və nəticələri izləmək* üçün hazırlanmış onlayn tədris platformasıdır.

Deyəsən, istifadə zamanı hansısa çətinlik yaşamısınız. *Hansı hissədə ilişdiniz?* Sizə kömək edə bilərəm 😊

https://examopia.com`;
}

// Attempt one send + record the outcome. Returns the raw send result
// ("sent" | "no_whatsapp" | "not_ready" | "failed"). Terminal statuses guarantee
// the teacher is never messaged twice; a transient "failed" is retried up to
// MAX_RETRIES before being marked terminal.
async function contact(senderId, u, stuck) {
  let status = "failed";
  try {
    status = await wa.sendOutreachFor(senderId, u.phone, outreachMessage(u, stuck));
  } catch {
    status = "failed";
  }
  if (status === "not_ready") return status; // session down — retry next tick, don't persist

  const guard = { _id: u._id, outreachStatus: { $in: [null] } };
  if (status === "sent") {
    await User.updateOne(guard, {
      $set: { outreachStatus: "sent", outreachAt: new Date(), outreachReason: "sent" },
      $inc: { outreachAttempts: 1 },
    });
  } else if (status === "no_whatsapp") {
    await User.updateOne(guard, {
      $set: { outreachStatus: "skipped", outreachAt: new Date(), outreachReason: "no_whatsapp" },
    });
  } else {
    // failed — retry a few times before giving up.
    const nextAttempts = (u.outreachAttempts || 0) + 1;
    if (nextAttempts >= MAX_RETRIES) {
      await User.updateOne(guard, {
        $set: { outreachStatus: "failed", outreachAt: new Date(), outreachReason: "failed", outreachAttempts: nextAttempts },
      });
    } else {
      await User.updateOne(guard, {
        $set: { outreachReason: "failed" },
        $inc: { outreachAttempts: 1 },
      }); // outreachStatus stays null → still in the queue
    }
  }
  return status;
}

// ── Second wave: re-engagement ───────────────────────────────────────────────
// A teacher on no paid plan who has not opened the site for INACTIVE_DAYS gets
// ONE message reminding them what Examopia does. It is re-checked on every
// sweep, so a teacher who crosses the line today is queued today. It shares the
// first wave's numbers, hours, gap and daily cap, so the two together never send
// more than the numbers can safely carry, and the first wave (new signups, which
// cannot wait a week) gets the slot whenever both have someone waiting.
// Newest registrations first: they are the likeliest to come back.
function reengageMessage(u) {
  const fn = firstName(u.name);
  const n = fn ? ` ${fn} müəllim` : " müəllim";
  return `Salam${n} 😊 Bir müddət əvvəl *Examopia*-da qeydiyyatdan keçmişdiniz, amma platformadan istifadə etmədiniz. Yəqin platforma da yadınızdan çıxıb 🙂 Nə mane oldu?

Qısaca xatırladım, Examopia nə edir:

🤖 *AI ilə imtahan*: mövzunu yazırsınız, AI dəqiqələr içində hazır imtahan qurur
🔴 *Canlı imtahan*: şagirdlər yazarkən kimin hansı sualda olduğunu və doğru-səhvini canlı izləyirsiniz, köçürmək üçün səhifədən çıxan dərhal görünür
👨‍👩‍👧 *Valideynlər*: nəticələri öz telefonundan görür, WhatsApp-a avtomatik bildiriş alır
👥 *Bütün şagirdlər bir yerdə*: siniflər, nəticələr, ev tapşırıqları bir paneldə
📚 *Ev tapşırığı*: onlayn verin, onlayn yoxlayın
🎓 *Dərs hazırlığı*: AI ilə dərs planı və dərs materialı hazırlayın
✅ *Kağız yoxlamağa son*: nəticə imtahan bitən kimi hazırdır

Hesabınız artıq hazırdır, pulsuz başlaya bilərsiniz 👇
https://examopia.com/login

Sualınız olsa, elə bura yazın 😊`;
}

/*
 * Who the second wave is for, as one query: a teacher with a phone, on no paid
 * plan, not deleted, not yet given a second-wave outcome, whose last visit (or,
 * never having come back, whose registration) is older than INACTIVE_DAYS, and
 * who has had nothing from the first wave in that time either.
 */
function reengageQuery(now = new Date()) {
  const cut = new Date(now.getTime() - INACTIVE_DAYS * 24 * 60 * 60 * 1000);
  return {
    role: "teacher",
    deletedAt: null,
    // "+994" alone is the schema default: a teacher who never gave a number.
    phone: { $nin: [null, "", "+994"] },
    plan: { $nin: ["pro", "premium"] },
    reengageStatus: { $in: [null] },
    $and: [
      { $or: [{ lastActiveAt: { $lt: cut } }, { lastActiveAt: null, createdAt: { $lt: cut } }] },
      { $or: [{ outreachAt: null }, { outreachAt: { $lt: cut } }] },
    ],
  };
}

async function reengageWaitingCount(now = new Date()) {
  return User.countDocuments(reengageQuery(now));
}

// One second-wave send + its outcome, the same rules as `contact` below.
async function contactReengage(senderId, u, now = new Date()) {
  let status = "failed";
  try {
    status = await wa.sendOutreachFor(senderId, u.phone, reengageMessage(u));
  } catch {
    status = "failed";
  }
  if (status === "not_ready") return status;

  const guard = { _id: u._id, reengageStatus: { $in: [null] } };
  if (status === "sent") {
    await User.updateOne(guard, {
      $set: { reengageStatus: "sent", reengageAt: now, reengageReason: "sent" },
      $inc: { reengageAttempts: 1 },
    });
  } else if (status === "no_whatsapp") {
    await User.updateOne(guard, {
      $set: { reengageStatus: "skipped", reengageAt: now, reengageReason: "no_whatsapp" },
    });
  } else {
    const nextAttempts = (u.reengageAttempts || 0) + 1;
    if (nextAttempts >= MAX_RETRIES) {
      await User.updateOne(guard, {
        $set: { reengageStatus: "failed", reengageAt: now, reengageReason: "failed", reengageAttempts: nextAttempts },
      });
    } else {
      await User.updateOne(guard, { $set: { reengageReason: "failed" }, $inc: { reengageAttempts: 1 } });
    }
  }
  return status;
}

async function secondWave(now, senderKeys) {
  const candidates = await User.find(reengageQuery(now))
    .select("_id name phone createdAt reengageAttempts")
    .sort({ createdAt: -1 })
    .limit(ATTEMPTS_PER_SWEEP)
    .lean();
  if (!candidates.length) return { wave: 2, drained: true };
  let cleared = 0;
  for (const u of candidates) {
    const senderId = wa.nextReadyOwner(senderKeys);
    if (!senderId) return { wave: 2, skipped: "not_ready" };
    const status = await contactReengage(senderId, u, now);
    if (status === "not_ready") return { wave: 2, skipped: "not_ready" };
    if (status === "sent") {
      // The sweep's own clock, so the gap and the daily count agree with it.
      await setLastSentAt(now);
      console.log(`[OUTREACH] wave 2: sent 1 (cleared ${cleared} dead this slot)`);
      return { wave: 2, sent: 1, cleared };
    }
    cleared += 1;
  }
  return { wave: 2, sent: 0, cleared };
}

// ── Second wave by email ─────────────────────────────────────────────────────
// Follows the WhatsApp step: a teacher becomes due for the email the moment the
// second wave has run for them (whether the WhatsApp went out, the number is not
// on WhatsApp, or it failed), so the two arrive together. Once per teacher, never
// to anyone who unsubscribed, and only to teachers still on no paid plan.
function reengageEmailQuery() {
  return {
    role: "teacher",
    deletedAt: null,
    email: { $nin: [null, ""] },
    emailOptOut: { $ne: true },
    plan: { $nin: ["pro", "premium"] },
    reengageStatus: { $in: ["sent", "skipped", "failed"] },
    reengageEmailStatus: { $in: [null] },
  };
}

const reengageEmailSubject = (u) => {
  const fn = firstName(u.name);
  return `${fn ? `${fn} müəllim` : "Hörmətli müəllim"}, qeydiyyatdan keçdiniz, amma başlamadınız 🙂`;
};

async function emailsSentToday(now = new Date()) {
  return User.countDocuments({ reengageEmailStatus: "sent", reengageEmailAt: { $gte: bakuMidnight(now) } });
}

async function sendReengageEmail(u, now = new Date()) {
  const { sendNotification } = require("../utils/sendEmail");
  const { unsubscribePath } = require("../helper/unsubscribe");
  const guard = { _id: u._id, reengageEmailStatus: { $in: [null] } };
  try {
    const info = await sendNotification({
      kind: "reengage",
      to: u.email,
      subject: reengageEmailSubject(u),
      name: firstName(u.name),
      link: unsubscribePath(u._id),
    });
    // Mail is switched off on this server: nothing was sent, try again later.
    if (info && info.skipped) return "not_ready";
    await User.updateOne(guard, { $set: { reengageEmailStatus: "sent", reengageEmailAt: now }, $inc: { reengageEmailAttempts: 1 } });
    return "sent";
  } catch (e) {
    const next = (u.reengageEmailAttempts || 0) + 1;
    await User.updateOne(
      guard,
      next >= MAX_RETRIES
        ? { $set: { reengageEmailStatus: "failed", reengageEmailAt: now, reengageEmailAttempts: next } }
        : { $inc: { reengageEmailAttempts: 1 } }
    );
    console.warn("[OUTREACH] email failed:", e && e.code ? e.code : "error");
    return "failed";
  }
}

async function emailSweep(now = new Date()) {
  const { reengageEmailEnabled } = await getSettings();
  if (!reengageEmailEnabled || !withinHours(now)) return null;
  const today = await emailsSentToday(now);
  if (today >= EMAIL_DAILY_MAX) return { email: "daily_cap" };
  const due = await User.find(reengageEmailQuery())
    .select("_id name email reengageEmailAttempts")
    .sort({ reengageAt: 1 })
    .limit(Math.min(EMAILS_PER_SWEEP, EMAIL_DAILY_MAX - today))
    .lean();
  if (!due.length) return null;
  let emailed = 0;
  for (const u of due) {
    const r = await sendReengageEmail(u, now);
    if (r === "not_ready") return { email: "mail_disabled" };
    if (r === "sent") emailed += 1;
  }
  return { emailed };
}

async function reengageEmailWaitingCount() {
  return User.countDocuments(reengageEmailQuery());
}

// Base query for "still waiting": a teacher registered longer than the grace
// window, with a phone, not yet given a terminal status.
function waitingQuery(now) {
  return {
    role: "teacher",
    createdAt: { $lte: new Date(now.getTime() - WATCH_MINUTES * 60 * 1000) },
    phone: { $nin: [null, ""] },
    outreachStatus: { $in: [null] }, // matches null OR missing
  };
}

// How many stuck teachers are currently waiting (for the admin status view).
async function waitingCount(now = new Date()) {
  const rows = await User.find(waitingQuery(now)).select("_id").lean();
  if (!rows.length) return 0;
  const stuckMap = await stuckStateForOwners(rows.map((r) => r._id));
  let n = 0;
  stuckMap.forEach((s) => {
    if (s.isStuck) n += 1;
  });
  return n;
}

// Why the last sweep did nothing. Logged only when the reason CHANGES, so the
// watcher's state is always visible in the logs without spamming every 2 minutes.
let lastNote = "";
function note(res) {
  const k = JSON.stringify(res);
  if (k !== lastNote) {
    lastNote = k;
    console.log("[OUTREACH]", k);
  }
  return res;
}

async function runOutreachSweep(now = new Date()) {
  const res = await sweepInner(now);
  // The email follows the WhatsApp step, on its own limits, every tick.
  let mail = null;
  try {
    mail = await emailSweep(now);
  } catch (e) {
    mail = { email: "error" };
    console.warn("[OUTREACH] email sweep error:", e && e.message);
  }
  return note(mail ? { ...res, ...mail } : res);
}

// One sweep. Idempotent, bounded, safe on an interval.
async function sweepInner(now = new Date()) {
  const { enabled, reengageEnabled, lastSentAt, since } = await getSettings();
  if (!enabled && !reengageEnabled) return { skipped: "disabled" };

  const admins = await User.find({ role: "admin" }).select("_id").lean();
  // Consider BOTH linked numbers (slot 1 + slot 2) of every admin. The sender is
  // rotated PER ACTUAL SEND (in the loop below), NOT here: a sweep runs every ~2 min
  // but real sends are ~30 min apart, so advancing the round-robin cursor here would
  // churn it on every idle sweep and the alternation would drift / stick to one
  // number. Here we only check that SOMETHING is ready.
  const senderKeys = admins.flatMap((a) => [wa.accountKey(a._id, 1), wa.accountKey(a._id, 2)]);
  if (!wa.readyOwners(senderKeys).length) return { skipped: "no_linked_whatsapp" };

  if (!withinHours(now)) return { skipped: "outside_hours", hour: localHour(now) };
  if (lastSentAt && now.getTime() - lastSentAt.getTime() < GAP_MIN * 60 * 1000) return { skipped: "gap" };

  // Hard daily cap: stop once DAILY_MAX real sends have gone out today (Baku).
  const sentToday = await sentTodayCount(now);
  if (sentToday >= DAILY_MAX) return { skipped: "daily_cap", sentToday };

  // The first wave gets the slot when it has someone; otherwise the second.
  let first = null;
  if (enabled) {
    first = await firstWave(now, since, senderKeys);
    if (first.sent || first.skipped) return first;
  }
  if (!reengageEnabled) return first;
  const second = await secondWave(now, senderKeys);
  return first ? { ...second, firstWave: first } : second;
}

// The first wave's queue for one slot: stuck new signups, then the backlog.
async function firstWave(now, since, senderKeys) {
  // Build the ordered queue: NEW signups (registered after the watcher started)
  // first, oldest-of-them first (FIFO); then the EXISTING backlog, newest-first
  // (LIFO). Everyone is still past the grace window (createdAt <= graceCutoff).
  const graceCutoff = new Date(now.getTime() - WATCH_MINUTES * 60 * 1000);
  const base = { role: "teacher", phone: { $nin: [null, ""] }, outreachStatus: { $in: [null] } };
  const sel = "_id name phone createdAt outreachAttempts";
  // Scan the WHOLE waiting list, not a 48-row slice of it. "Stuck" cannot be
  // expressed as a query (it depends on the teacher's exams/classes), so it is
  // computed after fetching — which means a slice can be filled entirely with
  // teachers who already finished setting up, and the sweep then reports "nothing
  // to do" forever while the people who need the message sit behind them. That is
  // exactly what happened: 0 stuck inside the window, 137 stuck outside it.
  // This runs at most once per GAP_MIN (the gap check is above), so it is cheap.
  const cap = Number(process.env.OUTREACH_SCAN_CAP) || 500;
  let candidates;
  if (since) {
    const [fresh, backlog] = await Promise.all([
      User.find({ ...base, createdAt: { $gte: since, $lte: graceCutoff } }).select(sel).sort({ createdAt: 1 }).limit(cap).lean(),
      User.find({ ...base, createdAt: { $lt: since, $lte: graceCutoff } }).select(sel).sort({ createdAt: -1 }).limit(cap).lean(),
    ]);
    candidates = [...fresh, ...backlog];
  } else {
    candidates = await User.find({ ...base, createdAt: { $lte: graceCutoff } }).select(sel).sort({ createdAt: -1 }).limit(cap).lean();
  }
  if (!candidates.length) return { drained: true };

  const stuckMap = await stuckStateForOwners(candidates.map((c) => c._id));
  let attempts = 0;
  let cleared = 0;
  for (const u of candidates) {
    if (attempts >= ATTEMPTS_PER_SWEEP) break;
    const stuck = stuckMap.get(String(u._id));
    if (!stuck || !stuck.isStuck) continue; // finished setup → leave alone
    attempts += 1;
    // Rotate to the next ready number for THIS send, so consecutive sends go out
    // from alternating linked numbers ("1 by 1").
    const senderId = wa.nextReadyOwner(senderKeys);
    if (!senderId) return { skipped: "not_ready" };
    const status = await contact(senderId, u, stuck);
    if (status === "not_ready") return { skipped: "not_ready" };
    if (status === "sent") {
      await setLastSentAt(new Date());
      console.log(`[OUTREACH] sent 1 (cleared ${cleared} dead this slot)`);
      return { sent: 1, cleared };
    }
    cleared += 1; // no_whatsapp / retry-failed — move to the next immediately
  }
  return { sent: 0, cleared };
}

module.exports = {
  runOutreachSweep,
  getSettings,
  setEnabled,
  setReengageEnabled,
  setReengageEmailEnabled,
  reengageEmailQuery,
  reengageEmailSubject,
  reengageEmailWaitingCount,
  emailsSentToday,
  EMAIL_DAILY_MAX,
  reengageMessage,
  reengageQuery,
  reengageWaitingCount,
  INACTIVE_DAYS,
  waitingCount,
  sentTodayCount,
  withinHours,
  outreachMessage,
  firstName,
  localHour,
  WATCH_MINUTES,
  GAP_MIN,
  DAILY_MAX,
  DAY_START,
  DAY_END,
};
