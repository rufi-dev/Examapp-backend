const User = require("../models/userModel");
const AppSetting = require("../models/appSettingModel");
const { stuckStateForOwners } = require("../helper/stuckTeachers");
const wa = require("../helper/whatsapp");

// ─────────────────────────────────────────────────────────────────────────────
// Auto-outreach watcher.
//
// Sends ONE warm WhatsApp (from the admin's LINKED number, first name only,
// tailored to how far they got) to teachers who signed up but never finished
// setting up — empty exam, empty class, or nothing. Two groups, two rhythms:
//
//   • NEW registrants (createdAt >= the moment the watcher was switched on):
//     messaged as soon as they've been registered longer than the grace window
//     (default 10 min). No time-of-day restriction — reach them while warm.
//     A few may go out per sweep.
//
//   • EXISTING backlog (createdAt < that moment): drip out ONE AT A TIME, only
//     during working hours (10:00–19:00 Baku) and at most one real send every
//     10 minutes — so blasting the historical list can't get the number banned.
//     Numbers not on WhatsApp are skipped quickly (they don't consume the gap).
//
// Each teacher is messaged AT MOST ONCE (terminal status on the user). If no
// admin WhatsApp is linked+ready, the whole sweep does nothing (never wa.me).
// Toggle is admin-controlled and persisted (AppSetting).
// ─────────────────────────────────────────────────────────────────────────────

const ENABLED_KEY = "autoOutreachEnabled";
const SINCE_KEY = "autoOutreachSince";
const LAST_BACKLOG_KEY = "autoOutreachLastBacklogAt";

const WATCH_MINUTES = Number(process.env.OUTREACH_WATCH_MINUTES) || 10;
const MAX_PER_SWEEP = Number(process.env.OUTREACH_MAX_PER_SWEEP) || 5;
const SEND_GAP_MS = Number(process.env.OUTREACH_SEND_GAP_MS) || 2500;

// Backlog-only pacing (does NOT apply to new registrants).
const BACKLOG_GAP_MIN = Number(process.env.OUTREACH_BACKLOG_GAP_MIN) || 10;
const DAY_START = Number(process.env.OUTREACH_DAY_START) || 10; // 10:00 inclusive
const DAY_END = Number(process.env.OUTREACH_DAY_END) || 19; // 19:00 exclusive (7pm)
const TZ = process.env.OUTREACH_TZ || "Asia/Baku";
// How many backlog numbers to probe per sweep (skips/failures processed fast;
// stops after the first real send). Keeps getNumberId calls gentle.
const BACKLOG_ATTEMPTS_PER_SWEEP = Number(process.env.OUTREACH_BACKLOG_ATTEMPTS) || 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Current hour (0–23) in the target timezone.
function localHour(now) {
  try {
    const s = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now);
    return parseInt(s, 10);
  } catch {
    return (now.getUTCHours() + 4) % 24; // Baku is UTC+4 (no DST) — fallback
  }
}

async function getSettings() {
  const [enabled, since, lastBacklog] = await Promise.all([
    AppSetting.findOne({ key: ENABLED_KEY }).lean(),
    AppSetting.findOne({ key: SINCE_KEY }).lean(),
    AppSetting.findOne({ key: LAST_BACKLOG_KEY }).lean(),
  ]);
  return {
    enabled: !!(enabled && enabled.value),
    since: since && since.value ? new Date(since.value) : null,
    lastBacklogAt: lastBacklog && lastBacklog.value ? new Date(lastBacklog.value) : null,
  };
}

// Flip the watcher on/off. The new/backlog boundary (`since`) is stamped ONCE on
// the first enable and then kept stable across later toggles.
async function setEnabled(on, now = new Date()) {
  await AppSetting.updateOne({ key: ENABLED_KEY }, { $set: { value: !!on } }, { upsert: true });
  if (on) {
    const existing = await AppSetting.findOne({ key: SINCE_KEY }).lean();
    if (!existing || !existing.value) {
      await AppSetting.updateOne({ key: SINCE_KEY }, { $set: { value: now } }, { upsert: true });
    }
  }
  return getSettings();
}

async function setLastBacklogAt(when) {
  await AppSetting.updateOne({ key: LAST_BACKLOG_KEY }, { $set: { value: when } }, { upsert: true });
}

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

// Tailored outreach scripts — first name only, warm, asks what went wrong and
// offers to help. Mirror of the frontend manual scripts.
function outreachMessage(u, stuck) {
  const fn = firstName(u.name);
  const n = fn ? ` ${fn}` : "";
  if (stuck.hasEmptyExam)
    return `Salam${n} 🙂 Examopia komandasından yazıram. Gördüm ki, imtahan yaratmağa başlamısınız, amma sual əlavə etməmisiniz. Nə oldu? Hansı hissə çətin gəldi, nədə ilişdiniz? İstəsəniz, birlikdə edə bilərik — kömək etməkdən məmnun olaram 🌷`;
  if (stuck.hasEmptyClass)
    return `Salam${n} 🙂 Examopia komandasından yazıram. Gördüm ki, sinif yaratmısınız, amma hələ imtahan əlavə etməmisiniz. Nə oldu? Hansı hissə çətin gəldi, nədə ilişdiniz? İstəsəniz, birlikdə ilk imtahanınızı yarada bilərik — kömək etməkdən məmnun olaram 🌷`;
  return `Salam${n} 🙂 Examopia komandasından yazıram. Gördüm ki, qeydiyyatdan keçmisiniz, amma hələ başlamamısınız. Nə oldu? Hansı hissə çətin gəldi, nə sizi dayandırdı? İstəsəniz, birlikdə ilk imtahanınızı yarada bilərik — kömək etməkdən məmnun olaram 🌷`;
}

