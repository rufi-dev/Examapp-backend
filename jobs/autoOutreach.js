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

async function getSettings() {
  const [enabled, lastSent, since] = await Promise.all([
    AppSetting.findOne({ key: ENABLED_KEY }).lean(),
    AppSetting.findOne({ key: LAST_SENT_KEY }).lean(),
    AppSetting.findOne({ key: SINCE_KEY }).lean(),
  ]);
  return {
    enabled: !!(enabled && enabled.value),
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

async function setLastSentAt(when) {
  await AppSetting.updateOne({ key: LAST_SENT_KEY }, { $set: { value: when } }, { upsert: true });
}

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

// Tailored outreach scripts — first name only, warm, asks what went wrong and
// offers to help. Mirror of the frontend manual scripts.
function outreachMessage(u, stuck) {
  const fn = firstName(u.name);
  const n = fn ? ` ${fn} müəllim` : " müəllim";
  if (stuck.hasEmptyExam)
    return `Salam${n} 🙂 Examopia komandasından yazıram. Gördüm ki, imtahan yaratmağa başlamısınız, amma sual əlavə etməmisiniz. Nə oldu? Hansı hissə çətin gəldi, nədə ilişdiniz? İstəsəniz, birlikdə edə bilərik — kömək etməkdən məmnun olaram 🌷`;
  if (stuck.hasEmptyClass)
    return `Salam${n} 🙂 Examopia komandasından yazıram. Gördüm ki, sinif yaratmısınız, amma hələ imtahan əlavə etməmisiniz. Nə oldu? Hansı hissə çətin gəldi, nədə ilişdiniz? İstəsəniz, birlikdə ilk imtahanınızı yarada bilərik — kömək etməkdən məmnun olaram 🌷`;
  return `Salam${n} 🙂 Examopia komandasından yazıram. Gördüm ki, qeydiyyatdan keçmisiniz, amma hələ başlamamısınız. Nə oldu? Hansı hissə çətin gəldi, nə sizi dayandırdı? İstəsəniz, birlikdə ilk imtahanınızı yarada bilərik — kömək etməkdən məmnun olaram 🌷`;
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

// One sweep. Idempotent, bounded, safe on an interval.
async function runOutreachSweep(now = new Date()) {
  const { enabled, lastSentAt, since } = await getSettings();
  if (!enabled) return { skipped: "disabled" };

  const admins = await User.find({ role: "admin" }).select("_id").lean();
  const senderId = wa.firstReadyOwner(admins.map((a) => a._id));
  if (!senderId) return { skipped: "no_linked_whatsapp" };

  if (!withinHours(now)) return { skipped: "outside_hours", hour: localHour(now) };
  if (lastSentAt && now.getTime() - lastSentAt.getTime() < GAP_MIN * 60 * 1000) return { skipped: "gap" };

  // Hard daily cap: stop once DAILY_MAX real sends have gone out today (Baku).
  const dayStartUtc = new Date(now.getTime() + 4 * 3600 * 1000);
  dayStartUtc.setUTCHours(0, 0, 0, 0);
  const bakuMidnight = new Date(dayStartUtc.getTime() - 4 * 3600 * 1000);
  const sentToday = await User.countDocuments({ outreachStatus: "sent", outreachAt: { $gte: bakuMidnight } });
  if (sentToday >= DAILY_MAX) return { skipped: "daily_cap", sentToday };

  // Build the ordered queue: NEW signups (registered after the watcher started)
  // first, oldest-of-them first (FIFO); then the EXISTING backlog, newest-first
  // (LIFO). Everyone is still past the grace window (createdAt <= graceCutoff).
  const graceCutoff = new Date(now.getTime() - WATCH_MINUTES * 60 * 1000);
  const base = { role: "teacher", phone: { $nin: [null, ""] }, outreachStatus: { $in: [null] } };
  const sel = "_id name phone createdAt outreachAttempts";
  const cap = ATTEMPTS_PER_SWEEP * 6;
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
  waitingCount,
  withinHours,
  outreachMessage,
  firstName,
  localHour,
  WATCH_MINUTES,
  GAP_MIN,
  DAY_START,
  DAY_END,
};