// Attempt one send + record a TERMINAL status so the teacher is never messaged
// again. Returns the raw send result ("sent"|"no_whatsapp"|"not_ready"|"failed").
async function contact(senderId, u, stuck) {
  let status = "failed";
  try {
    status = await wa.sendOutreachFor(senderId, u.phone, outreachMessage(u, stuck));
  } catch {
    status = "failed";
  }
  if (status === "not_ready") return status; // don't persist — retry next tick
  const persist = status === "sent" ? "sent" : status === "no_whatsapp" ? "skipped" : "failed";
  await User.updateOne(
    { _id: u._id, outreachStatus: { $in: [null] } },
    { $set: { outreachStatus: persist, outreachAt: new Date(), outreachReason: status } }
  );
  return status;
}

// New registrants: since <= createdAt <= now-grace, stuck, not contacted.
async function sweepNew(senderId, settings, now) {
  const cutoff = new Date(now.getTime() - WATCH_MINUTES * 60 * 1000);
  const q = {
    role: "teacher",
    createdAt: { $lte: cutoff },
    phone: { $nin: [null, ""] },
    outreachStatus: { $in: [null] },
  };
  if (settings.since) q.createdAt.$gte = settings.since;

  const candidates = await User.find(q)
    .select("_id name phone createdAt")
    .sort({ createdAt: 1 })
    .limit(MAX_PER_SWEEP * 5)
    .lean();
  if (!candidates.length) return { sent: 0, skipped: 0, failed: 0 };

  const stuckMap = await stuckStateForOwners(candidates.map((c) => c._id));
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const u of candidates) {
    if (sent + skipped + failed >= MAX_PER_SWEEP) break;
    const stuck = stuckMap.get(String(u._id));
    if (!stuck || !stuck.isStuck) continue;
    const status = await contact(senderId, u, stuck);
    if (status === "not_ready") break;
    if (status === "sent") sent += 1;
    else if (status === "no_whatsapp") skipped += 1;
    else failed += 1;
    if (status === "sent" && sent + skipped + failed < MAX_PER_SWEEP) await sleep(SEND_GAP_MS);
  }
  return { sent, skipped, failed };
}

// Existing backlog: createdAt < since. Working hours only, one real send per
// BACKLOG_GAP_MIN. Non-WhatsApp numbers are cleared quickly without consuming
// the gap so dead numbers don't stall the queue for days.
async function sweepBacklog(senderId, settings, now) {
  if (!settings.since) return { skipped: "no_since" };
  const hour = localHour(now);
  if (hour < DAY_START || hour >= DAY_END) return { skipped: "outside_hours", hour };
  if (
    settings.lastBacklogAt &&
    now.getTime() - settings.lastBacklogAt.getTime() < BACKLOG_GAP_MIN * 60 * 1000
  ) {
    return { skipped: "gap" };
  }

  const candidates = await User.find({
    role: "teacher",
    createdAt: { $lt: settings.since },
    phone: { $nin: [null, ""] },
    outreachStatus: { $in: [null] },
  })
    .select("_id name phone createdAt")
    .sort({ createdAt: -1 }) // newest of the backlog first
    .limit(BACKLOG_ATTEMPTS_PER_SWEEP * 6)
    .lean();
  if (!candidates.length) return { drained: true };

  const stuckMap = await stuckStateForOwners(candidates.map((c) => c._id));
  let attempts = 0;
  let cleared = 0; // skipped/failed cleared this sweep
  for (const u of candidates) {
    if (attempts >= BACKLOG_ATTEMPTS_PER_SWEEP) break;
    const stuck = stuckMap.get(String(u._id));
    if (!stuck || !stuck.isStuck) continue; // finished setup → leave alone
    attempts += 1;
    const status = await contact(senderId, u, stuck);
    if (status === "not_ready") return { skipped: "not_ready" };
    if (status === "sent") {
      await setLastBacklogAt(new Date());
      return { sent: 1, cleared };
    }
    cleared += 1; // no_whatsapp / failed — try the next one right away
  }
  return { sent: 0, cleared };
}

// One sweep. Idempotent, bounded, safe on an interval.
async function runOutreachSweep(now = new Date()) {
  const settings = await getSettings();
  if (!settings.enabled) return { skipped: "disabled" };

  const admins = await User.find({ role: "admin" }).select("_id").lean();
  const senderId = wa.firstReadyOwner(admins.map((a) => a._id));
  if (!senderId) return { skipped: "no_linked_whatsapp" };

  const fresh = await sweepNew(senderId, settings, now);
  // Re-read settings so the backlog phase sees any lastBacklogAt just written.
  const backlog = await sweepBacklog(senderId, await getSettings(), now);

  if (fresh.sent || fresh.failed || backlog.sent)
    console.log(
      `[OUTREACH] new: sent=${fresh.sent} skipped=${fresh.skipped} failed=${fresh.failed} · backlog: ${JSON.stringify(backlog)}`
    );
  return { new: fresh, backlog };
}

module.exports = {
  runOutreachSweep,
  sweepNew,
  sweepBacklog,
  getSettings,
  setEnabled,
  outreachMessage,
  firstName,
  localHour,
  WATCH_MINUTES,
};
